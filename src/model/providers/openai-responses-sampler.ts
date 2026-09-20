import { trace } from '@opentelemetry/api';

import type { ToolCallId } from '../../ids.js';
import type { JsonObject } from '../../json.js';
import type { Sampler } from '../sampler.interface.js';
import {
  SamplingError,
  validateOutputTokenLimit,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type SamplingOptions,
  type StopReason,
  type TokenUsage,
} from '../sampling-types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

type FetchTransport = (input: string | URL, init?: RequestInit) => Promise<Response>;
type RetryDelay = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export interface OpenAIResponsesSamplerOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Number of retries after the initial request. */
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  /** Injectable provider transport for focused adapter tests. */
  readonly fetch?: FetchTransport;
  /** Injectable wait boundary for retry tests. */
  readonly retryDelay?: RetryDelay;
}

interface OpenAIInputMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

interface OpenAIFunctionCallInput {
  readonly type: 'function_call';
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
}

interface OpenAIFunctionOutputInput {
  readonly type: 'function_call_output';
  readonly call_id: string;
  readonly output: string;
}

type OpenAIInputItem = OpenAIInputMessage | OpenAIFunctionCallInput | OpenAIFunctionOutputInput;

interface OpenAIToolDefinition {
  readonly type: 'function';
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  readonly strict: false;
}

interface OpenAIResponsesRequest {
  readonly max_output_tokens?: number;
  readonly model: string;
  readonly input: readonly OpenAIInputItem[];
  readonly tools: readonly OpenAIToolDefinition[];
  readonly store: false;
}

interface CancellationScope {
  readonly signal?: AbortSignal;
  readonly deadlineReached: () => boolean;
  readonly dispose: () => void;
}

interface ProviderFailure {
  readonly error: SamplingError;
  readonly retryAfterMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function requireNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function requireNonNegativeFiniteNumber(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
}

function createCancellationScope(options: SamplingOptions | undefined): CancellationScope {
  const deadlineMs = options?.deadlineMs;
  if (deadlineMs !== undefined && !Number.isFinite(deadlineMs)) {
    throw new RangeError('deadlineMs must be a finite absolute timestamp.');
  }

  if (options?.signal === undefined && deadlineMs === undefined) {
    return { deadlineReached: () => false, dispose: () => undefined };
  }

  const controller = new AbortController();
  let deadlineReached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abortFromParent = (): void => controller.abort(options?.signal?.reason);

  if (deadlineMs !== undefined && deadlineMs <= Date.now()) {
    deadlineReached = true;
    controller.abort();
  } else if (options?.signal?.aborted === true) {
    abortFromParent();
  } else {
    options?.signal?.addEventListener('abort', abortFromParent, { once: true });
    if (deadlineMs !== undefined) {
      timer = setTimeout(() => {
        deadlineReached = true;
        controller.abort();
      }, deadlineMs - Date.now());
    }
  }

  return {
    signal: controller.signal,
    deadlineReached: () => deadlineReached,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      options?.signal?.removeEventListener('abort', abortFromParent);
    },
  };
}

function cancellationError(cancellation: CancellationScope): SamplingError {
  if (cancellation.deadlineReached()) {
    return new SamplingError('The model request deadline was exceeded.', {
      code: 'deadline_exceeded',
      retryable: false,
    });
  }

  return new SamplingError('The model request was cancelled.', {
    code: 'cancelled',
    retryable: false,
  });
}

function throwIfCancelled(cancellation: CancellationScope): void {
  if (cancellation.signal?.aborted === true) throw cancellationError(cancellation);
}

function mapMessage(message: ModelMessage): readonly OpenAIInputItem[] {
  switch (message.role) {
    case 'system':
    case 'user':
      return [{ role: message.role, content: message.content }];
    case 'assistant': {
      const items: OpenAIInputItem[] = [];
      if (message.content !== null) {
        items.push({ role: 'assistant', content: message.content });
      }
      for (const toolCall of message.toolCalls) {
        items.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        });
      }
      return items;
    }
    case 'tool':
      return [
        {
          type: 'function_call_output',
          call_id: message.toolCallId,
          output: message.content,
        },
      ];
  }
}

function mapRequest(request: ModelRequest): OpenAIResponsesRequest {
  return {
    model: request.modelId,
    input: request.messages.flatMap(mapMessage),
    tools: request.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      // The harness permits optional schema properties. Strict mode would require
      // rewriting that provider-neutral schema, so Phase 1 leaves it disabled.
      strict: false,
    })),
    // Session state is owned by the harness rather than provider-side storage.
    store: false,
    ...(request.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: request.maxOutputTokens }),
  };
}

function serializeRequest(request: ModelRequest): string {
  try {
    return JSON.stringify(mapRequest(request));
  } catch {
    throw new SamplingError('The model request could not be encoded for OpenAI.', {
      code: 'invalid_request',
      retryable: false,
      cause: new Error('The provider request was not JSON serializable.'),
    });
  }
}

function readUsage(payload: Record<string, unknown>): TokenUsage {
  const usage = payload.usage;
  if (!isRecord(usage) || !isNonNegativeNumber(usage.input_tokens)) {
    throw invalidProviderResponse('The provider response omitted input token usage.');
  }
  if (!isNonNegativeNumber(usage.output_tokens)) {
    throw invalidProviderResponse('The provider response omitted output token usage.');
  }

  const inputDetails = isRecord(usage.input_tokens_details)
    ? usage.input_tokens_details
    : undefined;
  const outputDetails = isRecord(usage.output_tokens_details)
    ? usage.output_tokens_details
    : undefined;
  const cachedInputTokens = inputDetails?.cached_tokens;
  const reasoningTokens = outputDetails?.reasoning_tokens;

  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(isNonNegativeNumber(cachedInputTokens) ? { cachedInputTokens } : {}),
    ...(isNonNegativeNumber(reasoningTokens) ? { reasoningTokens } : {}),
  };
}

function invalidProviderResponse(detail: string): SamplingError {
  return new SamplingError('OpenAI returned an invalid response.', {
    code: 'provider_error',
    retryable: false,
    cause: new Error(detail),
  });
}

function readToolArguments(value: unknown): JsonObject {
  if (typeof value !== 'string') {
    throw invalidProviderResponse('A function call omitted its JSON arguments.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidProviderResponse('A function call contained invalid JSON arguments.');
  }
  if (!isRecord(parsed)) {
    throw invalidProviderResponse('A function call argument payload was not an object.');
  }
  return parsed as JsonObject;
}

function readOutput(payload: Record<string, unknown>): {
  readonly text: string | null;
  readonly toolCalls: ModelResponse['toolCalls'];
} {
  if (!Array.isArray(payload.output)) {
    throw invalidProviderResponse('The provider response omitted its output items.');
  }

  const textParts: string[] = [];
  const toolCalls: ModelResponse['toolCalls'][number][] = [];

  for (const item of payload.output) {
    if (!isRecord(item)) continue;

    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
          textParts.push(part.text);
        } else if (isRecord(part) && part.type === 'refusal' && typeof part.refusal === 'string') {
          textParts.push(part.refusal);
        }
      }
      continue;
    }

    if (item.type === 'function_call') {
      if (
        typeof item.call_id !== 'string' ||
        item.call_id.length === 0 ||
        typeof item.name !== 'string' ||
        item.name.length === 0
      ) {
        throw invalidProviderResponse('A function call omitted its call ID or name.');
      }
      toolCalls.push({
        id: item.call_id as ToolCallId,
        name: item.name,
        arguments: readToolArguments(item.arguments),
      });
    }
  }

  return {
    text: textParts.length === 0 ? null : textParts.join(''),
    toolCalls,
  };
}

function readStopReason(payload: Record<string, unknown>, toolCallCount: number): StopReason {
  if (toolCallCount > 0) return 'tool_calls';

  if (payload.status === 'incomplete') {
    const details = isRecord(payload.incomplete_details) ? payload.incomplete_details : undefined;
    if (details?.reason === 'max_output_tokens' || details?.reason === 'max_tokens') {
      return 'max_output_tokens';
    }
    if (details?.reason === 'content_filter') return 'content_filtered';
    return 'unknown';
  }

  return payload.status === 'completed' ? 'end_turn' : 'unknown';
}

function normalizeResponse(request: ModelRequest, value: unknown): ModelResponse {
  if (!isRecord(value)) throw invalidProviderResponse('The response body was not an object.');

  if (value.status === 'cancelled') {
    throw new SamplingError('OpenAI cancelled the model request.', {
      code: 'cancelled',
      retryable: false,
    });
  }
  if (value.status === 'failed') {
    throw new SamplingError('OpenAI failed to produce a model response.', {
      code: 'provider_error',
      retryable: false,
    });
  }

  const output = readOutput(value);
  return {
    modelCallId: request.modelCallId,
    text: output.text,
    toolCalls: output.toolCalls,
    usage: readUsage(value),
    stopReason: readStopReason(value, output.toolCalls.length),
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function transportFailure(error: unknown, cancellation: CancellationScope): SamplingError {
  if (cancellation.signal?.aborted === true || isAbortError(error)) {
    return cancellationError(cancellation);
  }

  if (error instanceof TypeError) {
    return new SamplingError('The OpenAI transport is unavailable.', {
      code: 'unavailable',
      retryable: true,
      cause: new Error('The provider transport failed.'),
    });
  }

  return new SamplingError('The OpenAI transport failed.', {
    code: 'provider_error',
    retryable: false,
    cause: new Error('The provider transport threw an unexpected error.'),
  });
}

const NON_RETRIABLE_RATE_LIMIT_CODES = new Set([
  'billing_hard_limit_reached',
  'billing_not_active',
  'insufficient_quota',
  'usage_limit_reached',
]);

async function providerFailure(
  response: Response,
  maxRetryDelayMs: number,
): Promise<ProviderFailure> {
  let providerCode: string | undefined;
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') {
      providerCode = body.error.code;
    }
  } catch {
    // Error bodies are deliberately ignored: they may contain request content.
  }

  const status = response.status;
  let code: SamplingError['code'] = 'provider_error';
  let retryable = false;

  if (status === 400 || status === 404 || status === 422) {
    code = 'invalid_request';
  } else if (status === 401 || status === 403) {
    code = 'authentication';
  } else if (status === 429) {
    code = 'rate_limited';
    retryable = providerCode === undefined || !NON_RETRIABLE_RATE_LIMIT_CODES.has(providerCode);
  } else if (status === 408 || status === 409 || status >= 500) {
    code = 'unavailable';
    retryable = true;
  }

  const retryAfterMs = readRetryAfterMs(response.headers.get('retry-after'), maxRetryDelayMs);
  return {
    error: new SamplingError(`OpenAI request failed with HTTP ${status}.`, {
      code,
      retryable,
      cause: new Error(`Provider HTTP status ${status}.`),
    }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

function readRetryAfterMs(value: string | null, maxRetryDelayMs: number): number | undefined {
  if (value === null) return undefined;

  const seconds = Number(value);
  const delayMs = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(value) - Date.now();
  if (!Number.isFinite(delayMs)) return undefined;
  return Math.min(Math.max(0, delayMs), maxRetryDelayMs);
}

function defaultRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(new DOMException('Aborted', 'AbortError'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function retryDelayMs(
  retryCount: number,
  baseDelayMs: number,
  maxDelayMs: number,
  retryAfterMs: number | undefined,
): number {
  if (retryAfterMs !== undefined) return retryAfterMs;
  return Math.min(baseDelayMs * 2 ** retryCount, maxDelayMs);
}

export class OpenAIResponsesSampler implements Sampler {
  readonly #apiKey: string;
  readonly #url: string;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #fetch: FetchTransport;
  readonly #retryDelay: RetryDelay;

  public constructor(options: OpenAIResponsesSamplerOptions) {
    if (options.apiKey.trim().length === 0) throw new TypeError('apiKey must not be empty.');

    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    requireNonNegativeInteger('maxRetries', maxRetries);
    requireNonNegativeFiniteNumber('retryBaseDelayMs', retryBaseDelayMs);
    requireNonNegativeFiniteNumber('maxRetryDelayMs', maxRetryDelayMs);

    this.#apiKey = options.apiKey;
    this.#url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/u, '')}/responses`;
    this.#maxRetries = maxRetries;
    this.#retryBaseDelayMs = retryBaseDelayMs;
    this.#maxRetryDelayMs = maxRetryDelayMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  public async sample(request: ModelRequest, options?: SamplingOptions): Promise<ModelResponse> {
    validateOutputTokenLimit(request);
    const span = trace.getActiveSpan();
    span?.setAttribute('provider', 'openai');

    const cancellation = createCancellationScope(options);
    let retryCount = 0;

    try {
      const body = serializeRequest(request);
      while (true) {
        throwIfCancelled(cancellation);

        let response: Response;
        try {
          response = await this.#fetch(this.#url, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              'content-type': 'application/json',
            },
            body,
            ...(cancellation.signal === undefined ? {} : { signal: cancellation.signal }),
          });
          throwIfCancelled(cancellation);
        } catch (error) {
          const failure =
            error instanceof SamplingError ? error : transportFailure(error, cancellation);
          if (!failure.retryable || retryCount >= this.#maxRetries) throw failure;

          await this.#waitBeforeRetry(retryCount, undefined, cancellation);
          retryCount += 1;
          continue;
        }

        const providerRequestId = response.headers.get('x-request-id');
        if (providerRequestId !== null) {
          span?.setAttribute('provider.request_id', providerRequestId);
        }
        if (!response.ok) {
          const failure = await providerFailure(response, this.#maxRetryDelayMs);
          throwIfCancelled(cancellation);
          if (!failure.error.retryable || retryCount >= this.#maxRetries) throw failure.error;

          await this.#waitBeforeRetry(retryCount, failure.retryAfterMs, cancellation);
          retryCount += 1;
          continue;
        }

        let payload: unknown;
        try {
          payload = (await response.json()) as unknown;
          throwIfCancelled(cancellation);
        } catch (error) {
          if (cancellation.signal?.aborted === true || isAbortError(error)) {
            throw cancellationError(cancellation);
          }
          throw invalidProviderResponse('The response body was not valid JSON.');
        }
        return normalizeResponse(request, payload);
      }
    } finally {
      span?.setAttribute('retry_count', retryCount);
      cancellation.dispose();
    }
  }

  async #waitBeforeRetry(
    retryCount: number,
    retryAfterMs: number | undefined,
    cancellation: CancellationScope,
  ): Promise<void> {
    const delayMs = retryDelayMs(
      retryCount,
      this.#retryBaseDelayMs,
      this.#maxRetryDelayMs,
      retryAfterMs,
    );
    try {
      await this.#retryDelay(delayMs, cancellation.signal);
      throwIfCancelled(cancellation);
    } catch (error) {
      if (error instanceof SamplingError) throw error;
      throw transportFailure(error, cancellation);
    }
  }
}
