import type { JsonObject } from '../../json.js';
import type { FileWriteCapability } from '../../workspace/file-write-capability.js';
import type { FileSystemCapability } from '../../workspace/filesystem-capability.js';
import type { Tool } from '../tool.interface.js';
import {
  fileSystemToolFailure,
  invalidToolInput,
  toolFailure,
  toolSuccess,
} from '../tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from '../tool-types.js';
import { MAX_WRITE_CHARACTERS } from './write-file.tool.js';

const MAX_PATH_CHARACTERS = 4_096;
const MAX_EDIT_CHARACTERS = 100_000;

interface EditInput {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
}

function parse(
  input: JsonObject,
): { valid: true; value: EditInput } | { valid: false; message: string } {
  if (!Object.keys(input).every((key) => ['path', 'oldText', 'newText'].includes(key)))
    return { valid: false, message: 'Only path, oldText and newText are allowed.' };
  const { path, oldText, newText } = input;
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_CHARACTERS)
    return { valid: false, message: 'path must be a non-empty string.' };
  if (typeof oldText !== 'string' || oldText.length === 0 || oldText.length > MAX_EDIT_CHARACTERS)
    return { valid: false, message: 'oldText must be a non-empty string.' };
  if (typeof newText !== 'string' || newText.length > MAX_EDIT_CHARACTERS)
    return { valid: false, message: 'newText must be a string.' };
  return { valid: true, value: { path, oldText, newText } };
}

/** Replaces exactly one occurrence of `oldText`; zero or several matches change nothing. */
export class EditFileTool implements Tool {
  public readonly definition = {
    name: 'edit_file',
    description:
      'Replace exactly one occurrence of oldText with newText in an existing UTF-8 file. Include enough surrounding text in oldText to make it unique; the edit fails without changes if oldText is missing or ambiguous.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: MAX_PATH_CHARACTERS },
        oldText: { type: 'string', minLength: 1, maxLength: MAX_EDIT_CHARACTERS },
        newText: { type: 'string', maxLength: MAX_EDIT_CHARACTERS },
      },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    accessKind: 'write',
  } as const;

  public constructor(
    private readonly files: FileSystemCapability,
    private readonly writer: FileWriteCapability,
  ) {}

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
    const { path, oldText, newText } = parsed.value;
    const options = execution.signal === undefined ? {} : { signal: execution.signal };
    try {
      const current = await this.files.readFile(path, options);
      const first = current.content.indexOf(oldText);
      if (first === -1)
        return toolFailure(call.id, 'no_match', 'oldText was not found; nothing changed.');
      if (current.content.indexOf(oldText, first + 1) !== -1)
        return toolFailure(
          call.id,
          'ambiguous_match',
          'oldText occurs more than once; add surrounding context. Nothing changed.',
        );
      const next =
        current.content.slice(0, first) + newText + current.content.slice(first + oldText.length);
      if (next.length > MAX_WRITE_CHARACTERS)
        return toolFailure(call.id, 'size_limit', 'The edited file would exceed the write limit.');
      const result = await this.writer.writeFile(current.path, next, options);
      return toolSuccess(call.id, { path: result.path, sizeBytes: result.sizeBytes });
    } catch (error) {
      return fileSystemToolFailure(call.id, error);
    }
  };
}
