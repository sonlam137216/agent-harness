import { SamplingError } from '../sampling-types.js';

export type FetchTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type RetryDelay = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export interface CancellationScope {
  readonly signal?: AbortSignal;
  readonly deadlineReached: () => boolean;
  readonly dispose: () => void;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

export function requireNonNegativeFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
}

export function createCancellationScope(
  signal: AbortSignal | undefined,
  deadlineMs: number | undefined,
): CancellationScope {
  if (deadlineMs !== undefined && !Number.isFinite(deadlineMs)) {
    throw new RangeError('deadlineMs must be a finite absolute timestamp.');
  }

  if (signal === undefined && deadlineMs === undefined) {
    return { deadlineReached: () => false, dispose: () => undefined };
  }

  const controller = new AbortController();
  let deadlineReached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = (): void => controller.abort(signal?.reason);

  if (deadlineMs !== undefined && deadlineMs <= Date.now()) {
    deadlineReached = true;
    controller.abort();
  } else if (signal?.aborted === true) {
    abortFromParent();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
    if (deadlineMs !== undefined) {
      timer = setTimeout(() => {
        deadlineReached = true;
        controller.abort();
      }, deadlineMs - Date.now());
    }
  }

  return {
    signal: controller.signal,
    deadlineReached: () => deadlineReached,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromParent);
    },
  };
}

export function cancellationError(cancellation: CancellationScope): SamplingError {
  if (cancellation.deadlineReached()) {
    return new SamplingError('The model request deadline was exceeded.', {
      code: 'deadline_exceeded',
      retryable: false,
    });
  }

  return new SamplingError('The model request was cancelled.', {
    code: 'cancelled',
    retryable: false,
  });
}

export function throwIfCancelled(cancellation: CancellationScope): void {
  if (cancellation.signal?.aborted === true) throw cancellationError(cancellation);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function transportFailure(
  provider: string,
  error: unknown,
  cancellation: CancellationScope,
): SamplingError {
  if (cancellation.signal?.aborted === true || isAbortError(error)) {
    return cancellationError(cancellation);
  }

  if (error instanceof TypeError) {
    return new SamplingError(`The ${provider} transport is unavailable.`, {
      code: 'unavailable',
      retryable: true,
      cause: new Error('The provider transport failed.'),
    });
  }

  return new SamplingError(`The ${provider} transport failed.`, {
    code: 'provider_error',
    retryable: false,
    cause: new Error('The provider transport threw an unexpected error.'),
  });
}

export function readRetryAfterMs(
  value: string | null,
  maxRetryDelayMs: number,
): number | undefined {
  if (value === null) return undefined;

  const seconds = Number(value);
  const delayMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(delayMs)) return undefined;
  return Math.min(Math.max(0, delayMs), maxRetryDelayMs);
}

export function retryDelayMs(
  retryCount: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs?: number,
): number {
  return retryAfterMs ?? Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs);
}

export function defaultRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
