import type { EventSubscriber } from '../events/event-bus.js';
import type { JsonObject, JsonValue } from '../json.js';
import { toolTitle } from '../protocol/acp-updates.js';
import type { ToolCall, TurnEntry } from '../session/turn.js';
import { visible } from './terminal-approval.js';

const MAX_NOTE_CHARACTERS = 160;

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > MAX_NOTE_CHARACTERS ? `${line.slice(0, MAX_NOTE_CHARACTERS)}…` : line;
}

/** Commands show their argv (bounded); other tools use the shared short title. */
function callTitle(call: ToolCall): string {
  const { command, args } = call.arguments;
  if (call.name !== 'run_command' || typeof command !== 'string') return toolTitle(call);
  const words = Array.isArray(args) ? args.filter((arg) => typeof arg === 'string') : [];
  return firstLine(`run_command ${[command, ...words].join(' ')}`);
}

function describeResult(entry: Extract<TurnEntry, { kind: 'tool_result' }>, tool: string) {
  const output = isRecord(entry.output) ? entry.output : {};
  if (entry.outcome === 'error') {
    const error = isRecord(output.error) ? output.error : {};
    const code = typeof error.code === 'string' ? error.code : 'error';
    const message = typeof error.message === 'string' ? `: ${firstLine(error.message)}` : '';
    return `  ✗ ${code}${message}`;
  }
  if (tool === 'run_command') {
    if (output.timedOut === true) return '  ✗ timed out';
    const exitCode = typeof output.exitCode === 'number' ? String(output.exitCode) : 'unknown';
    return `  ${output.exitCode === 0 ? '✓' : '✗'} exit ${exitCode}`;
  }
  return undefined;
}

/**
 * Writes one terminal line per tool call, failed result and command exit, derived from
 * `SessionUpdated` transcript snapshots, so a long turn is visibly making progress. The
 * final answer is not repeated; it is presentation output of the run itself.
 */
export function createProgressReporter(writeLine: (line: string) => void): EventSubscriber {
  const seen = new Map<string, number>();
  const tools = new Map<string, string>();
  return (event) => {
    if (event.type !== 'SessionUpdated') return;
    const turn = event.session.turns.at(-1);
    // Only the running turn; a resumed session's earlier turns are not replayed.
    if (turn === undefined || (turn.status !== 'in_progress' && !seen.has(turn.id))) return;
    const start = seen.get(turn.id) ?? 1; // the user's own message is not echoed
    if (turn.entries.length <= start) return;
    seen.set(turn.id, turn.entries.length);
    for (const entry of turn.entries.slice(start)) {
      if (entry.kind === 'assistant_message') {
        if (entry.toolCalls.length === 0) continue;
        if (entry.content !== null && entry.content.trim() !== '')
          writeLine(`  ${visible(firstLine(entry.content))}`);
        for (const call of entry.toolCalls) {
          tools.set(call.id, call.name);
          writeLine(`→ ${visible(callTitle(call))}`);
        }
      } else if (entry.kind === 'tool_result') {
        const line = describeResult(entry, tools.get(entry.toolCallId) ?? '');
        if (line !== undefined) writeLine(visible(line));
      }
    }
  };
}
