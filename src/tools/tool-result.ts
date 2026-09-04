import type { ToolCallId } from '../ids.js';
import type { JsonValue } from '../json.js';
import { FileSystemError } from '../workspace/filesystem-capability.js';
import type { ToolResult } from './tool-types.js';

const MAX_ERROR_MESSAGE_CHARACTERS = 500;

function boundedMessage(message: string): string {
  return message.slice(0, MAX_ERROR_MESSAGE_CHARACTERS);
}

export function toolSuccess(toolCallId: ToolCallId, output: JsonValue): ToolResult {
  return { toolCallId, outcome: 'success', output };
}

export function toolFailure(toolCallId: ToolCallId, code: string, message: string): ToolResult {
  return {
    toolCallId,
    outcome: 'error',
    output: {
      error: {
        code,
        message: boundedMessage(message),
      },
    },
  };
}

export function invalidToolInput(toolCallId: ToolCallId, message: string): ToolResult {
  return toolFailure(toolCallId, 'invalid_input', message);
}

export function fileSystemToolFailure(toolCallId: ToolCallId, error: unknown): ToolResult {
  if (error instanceof FileSystemError) {
    return toolFailure(toolCallId, error.code, error.message);
  }

  return toolFailure(toolCallId, 'workspace_error', 'The filesystem operation failed.');
}
