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
import {
  cancellationError,
  createCancellationScope,
  defaultRetryDelay,
  isAbortError,
  isNonNegativeNumber,
  isRecord,
  readRetryAfterMs,
  requireNonNegativeFiniteNumber,
  requireNonNegativeInteger,
  retryDelayMs,
  throwIfCancelled,
  transportFailure,
  type CancellationScope,
  type FetchTransport,
  type RetryDelay,
} from './provider-http.js';

const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

export interface AnthropicMessagesSamplerOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly anthropicVersion?: string;
  readonly maxOutputTokens?: number;
  /** Number of retries after the initial request. */
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly fetch?: FetchTransport;
  readonly retryDelay?: RetryDelay;
}

interface AnthropicTextBlock {
  readonly type: 'text';
  readonly text: string;
}

interface AnthropicToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: JsonObject;
}

interface AnthropicToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string | readonly AnthropicContentBlock[];
}

function mapMessage(message: ModelMessage): AnthropicMessage | undefined {
  switch (message.role) {
    case 'system':
      return undefined;
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant': {
      const content: Array<AnthropicTextBlock | AnthropicToolUseBlock> = [];
      if (message.content !== null) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      }
      return { role: 'assistant', content };
    }
    case 'tool':
      return {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: message.toolCallId, content: message.content },
        ],
      };
  }
}

function mergeAdjacentMessages(messages: readonly AnthropicMessage[]): readonly AnthropicMessage[] {
  const merged: AnthropicMessage[] = [];
  for (const message of messages) {
    const previous = merged.at(-1);
    if (previous?.role !== message.role) {
      merged.push(message);
      continue;
    }

    const previousContent =
      typeof previous.content === 'string'
        ? [{ type: 'text' as const, text: previous.content }]
        : previous.content;
    const content =
      typeof message.content === 'string'
        ? [{ type: 'text' as const, text: message.content }]
        : message.content;
    merged[merged.length - 1] = { role: message.role, content: [...previousContent, ...content] };
  }
  return merged;
}

function serializeRequest(request: ModelRequest, maxOutputTokens: number): string {
  try {
    return JSON.stringify({
      model: request.modelId,
      max_tokens: request.maxOutputTokens ?? maxOutputTokens,
      system: request.messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n'),
      messages: mergeAdjacentMessages(
        request.messages
          .map(mapMessage)
          .filter((message): message is AnthropicMessage => message !== undefined),
      ),
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    });
  } catch {
    throw new SamplingError('The model request could not be encoded for Anthropic.', {
      code: 'invalid_request',
      retryable: false,
      cause: new Error('The provider request was not JSON serializable.'),
    });
  }
}

function invalidProviderResponse(detail: string): SamplingError {
  return new SamplingError('Anthropic returned an invalid response.', {
    code: 'provider_error',
    retryable: false,
    cause: new Error(detail),
  });
}

function readUsage(payload: Record<string, unknown>): TokenUsage {
  if (!isRecord(payload.usage)) {
    throw invalidProviderResponse('The provider response omitted token usage.');
  }
  const inputTokens = payload.usage.input_tokens;
  const outputTokens = payload.usage.output_tokens;
  if (!isNonNegativeNumber(inputTokens) || !isNonNegativeNumber(outputTokens)) {
    throw invalidProviderResponse('The provider response contained invalid token usage.');
  }
  const cachedInputTokens = payload.usage.cache_read_input_tokens;
  return {
    inputTokens,
    outputTokens,
    ...(isNonNegativeNumber(cachedInputTokens) ? { cachedInputTokens } : {}),
  };
}

function readOutput(payload: Record<string, unknown>): {
  readonly text: string | null;
  readonly toolCalls: ModelResponse['toolCalls'];
} {
  if (!Array.isArray(payload.content)) {
    throw invalidProviderResponse('The provider response omitted its content blocks.');
  }

  const text: string[] = [];
  const toolCalls: ModelResponse['toolCalls'][number][] = [];
  for (const block of payload.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      text.push(block.text);
      continue;
    }
    if (block.type === 'tool_use') {
      if (
        typeof block.id !== 'string' ||
        block.id.length === 0 ||
        typeof block.name !== 'string' ||
        block.name.length === 0 ||
        !isRecord(block.input)
      ) {
        throw invalidProviderResponse('A tool-use block was malformed.');
      }
      toolCalls.push({
        id: block.id as ToolCallId,
        name: block.name,
        arguments: block.input as JsonObject,
      });
    }
  }
  return { text: text.length === 0 ? null : text.join(''), toolCalls };
}

function readStopReason(value: unknown, toolCallCount: number): StopReason {
  if (toolCallCount > 0) return 'tool_calls';
  if (value === 'end_turn' || value === 'stop_sequence') return 'end_turn';
  if (value === 'max_tokens') return 'max_output_tokens';
  if (value === 'refusal') return 'content_filtered';
  return 'unknown';
}

function normalizeResponse(request: ModelRequest, value: unknown): ModelResponse {
  if (!isRecord(value)) throw invalidProviderResponse('The response body was not an object.');
  if (value.type === 'error') {
    throw new SamplingError('Anthropic failed to produce a model response.', {
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
    stopReason: readStopReason(value.stop_reason, output.toolCalls.length),
  };
}

async function providerFailure(
  response: Response,
  maxRetryDelayMs: number,
): Promise<{
  readonly error: SamplingError;
  readonly retryAfterMs?: number;
}> {
  const status = response.status;
  let code: SamplingError['code'] = 'provider_error';
  let retryable = false;
  if (status === 400 || status === 404 || status === 422) code = 'invalid_request';
  else if (status === 401 || status === 403) code = 'authentication';
  else if (status === 429) {
    code = 'rate_limited';
    retryable = true;
  } else if (status === 408 || status === 409 || status === 529 || status >= 500) {
    code = 'unavailable';
    retryable = true;
  }

  try {
    await response.body?.cancel();
  } catch {
    // Provider error bodies are deliberately discarded because they may contain prompt data.
  }
  const retryAfterMs = readRetryAfterMs(response.headers.get('retry-after'), maxRetryDelayMs);
  return {
    error: new SamplingError(`Anthropic request failed with HTTP ${status}.`, {
      code,
      retryable,
      cause: new Error(`Provider HTTP status ${status}.`),
    }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

export class AnthropicMessagesSampler implements Sampler {
  readonly #apiKey: string;
  readonly #url: string;
  readonly #anthropicVersion: string;
  readonly #maxOutputTokens: number;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #fetch: FetchTransport;
  readonly #retryDelay: RetryDelay;

  public constructor(options: AnthropicMessagesSamplerOptions) {
    if (options.apiKey.trim().length === 0) throw new TypeError('apiKey must not be empty.');
    const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    requireNonNegativeInteger('maxOutputTokens', maxOutputTokens);
    if (maxOutputTokens === 0) throw new RangeError('maxOutputTokens must be greater than zero.');
    requireNonNegativeInteger('maxRetries', maxRetries);
    requireNonNegativeFiniteNumber('retryBaseDelayMs', retryBaseDelayMs);
    requireNonNegativeFiniteNumber('maxRetryDelayMs', maxRetryDelayMs);

    this.#apiKey = options.apiKey;
    this.#url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/u, '')}/messages`;
    this.#anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    this.#maxOutputTokens = maxOutputTokens;
    this.#maxRetries = maxRetries;
    this.#retryBaseDelayMs = retryBaseDelayMs;
    this.#maxRetryDelayMs = maxRetryDelayMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  public async sample(request: ModelRequest, options?: SamplingOptions): Promise<ModelResponse> {
    validateOutputTokenLimit(request);
    const span = trace.getActiveSpan();
    span?.setAttribute('provider', 'anthropic');
    const cancellation = createCancellationScope(options?.signal, options?.deadlineMs);
    let retryCount = 0;

    try {
      const body = serializeRequest(request, this.#maxOutputTokens);
      while (true) {
        throwIfCancelled(cancellation);
        let response: Response;
        try {
          response = await this.#fetch(this.#url, {
            method: 'POST',
            headers: {
              'anthropic-version': this.#anthropicVersion,
              'content-type': 'application/json',
              'x-api-key': this.#apiKey,
            },
            body,
            ...(cancellation.signal === undefined ? {} : { signal: cancellation.signal }),
          });
          throwIfCancelled(cancellation);
        } catch (error) {
          const failure =
            error instanceof SamplingError
              ? error
              : transportFailure('Anthropic', error, cancellation);
          if (!failure.retryable || retryCount >= this.#maxRetries) throw failure;
          await this.#waitBeforeRetry(retryCount, undefined, cancellation);
          retryCount += 1;
          continue;
        }

        const providerRequestId = response.headers.get('request-id');
        if (providerRequestId !== null)
          span?.setAttribute('provider.request_id', providerRequestId);
        if (!response.ok) {
          const failure = await providerFailure(response, this.#maxRetryDelayMs);
          throwIfCancelled(cancellation);
          if (!failure.error.retryable || retryCount >= this.#maxRetries) throw failure.error;
          await this.#waitBeforeRetry(retryCount, failure.retryAfterMs, cancellation);
          retryCount += 1;
          continue;
        }

        try {
          const payload = (await response.json()) as unknown;
          throwIfCancelled(cancellation);
          return normalizeResponse(request, payload);
        } catch (error) {
          if (error instanceof SamplingError) throw error;
          if (cancellation.signal?.aborted === true || isAbortError(error)) {
            throw cancellationError(cancellation);
          }
          throw invalidProviderResponse('The response body was not valid JSON.');
        }
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
    try {
      await this.#retryDelay(
        retryDelayMs(retryCount, this.#retryBaseDelayMs, this.#maxRetryDelayMs, retryAfterMs),
        cancellation.signal,
      );
      throwIfCancelled(cancellation);
    } catch (error) {
      if (error instanceof SamplingError) throw error;
      throw transportFailure('Anthropic', error, cancellation);
    }
  }
}
