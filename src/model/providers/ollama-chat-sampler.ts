import { trace } from '@opentelemetry/api';

import { createToolCallId, type ToolCallId } from '../../ids.js';
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

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

export interface OllamaChatSamplerOptions {
  readonly baseUrl?: string;
  /** Number of retries after the initial request. */
  readonly maxRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly fetch?: FetchTransport;
  readonly retryDelay?: RetryDelay;
}

interface OllamaToolCall {
  readonly id?: string;
  readonly function: {
    readonly name: string;
    readonly arguments: JsonObject;
  };
}

interface OllamaMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_name?: string;
  readonly tool_calls?: readonly OllamaToolCall[];
}

function toolNameById(messages: readonly ModelMessage[]): ReadonlyMap<ToolCallId, string> {
  const names = new Map<ToolCallId, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) names.set(call.id, call.name);
  }
  return names;
}

function mapMessages(messages: readonly ModelMessage[]): readonly OllamaMessage[] {
  const names = toolNameById(messages);
  return messages.map((message): OllamaMessage => {
    switch (message.role) {
      case 'system':
      case 'user':
        return { role: message.role, content: message.content };
      case 'assistant':
        return {
          role: 'assistant',
          content: message.content ?? '',
          ...(message.toolCalls.length === 0
            ? {}
            : {
                tool_calls: message.toolCalls.map((call) => ({
                  id: call.id,
                  function: { name: call.name, arguments: call.arguments },
                })),
              }),
        };
      case 'tool': {
        const toolName = names.get(message.toolCallId);
        return {
          role: 'tool',
          content: message.content,
          ...(toolName === undefined ? {} : { tool_name: toolName }),
        };
      }
    }
  });
}

function serializeRequest(request: ModelRequest): string {
  try {
    return JSON.stringify({
      model: request.modelId,
      messages: mapMessages(request.messages),
      tools: request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      stream: false,
      ...(request.maxOutputTokens === undefined
        ? {}
        : { options: { num_predict: request.maxOutputTokens } }),
    });
  } catch {
    throw new SamplingError('The model request could not be encoded for Ollama.', {
      code: 'invalid_request',
      retryable: false,
      cause: new Error('The provider request was not JSON serializable.'),
    });
  }
}

function invalidProviderResponse(detail: string): SamplingError {
  return new SamplingError('Ollama returned an invalid response.', {
    code: 'provider_error',
    retryable: false,
    cause: new Error(detail),
  });
}

function readArguments(value: unknown): JsonObject {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw invalidProviderResponse('A tool call contained invalid JSON arguments.');
    }
  }
  if (!isRecord(parsed)) {
    throw invalidProviderResponse('A tool call argument payload was not an object.');
  }
  return parsed as JsonObject;
}

function readToolCalls(message: Record<string, unknown>): ModelResponse['toolCalls'] {
  if (message.tool_calls === undefined) return [];
  if (!Array.isArray(message.tool_calls)) {
    throw invalidProviderResponse('The assistant tool calls were not an array.');
  }

  return message.tool_calls.map((value) => {
    if (!isRecord(value) || !isRecord(value.function)) {
      throw invalidProviderResponse('A tool call was malformed.');
    }
    const name = value.function.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw invalidProviderResponse('A tool call omitted its name.');
    }
    const id = typeof value.id === 'string' && value.id.length > 0 ? value.id : createToolCallId();
    return {
      id: id as ToolCallId,
      name,
      arguments: readArguments(value.function.arguments),
    };
  });
}

function readStopReason(payload: Record<string, unknown>, toolCallCount: number): StopReason {
  if (toolCallCount > 0) return 'tool_calls';
  if (payload.done !== true) return 'unknown';
  if (payload.done_reason === 'length') return 'max_output_tokens';
  return payload.done_reason === 'stop' ? 'end_turn' : 'unknown';
}

function normalizeResponse(request: ModelRequest, value: unknown): ModelResponse {
  if (!isRecord(value)) throw invalidProviderResponse('The response body was not an object.');
  if (typeof value.error === 'string') {
    throw new SamplingError('Ollama failed to produce a model response.', {
      code: 'provider_error',
      retryable: false,
    });
  }
  if (!isRecord(value.message) || typeof value.message.content !== 'string') {
    throw invalidProviderResponse('The response omitted its assistant message.');
  }
  if (!isNonNegativeNumber(value.prompt_eval_count) || !isNonNegativeNumber(value.eval_count)) {
    throw invalidProviderResponse('The response omitted token usage.');
  }

  const toolCalls = readToolCalls(value.message);
  return {
    modelCallId: request.modelCallId,
    text: value.message.content.length === 0 ? null : value.message.content,
    toolCalls,
    usage: { inputTokens: value.prompt_eval_count, outputTokens: value.eval_count },
    stopReason: readStopReason(value, toolCalls.length),
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
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const code =
    status === 400 || status === 404 || status === 422
      ? 'invalid_request'
      : retryable
        ? 'unavailable'
        : 'provider_error';
  try {
    await response.body?.cancel();
  } catch {
    // Provider error bodies are deliberately discarded because they may contain prompt data.
  }
  const retryAfterMs = readRetryAfterMs(response.headers.get('retry-after'), maxRetryDelayMs);
  return {
    error: new SamplingError(`Ollama request failed with HTTP ${status}.`, {
      code,
      retryable,
      cause: new Error(`Provider HTTP status ${status}.`),
    }),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

export class OllamaChatSampler implements Sampler {
  readonly #url: string;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #fetch: FetchTransport;
  readonly #retryDelay: RetryDelay;

  public constructor(options: OllamaChatSamplerOptions = {}) {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    const maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
    requireNonNegativeInteger('maxRetries', maxRetries);
    requireNonNegativeFiniteNumber('retryBaseDelayMs', retryBaseDelayMs);
    requireNonNegativeFiniteNumber('maxRetryDelayMs', maxRetryDelayMs);

    this.#url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/u, '')}/api/chat`;
    this.#maxRetries = maxRetries;
    this.#retryBaseDelayMs = retryBaseDelayMs;
    this.#maxRetryDelayMs = maxRetryDelayMs;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  public async sample(request: ModelRequest, options?: SamplingOptions): Promise<ModelResponse> {
    validateOutputTokenLimit(request);
    const span = trace.getActiveSpan();
    span?.setAttribute('provider', 'ollama');
    const cancellation = createCancellationScope(options?.signal, options?.deadlineMs);
    let retryCount = 0;

    try {
      const body = serializeRequest(request);
      while (true) {
        throwIfCancelled(cancellation);
        let response: Response;
        try {
          response = await this.#fetch(this.#url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            ...(cancellation.signal === undefined ? {} : { signal: cancellation.signal }),
          });
          throwIfCancelled(cancellation);
        } catch (error) {
          const failure =
            error instanceof SamplingError
              ? error
              : transportFailure('Ollama', error, cancellation);
          if (!failure.retryable || retryCount >= this.#maxRetries) throw failure;
          await this.#waitBeforeRetry(retryCount, undefined, cancellation);
          retryCount += 1;
          continue;
        }

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
      throw transportFailure('Ollama', error, cancellation);
    }
  }
}
