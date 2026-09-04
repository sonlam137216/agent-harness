import type { FileSystemCapability } from '../../workspace/filesystem-capability.js';
import type { Tool } from '../tool.interface.js';
import { fileSystemToolFailure, invalidToolInput, toolSuccess } from '../tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from '../tool-types.js';
import { validateRequiredPath } from './input-validation.js';

export class ReadFileTool implements Tool {
  public readonly definition = {
    name: 'read_file',
    description: 'Read one UTF-8 text file within the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4_096 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    accessKind: 'read',
  } as const;

  public constructor(private readonly fileSystem: FileSystemCapability) {}

  public readonly validateInput: Tool['validateInput'] = (input) => validateRequiredPath(input);

  public readonly execute = async (
    call: ToolCall,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> => {
    const path = validateRequiredPath(call.arguments);
    if (!path.valid) return invalidToolInput(call.id, path.message);

    try {
      const result = await this.fileSystem.readFile(path.value, options);
      return toolSuccess(call.id, {
        path: result.path,
        content: result.content,
        sizeBytes: result.sizeBytes,
      });
    } catch (error) {
      return fileSystemToolFailure(call.id, error);
    }
  };
}
