import { describe, expect, expectTypeOf, it } from 'vitest';

import { createModelCallId, createToolCallId } from '../../src/ids.js';
import type { JsonObject } from '../../src/json.js';
import {
  SamplingError,
  type ModelMessage,
  type ModelMessageRole,
  type ModelRequest,
  type ModelResponse,
  type ModelToolDefinition,
  type StopReason,
  type TokenUsage,
} from '../../src/model/sampling-types.js';

describe('shared sampling types', () => {
  it('represents the complete provider-neutral Phase 1 exchange', () => {
    const modelCallId = createModelCallId();
    const toolCallId = createToolCallId();
    const tool: ModelToolDefinition = {
      name: 'read_file',
      description: 'Read a UTF-8 text file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    };
    const messages: readonly ModelMessage[] = [
      { role: 'system', content: 'You are a coding agent.' },
      { role: 'user', content: 'Read package.json.' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: toolCallId, name: 'read_file', arguments: { path: 'package.json' } }],
      },
      {
        role: 'tool',
        toolCallId,
        content: '{"name":"agent-harness"}',
      },
    ];
    const request: ModelRequest = {
      modelCallId,
      modelId: 'test-model',
      messages,
      tools: [tool],
    };
    const response: ModelResponse = {
      modelCallId,
      text: 'The package is named agent-harness.',
      toolCalls: [],
      usage: {
        inputTokens: 24,
        outputTokens: 8,
        cachedInputTokens: 4,
      },
      stopReason: 'end_turn',
    };

    expect(request.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ]);
    expect(response.modelCallId).toBe(request.modelCallId);
  });

  it('keeps core unions and payloads provider-neutral', () => {
    expectTypeOf<ModelMessageRole>().toEqualTypeOf<'system' | 'user' | 'assistant' | 'tool'>();
    expectTypeOf<StopReason>().toEqualTypeOf<
      'end_turn' | 'tool_calls' | 'max_output_tokens' | 'content_filtered' | 'unknown'
    >();
    expectTypeOf<ModelToolDefinition['inputSchema']>().toEqualTypeOf<JsonObject>();
    expectTypeOf<TokenUsage>().toMatchTypeOf<{
      readonly inputTokens: number;
      readonly outputTokens: number;
    }>();
  });

  it('normalizes exhausted adapter failures without provider SDK types', () => {
    const cause = new Error('sanitized transport failure');
    const error = new SamplingError('Model sampling failed.', {
      code: 'unavailable',
      retryable: true,
      cause,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('SamplingError');
    expect(error.code).toBe('unavailable');
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });
});
