import type { SubagentId } from '../ids.js';
import type { JsonObject } from '../json.js';
import type { Tool } from '../tools/tool.interface.js';
import { invalidToolInput, toolFailure, toolSuccess } from '../tools/tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from '../tools/tool-types.js';
import {
  isSubagentRole,
  SUBAGENT_ROLE_DEFINITIONS,
  SUBAGENT_ROLES,
  type SubagentRole,
} from './subagent-definition.js';
import { SubagentError, type SubagentManager } from './subagent-manager.js';
import type { SubagentHandoff } from './subagent-runner.js';

export const MAX_TASK_CHARACTERS = 8_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

type Parsed<T> = { valid: true; value: T } | { valid: false; message: string };

function onlyKeys(input: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function parseDelegation(
  input: JsonObject,
): Parsed<{ role: SubagentRole; task: string; background: boolean }> {
  if (!onlyKeys(input, ['role', 'task', 'background']))
    return { valid: false, message: 'Only role, task and background are allowed.' };
  const { role, task, background = false } = input;
  if (!isSubagentRole(role))
    return { valid: false, message: `role must be one of: ${SUBAGENT_ROLES.join(', ')}.` };
  if (typeof task !== 'string' || task.trim() === '' || task.length > MAX_TASK_CHARACTERS)
    return {
      valid: false,
      message: `task must be a non-empty string of at most ${MAX_TASK_CHARACTERS} characters.`,
    };
  if (typeof background !== 'boolean')
    return { valid: false, message: 'background must be a boolean.' };
  return { valid: true, value: { role, task, background } };
}

function parseSubagentId(input: JsonObject): Parsed<SubagentId> {
  if (!onlyKeys(input, ['subagentId']) || typeof input.subagentId !== 'string')
    return { valid: false, message: 'Expected exactly one string field named "subagentId".' };
  if (!UUID.test(input.subagentId))
    return { valid: false, message: 'subagentId must be an ID returned by delegate_task.' };
  return { valid: true, value: input.subagentId as SubagentId };
}

const subagentIdSchema = {
  type: 'object',
  properties: { subagentId: { type: 'string', pattern: UUID.source } },
  required: ['subagentId'],
  additionalProperties: false,
} as const;

/** Completed children return their report; any other outcome is an error result. */
function handoffResult(call: ToolCall, handoff: SubagentHandoff): ToolResult {
  if (handoff.outcome === 'completed') return toolSuccess(call.id, { ...handoff });
  const transcript =
    handoff.sessionId === undefined ? '' : ` Its transcript is session ${handoff.sessionId}.`;
  return toolFailure(
    call.id,
    `subagent_${handoff.outcome}`,
    `Subagent ${handoff.subagentId} (${handoff.role}) ended with outcome "${handoff.outcome}" and no report.${transcript}`,
  );
}

function failure(call: ToolCall, error: unknown): ToolResult {
  if (error instanceof SubagentError) return toolFailure(call.id, error.code, error.message);
  throw error;
}

function missingCorrelation(call: ToolCall): ToolResult {
  return toolFailure(call.id, 'invalid_state', `${call.name} requires session correlation.`);
}

const roleList = SUBAGENT_ROLES.map(
  (role) => `${role}: ${SUBAGENT_ROLE_DEFINITIONS[role].description}`,
).join(' ');

/**
 * Hands a self-contained task to a read-only child session. The tool depends only on the
 * SubagentManager port; it never samples a model or reaches Workspace itself.
 */
export class DelegateTaskTool implements Tool {
  public readonly definition = {
    name: 'delegate_task',
    description: `Delegate a self-contained task to a read-only subagent with its own fresh context; only its bounded report and the files it read return to you. The subagent does not see this conversation, so state everything it needs in the task. Roles: ${roleList} Set background to true to start several at once, then collect each with await_subagent.`,
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: [...SUBAGENT_ROLES] },
        task: { type: 'string', minLength: 1, maxLength: MAX_TASK_CHARACTERS },
        background: { type: 'boolean' },
      },
      required: ['role', 'task'],
      additionalProperties: false,
    },
    // Children are read-only; their sessions are harness-owned records, not workspace writes.
    accessKind: 'read',
  } as const;

  public constructor(private readonly manager: SubagentManager) {}

  public readonly validateInput: Tool['validateInput'] = (input) => {
    const parsed = parseDelegation(input);
    return parsed.valid ? { valid: true } : parsed;
  };

  public readonly execute = async (
    call: ToolCall,
    execution: ToolExecutionOptions = {},
  ): Promise<ToolResult> => {
    const parsed = parseDelegation(call.arguments);
    if (!parsed.valid) return invalidToolInput(call.id, parsed.message);
    const correlation = execution.correlation;
    if (correlation === undefined) return missingCorrelation(call);
    const request = {
      role: parsed.value.role,
      task: parsed.value.task,
      parent: { sessionId: correlation.sessionId, turnId: correlation.turnId, toolCallId: call.id },
    };
    try {
      if (parsed.value.background) {
        const subagentId = this.manager.start(request);
        return toolSuccess(call.id, { subagentId, role: request.role, status: 'running' });
      }
      return handoffResult(
        call,
        await this.manager.run({
          ...request,
          ...(execution.signal === undefined ? {} : { signal: execution.signal }),
        }),
      );
    } catch (error) {
      return failure(call, error);
    }
  };
}

export class AwaitSubagentTool implements Tool {
  public readonly definition = {
    name: 'await_subagent',
    description:
      'Wait for a background subagent started with delegate_task and return its report and sources.',
    inputSchema: subagentIdSchema,
    accessKind: 'read',
  } as const;

  public constructor(private readonly manager: SubagentManager) {}

  public readonly validateInput: Tool['validateInput'] = (input) => {
    const parsed = parseSubagentId(input);
    return parsed.valid ? { valid: true } : parsed;
  };

  public readonly execute = async (
    call: ToolCall,
    execution: ToolExecutionOptions = {},
  ): Promise<ToolResult> => {
    const parsed = parseSubagentId(call.arguments);
    if (!parsed.valid) return invalidToolInput(call.id, parsed.message);
    if (execution.correlation === undefined) return missingCorrelation(call);
    try {
      return handoffResult(
        call,
        await this.manager.wait(parsed.value, execution.correlation.sessionId, execution.signal),
      );
    } catch (error) {
      return failure(call, error);
    }
  };
}

export class CancelSubagentTool implements Tool {
  public readonly definition = {
    name: 'cancel_subagent',
    description: 'Cancel a background subagent that is no longer needed.',
    inputSchema: subagentIdSchema,
    accessKind: 'read',
  } as const;

  public constructor(private readonly manager: SubagentManager) {}

  public readonly validateInput: Tool['validateInput'] = (input) => {
    const parsed = parseSubagentId(input);
    return parsed.valid ? { valid: true } : parsed;
  };

  public readonly execute = async (
    call: ToolCall,
    execution: ToolExecutionOptions = {},
  ): Promise<ToolResult> => {
    const parsed = parseSubagentId(call.arguments);
    if (!parsed.valid) return invalidToolInput(call.id, parsed.message);
    if (execution.correlation === undefined) return missingCorrelation(call);
    try {
      const handoff = await this.manager.cancel(parsed.value, execution.correlation.sessionId);
      return toolSuccess(call.id, {
        subagentId: handoff.subagentId,
        outcome: handoff.outcome,
        ...(handoff.sessionId === undefined ? {} : { sessionId: handoff.sessionId }),
      });
    } catch (error) {
      return failure(call, error);
    }
  };
}
