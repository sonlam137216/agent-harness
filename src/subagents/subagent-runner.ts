import { SpanStatusCode } from '@opentelemetry/api';

import type { AgentDefinition } from '../agent/agent-definition.js';
import type { ContextBuilder } from '../context/context-builder.js';
import { EventBus } from '../events/event-bus.js';
import type { SessionId, SubagentId, ToolCallId, TurnId } from '../ids.js';
import type { Sampler } from '../model/sampler.interface.js';
import type { TracingHandle } from '../observability/tracing.js';
import { tracingSubscriber } from '../observability/tracing-subscriber.js';
import { PermissionEngine, type PermissionRule } from '../permissions/permission-engine.js';
import { AgentLoop, type AgentLoopOutcome } from '../runtime/agent-loop.js';
import { SessionRuntime } from '../runtime/session-runtime.js';
import type { Session, SessionMetadata } from '../session/session.js';
import type { SessionStore } from '../session/session-store.js';
import type { Tool } from '../tools/tool.interface.js';
import { ToolBridge } from '../tools/tool-bridge.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
  SubagentError,
  SUBAGENT_ROLE_DEFINITIONS,
  SUBAGENT_ROLES,
  SUBAGENT_TOOL_NAMES,
  type SubagentRole,
  type SubagentRoleDefinition,
} from './subagent-definition.js';

export const DEFAULT_SUBAGENT_MAX_TOKENS = 120_000;
export const DEFAULT_MAX_REPORT_CHARACTERS = 6_000;
const MAX_SOURCES = 32;

export type SubagentOutcome = AgentLoopOutcome | 'token_budget_exceeded';

export interface SubagentRunRequest {
  readonly subagentId: SubagentId;
  readonly role: SubagentRole;
  readonly task: string;
  readonly parent: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly toolCallId: ToolCallId;
  };
  readonly background: boolean;
  readonly signal?: AbortSignal;
}

/** Bounded result returned to the parent; the child transcript stays in its own session. */
export interface SubagentHandoff {
  readonly subagentId: SubagentId;
  readonly role: SubagentRole;
  readonly sessionId?: SessionId;
  readonly outcome: SubagentOutcome;
  readonly report: string | null;
  readonly reportTruncated: boolean;
  /** Workspace paths the child successfully read, in first-read order. */
  readonly sources: readonly string[];
  readonly iterations: number;
  readonly toolCalls: number;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  /** Present for worktree roles: where the changes are and how large they are. */
  readonly worktree?: {
    readonly id: string;
    readonly branch: string;
    /** Absent when the final snapshot failed; the checkout still holds the files. */
    readonly changes?: IsolatedWorkspaceChanges;
  };
}

/** A type alias (not an interface) so handoffs stay assignable to JSON values. */
export type IsolatedWorkspaceChanges = {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
};

/** A disposable checkout with tools rooted inside it. */
export interface IsolatedWorkspace {
  readonly id: string;
  readonly branch: string;
  readonly root: string;
  readonly tools: readonly Tool[];
}

/**
 * Port for worktree roles, implemented at the composition root. Errors must carry
 * messages that are safe to show to the parent model.
 */
export interface IsolatedWorkspaceProvider {
  create(
    input: { readonly subagentId: SubagentId; readonly parentSessionId: SessionId },
    signal?: AbortSignal,
  ): Promise<IsolatedWorkspace>;
  /** Keeps the child's work (e.g. commits it) even after cancellation. */
  finalize(
    id: string,
    input: { readonly sessionId?: SessionId },
  ): Promise<IsolatedWorkspaceChanges>;
}

export interface SubagentRunnerOptions {
  readonly sampler: Sampler;
  /** Child context; composed by the caller (typically rules only, never the parent's history). */
  readonly contextBuilder: ContextBuilder;
  readonly sessionStore: SessionStore;
  /** Candidate tools for shared-workspace roles. Every one must be a native read-only leaf tool. */
  readonly tools: readonly Tool[];
  /** Enables worktree roles (`implement`); without it they are not offered. */
  readonly worktrees?: IsolatedWorkspaceProvider;
  readonly tracer: TracingHandle['tracer'];
  readonly modelId: string;
  /** The parent's rules; deny and ask rules therefore also restrict children. */
  readonly permissionRules?: readonly PermissionRule[];
  readonly configuration?: Pick<
    SessionMetadata,
    'workspaceRoot' | 'provider' | 'contextBudget' | 'rulesDirectory'
  >;
  readonly roles?: Readonly<Record<SubagentRole, SubagentRoleDefinition>>;
  /** Input plus output tokens of child response calls, checked before each call. */
  readonly maxTokens?: number;
  readonly maxReportCharacters?: number;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer.`);
  return value;
}

function validateTools(tools: readonly Tool[], allowWrite: boolean): void {
  for (const tool of tools) {
    const { name, accessKind, origin } = tool.definition;
    if ((SUBAGENT_TOOL_NAMES as readonly string[]).includes(name))
      throw new TypeError('Delegation tools cannot be offered to a subagent.');
    const kindAllowed = accessKind === 'read' || (allowWrite && accessKind === 'write');
    if (!kindAllowed || origin === 'external' || tool.resolveInvocation !== undefined)
      throw new TypeError(
        allowWrite
          ? 'Worktree tools must be native read or write leaf tools.'
          : 'Subagent tools must be native read-only leaf tools.',
      );
  }
}

function childTurnStats(
  session: Session,
): Pick<SubagentHandoff, 'sources' | 'toolCalls' | 'usage'> {
  const turn = session.turns.at(-1);
  const readCalls = new Set<string>();
  const sources: string[] = [];
  let toolCalls = 0;
  for (const entry of turn?.entries ?? []) {
    if (entry.kind === 'assistant_message') {
      toolCalls += entry.toolCalls.length;
      for (const call of entry.toolCalls) if (call.name === 'read_file') readCalls.add(call.id);
    }
    if (entry.kind !== 'tool_result' || entry.outcome !== 'success') continue;
    if (!readCalls.has(entry.toolCallId)) continue;
    const output = entry.output;
    const path =
      output !== null && typeof output === 'object' && 'path' in output ? output.path : undefined;
    if (typeof path === 'string' && !sources.includes(path) && sources.length < MAX_SOURCES)
      sources.push(path);
  }
  const usage = (session.usage ?? []).reduce(
    (sum, record) => ({
      inputTokens: sum.inputTokens + record.tokens.inputTokens,
      outputTokens: sum.outputTokens + record.tokens.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  return { sources, toolCalls, usage };
}

/**
 * Runs one child as an isolated session: its own SessionRuntime, AgentLoop, tool registry,
 * permission engine and event bus. It never throws for child failure; the outcome is data.
 */
export class SubagentRunner {
  readonly #options: SubagentRunnerOptions;
  readonly #roles: Readonly<Record<SubagentRole, SubagentRoleDefinition>>;
  readonly #maxTokens: number;
  readonly #maxReportCharacters: number;

  public constructor(options: SubagentRunnerOptions) {
    validateTools(options.tools, false);
    this.#roles = options.roles ?? SUBAGENT_ROLE_DEFINITIONS;
    for (const role of Object.values(this.#roles)) positive(role.maxIterations, 'maxIterations');
    this.#maxTokens = positive(options.maxTokens ?? DEFAULT_SUBAGENT_MAX_TOKENS, 'maxTokens');
    this.#maxReportCharacters = positive(
      options.maxReportCharacters ?? DEFAULT_MAX_REPORT_CHARACTERS,
      'maxReportCharacters',
    );
    this.#options = options;
  }

  public role(role: SubagentRole): SubagentRoleDefinition {
    return this.#roles[role];
  }

  public availableRoles(): readonly SubagentRole[] {
    return SUBAGENT_ROLES.filter(
      (role) => this.#roles[role].workspace === 'shared' || this.#options.worktrees !== undefined,
    );
  }

  public async run(request: SubagentRunRequest): Promise<SubagentHandoff> {
    const options = this.#options;
    const definition = this.#roles[request.role];
    return options.tracer.startActiveSpan('subagent.spawn', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({
        'subagent.id': request.subagentId,
        'subagent.role': request.role,
        'subagent.background': request.background,
        'session.id': request.parent.sessionId,
        'turn.id': request.parent.turnId,
        'tool_call.id': request.parent.toolCallId,
        'subagent.max_tokens': this.#maxTokens,
        'subagent.max_iterations': definition.maxIterations,
      });

      const controller = new AbortController();
      const cancel = (): void => controller.abort(request.signal?.reason);
      if (request.signal?.aborted === true) cancel();
      else request.signal?.addEventListener('abort', cancel, { once: true });

      let isolated: IsolatedWorkspace | undefined;
      if (definition.workspace === 'worktree') {
        try {
          const provider = options.worktrees;
          if (provider === undefined) throw new Error('Worktrees are not enabled for this run.');
          isolated = await provider.create(
            { subagentId: request.subagentId, parentSessionId: request.parent.sessionId },
            controller.signal,
          );
          validateTools(isolated.tools, true);
          span.setAttribute('subagent.worktree_id', isolated.id);
        } catch (error) {
          request.signal?.removeEventListener('abort', cancel);
          span.setAttributes({ success: false, 'error.type': 'worktree_unavailable' });
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          throw new SubagentError(
            'worktree_unavailable',
            error instanceof Error
              ? error.message.slice(0, 300)
              : 'The worktree could not be created.',
          );
        }
      }
      const tools = isolated?.tools ?? options.tools;

      let consumed = 0;
      let budgetExceeded = false;
      const sampler: Sampler = {
        sample: async (modelRequest, samplingOptions) => {
          if (consumed >= this.#maxTokens) {
            budgetExceeded = true;
            controller.abort();
            controller.signal.throwIfAborted();
          }
          const response = await options.sampler.sample(modelRequest, samplingOptions);
          consumed += response.usage.inputTokens + response.usage.outputTokens;
          return response;
        },
      };

      const registry = new ToolRegistry();
      for (const tool of tools)
        if (definition.tools.includes(tool.definition.name)) registry.register(tool);
      const events = new EventBus();
      let childSessionId: SessionId | undefined;
      const unsubscribe = [
        events.subscribe(tracingSubscriber),
        events.subscribe((event) => {
          childSessionId ??= event.sessionId;
        }),
      ];
      const toolBridge = new ToolBridge(registry, options.tracer, {
        // No approval handler: anything that would need a prompt is denied inside a child.
        permissions: new PermissionEngine({
          mode: 'auto',
          rules: [
            ...(options.permissionRules ?? []),
            // Writes land only in the disposable worktree; parent deny/ask rules still win.
            ...(isolated === undefined
              ? []
              : [{ accessKind: 'write' as const, decision: 'allow' as const }]),
          ],
        }),
        events,
      });
      const runtime = new SessionRuntime({
        sessionStore: options.sessionStore,
        agentLoop: new AgentLoop({
          sampler,
          contextBuilder: options.contextBuilder,
          toolBridge,
          tracer: options.tracer,
          maxIterations: definition.maxIterations,
          events,
        }),
        tracer: options.tracer,
        events,
      });
      const agent: AgentDefinition = {
        name: `subagent-${request.role}`,
        systemPrompt: definition.instructions,
        model: { modelId: options.modelId },
      };

      let handoff: SubagentHandoff;
      try {
        const result = await runtime.run({
          agent,
          prompt: request.task,
          tools: registry.getModelDefinitions(),
          configuration: {
            ...options.configuration,
            ...(isolated === undefined ? {} : { workspaceRoot: isolated.root }),
            parent: { ...request.parent, subagentId: request.subagentId, role: request.role },
          },
          signal: controller.signal,
        });
        const report = result.finalText;
        handoff = {
          subagentId: request.subagentId,
          role: request.role,
          sessionId: result.session.id,
          outcome: budgetExceeded ? 'token_budget_exceeded' : result.outcome,
          report: report === null ? null : report.slice(0, this.#maxReportCharacters),
          reportTruncated: report !== null && report.length > this.#maxReportCharacters,
          iterations: result.iterations,
          ...childTurnStats(result.session),
        };
      } catch (error) {
        span.setAttribute('error.type', error instanceof Error ? error.name : 'unknown');
        handoff = {
          subagentId: request.subagentId,
          role: request.role,
          ...(childSessionId === undefined ? {} : { sessionId: childSessionId }),
          outcome: budgetExceeded
            ? 'token_budget_exceeded'
            : controller.signal.aborted
              ? 'cancelled'
              : 'failed',
          report: null,
          reportTruncated: false,
          sources: [],
          iterations: 0,
          toolCalls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      } finally {
        runtime.dispose();
        for (const stop of unsubscribe) stop();
        request.signal?.removeEventListener('abort', cancel);
      }

      if (isolated !== undefined) {
        let changes: IsolatedWorkspaceChanges | undefined;
        try {
          changes = await options.worktrees!.finalize(isolated.id, {
            ...(handoff.sessionId === undefined ? {} : { sessionId: handoff.sessionId }),
          });
          span.setAttribute('subagent.changed_files', changes.files);
        } catch {
          span.setAttribute('subagent.snapshot_failed', true);
        }
        handoff = {
          ...handoff,
          worktree: {
            id: isolated.id,
            branch: isolated.branch,
            ...(changes === undefined ? {} : { changes }),
          },
        };
      }

      span.setAttributes({
        ...(handoff.sessionId === undefined ? {} : { 'subagent.session_id': handoff.sessionId }),
        'subagent.outcome': handoff.outcome,
        'loop.iterations': handoff.iterations,
        'subagent.tool_calls': handoff.toolCalls,
        'subagent.sources': handoff.sources.length,
        'subagent.report_chars': handoff.report?.length ?? 0,
        'subagent.report_truncated': handoff.reportTruncated,
        input_tokens: handoff.usage.inputTokens,
        output_tokens: handoff.usage.outputTokens,
        success: handoff.outcome === 'completed',
        duration_ms: performance.now() - startedAt,
      });
      if (handoff.outcome !== 'completed') span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      return handoff;
    });
  }
}
