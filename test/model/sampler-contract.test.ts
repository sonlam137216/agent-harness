import { describe, expect, expectTypeOf, it } from 'vitest';

import { createModelCallId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import type {
  ModelRequest,
  ModelResponse,
  SamplingOptions,
} from '../../src/model/sampling-types.js';

describe('Sampler contract', () => {
  it('propagates correlation, cancellation, and deadline inputs', async () => {
    const controller = new AbortController();
    const options: SamplingOptions = {
      signal: controller.signal,
      deadlineMs: Date.now() + 1_000,
    };
    const request: ModelRequest = {
      modelCallId: createModelCallId(),
      modelId: 'test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [],
    };
    let receivedOptions: SamplingOptions | undefined;
    const sampler: Sampler = {
      sample: (receivedRequest, received) => {
        receivedOptions = received;
        return Promise.resolve({
          modelCallId: receivedRequest.modelCallId,
          text: 'Hello',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
        });
      },
    };

    const response = await sampler.sample(request, options);

    expect(response.modelCallId).toBe(request.modelCallId);
    expect(receivedOptions?.signal).toBe(controller.signal);
    expect(receivedOptions?.deadlineMs).toBe(options.deadlineMs);
  });

  it('exposes only the provider-neutral request and response contract', () => {
    expectTypeOf<Sampler['sample']>().parameters.toEqualTypeOf<
      [request: ModelRequest, options?: SamplingOptions]
    >();
    expectTypeOf<Sampler['sample']>().returns.toEqualTypeOf<Promise<ModelResponse>>();
  });
});
