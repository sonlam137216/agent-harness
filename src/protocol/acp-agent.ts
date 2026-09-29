import { isAbsolute } from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';

import type { AgentDefinition } from '../agent/agent-definition.js';
import { EventBus } from '../events/event-bus.js';
import { createSessionId, type SessionId } from '../ids.js';
import type { TracingHandle } from '../observability/tracing.js';
import type { ApprovalHandler, PermissionRequest } from '../permissions/permission-engine.js';
import type { Session, SessionMetadata } from '../session/session.js';
import type { SessionStore } from '../session/session-store.js';
import { validRecordKey } from '../workspace/record-storage.js';
import {
  replayUpdates,
  toolKind,
  toolTitle,
  TurnUpdateTracker,
  type AcpSessionUpdate,
} from './acp-updates.js';
import {
  JSON_RPC_ERRORS,
  JsonRpcError,
  type JsonRpcConnection,
  type JsonRpcHandlers,
} from './json-rpc.js';

export const ACP_PROTOCOL_VERSION = 1;

export type AcpPromptOutcome =
  'completed' | 'cancelled' | 'deadline_exceeded' | 'max_iterations' | 'failed';

export interface AcpPromptInput {
  readonly sessionId: SessionId;
  readonly workspaceRoot: string;
  readonly prompt: string;
  /** The saved agent of a session that already has turns, as CLI resume does. */
  readonly savedAgent?: AgentDefinition;
  readonly events: EventBus;
  readonly approve: ApprovalHandler;
  readonly signal: AbortSignal;
}

/**
 * Runs one prompt through the normal harness runtime. Implemented at the composition root,
 * so the protocol layer never constructs providers, tools or workspaces itself.
 */
export interface AcpPromptRunner {
  run(input: AcpPromptInput): Promise<{ readonly outcome: AcpPromptOutcome }>;
}

export interface AcpAgentOptions {
  readonly sessionStore: SessionStore;
  readonly runner: AcpPromptRunner;
  readonly tracer: TracingHandle['tracer'];
  /** Configuration saved with new sessions, matching what the CLI stores. */
  readonly defaults: Pick<SessionMetadata, 'provider' | 'contextBudget' | 'rulesDirectory'> & {
    readonly modelId: string;
  };
  readonly agentInfo: { readonly name: string; readonly version: string };
  /** Converts an unexpected error into a message that is safe to send to the client. */
  readonly describeError: (error: unknown) => string;
  /** Diagnostics that must not go to the protocol stream (e.g. stderr). */
  readonly warn?: (message: string) => void;
}

const STOP_REASONS: Readonly<Record<Exclude<AcpPromptOutcome, 'failed'>, string>> = {
  completed: 'end_turn',
  cancelled: 'cancelled',
  deadline_exceeded: 'cancelled',
  max_iterations: 'max_turn_requests',
};

function invalidParams(message: string): JsonRpcError {
  return new JsonRpcError(JSON_RPC_ERRORS.invalidParams, message);
}

function object(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw invalidParams(`${what} must be an object.`);
  return value as Record<string, unknown>;
}

function sessionIdParam(params: Record<string, unknown>): SessionId {
  const id = params.sessionId;
  if (typeof id !== 'string' || !validRecordKey(id)) throw invalidParams('Unknown sessionId.');
  return id as SessionId;
}

function cwdParam(params: Record<string, unknown>): string {
  const cwd = params.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd))
    throw invalidParams('cwd must be an absolute path.');
  return cwd;
}

/** Text and resource links become prompt text; other content types are not advertised. */
function promptText(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0)
    throw invalidParams('prompt must be a non-empty array of content blocks.');
  const parts = value.map((raw) => {
    const block = object(raw, 'A content block');
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (block.type === 'resource_link' && typeof block.uri === 'string')
      return `[Resource: ${typeof block.name === 'string' ? `${block.name} ` : ''}${block.uri}]`;
    throw invalidParams('Only text and resource_link content blocks are supported.');
  });
  const text = parts.join('\n').trim();
  if (text === '') throw invalidParams('The prompt is empty.');
  return text;
}

/**
 * Agent side of the Agent Client Protocol (ACP) over JSON-RPC: initialize, session/new,
 * session/load, session/prompt, session/cancel, session/update notifications and
 * session/request_permission round trips. Each prompt is one normal SessionRuntime turn.
 */
export class AcpAgent implements JsonRpcHandlers {
  readonly #options: AcpAgentOptions;
  readonly #running = new Map<SessionId, AbortController>();
  #connection: JsonRpcConnection | undefined;
  #initialized = false;

  public constructor(options: AcpAgentOptions) {
    this.#options = options;
  }

  public attach(connection: JsonRpcConnection): void {
    this.#connection = connection;
  }

  /** Cancels every running prompt, e.g. when the client disconnects. */
  public cancelAll(): void {
    for (const controller of this.#running.values()) controller.abort();
  }

  public async request(method: string, params: unknown): Promise<unknown> {
    if (method === 'initialize') return this.#initialize(params);
    if (!this.#initialized)
      throw new JsonRpcError(JSON_RPC_ERRORS.invalidRequest, 'Call initialize first.');
    switch (method) {
      case 'authenticate':
        return {};
      case 'session/new':
        return this.#newSession(object(params, 'params'));
      case 'session/load':
        return this.#loadSession(object(params, 'params'));
      case 'session/prompt':
        return this.#prompt(object(params, 'params'));
      default:
        throw new JsonRpcError(JSON_RPC_ERRORS.methodNotFound, `Method not found: ${method}`);
    }
  }

  public notification(method: string, params: unknown): void {
    if (method !== 'session/cancel') return;
    try {
      this.#running.get(sessionIdParam(object(params, 'params')))?.abort();
    } catch {
      // A malformed cancel has nothing to cancel.
    }
  }

  #initialize(params: unknown): unknown {
    const version = object(params, 'params').protocolVersion;
    if (typeof version !== 'number') throw invalidParams('protocolVersion must be a number.');
    this.#initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: this.#options.agentInfo,
    };
  }

  #ignoreMcpServers(params: Record<string, unknown>): void {
    const servers = params.mcpServers;
    if (servers !== undefined && !Array.isArray(servers))
      throw invalidParams('mcpServers must be an array.');
    if (Array.isArray(servers) && servers.length > 0)
      this.#options.warn?.(
        `Ignoring ${servers.length} client-provided MCP server(s); configure --mcp-config on the agent instead.`,
      );
  }

  async #newSession(params: Record<string, unknown>): Promise<unknown> {
    const cwd = cwdParam(params);
    this.#ignoreMcpServers(params);
    const { modelId, ...configuration } = this.#options.defaults;
    const now = new Date().toISOString();
    const session: Session = {
      id: createSessionId(),
      turns: [],
      metadata: {
        createdAt: now,
        updatedAt: now,
        // Replaced by the runtime's agent on the first prompt.
        agent: { name: 'acp-session', systemPrompt: '', model: { modelId } },
        workspaceRoot: cwd,
        ...configuration,
      },
    };
    await this.#options.sessionStore.save(session);
    return { sessionId: session.id };
  }

  async #existing(sessionId: SessionId, cwd?: string): Promise<Session> {
    const session = await this.#options.sessionStore.get(sessionId);
    if (session === undefined) throw invalidParams('Unknown sessionId.');
    if (session.metadata?.parent !== undefined)
      throw invalidParams('Subagent sessions cannot be loaded; inspect them with sessions show.');
    if (
      cwd !== undefined &&
      session.metadata?.workspaceRoot !== undefined &&
      session.metadata.workspaceRoot !== cwd
    )
      throw invalidParams('A loaded session must use its original workspace.');
    return session;
  }

  async #loadSession(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = sessionIdParam(params);
    const cwd = cwdParam(params);
    this.#ignoreMcpServers(params);
    const session = await this.#existing(sessionId, cwd);
    for (const update of replayUpdates(session, cwd)) this.#update(sessionId, update);
    return null;
  }

  async #prompt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = sessionIdParam(params);
    const prompt = promptText(params.prompt);
    const session = await this.#existing(sessionId);
    const workspaceRoot = session.metadata?.workspaceRoot;
    if (workspaceRoot === undefined) throw invalidParams('The session has no workspace.');
    if (this.#running.has(sessionId))
      throw new JsonRpcError(
        JSON_RPC_ERRORS.invalidRequest,
        'A prompt is already running for this session.',
      );

    const controller = new AbortController();
    this.#running.set(sessionId, controller);
    const events = new EventBus();
    const tracker = new TurnUpdateTracker(workspaceRoot);
    events.subscribe((event) => {
      if (event.type === 'SessionUpdated')
        for (const update of tracker.next(event.session)) this.#update(sessionId, update);
      else if (event.type === 'ToolStarted')
        this.#update(sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: 'in_progress',
        });
    });
    return this.#options.tracer.startActiveSpan('protocol.prompt', async (span) => {
      span.setAttributes({ 'protocol.name': 'acp', 'session.id': sessionId });
      try {
        const { outcome } = await this.#options.runner.run({
          sessionId,
          workspaceRoot,
          prompt,
          ...(session.turns.length > 0 && session.metadata !== undefined
            ? { savedAgent: session.metadata.agent }
            : {}),
          events,
          approve: (request, signal) => this.#requestPermission(sessionId, request, signal),
          signal: controller.signal,
        });
        span.setAttribute('protocol.outcome', outcome);
        if (outcome === 'failed')
          throw new JsonRpcError(
            JSON_RPC_ERRORS.internalError,
            'The turn failed without a final answer.',
          );
        if (outcome !== 'completed') span.setStatus({ code: SpanStatusCode.ERROR });
        return { stopReason: STOP_REASONS[outcome] };
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (controller.signal.aborted) return { stopReason: 'cancelled' };
        if (error instanceof JsonRpcError) throw error;
        throw new JsonRpcError(JSON_RPC_ERRORS.internalError, this.#options.describeError(error));
      } finally {
        this.#running.delete(sessionId);
        span.end();
      }
    });
  }

  async #requestPermission(
    sessionId: SessionId,
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const connection = this.#connection;
    if (connection === undefined) return false;
    try {
      const response = await connection.request(
        'session/request_permission',
        {
          sessionId,
          toolCall: {
            toolCallId: request.call.id,
            title: toolTitle(request.call),
            kind: toolKind(request.call.name),
            status: 'pending',
            rawInput: request.call.arguments,
          },
          options: [
            { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
            { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
        signal,
      );
      const outcome = (response as { outcome?: { outcome?: unknown; optionId?: unknown } } | null)
        ?.outcome;
      return outcome?.outcome === 'selected' && outcome.optionId === 'allow';
    } catch {
      // Cancelled, disconnected or malformed responses never grant permission.
      return false;
    }
  }

  #update(sessionId: SessionId, update: AcpSessionUpdate): void {
    this.#connection?.notify('session/update', { sessionId, update });
  }
}
