import type { EventBus } from '../events/event-bus.js';
import type { HookRegistry } from '../hooks/hook-registry.js';
import { createCancellationScope, type CancellationScope } from '../cancellation.js';
import { SpanStatusCode } from '@opentelemetry/api';

import type { AgentDefinition } from '../agent/agent-definition.js';
import type { ContextBuilder } from '../context/context-builder.js';
import { createModelCallId, type TurnId } from '../ids.js';
import type { Sampler } from '../model/sampler.interface.js';
import {
  SamplingError,
  type ModelRequest,
  type ModelResponse,
  type ModelToolDefinition,
  type SamplingOptions,
} from '../model/sampling-types.js';
import type { TracingHandle } from '../observability/tracing.js';
import type { Session } from '../session/session.js';
import type { Turn, TurnEntry, TurnStatus } from '../session/turn.js';
import type { ToolBridge } from '../tools/tool-bridge.js';

const DEFAULT_MAX_ITERATIONS = 8;

export interface AgentLoopOptions {
  readonly sampler: Sampler;
  readonly contextBuilder: ContextBuilder;
  readonly toolBridge: ToolBridge;
  readonly tracer: TracingHandle['tracer'];
  readonly maxIterations?: number;
  readonly hooks?: HookRegistry;
  readonly events?: EventBus;
}

export interface AgentLoopRunInput {
  readonly agent: AgentDefinition;
  readonly session: Session;
  readonly onProgress?: (session: Session) => Promise<void>;
  readonly turnId: TurnId;
  readonly tools: readonly ModelToolDefinition[];
  readonly signal?: AbortSignal;
  /** Absolute Unix timestamp in milliseconds. */
  readonly deadlineMs?: number;
}

export type AgentLoopOutcome =
  'completed' | 'max_iterations' | 'cancelled' | 'deadline_exceeded' | 'failed';

export interface AgentLoopResult {
  readonly session: Session;
  readonly outcome: AgentLoopOutcome;
  readonly iterations: number;
  readonly finalText: string | null;
}

interface IterationResult {
  readonly session: Session;
  readonly outcome: 'continue' | 'completed' | 'failed';
  readonly finalText: string | null;
}

export class AgentLoopStateError extends Error {
  public override readonly name = 'AgentLoopStateError';
}

export class AgentLoopExecutionError extends Error {
  public override readonly name = 'AgentLoopExecutionError';

  public constructor(
    public readonly latestSession: Session,
    public readonly iterations: number,
    cause: unknown,
  ) {
    super('Agent loop execution failed.', { cause });
  }
}

function findTurn(session: Session, turnId: TurnId): Turn {
  const turn = session.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) throw new AgentLoopStateError('The target turn does not exist.');
  return turn;
}

function replaceTurn(session: Session, updatedTurn: Turn): Session {
  return {
    ...session,
    turns: session.turns.map((turn) => (turn.id === updatedTurn.id ? updatedTurn : turn)),
  };
}

function appendEntries(session: Session, turnId: TurnId, entries: readonly TurnEntry[]): Session {
  const turn = findTurn(session, turnId);
  return replaceTurn(session, { ...turn, entries: [...turn.entries, ...entries] });
}

function setTurnStatus(session: Session, turnId: TurnId, status: TurnStatus): Session {
  const turn = findTurn(session, turnId);
  return replaceTurn(session, { ...turn, status });
}

function isCancellationRequested(cancellation: CancellationScope): boolean {
  return cancellation.signal?.aborted === true;
}

export class AgentLoop {
  readonly #sampler: Sampler;
  readonly #contextBuilder: ContextBuilder;
  readonly #toolBridge: ToolBridge;
  readonly #tracer: TracingHandle['tracer'];
  readonly #maxIterations: number;
  readonly #hooks: HookRegistry | undefined;
  readonly #events: EventBus | undefined;

  public constructor(options: AgentLoopOptions) {
    if (!Number.isSafeInteger(options.maxIterations ?? DEFAULT_MAX_ITERATIONS)) {
      throw new RangeError('maxIterations must be a positive safe integer.');
    }
    if ((options.maxIterations ?? DEFAULT_MAX_ITERATIONS) <= 0) {
      throw new RangeError('maxIterations must be a positive safe integer.');
    }

    this.#hooks = options.hooks;
    this.#events = options.events;
    this.#sampler = options.sampler;
    this.#contextBuilder = options.contextBuilder;
    this.#toolBridge = options.toolBridge;
    this.#tracer = options.tracer;
    this.#maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  public async run(input: AgentLoopRunInput): Promise<AgentLoopResult> {
    const initialTurn = findTurn(input.session, input.turnId);
    if (initialTurn.status !== 'in_progress') {
      throw new AgentLoopStateError('AgentLoop requires an in-progress turn.');
    }

    const cancellation = createCancellationScope(input.signal, input.deadlineMs);
    let session = input.session;
    let iterations = 0;

    try {
      for (let iteration = 1; iteration <= this.#maxIterations; iteration += 1) {
        if (isCancellationRequested(cancellation)) {
          return this.#cancelledResult(session, input.turnId, iterations, cancellation);
        }

        iterations = iteration;
        const iterationResult = await this.#tracer.startActiveSpan(
          'agent.loop.iteration',
          async (span) => {
            const startedAt = performance.now();
            span.setAttributes({
              'session.id': session.id,
              'turn.id': input.turnId,
              'loop.iteration': iteration,
            });

            try {
              const modelCallId = createModelCallId();
              const context = await this.#contextBuilder.build({
                agent: input.agent,
                session,
                turnId: input.turnId,
                modelCallId,
                tools: input.tools,
                ...(cancellation.signal === undefined ? {} : { signal: cancellation.signal }),
                ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
              });
              if (context.session !== session) {
                session = context.session;
                await input.onProgress?.(session);
              }
              await this.#hooks?.run(
                {
                  name: 'BeforeModel',
                  sessionId: session.id,
                  turnId: input.turnId,
                  modelCallId,
                  request: context.request,
                },
                cancellation.signal,
              );
              cancellation.signal?.throwIfAborted();
              const response = await this.#sample(
                context.request,
                session.id,
                input.turnId,
                iteration,
                cancellation.signal,
                input.deadlineMs,
              );

              session = appendEntries(session, input.turnId, [
                {
                  kind: 'assistant_message',
                  modelCallId: response.modelCallId,
                  content: response.text,
                  toolCalls: response.toolCalls,
                },
              ]);

              session = {
                ...session,
                usage: [
                  ...(session.usage ?? []),
                  {
                    modelCallId,
                    turnId: input.turnId,
                    modelId: context.request.modelId,
                    purpose: 'response',
                    tokens: response.usage,
                    stopReason: response.stopReason,
                  },
                ],
              };
              await input.onProgress?.(session);
              await this.#hooks?.run(
                {
                  name: 'AfterModel',
                  sessionId: session.id,
                  turnId: input.turnId,
                  modelCallId,
                  response,
                },
                cancellation.signal,
              );
              cancellation.signal?.throwIfAborted();

              if (response.toolCalls.length === 0) {
                const completed = response.stopReason === 'end_turn' && response.text !== null;
                const outcome = completed ? 'completed' : 'failed';
                const finalText = completed ? response.text : null;
                span.setAttribute('loop.outcome', outcome);
                if (!completed) span.setStatus({ code: SpanStatusCode.ERROR });
                return {
                  session: setTurnStatus(session, input.turnId, outcome),
                  outcome,
                  finalText,
                } satisfies IterationResult;
              }

              if (response.stopReason !== 'tool_calls') {
                span.setAttribute('loop.outcome', 'failed');
                span.setStatus({ code: SpanStatusCode.ERROR });
                return {
                  session: setTurnStatus(session, input.turnId, 'failed'),
                  outcome: 'failed',
                  finalText: null,
                } satisfies IterationResult;
              }

              for (const toolCall of response.toolCalls) {
                const toolResult = await this.#toolBridge.execute(toolCall, {
                  sessionId: session.id,
                  turnId: input.turnId,
                  modelCallId,
                  ...(cancellation.signal === undefined ? {} : { signal: cancellation.signal }),
                });
                session = appendEntries(session, input.turnId, [
                  { kind: 'tool_result', ...toolResult },
                ]);
                await input.onProgress?.(session);
              }

              span.setAttribute('loop.outcome', 'continue');
              return {
                session,
                outcome: 'continue',
                finalText: null,
              } satisfies IterationResult;
            } catch (error) {
              span.setAttribute('loop.outcome', 'error');
              span.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            } finally {
              span.setAttribute('duration_ms', performance.now() - startedAt);
              span.end();
            }
          },
        );

        session = iterationResult.session;
        if (iterationResult.outcome === 'completed' || iterationResult.outcome === 'failed') {
          return {
            session,
            outcome: iterationResult.outcome,
            iterations,
            finalText: iterationResult.finalText,
          };
        }
        if (isCancellationRequested(cancellation)) {
          return this.#cancelledResult(session, input.turnId, iterations, cancellation);
        }
      }

      return {
        session: setTurnStatus(session, input.turnId, 'failed'),
        outcome: 'max_iterations',
        iterations,
        finalText: null,
      };
    } catch (error) {
      if (
        isCancellationRequested(cancellation) ||
        (error instanceof SamplingError &&
          (error.code === 'cancelled' || error.code === 'deadline_exceeded'))
      ) {
        const deadlineExceeded =
          cancellation.deadlineReached() ||
          (error instanceof SamplingError && error.code === 'deadline_exceeded');
        const cancelledSession = setTurnStatus(session, input.turnId, 'cancelled');
        return {
          session: cancelledSession,
          outcome: deadlineExceeded ? 'deadline_exceeded' : 'cancelled',
          iterations,
          finalText: null,
        };
      }

      throw new AgentLoopExecutionError(
        setTurnStatus(session, input.turnId, 'failed'),
        iterations,
        error,
      );
    } finally {
      cancellation.dispose();
    }
  }

  #cancelledResult(
    session: Session,
    turnId: TurnId,
    iterations: number,
    cancellation: CancellationScope,
  ): AgentLoopResult {
    return {
      session: setTurnStatus(session, turnId, 'cancelled'),
      outcome: cancellation.deadlineReached() ? 'deadline_exceeded' : 'cancelled',
      iterations,
      finalText: null,
    };
  }

  async #sample(
    request: ModelRequest,
    sessionId: Session['id'],
    turnId: TurnId,
    iteration: number,
    signal: AbortSignal | undefined,
    deadlineMs: number | undefined,
  ): Promise<ModelResponse> {
    const samplingOptions: SamplingOptions = {
      ...(signal === undefined ? {} : { signal }),
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    };

    return this.#tracer.startActiveSpan('model.sample', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({
        'session.id': sessionId,
        'turn.id': turnId,
        'model_call.id': request.modelCallId,
        'loop.iteration': iteration,
        model: request.modelId,
      });

      let success = false;
      try {
        await this.#events?.publish({
          type: 'ModelStarted',
          sessionId,
          turnId,
          modelCallId: request.modelCallId,
        });
        signal?.throwIfAborted();
        const response = await this.#sampler.sample(request, samplingOptions);
        if (response.modelCallId !== request.modelCallId) {
          throw new AgentLoopStateError('Sampler returned a mismatched model call correlation ID.');
        }
        success = true;
        span.setAttributes({
          success: true,
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
          stop_reason: response.stopReason,
        });
        if (response.usage.cachedInputTokens !== undefined) {
          span.setAttribute('cached_input_tokens', response.usage.cachedInputTokens);
        }
        if (response.usage.reasoningTokens !== undefined) {
          span.setAttribute('reasoning_tokens', response.usage.reasoningTokens);
        }
        return response;
      } catch (error) {
        span.setAttribute('success', false);
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (error instanceof SamplingError) {
          span.setAttributes({
            'error.type': error.code,
            'sampling.retryable': error.retryable,
          });
        }
        throw error;
      } finally {
        await this.#events?.publish({
          type: 'ModelCompleted',
          sessionId,
          turnId,
          modelCallId: request.modelCallId,
          success,
        });
        span.setAttribute('latency_ms', performance.now() - startedAt);
        span.end();
      }
    });
  }
}
