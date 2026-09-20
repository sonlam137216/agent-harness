import { SpanStatusCode } from '@opentelemetry/api';

import type { AgentDefinition } from '../agent/agent-definition.js';
import { createSessionId, createTurnId, type SessionId, type TurnId } from '../ids.js';
import type { ModelToolDefinition } from '../model/sampling-types.js';
import type { TracingHandle } from '../observability/tracing.js';
import type { SessionStore } from '../session/session-store.js';
import type { Session } from '../session/session.js';
import type { TurnStatus } from '../session/turn.js';
import { AgentLoopExecutionError, type AgentLoop, type AgentLoopResult } from './agent-loop.js';

export interface SessionRuntimeOptions {
  readonly sessionStore: SessionStore;
  readonly agentLoop: AgentLoop;
  readonly tracer: TracingHandle['tracer'];
}

export interface SessionRuntimeRunInput {
  readonly agent: AgentDefinition;
  readonly prompt: string;
  readonly tools: readonly ModelToolDefinition[];
  /** Omit to create a new session; provide an existing ID to continue it. */
  readonly sessionId?: SessionId;
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

function appendUserTurn(session: Session, turnId: TurnId, prompt: string): Session {
  return {
    ...session,
    turns: [
      ...session.turns,
      {
        id: turnId,
        status: 'in_progress',
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

  public constructor(options: SessionRuntimeOptions) {
    this.#sessionStore = options.sessionStore;
    this.#agentLoop = options.agentLoop;
    this.#tracer = options.tracer;
  }

  public async run(input: SessionRuntimeRunInput): Promise<SessionRuntimeResult> {
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
        const session = await this.#loadOrCreateSession(sessionId, input.sessionId !== undefined);
        const turnId = createTurnId();
        const turnIndex = session.turns.length;
        const activeSession = appendUserTurn(session, turnId, input.prompt);
        const result = await this.#runTurn(input, activeSession, turnId, turnIndex);

        sessionSpan.setAttributes({
          'session.outcome': result.outcome,
          success: result.outcome === 'completed',
        });
        if (result.outcome !== 'completed') {
          sessionSpan.setStatus({ code: SpanStatusCode.ERROR });
        }
        return result;
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

      try {
        await this.#sessionStore.save(activeSession);

        let loopResult: AgentLoopResult;
        try {
          loopResult = await this.#agentLoop.run({
            agent: input.agent,
            session: activeSession,
            turnId,
            tools: input.tools,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
            ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
          });
        } catch (error) {
          if (error instanceof AgentLoopExecutionError) {
            await this.#sessionStore.save(error.latestSession);
            turnSpan.setAttribute('loop.iterations', error.iterations);
            throw error.cause;
          }

          await this.#sessionStore.save(setTurnStatus(activeSession, turnId, 'failed'));
          throw error;
        }

        await this.#sessionStore.save(loopResult.session);
        turnSpan.setAttributes({
          'loop.iterations': loopResult.iterations,
          'turn.outcome': loopResult.outcome,
          success: loopResult.outcome === 'completed',
        });
        if (loopResult.outcome !== 'completed') {
          turnSpan.setStatus({ code: SpanStatusCode.ERROR });
        }
        return { ...loopResult, turnId };
      } catch (error) {
        turnSpan.setAttributes({ 'turn.outcome': 'error', success: false });
        turnSpan.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        turnSpan.setAttribute('duration_ms', performance.now() - startedAt);
        turnSpan.end();
      }
    });
  }
}
