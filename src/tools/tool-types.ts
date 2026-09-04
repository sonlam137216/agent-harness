import type { ToolCallId } from '../ids.js';
import type { JsonObject, JsonValue } from '../json.js';

export type ToolAccessKind = 'read' | 'write' | 'execute' | 'external';

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ToolDefinition extends ModelToolDefinition {
  readonly accessKind: ToolAccessKind;
}

export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly arguments: JsonObject;
}

export type ToolResultOutcome = 'success' | 'error';

export interface ToolExecutionOptions {
  readonly signal?: AbortSignal;
}

export type ToolInputValidation =
  { readonly valid: true } | { readonly valid: false; readonly message: string };

export interface ToolResult {
  readonly toolCallId: ToolCallId;
  readonly outcome: ToolResultOutcome;
  readonly output: JsonValue;
}
