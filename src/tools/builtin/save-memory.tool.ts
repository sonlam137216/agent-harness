import type { JsonObject } from '../../json.js';
import {
  MAX_MEMORY_BODY_CHARACTERS,
  MAX_MEMORY_TITLE_CHARACTERS,
  memoryInputProblem,
  MemoryWriteError,
  type MemoryRecordInput,
  type MemoryWriter,
} from '../../memory/memory-writer.js';
import type { Tool } from '../tool.interface.js';
import { invalidToolInput, toolFailure, toolSuccess } from '../tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from '../tool-types.js';

interface SaveMemoryInput {
  readonly title: string;
  readonly content: string;
  readonly scope: MemoryRecordInput['scope'];
  readonly file?: string;
}

function parse(
  input: JsonObject,
): { valid: true; value: SaveMemoryInput } | { valid: false; message: string } {
  const allowed = ['title', 'content', 'scope', 'file'];
  if (!Object.keys(input).every((key) => allowed.includes(key)))
    return { valid: false, message: `Only ${allowed.join(', ')} are allowed.` };
  const { title, content, scope = 'workspace', file } = input;
  if (typeof title !== 'string' || typeof content !== 'string')
    return { valid: false, message: 'title and content must be strings.' };
  if (scope !== 'workspace' && scope !== 'user')
    return { valid: false, message: 'scope must be "workspace" or "user".' };
  if (file !== undefined && typeof file !== 'string')
    return { valid: false, message: 'file must be a string.' };
  const problem = memoryInputProblem({
    title,
    body: content,
    ...(file === undefined ? {} : { file }),
  });
  if (problem !== undefined) return { valid: false, message: problem };
  return {
    valid: true,
    value: { title, content, scope, ...(file === undefined ? {} : { file }) },
  };
}

/** Appends one durable note; the harness permission policy decides whether it may run. */
export class SaveMemoryTool implements Tool {
  public readonly definition = {
    name: 'save_memory',
    description:
      'Record one durable note for future sessions, such as a decision the user confirmed or a stable project fact. Do not store secrets, speculation or transient task state. Workspace scope is shared with the project; user scope applies across projects.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_TITLE_CHARACTERS },
        content: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_BODY_CHARACTERS },
        scope: { type: 'string', enum: ['workspace', 'user'] },
        file: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
      },
      required: ['title', 'content'],
      additionalProperties: false,
    },
    accessKind: 'write',
  } as const;

  public constructor(private readonly writer: MemoryWriter) {}

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
    if (execution.correlation === undefined)
      return toolFailure(call.id, 'invalid_state', 'save_memory requires session correlation.');
    try {
      const recorded = await this.writer.record({
        scope: parsed.value.scope,
        title: parsed.value.title,
        body: parsed.value.content,
        ...(parsed.value.file === undefined ? {} : { file: parsed.value.file }),
        source: { kind: 'agent', sessionId: execution.correlation.sessionId },
        ...(execution.signal === undefined ? {} : { signal: execution.signal }),
      });
      return toolSuccess(call.id, { ...recorded });
    } catch (error) {
      if (error instanceof MemoryWriteError) return toolFailure(call.id, error.code, error.message);
      return toolFailure(call.id, 'memory_error', 'The memory note could not be recorded.');
    }
  };
}
