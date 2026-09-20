import { describe, expect, it } from 'vitest';

import { createSampler, SamplerConfigurationError } from '../../src/model/create-sampler.js';
import { AnthropicMessagesSampler } from '../../src/model/providers/anthropic-messages-sampler.js';
import { OllamaChatSampler } from '../../src/model/providers/ollama-chat-sampler.js';
import { OpenAIResponsesSampler } from '../../src/model/providers/openai-responses-sampler.js';

describe('createSampler', () => {
  it('creates each supported provider adapter at the composition boundary', () => {
    expect(
      createSampler({ provider: 'openai', environment: { OPENAI_API_KEY: 'openai-key' } }),
    ).toBeInstanceOf(OpenAIResponsesSampler);
    expect(
      createSampler({
        provider: 'anthropic',
        environment: { ANTHROPIC_API_KEY: 'anthropic-key' },
      }),
    ).toBeInstanceOf(AnthropicMessagesSampler);
    expect(createSampler({ provider: 'ollama', environment: {} })).toBeInstanceOf(
      OllamaChatSampler,
    );
  });

  it('requires credentials only for hosted providers', () => {
    expect(() => createSampler({ provider: 'openai', environment: {} })).toThrow(
      SamplerConfigurationError,
    );
    expect(() => createSampler({ provider: 'anthropic', environment: {} })).toThrow(
      SamplerConfigurationError,
    );
    expect(() => createSampler({ provider: 'ollama', environment: {} })).not.toThrow();
  });
});
