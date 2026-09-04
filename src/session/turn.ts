import type { ModelCallId, TurnId } from '../ids.js';
import type {
  ToolCall as NormalizedToolCall,
  ToolResult as NormalizedToolResult,
} from '../tools/tool-types.js';

export type TurnStatus = 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface UserMessage {
  readonly kind: 'user_message';
  readonly content: string;
}

export type ToolCall = NormalizedToolCall;

export interface AssistantMessage {
  readonly kind: 'assistant_message';
  readonly modelCallId: ModelCallId;
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
}

export type ToolResultOutcome = NormalizedToolResult['outcome'];

export interface ToolResult extends NormalizedToolResult {
  readonly kind: 'tool_result';
}

export type TurnEntry = UserMessage | AssistantMessage | ToolResult;

export interface Turn {
  readonly id: TurnId;
  readonly status: TurnStatus;
  readonly entries: readonly TurnEntry[];
}
