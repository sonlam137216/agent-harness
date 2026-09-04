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
  readonly execute: (call: ToolCall, options?: ToolExecutionOptions) => Promise<ToolResult>;
}
