import type { JsonObject } from '../../json.js';
import type { FileWriteCapability } from '../../workspace/file-write-capability.js';
import type { Tool } from '../tool.interface.js';
import { fileSystemToolFailure, invalidToolInput, toolSuccess } from '../tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from '../tool-types.js';

const MAX_PATH_CHARACTERS = 4_096;
export const MAX_WRITE_CHARACTERS = 1_000_000;

function parse(
  input: JsonObject,
): { valid: true; path: string; content: string } | { valid: false; message: string } {
  if (!Object.keys(input).every((key) => key === 'path' || key === 'content'))
    return { valid: false, message: 'Only path and content are allowed.' };
  const { path, content } = input;
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARACTERS)
    return { valid: false, message: 'path must be a non-empty string.' };
  if (typeof content !== 'string' || content.length > MAX_WRITE_CHARACTERS)
    return {
      valid: false,
      message: `content must be a string of at most ${MAX_WRITE_CHARACTERS} characters.`,
    };
  return { valid: true, path, content };
}

/** Creates or replaces one file. Registered only for sessions bound to a disposable worktree. */
export class WriteFileTool implements Tool {
  public readonly definition = {
    name: 'write_file',
    description:
      'Create or replace one UTF-8 text file with the given content. Parent directories are created. Prefer edit_file for small changes to existing files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARACTERS },
        content: { type: 'string', maxLength: MAX_WRITE_CHARACTERS },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    accessKind: 'write',
  } as const;

  public constructor(private readonly writer: FileWriteCapability) {}

  public readonly validateInput: Tool['validateInput'] = (input) => {
    const parsed = parse(input);
    return parsed.valid ? { valid: true } : parsed;
  };

  public readonly execute = async (
    call: ToolCall,
    execution: ToolExecutionOptions = {},
  ): Promise<ToolResult> => {
    const parsed = parse(call.arguments);
    if (!parsed.valid) return invalidToolInput(call.id, parsed.message);
    try {
      const result = await this.writer.writeFile(
        parsed.path,
        parsed.content,
        execution.signal === undefined ? {} : { signal: execution.signal },
      );
      return toolSuccess(call.id, { ...result });
    } catch (error) {
      return fileSystemToolFailure(call.id, error);
    }
  };
}
