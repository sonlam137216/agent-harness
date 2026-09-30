import { isAbsolute, join } from 'node:path';

import type { Session } from '../session/session.js';
import type { ToolCall, TurnEntry } from '../session/turn.js';

/** Upper bound for tool output text copied into a client update. */
export const MAX_TOOL_CONTENT_CHARACTERS = 8_000;

/** ACP `session/update` payloads (the `update` field). */
export type AcpSessionUpdate =
  | {
      readonly sessionUpdate: 'user_message_chunk' | 'agent_message_chunk';
      readonly content: { readonly type: 'text'; readonly text: string };
    }
  | {
      readonly sessionUpdate: 'tool_call';
      readonly toolCallId: string;
      readonly title: string;
      readonly kind: AcpToolKind;
      readonly status: 'pending';
      readonly rawInput: unknown;
      readonly locations?: readonly { readonly path: string }[];
    }
  | {
      readonly sessionUpdate: 'tool_call_update';
      readonly toolCallId: string;
      readonly status: 'in_progress' | 'completed' | 'failed';
      readonly content?: readonly {
        readonly type: 'content';
        readonly content: { readonly type: 'text'; readonly text: string };
      }[];
    };

export type AcpToolKind =
  'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

const KINDS: Readonly<Record<string, AcpToolKind>> = {
  read_file: 'read',
  list_files: 'read',
  search_text: 'search',
  search_tools: 'search',
  write_file: 'edit',
  edit_file: 'edit',
  save_memory: 'edit',
  run_command: 'execute',
  delegate_task: 'think',
  await_subagent: 'think',
  cancel_subagent: 'think',
};

export function toolKind(name: string): AcpToolKind {
  return KINDS[name] ?? 'other';
}

/** A short human-readable title such as `read_file README.md`. */
export function toolTitle(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  const { path, command, role, query, title } = call.arguments;
  const detail = [path, command, role, query, title].find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return (detail === undefined ? call.name : `${call.name} ${detail}`).slice(0, 200);
}

/** ACP locations must be absolute; workspace-relative path arguments are resolved. */
function locations(call: ToolCall, workspaceRoot: string): { path: string }[] | undefined {
  const path = call.arguments.path;
  if (typeof path !== 'string' || path === '') return undefined;
  return [{ path: isAbsolute(path) ? path : join(workspaceRoot, path) }];
}

function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

/** Converts transcript entries into the updates a client would have seen live. */
export function entryUpdates(
  entries: readonly TurnEntry[],
  workspaceRoot: string,
  options: { readonly includeUser: boolean },
): AcpSessionUpdate[] {
  const updates: AcpSessionUpdate[] = [];
  for (const entry of entries) {
    if (entry.kind === 'user_message') {
      if (options.includeUser)
        updates.push({ sessionUpdate: 'user_message_chunk', content: text(entry.content) });
    } else if (entry.kind === 'assistant_message') {
      if (entry.content !== null && entry.content !== '')
        updates.push({ sessionUpdate: 'agent_message_chunk', content: text(entry.content) });
      for (const call of entry.toolCalls) {
        const where = locations(call, workspaceRoot);
        updates.push({
          sessionUpdate: 'tool_call',
          toolCallId: call.id,
          title: toolTitle(call),
          kind: toolKind(call.name),
          status: 'pending',
          rawInput: call.arguments,
          ...(where === undefined ? {} : { locations: where }),
        });
      }
    } else {
      const output = JSON.stringify(entry.output);
      updates.push({
        sessionUpdate: 'tool_call_update',
        toolCallId: entry.toolCallId,
        status: entry.outcome === 'success' ? 'completed' : 'failed',
        content: [
          {
            type: 'content',
            content: text(
              output.length > MAX_TOOL_CONTENT_CHARACTERS
                ? `${output.slice(0, MAX_TOOL_CONTENT_CHARACTERS)}… (truncated)`
                : output,
            ),
          },
        ],
      });
    }
  }
  return updates;
}

/** Every turn of a saved session, for `session/load`. */
export function replayUpdates(session: Session, workspaceRoot: string): AcpSessionUpdate[] {
  return session.turns.flatMap((turn) =>
    entryUpdates(turn.entries, workspaceRoot, { includeUser: true }),
  );
}

/**
 * Tracks how many entries of the active turn were already streamed, so each
 * `SessionUpdated` event yields only new messages, tool calls and results.
 */
export class TurnUpdateTracker {
  readonly #seen = new Map<string, number>();

  public constructor(private readonly workspaceRoot: string) {}

  public next(session: Session): AcpSessionUpdate[] {
    const turn = session.turns.at(-1);
    if (turn === undefined) return [];
    const seen = this.#seen.get(turn.id) ?? 0;
    if (turn.entries.length <= seen) return [];
    this.#seen.set(turn.id, turn.entries.length);
    // The client sent the user message itself.
    return entryUpdates(turn.entries.slice(seen), this.workspaceRoot, { includeUser: false });
  }
}
