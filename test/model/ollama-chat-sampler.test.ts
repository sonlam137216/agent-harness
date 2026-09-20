import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';

import { createModelCallId, createToolCallId } from '../../src/ids.js';
import { OllamaChatSampler } from '../../src/model/providers/ollama-chat-sampler.js';
import { SamplingError, type ModelRequest } from '../../src/model/sampling-types.js';
import { createTracing } from '../../src/observability/tracing.js';

type FetchTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    modelCallId: createModelCallId(),
    modelId: 'qwen3:1.7b',
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

function successResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    model: 'qwen3:1.7b',
    message: { role: 'assistant', content: 'Done.' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 20,
    eval_count: 5,
    ...overrides,
  });
}

describe('OllamaChatSampler', () => {
  it('maps Context output limits and rejects invalid limits before transport', async () => {
    const fetch = vi.fn<FetchTransport>(() => Promise.resolve(successResponse()));
    const sampler = new OllamaChatSampler({ fetch });
    await sampler.sample(request({ maxOutputTokens: 123 }));
    const body = fetch.mock.calls[0]?.[1]?.body;
    if (typeof body !== 'string') throw new TypeError('Expected request body.');
    expect(JSON.parse(body)).toMatchObject({ options: { num_predict: 123 } });
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
          content: null,
          toolCalls: [{ id: toolCallId, name: 'read_file', arguments: { path: 'package.json' } }],
        },
        { role: 'tool', toolCallId, content: '{"outcome":"success"}' },
      ],
    });
    const fetch = vi.fn<FetchTransport>(() => Promise.resolve(successResponse()));
    const sampler = new OllamaChatSampler({ fetch });

    const response = await sampler.sample(modelRequest);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON request body.');
    expect(JSON.parse(init.body)).toEqual({
      model: 'qwen3:1.7b',
      messages: [
        { role: 'system', content: 'System rules' },
        { role: 'user', content: 'Read a file' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: toolCallId,
              function: { name: 'read_file', arguments: { path: 'package.json' } },
            },
          ],
        },
        { role: 'tool', content: '{"outcome":"success"}', tool_name: 'read_file' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read one workspace file.',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        },
      ],
      stream: false,
    });
    expect(response).toEqual({
      modelCallId: modelRequest.modelCallId,
      text: 'Done.',
      toolCalls: [],
      usage: { inputTokens: 20, outputTokens: 5 },
      stopReason: 'end_turn',
    });
  });

  it('normalizes object and JSON-string tool arguments', async () => {
    const responses = [
      successResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'call_one', function: { name: 'read_file', arguments: { path: 'one.txt' } } },
            { function: { name: 'read_file', arguments: '{"path":"two.txt"}' } },
          ],
        },
      }),
    ];
    const sampler = new OllamaChatSampler({
      fetch: () => Promise.resolve(responses.shift() ?? successResponse()),
    });

    const response = await sampler.sample(request());

    expect(response.stopReason).toBe('tool_calls');
    expect(response.toolCalls[0]).toEqual({
      id: 'call_one',
      name: 'read_file',
      arguments: { path: 'one.txt' },
    });
    expect(response.toolCalls[1]).toEqual(
      expect.objectContaining({ name: 'read_file', arguments: { path: 'two.txt' } }),
    );
    expect(response.toolCalls[1]?.id).toEqual(expect.any(String));
  });

  it('retries transient failures, rejects malformed output, and propagates cancellation', async () => {
    const fetch = vi
      .fn<FetchTransport>()
      .mockResolvedValueOnce(new Response(undefined, { status: 503 }))
      .mockResolvedValueOnce(successResponse());
    const retryDelay = vi.fn(() => Promise.resolve());
    const sampler = new OllamaChatSampler({ fetch, retryDelay });
    await expect(sampler.sample(request())).resolves.toMatchObject({ text: 'Done.' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(retryDelay).toHaveBeenCalledOnce();

    const malformed = new OllamaChatSampler({
      fetch: () => Promise.resolve(successResponse({ prompt_eval_count: undefined })),
    });
    await expect(malformed.sample(request())).rejects.toBeInstanceOf(SamplingError);

    const controller = new AbortController();
    controller.abort();
    await expect(sampler.sample(request(), { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
      retryable: false,
    });
  });

  it('adds safe Ollama attributes to the active model span', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({ exporter });
    const sampler = new OllamaChatSampler({ fetch: () => Promise.resolve(successResponse()) });

    await tracing.tracer.startActiveSpan('model.sample', async (span) => {
      await sampler.sample(request());
      span.end();
    });
    await tracing.forceFlush();

    expect(exporter.getFinishedSpans()[0]?.attributes).toEqual(
      expect.objectContaining({ provider: 'ollama', retry_count: 0 }),
    );
    await tracing.shutdown();
  });
});
