import type { ModelCallId, ToolCallId } from '../ids.js';
import type { ModelToolDefinition, ToolCall } from '../tools/tool-types.js';

export type { ModelToolDefinition } from '../tools/tool-types.js';

export interface ModelSystemMessage {
  readonly role: 'system';
  readonly content: string;
}

export interface ModelUserMessage {
  readonly role: 'user';
  readonly content: string;
}

export type ModelToolCall = ToolCall;

export interface ModelAssistantMessage {
  readonly role: 'assistant';
  readonly content: string | null;
  readonly toolCalls: readonly ModelToolCall[];
}

export interface ModelToolMessage {
  readonly role: 'tool';
  readonly toolCallId: ToolCallId;
  readonly content: string;
}

export type ModelMessage =
  ModelSystemMessage | ModelUserMessage | ModelAssistantMessage | ModelToolMessage;

export type ModelMessageRole = ModelMessage['role'];

export interface ModelRequest {
  readonly modelCallId: ModelCallId;
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  /** Context-selected output allowance; provider-specific mapping stays in adapters. */
  readonly maxOutputTokens?: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

export function validateOutputTokenLimit(request: ModelRequest): void {
  const value = request.maxOutputTokens;
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new SamplingError('maxOutputTokens must be a positive safe integer.', {
      code: 'invalid_request',
      retryable: false,
    });
  }
}

export type StopReason =
  'end_turn' | 'tool_calls' | 'max_output_tokens' | 'content_filtered' | 'unknown';

export interface ModelResponse {
  readonly modelCallId: ModelCallId;
  readonly text: string | null;
  readonly toolCalls: readonly ModelToolCall[];
  readonly usage: TokenUsage;
  readonly stopReason: StopReason;
}

export interface SamplingOptions {
  readonly signal?: AbortSignal;
  /** Absolute Unix timestamp in milliseconds. */
  readonly deadlineMs?: number;
}

export type SamplingErrorCode =
  | 'cancelled'
  | 'deadline_exceeded'
  | 'invalid_request'
  | 'authentication'
  | 'rate_limited'
  | 'unavailable'
  | 'provider_error';

export interface SamplingErrorOptions {
  readonly code: SamplingErrorCode;
  readonly retryable: boolean;
  /** A sanitized built-in error, never a provider SDK error object. */
  readonly cause?: Error;
}

export class SamplingError extends Error {
  public override readonly name = 'SamplingError';
  public readonly code: SamplingErrorCode;
  public readonly retryable: boolean;
  public override readonly cause: Error | undefined;

  public constructor(message: string, options: SamplingErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.retryable = options.retryable;
    this.cause = options.cause;
  }
}
