import {
  SamplingError,
  type ModelMessage,
  type ModelToolDefinition,
} from '../model/sampling-types.js';

export interface TokenCounter {
  readonly name: string;
  readonly count: (text: string) => number;
}

/** Deliberately conservative and provider-independent, not a tokenizer or a usage measurement. */
export const utf8TokenEstimate: TokenCounter = {
  name: 'utf8-bytes-estimate',
  count: (text) => new TextEncoder().encode(text).length,
};

export interface ContextBudget {
  readonly windowTokens: number;
  readonly outputReserveTokens: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  windowTokens: 32_768,
  outputReserveTokens: 4_096,
};

export class ContextError extends Error {
  public override readonly name = 'ContextError';

  public constructor(
    public readonly code:
      'invalid_state' | 'budget_exceeded' | 'source_failed' | 'compaction_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function positiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
}

export function validateBudget(budget: ContextBudget): void {
  positiveInteger('windowTokens', budget.windowTokens);
  positiveInteger('outputReserveTokens', budget.outputReserveTokens);
  if (budget.outputReserveTokens >= budget.windowTokens) {
    throw new RangeError('outputReserveTokens must be smaller than windowTokens.');
  }
}

export function countTokens(counter: TokenCounter, text: string): number {
  const value = counter.count(text);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('TokenCounter must return a non-negative safe integer.');
  }
  return value;
}

export function contributionTokens(
  counter: TokenCounter,
  messages: readonly ModelMessage[],
  tools: readonly ModelToolDefinition[],
): number {
  return [...messages, ...tools].reduce(
    (total, item) => total + countTokens(counter, JSON.stringify(item)) + 8,
    0,
  );
}

export const REQUEST_FRAMING_TOKENS = 32;

export function checkContextCancellation(input: {
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}): void {
  if (input.deadlineMs !== undefined && Date.now() >= input.deadlineMs) {
    throw new SamplingError('Context deadline exceeded.', {
      code: 'deadline_exceeded',
      retryable: false,
    });
  }
  if (input.signal?.aborted === true) {
    throw new SamplingError('Context build was cancelled.', {
      code: 'cancelled',
      retryable: false,
    });
  }
}
