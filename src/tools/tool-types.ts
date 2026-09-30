import type { ToolCallId, SessionId, TurnId, ModelCallId } from '../ids.js';
import type { JsonObject, JsonValue } from '../json.js';

import type { AccessKind } from '../permissions/access-kind.js';
export type ToolAccessKind = AccessKind;

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ToolDefinition extends ModelToolDefinition {
  readonly accessKind: ToolAccessKind;
  readonly destructive?: boolean;
  readonly origin?: 'native' | 'external';
  /** Side-effect free and safe to run alongside other concurrent calls. */
  readonly concurrent?: boolean;
}

export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly arguments: JsonObject;
}

export type ToolResultOutcome = 'success' | 'error';

export interface ToolExecutionOptions {
  readonly correlation?: {
    readonly sessionId: SessionId;
    readonly turnId: TurnId;
    readonly modelCallId: ModelCallId;
  };
  readonly signal?: AbortSignal;
}

export type ToolInputValidation =
  { readonly valid: true } | { readonly valid: false; readonly message: string };

export interface ToolResult {
  readonly toolCallId: ToolCallId;
  readonly outcome: ToolResultOutcome;
  readonly output: JsonValue;
}
