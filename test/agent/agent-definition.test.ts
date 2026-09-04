import { describe, expect, expectTypeOf, it } from 'vitest';

import type { AgentDefinition, AgentModelConfiguration } from '../../src/agent/agent-definition.js';

describe('AgentDefinition', () => {
  it('describes only provider-neutral agent configuration', () => {
    const definition = {
      name: 'coding-agent',
      systemPrompt: 'You are a coding agent.',
      model: {
        modelId: 'test-model',
      },
    } satisfies AgentDefinition;

    expect(definition).toEqual({
      name: 'coding-agent',
      systemPrompt: 'You are a coding agent.',
      model: {
        modelId: 'test-model',
      },
    });
  });

  it('keeps the model configuration minimal and provider-neutral', () => {
    expectTypeOf<AgentModelConfiguration>().toEqualTypeOf<{
      readonly modelId: string;
    }>();
    expectTypeOf<AgentDefinition>().toEqualTypeOf<{
      readonly name: string;
      readonly systemPrompt: string;
      readonly model: AgentModelConfiguration;
    }>();
  });
});
