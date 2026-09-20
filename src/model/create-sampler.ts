import type { Sampler } from './sampler.interface.js';
import { AnthropicMessagesSampler } from './providers/anthropic-messages-sampler.js';
import { OllamaChatSampler } from './providers/ollama-chat-sampler.js';
import { OpenAIResponsesSampler } from './providers/openai-responses-sampler.js';

export const MODEL_PROVIDERS = ['openai', 'anthropic', 'ollama'] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export interface CreateSamplerOptions {
  readonly provider: ModelProvider;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export class SamplerConfigurationError extends Error {
  public override readonly name = 'SamplerConfigurationError';
}

function credential(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new SamplerConfigurationError(`Set ${name} to use this sampler.`);
  }
  return value;
}

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

/** Creates one provider adapter at the application composition root. */
export function createSampler(options: CreateSamplerOptions): Sampler {
  const environment = options.environment;
  switch (options.provider) {
    case 'openai':
      return new OpenAIResponsesSampler({
        apiKey: credential(environment, 'OPENAI_API_KEY'),
        ...(environment.OPENAI_BASE_URL === undefined
          ? {}
          : { baseUrl: environment.OPENAI_BASE_URL }),
      });
    case 'anthropic':
      return new AnthropicMessagesSampler({
        apiKey: credential(environment, 'ANTHROPIC_API_KEY'),
        ...(environment.ANTHROPIC_BASE_URL === undefined
          ? {}
          : { baseUrl: environment.ANTHROPIC_BASE_URL }),
      });
    case 'ollama':
      return new OllamaChatSampler({
        ...(environment.OLLAMA_BASE_URL === undefined
          ? {}
          : { baseUrl: environment.OLLAMA_BASE_URL }),
      });
  }
}
