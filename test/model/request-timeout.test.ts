import { describe, expect, it } from 'vitest';

import { createModelCallId } from '../../src/ids.js';
import { withRequestTimeout } from '../../src/model/request-timeout.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import { SamplingError, type ModelRequest } from '../../src/model/sampling-types.js';

const request: ModelRequest = {
  modelCallId: createModelCallId(),
  modelId: 'fake',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
};

/** Never answers; rejects like a real adapter once its signal aborts. */
const stalled: Sampler = {
  sample: (_request, options) =>
    new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () =>
        reject(new SamplingError('cancelled', { code: 'cancelled', retryable: false })),
      );
    }),
};

describe('withRequestTimeout', () => {
  it('turns a stalled call into a retryable unavailable failure', async () => {
    await expect(withRequestTimeout(stalled, 20).sample(request)).rejects.toMatchObject({
      name: 'SamplingError',
      code: 'unavailable',
      retryable: true,
      message: 'The model request timed out after 0 seconds.',
    });
  });

  it('keeps a user cancellation as a cancellation', async () => {
    const controller = new AbortController();
    const pending = withRequestTimeout(stalled, 60_000).sample(request, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('passes fast responses through unchanged', async () => {
    const response = {
      modelCallId: request.modelCallId,
      text: 'ok',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: 'end_turn' as const,
    };
    const sampler: Sampler = { sample: () => Promise.resolve(response) };
    await expect(withRequestTimeout(sampler, 1_000).sample(request)).resolves.toBe(response);
    expect(() => withRequestTimeout(sampler, 0)).toThrow(RangeError);
  });
});
