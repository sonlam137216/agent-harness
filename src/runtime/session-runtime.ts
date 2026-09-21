import { createCancellationScope } from '../cancellation.js';
import { EventBus } from '../events/event-bus.js';
import { persistenceSubscriber } from '../events/persistence-subscriber.js';
import type { HookRegistry } from '../hooks/hook-registry.js';
import { SpanStatusCode } from '@opentelemetry/api';

import type { AgentDefinition } from '../agent/agent-definition.js';
import { createSessionId, createTurnId, type SessionId, type TurnId } from '../ids.js';
import type { ModelToolDefinition } from '../model/sampling-types.js';
import type { TracingHandle } from '../observability/tracing.js';
import type { SessionStore } from '../session/session-store.js';
import type { Session, SessionMetadata } from '../session/session.js';
import { recoverInterruptedSession, SessionStateError } from '../session/session-history.js';
import type { TurnStatus } from '../session/turn.js';
import { AgentLoopExecutionError, type AgentLoop, type AgentLoopResult } from './agent-loop.js';

export interface SessionRuntimeOptions {
  readonly sessionStore: SessionStore;
  readonly agentLoop: AgentLoop;
  readonly tracer: TracingHandle['tracer'];
  readonly events?: EventBus;
  readonly hooks?: HookRegistry;
}

export interface SessionRuntimeRunInput {
  readonly agent: AgentDefinition;
  readonly prompt: string;
  readonly tools: readonly ModelToolDefinition[];
  /** Omit to create a new session; provide an existing ID to continue it. */
  readonly sessionId?: SessionId;
  readonly configuration?: Pick<
    SessionMetadata,
    'workspaceRoot' | 'provider' | 'contextBudget' | 'rulesDirectory'
  >;
  readonly signal?: AbortSignal;
  /** Absolute Unix timestamp in milliseconds. */
  readonly deadlineMs?: number;
}

export interface SessionRuntimeResult extends AgentLoopResult {
  readonly turnId: TurnId;
}

export class SessionNotFoundError extends Error {
  public override readonly name = 'SessionNotFoundError';

  public constructor(public readonly sessionId: SessionId) {
    super(`Session "${sessionId}" does not exist.`);
  }
}

function appendUserTurn(
  session: Session,
  turnId: TurnId,
  prompt: string,
  traceId: string,
): Session {
  return {
    ...session,
    turns: [
      ...session.turns,
      {
        id: turnId,
        status: 'in_progress',
        ...(traceId === '0'.repeat(32) ? {} : { traceId }),
        entries: [{ kind: 'user_message', content: prompt }],
      },
    ],
  };
}

function setTurnStatus(session: Session, turnId: TurnId, status: TurnStatus): Session {
  return {
    ...session,
    turns: session.turns.map((turn) => (turn.id === turnId ? { ...turn, status } : turn)),
  };
}

export class SessionRuntime {
  readonly #sessionStore: SessionStore;
  readonly #agentLoop: AgentLoop;
  readonly #tracer: TracingHandle['tracer'];
  readonly #events: EventBus;
  readonly #hooks: HookRegistry | undefined;
  readonly #unsubscribePersistence: () => void;
  #disposed = false;

  public constructor(options: SessionRuntimeOptions) {
    this.#events = options.events ?? new EventBus();
    this.#hooks = options.hooks;
    this.#unsubscribePersistence = this.#events.subscribe(
      persistenceSubscriber(options.sessionStore),
      { required: true },
    );
    this.#sessionStore = options.sessionStore;
    this.#agentLoop = options.agentLoop;
    this.#tracer = options.tracer;
  }

  public dispose(): void {
    this.#unsubscribePersistence();
    this.#disposed = true;
  }

  public async run(input: SessionRuntimeRunInput): Promise<SessionRuntimeResult> {
    if (this.#disposed) throw new Error('SessionRuntime has been disposed.');
    if (input.deadlineMs !== undefined && !Number.isFinite(input.deadlineMs)) {
      throw new RangeError('deadlineMs must be a finite absolute timestamp.');
    }
    const sessionId = input.sessionId ?? createSessionId();

    return this.#tracer.startActiveSpan('session.run', async (sessionSpan) => {
      const startedAt = performance.now();
      sessionSpan.setAttributes({
        'session.id': sessionId,
        'agent.name': input.agent.name,
        'model.default': input.agent.model.modelId,
        'session.created': input.sessionId === undefined,
      });

      try {
        return await this.#sessionStore.withSessionLock(sessionId, async () => {
          let session = await this.#loadOrCreateSession(sessionId, input.sessionId !== undefined);
          if (
            session.metadata?.workspaceRoot !== undefined &&
            input.configuration?.workspaceRoot !== undefined &&
            session.metadata.workspaceRoot !== input.configuration.workspaceRoot
          ) {
            throw new SessionStateError('A resumed session must use its original workspace.');
          }
          const now = new Date().toISOString();
          session = {
            ...recoverInterruptedSession(session),
            metadata: {
              ...session.metadata,
              ...input.configuration,
              agent: input.agent,
              createdAt: session.metadata?.createdAt ?? now,
              updatedAt: now,
            },
          };
          const turnId = createTurnId();
          const turnIndex = session.turns.length;
          const activeSession = appendUserTurn(
            session,
            turnId,
            input.prompt,
            sessionSpan.spanContext().traceId,
          );
          const result = await this.#runTurn(input, activeSession, turnId, turnIndex);

          sessionSpan.setAttributes({
            'session.outcome': result.outcome,
            success: result.outcome === 'completed',
          });
          if (result.outcome !== 'completed') {
            sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
          }
          return result;
        });
      } catch (error) {
        sessionSpan.setAttributes({ 'session.outcome': 'error', success: false });
        sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        sessionSpan.setAttribute('duration_ms', performance.now() - startedAt);
        sessionSpan.end();
      }
    });
  }

  async #loadOrCreateSession(sessionId: SessionId, loadExisting: boolean): Promise<Session> {
    if (!loadExisting) return { id: sessionId, turns: [] };

    const session = await this.#sessionStore.get(sessionId);
    if (session === undefined) throw new SessionNotFoundError(sessionId);
    return session;
  }

  async #runTurn(
    input: SessionRuntimeRunInput,
    activeSession: Session,
    turnId: TurnId,
    turnIndex: number,
  ): Promise<SessionRuntimeResult> {
    return this.#tracer.startActiveSpan('turn.run', async (turnSpan) => {
      const startedAt = performance.now();
      turnSpan.setAttributes({
        'session.id': activeSession.id,
        'turn.id': turnId,
        'turn.index': turnIndex,
      });

      const correlation = { sessionId: activeSession.id, turnId };
      const cancellation = createCancellationScope(input.signal, input.deadlineMs);
      let latestSession = activeSession;
      let outcome: string = 'error';
      try {
        await this.#events.publish({
          type: 'SessionUpdated',
          ...correlation,
          session: activeSession,
        });
        let loopResult: AgentLoopResult;
        let failed = false;
        let failure: unknown;
        try {
          if (input.sessionId === undefined)
            await this.#events.publish({ type: 'SessionStarted', ...correlation });
          await this.#events.publish({ type: 'TurnStarted', ...correlation });
          if (input.sessionId === undefined) {
            await this.#hooks?.run({ name: 'SessionStart', ...correlation }, cancellation.signal);
          }
          await this.#hooks?.run({ name: 'TurnStart', ...correlation }, cancellation.signal);
          cancellation.signal?.throwIfAborted();
          loopResult = await this.#agentLoop.run({
            agent: input.agent,
            session: activeSession,
            turnId,
            tools: input.tools,
            onProgress: async (session) => {
              await this.#events.publish({
                type: 'SessionUpdated',
                ...correlation,
                session: {
                  ...session,
                  ...(session.metadata === undefined
                    ? {}
                    : { metadata: { ...session.metadata, updatedAt: new Date().toISOString() } }),
                },
              });
            },
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
          });
        } catch (error) {
          const cancelled = cancellation.signal?.aborted === true;
          latestSession =
            error instanceof AgentLoopExecutionError
              ? error.latestSession
              : setTurnStatus(activeSession, turnId, cancelled ? 'cancelled' : 'failed');
          loopResult = {
            session: latestSession,
            outcome: cancelled
              ? cancellation.deadlineReached()
                ? 'deadline_exceeded'
                : 'cancelled'
              : 'failed',
            iterations: error instanceof AgentLoopExecutionError ? error.iterations : 0,
            finalText: null,
          };
          failed = !cancelled;
          failure = error instanceof AgentLoopExecutionError ? error.cause : error;
        }

        latestSession = {
          ...loopResult.session,
          ...(loopResult.session.metadata === undefined
            ? {}
            : {
                metadata: { ...loopResult.session.metadata, updatedAt: new Date().toISOString() },
              }),
        };
        loopResult = { ...loopResult, session: latestSession };
        await this.#events.publish({
          type: 'SessionUpdated',
          ...correlation,
          session: latestSession,
        });
        outcome = loopResult.outcome;
        turnSpan.setAttributes({
          'loop.iterations': loopResult.iterations,
          'turn.outcome': outcome,
          success: outcome === 'completed',
        });
        if (outcome !== 'completed') turnSpan.setStatus({ code: SpanStatusCode.ERROR });
        if (failed) throw failure;
        return { ...loopResult, turnId };
      } catch (error) {
        turnSpan.setAttributes({ 'turn.outcome': 'error', success: false });
        turnSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        await this.#events.publish({ type: 'TurnCompleted', ...correlation, outcome });
        try {
          await this.#hooks?.run({ name: 'TurnEnd', ...correlation, outcome }, cancellation.signal);
        } catch {
          turnSpan.setAttribute('hook.turn_end_failed', true);
        }
        cancellation.dispose();
        turnSpan.setAttribute('duration_ms', performance.now() - startedAt);
        turnSpan.end();
      }
    });
  }
}
