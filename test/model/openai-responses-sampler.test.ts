import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';

import { createModelCallId, createToolCallId } from '../../src/ids.js';
import { OpenAIResponsesSampler } from '../../src/model/providers/openai-responses-sampler.js';
import { SamplingError, type ModelRequest } from '../../src/model/sampling-types.js';
import { createTracing } from '../../src/observability/tracing.js';

const API_KEY = 'test-api-key-that-must-not-be-traced';
type FetchTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;
type RetryDelay = (delayMs: number, signal?: AbortSignal) => Promise<void>;

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    modelCallId: createModelCallId(),
    modelId: 'gpt-test',
    messages: [
      { role: 'system', content: 'Keep this system prompt private.' },
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
      id: 'resp_test',
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'Done.' }],
        },
      ],
      usage: {
        input_tokens: 20,
        output_tokens: 5,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
      ...overrides,
    },
    headers === undefined ? undefined : { headers },
  );
}

function errorResponse(
  status: number,
  code: string,
  message = 'provider details must stay private',
  headers?: HeadersInit,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, ...(headers === undefined ? {} : { headers }) },
  );
}

describe('OpenAIResponsesSampler', () => {
  it('maps provider-neutral messages and tools to a Responses request', async () => {
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
    const sampler = new OpenAIResponsesSampler({ apiKey: API_KEY, fetch });

    const response = await sampler.sample(modelRequest, { deadlineMs: Date.now() + 5_000 });

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${API_KEY}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (typeof init?.body !== 'string') throw new TypeError('Expected a JSON request body.');
    expect(JSON.parse(init.body)).toEqual({
      model: 'gpt-test',
      input: [
        { role: 'system', content: 'System rules' },
        { role: 'user', content: 'Read a file' },
        { role: 'assistant', content: 'I will inspect it.' },
        {
          type: 'function_call',
          call_id: toolCallId,
          name: 'read_file',
          arguments: '{"path":"package.json"}',
        },
        {
          type: 'function_call_output',
          call_id: toolCallId,
          output: '{"outcome":"success"}',
        },
      ],
      tools: [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read one workspace file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          strict: false,
        },
      ],
      store: false,
    });
    expect(response).toEqual({
      modelCallId: modelRequest.modelCallId,
      text: 'Done.',
      toolCalls: [],
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 4,
        reasoningTokens: 2,
      },
      stopReason: 'end_turn',
    });
  });

  it('normalizes function calls and preserves the harness model-call correlation ID', async () => {
    const modelRequest = request();
    const fetch = vi.fn<FetchTransport>(() =>
      Promise.resolve(
        successResponse({
          output: [
            {
              type: 'function_call',
              call_id: 'call_provider_123',
              name: 'read_file',
              arguments: '{"path":"README.md"}',
            },
          ],
        }),
      ),
    );
    const sampler = new OpenAIResponsesSampler({ apiKey: API_KEY, fetch });

    const response = await sampler.sample(modelRequest);

    expect(response).toEqual(
      expect.objectContaining({
        modelCallId: modelRequest.modelCallId,
        text: null,
        toolCalls: [
          {
            id: 'call_provider_123',
            name: 'read_file',
            arguments: { path: 'README.md' },
          },
        ],
        stopReason: 'tool_calls',
      }),
    );
  });

  it.each([
    ['max_output_tokens', 'max_output_tokens'],
    ['max_tokens', 'max_output_tokens'],
    ['content_filter', 'content_filtered'],
    ['other', 'unknown'],
  ] as const)('normalizes incomplete reason %s to %s', async (reason, expected) => {
    const fetch = vi.fn<FetchTransport>(() =>
      Promise.resolve(
        successResponse({
          status: 'incomplete',
          incomplete_details: { reason },
          output: [],
        }),
      ),
    );
    const sampler = new OpenAIResponsesSampler({ apiKey: API_KEY, fetch });

    await expect(sampler.sample(request())).resolves.toEqual(
      expect.objectContaining({ stopReason: expected }),
    );
  });

  it('retries transient provider failures inside the adapter and honors Retry-After', async () => {
    const responses = [
      errorResponse(429, 'rate_limit_exceeded', undefined, { 'retry-after': '0.01' }),
      errorResponse(503, 'server_error'),
      successResponse(),
    ];
    const fetch = vi.fn<FetchTransport>(() =>
      Promise.resolve(responses.shift() ?? successResponse()),
    );
    const retryDelay = vi.fn<RetryDelay>(() => Promise.resolve());
    const sampler = new OpenAIResponsesSampler({
      apiKey: API_KEY,
      fetch,
      retryDelay,
      retryBaseDelayMs: 25,
    });

    await expect(sampler.sample(request())).resolves.toEqual(
      expect.objectContaining({ text: 'Done.' }),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(retryDelay.mock.calls.map(([delayMs]) => delayMs)).toEqual([10, 50]);
  });

  it('does not retry authentication or exhausted-quota failures and sanitizes errors', async () => {
    const secretProviderMessage = `invalid ${API_KEY}`;
    const authenticationFetch = vi.fn<FetchTransport>(() =>
      Promise.resolve(errorResponse(401, 'invalid_api_key', secretProviderMessage)),
    );
    const quotaFetch = vi.fn<FetchTransport>(() =>
      Promise.resolve(errorResponse(429, 'insufficient_quota', secretProviderMessage)),
    );

    const authentication = new OpenAIResponsesSampler({
      apiKey: API_KEY,
      fetch: authenticationFetch,
    });
    const quota = new OpenAIResponsesSampler({ apiKey: API_KEY, fetch: quotaFetch });

    const authenticationError = await authentication
      .sample(request())
      .catch((error: unknown) => error);
    expect(authenticationError).toMatchObject({
      code: 'authentication',
      retryable: false,
    });
    await expect(quota.sample(request())).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: false,
    });
    expect(authenticationFetch).toHaveBeenCalledOnce();
    expect(quotaFetch).toHaveBeenCalledOnce();
    expect(authenticationError).toBeInstanceOf(SamplingError);
    expect(String(authenticationError)).not.toContain(API_KEY);
    expect(String((authenticationError as SamplingError).cause)).not.toContain(API_KEY);
    expect(String(authenticationError)).not.toContain(secretProviderMessage);
  });

  it('retries transport unavailability but rejects malformed provider output intentionally', async () => {
    const responses: Array<Response | TypeError> = [
      new TypeError('socket exposed provider details'),
      successResponse({
        output: [
          {
            type: 'function_call',
            call_id: 'call_bad',
            name: 'read_file',
            arguments: 'not-json',
          },
        ],
      }),
    ];
    const fetch = vi.fn<FetchTransport>(() => {
      const next = responses.shift();
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? successResponse());
    });
    const sampler = new OpenAIResponsesSampler({
      apiKey: API_KEY,
      fetch,
      retryDelay: () => Promise.resolve(),
    });

    await expect(sampler.sample(request())).rejects.toMatchObject({
      code: 'provider_error',
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('propagates cancellation and deadlines without starting provider transport', async () => {
    const fetch = vi.fn<FetchTransport>(() => Promise.resolve(successResponse()));
    const sampler = new OpenAIResponsesSampler({ apiKey: API_KEY, fetch });
    const controller = new AbortController();
    controller.abort();

    await expect(sampler.sample(request(), { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
      retryable: false,
    });
    await expect(sampler.sample(request(), { deadlineMs: Date.now() - 1 })).rejects.toMatchObject({
      code: 'deadline_exceeded',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('adds safe provider attributes to the active model.sample span', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({ exporter });
    const responses = [
      errorResponse(503, 'server_error'),
      successResponse({}, { 'x-request-id': 'request_public_correlation' }),
    ];
    const fetch = vi.fn<FetchTransport>(() =>
      Promise.resolve(responses.shift() ?? successResponse()),
    );
    const sampler = new OpenAIResponsesSampler({
      apiKey: API_KEY,
      fetch,
      retryDelay: () => Promise.resolve(),
    });

    await tracing.tracer.startActiveSpan('model.sample', async (span) => {
      await sampler.sample(request());
      span.end();
    });
    await tracing.forceFlush();

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes).toEqual(
      expect.objectContaining({
        provider: 'openai',
        'provider.request_id': 'request_public_correlation',
        retry_count: 1,
      }),
    );
    expect(JSON.stringify(span?.attributes)).not.toContain(API_KEY);
    expect(JSON.stringify(span?.attributes)).not.toContain('Keep this system prompt private.');

    await tracing.shutdown();
  });
});
