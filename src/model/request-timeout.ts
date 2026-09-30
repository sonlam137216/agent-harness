import type { Sampler } from './sampler.interface.js';
import { SamplingError, type SamplingOptions } from './sampling-types.js';

/** Upper bound for one `sample` call, including the adapter's own transport retries. */
export const DEFAULT_MODEL_TIMEOUT_MS = 600_000;

/**
 * Bounds every sample call so a stalled provider cannot hang a turn. A timeout is a
 * sampling failure (`unavailable`), not a user cancellation; parent cancellation and
 * deadlines keep their own meaning.
 */
export function withRequestTimeout(sampler: Sampler, timeoutMs: number): Sampler {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError('timeoutMs must be a positive safe integer.');
  return {
    sample: async (request, options: SamplingOptions = {}) => {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), timeoutMs);
      const signal =
        options.signal === undefined
          ? timeout.signal
          : AbortSignal.any([options.signal, timeout.signal]);
      try {
        return await sampler.sample(request, { ...options, signal });
      } catch (error) {
        if (timeout.signal.aborted && options.signal?.aborted !== true)
          throw new SamplingError(
            `The model request timed out after ${Math.round(timeoutMs / 1_000)} seconds.`,
            { code: 'unavailable', retryable: true, cause: new Error('Request timeout.') },
          );
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
