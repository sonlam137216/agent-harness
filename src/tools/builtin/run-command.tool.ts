import type { JsonObject } from '../../json.js';
import { CommandError, type CommandCapability } from '../../workspace/command-capability.js';
import type { Tool } from '../tool.interface.js';
import { invalidToolInput, toolFailure, toolSuccess } from '../tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from '../tool-types.js';

const MAX_TIMEOUT_SECONDS = 600;

interface RunCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutSeconds?: number;
}

function parse(
  input: JsonObject,
): { valid: true; value: RunCommandInput } | { valid: false; message: string } {
  if (
    !Object.keys(input).every((key) => ['command', 'args', 'cwd', 'timeoutSeconds'].includes(key))
  )
    return { valid: false, message: 'Only command, args, cwd and timeoutSeconds are allowed.' };
  const { command, args = [], cwd = '.', timeoutSeconds } = input;
  if (typeof command !== 'string' || command.length === 0 || command.length > 64)
    return { valid: false, message: 'command must be a bare executable name.' };
  if (!Array.isArray(args) || args.length > 64 || !args.every((arg) => typeof arg === 'string'))
    return { valid: false, message: 'args must be an array of at most 64 strings.' };
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > 4_096)
    return { valid: false, message: 'cwd must be a workspace-relative directory.' };
  if (
    timeoutSeconds !== undefined &&
    (typeof timeoutSeconds !== 'number' ||
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < 1 ||
      timeoutSeconds > MAX_TIMEOUT_SECONDS)
  )
    return {
      valid: false,
      message: `timeoutSeconds must be an integer from 1 to ${MAX_TIMEOUT_SECONDS}.`,
    };
  return {
    valid: true,
    value: {
      command,
      args: args,
      cwd,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    },
  };
}

/**
 * Runs one allowlisted program without a shell through a sandboxed CommandCapability. The
 * capability, not this tool, enforces paths, network, environment and limits.
 */
export class RunCommandTool implements Tool {
  public readonly definition = {
    name: 'run_command',
    description:
      'Run one program (no shell) inside the sandbox, e.g. command "pnpm" with args ["test"]. The command must be a bare allowlisted name; pipes, redirects and globbing are not interpreted. Network is blocked and files can be written only inside the workspace. Returns the exit code and the tail of stdout/stderr.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 64 },
        args: { type: 'array', items: { type: 'string', maxLength: 4_096 }, maxItems: 64 },
        cwd: { type: 'string', minLength: 1, maxLength: 4_096 },
        timeoutSeconds: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_SECONDS },
      },
      required: ['command'],
      additionalProperties: false,
    },
    accessKind: 'execute',
  } as const;

  public constructor(private readonly commands: CommandCapability) {}

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
    const { command, args, cwd, timeoutSeconds } = parsed.value;
    try {
      const result = await this.commands.run(
        {
          command,
          args,
          cwd,
          ...(timeoutSeconds === undefined ? {} : { timeoutMs: timeoutSeconds * 1_000 }),
        },
        execution.signal === undefined ? {} : { signal: execution.signal },
      );
      // A non-zero exit is information for the model, not a tool failure.
      return toolSuccess(call.id, { ...result });
    } catch (error) {
      if (error instanceof CommandError) return toolFailure(call.id, error.code, error.message);
      return toolFailure(call.id, 'command_error', 'The command could not be run.');
    }
  };
}
