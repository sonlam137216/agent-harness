import { waitForCallback } from '../cancellation.js';
import {
  createSubagentId,
  type SessionId,
  type SubagentId,
  type ToolCallId,
  type TurnId,
} from '../ids.js';
import type { SubagentRole } from './subagent-definition.js';
import type { SubagentHandoff, SubagentRunner } from './subagent-runner.js';

export const DEFAULT_MAX_SUBAGENTS_PER_RUN = 8;
export const DEFAULT_MAX_CONCURRENT_SUBAGENTS = 4;

export type SubagentErrorCode = 'subagent_limit' | 'subagent_busy' | 'unknown_subagent' | 'closed';

export class SubagentError extends Error {
  public override readonly name = 'SubagentError';
  public constructor(
    public readonly code: SubagentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SubagentStartRequest {
  readonly role: SubagentRole;
  readonly task: string;
  readonly parent: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly toolCallId: ToolCallId;
  };
  readonly signal?: AbortSignal;
}

export interface SubagentManagerOptions {
  readonly runner: SubagentRunner;
  /** Cancels every child, including background children, e.g. the CLI's run signal. */
  readonly signal?: AbortSignal;
  readonly maxPerRun?: number;
  readonly maxConcurrent?: number;
}

interface BackgroundRun {
  readonly parentSessionId: SessionId;
  readonly controller: AbortController;
  readonly result: Promise<SubagentHandoff>;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new RangeError(`${name} must be a positive safe integer.`);
  return value;
}

/**
 * Owns the children of one parent run: spawn limits, background handles, cancellation and
 * cleanup. Children never receive a manager, so delegation depth stays at 1.
 */
export class SubagentManager {
  readonly #runner: SubagentRunner;
  readonly #maxPerRun: number;
  readonly #maxConcurrent: number;
  readonly #closed = new AbortController();
  readonly #background = new Map<SubagentId, BackgroundRun>();
  readonly #unlinkSignal: () => void;
  #started = 0;
  #active = 0;

  public constructor(options: SubagentManagerOptions) {
    this.#runner = options.runner;
    this.#maxPerRun = positive(options.maxPerRun ?? DEFAULT_MAX_SUBAGENTS_PER_RUN, 'maxPerRun');
    this.#maxConcurrent = positive(
      options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_SUBAGENTS,
      'maxConcurrent',
    );
    const signal = options.signal;
    const close = (): void => this.#closed.abort(signal?.reason);
    if (signal?.aborted === true) close();
    else signal?.addEventListener('abort', close, { once: true });
    this.#unlinkSignal = () => signal?.removeEventListener('abort', close);
  }

  /** Runs a child to completion; the caller's signal and manager closure both cancel it. */
  public async run(request: SubagentStartRequest): Promise<SubagentHandoff> {
    const subagentId = this.#reserve();
    const signal = AbortSignal.any(
      request.signal === undefined ? [this.#closed.signal] : [this.#closed.signal, request.signal],
    );
    try {
      return await this.#runner.run({ ...request, subagentId, background: false, signal });
    } finally {
      this.#active -= 1;
    }
  }

  /** Starts a child that outlives the delegating tool call; only closure or cancel stop it. */
  public start(request: SubagentStartRequest): SubagentId {
    const subagentId = this.#reserve();
    const controller = new AbortController();
    const signal = AbortSignal.any([this.#closed.signal, controller.signal]);
    const { role, task, parent } = request;
    const result = this.#runner
      .run({ role, task, parent, subagentId, background: true, signal })
      .finally(() => {
        this.#active -= 1;
      });
    // The runner reports child failure as data; an unexpected rejection surfaces on wait.
    result.catch(() => undefined);
    this.#background.set(subagentId, {
      parentSessionId: request.parent.sessionId,
      controller,
      result,
    });
    return subagentId;
  }

  /** Waits for a background child. Abandoning the wait does not cancel the child. */
  public async wait(
    subagentId: SubagentId,
    parentSessionId: SessionId,
    signal?: AbortSignal,
  ): Promise<SubagentHandoff> {
    const run = this.#find(subagentId, parentSessionId);
    return waitForCallback(() => run.result, signal);
  }

  public async cancel(
    subagentId: SubagentId,
    parentSessionId: SessionId,
  ): Promise<SubagentHandoff> {
    const run = this.#find(subagentId, parentSessionId);
    run.controller.abort();
    return run.result;
  }

  /** Cancels unfinished children and waits for them to persist their final state. */
  public async close(): Promise<void> {
    this.#closed.abort();
    this.#unlinkSignal();
    await Promise.allSettled([...this.#background.values()].map((run) => run.result));
  }

  #reserve(): SubagentId {
    if (this.#closed.signal.aborted)
      throw new SubagentError('closed', 'Subagents are no longer available in this run.');
    if (this.#started >= this.#maxPerRun)
      throw new SubagentError(
        'subagent_limit',
        `At most ${this.#maxPerRun} subagents can be started per run.`,
      );
    if (this.#active >= this.#maxConcurrent)
      throw new SubagentError(
        'subagent_busy',
        `At most ${this.#maxConcurrent} subagents can run at once; await one first.`,
      );
    this.#started += 1;
    this.#active += 1;
    return createSubagentId();
  }

  #find(subagentId: SubagentId, parentSessionId: SessionId): BackgroundRun {
    const run = this.#background.get(subagentId);
    if (run === undefined || run.parentSessionId !== parentSessionId)
      throw new SubagentError('unknown_subagent', 'No background subagent has this ID.');
    return run;
  }
}
