import type { JsonObject } from '../json.js';
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionOptions,
  ToolInputValidation,
  ToolResult,
} from './tool-types.js';

export interface Tool {
  readonly definition: ToolDefinition;
  readonly validateInput: (input: JsonObject) => ToolInputValidation;
  /** Pure, one-hop delegation to an already registered tool. */
  readonly resolveInvocation?: (call: ToolCall) => ToolCall;
  readonly execute: (call: ToolCall, options?: ToolExecutionOptions) => Promise<ToolResult>;
}
