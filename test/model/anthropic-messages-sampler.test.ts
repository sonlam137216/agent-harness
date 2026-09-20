import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';

import { createModelCallId, createToolCallId } from '../../src/ids.js';
import { AnthropicMessagesSampler } from '../../src/model/providers/anthropic-messages-sampler.js';
import { SamplingError, type ModelRequest } from '../../src/model/sampling-types.js';
import { createTracing } from '../../src/observability/tracing.js';

const API_KEY = 'anthropic-secret-key';
type FetchTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    modelCallId: createModelCallId(),
    modelId: 'claude-sonnet-4-5',
    messages: [
      { role: 'system', content: 'Use tools.' },
      { role: 'user', content: 'Read package.json.' },
    ],
    tools: [
      {
        name: 'read_file',
        description: 'Read one workspace file.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
    ...overrides,
  };
}

function successResponse(overrides: Record<string, unknown> = {}, headers?: HeadersInit): Response {
  return Response.json(
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 4 },
      ...overrides,
    },
    headers === undefined ? undefined : { headers },
  );
}

describe('AnthropicMessagesSampler', () => {
  it('maps Context output limits and rejects invalid limits before transport', async () => {
    const fetch = vi.fn<FetchTransport>(() => Promise.resolve(successResponse()));
    const sampler = new AnthropicMessagesSampler({ apiKey: 'test-key', fetch });
    await sampler.sample(request({ maxOutputTokens: 123 }));
    const body = fetch.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new TypeError('Expected request body.');
    expect(JSON.parse(body)).toMatchObject({ max_tokens: 123 });
    for (const maxOutputTokens of [0, -1, 1.5, NaN, Infinity]) {
      await expect(sampler.sample(request({ maxOutputTokens }))).rejects.toMatchObject({
        code: 'invalid_request',
        retryable: false,
      });
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps the provider-neutral transcript and normalizes a final response', async () => {
    const toolCallId = createToolCallId();
    const modelRequest = request({
      messages: [
        { role: 'system', content: 'System rules' },
        { role: 'user', content: 'Read a file' },
        {
          role: 'assistant',
          content: 'I will inspect it.',
          toolCalls: [{ id: toolCallId, name: 'read_file', arguments: { path: 'package.json' } }],
        },
        { role: 'tool', toolCallId, content: '{"outcome":"success"}' },
      ],
    });
    const fetch = vi.fn<FetchTransport>(() => Promise.resolve(successResponse()));
    const sampler = new AnthropicMessagesSampler({ apiKey: API_KEY, fetch });

    const response = await sampler.sample(modelRequest);

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(new Headers(init?.headers).get('x-api-key')).toBe(API_KEY);
    expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
    if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON request body.');
    expect(JSON.parse(init.body)).toEqual({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: 'System rules',
      messages: [
        { role: 'user', content: 'Read a file' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will inspect it.' },
            {
              type: 'tool_use',
              id: toolCallId,
              name: 'read_file',
              input: { path: 'package.json' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: toolCallId, content: '{"outcome":"success"}' },
          ],
        },
      ],
      tools: [
        {
          name: 'read_file',
          description: 'Read one workspace file.',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    });
    expect(response).toEqual({
      modelCallId: modelRequest.modelCallId,
      text: 'Done.',
      toolCalls: [],
      usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 4 },
      stopReason: 'end_turn',
    });
  });

  it('normalizes tool use, stop reasons, retries, and cancellation', async () => {
    const fetch = vi
      .fn<FetchTransport>()
      .mockResolvedValueOnce(new Response(undefined, { status: 529 }))
      .mockResolvedValueOnce(
        successResponse({
          content: [
            {
              type: 'tool_use',
              id: 'toolu_123',
              name: 'read_file',
              input: { path: 'README.md' },
            },
          ],
          stop_reason: 'tool_use',
        }),
      );
    const retryDelay = vi.fn(() => Promise.resolve());
    const sampler = new AnthropicMessagesSampler({ apiKey: API_KEY, fetch, retryDelay });

    await expect(sampler.sample(request())).resolves.toEqual(
      expect.objectContaining({
        text: null,
        stopReason: 'tool_calls',
        toolCalls: [{ id: 'toolu_123', name: 'read_file', arguments: { path: 'README.md' } }],
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();

    const controller = new AbortController();
    controller.abort();
    await expect(sampler.sample(request(), { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
      retryable: false,
    });
  });

  it('sanitizes provider failures and adds safe tracing attributes', async () => {
    const failed = new AnthropicMessagesSampler({
      apiKey: API_KEY,
      fetch: () =>
        Promise.resolve(
          Response.json({ error: { message: `leaked ${API_KEY}` } }, { status: 401 }),
        ),
    });
    const error = await failed.sample(request()).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SamplingError);
    expect(error).toMatchObject({ code: 'authentication', retryable: false });
    expect(String(error)).not.toContain(API_KEY);

    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({ exporter });
    const sampler = new AnthropicMessagesSampler({
      apiKey: API_KEY,
      fetch: () =>
        Promise.resolve(successResponse({}, { 'request-id': 'request_public_correlation' })),
    });
    await tracing.tracer.startActiveSpan('model.sample', async (span) => {
      await sampler.sample(request());
      span.end();
    });
    await tracing.forceFlush();
    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual(
      expect.objectContaining({
        provider: 'anthropic',
        'provider.request_id': 'request_public_correlation',
        retry_count: 0,
      }),
    );
    await tracing.shutdown();
  });
});
