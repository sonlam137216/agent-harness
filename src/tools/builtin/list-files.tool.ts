import type { FileSystemCapability } from '../../workspace/filesystem-capability.js';
import type { Tool } from '../tool.interface.js';
import { fileSystemToolFailure, invalidToolInput, toolSuccess } from '../tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from '../tool-types.js';
import { validateOptionalPath } from './input-validation.js';

export class ListFilesTool implements Tool {
  public readonly definition = {
    name: 'list_files',
    description: 'List immediate entries in one workspace directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 4_096 },
      },
      additionalProperties: false,
    },
    accessKind: 'read',
  } as const;

  public constructor(private readonly fileSystem: FileSystemCapability) {}

  public readonly validateInput: Tool['validateInput'] = (input) => validateOptionalPath(input);

  public readonly execute = async (
    call: ToolCall,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> => {
    const path = validateOptionalPath(call.arguments);
    if (!path.valid) return invalidToolInput(call.id, path.message);

    try {
      const entries = await this.fileSystem.listDirectory(path.value, options);
      return toolSuccess(call.id, {
        entries: entries.map((entry) => ({
          path: entry.path,
          name: entry.name,
          kind: entry.kind,
        })),
      });
    } catch (error) {
      return fileSystemToolFailure(call.id, error);
    }
  };
}
