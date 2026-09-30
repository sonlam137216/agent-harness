import { describe, expect, it } from 'vitest';

import { createProgressReporter } from '../../src/cli/progress-reporter.js';
import type { RuntimeEvent } from '../../src/events/runtime-event.js';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
  type TurnId,
} from '../../src/ids.js';
import type { Session } from '../../src/session/session.js';
import type { Turn, TurnEntry } from '../../src/session/turn.js';

const sessionId = createSessionId();
const modelCallId = createModelCallId();

function updated(turns: readonly Turn[]): RuntimeEvent {
  const session: Session = { id: sessionId, turns };
  return { type: 'SessionUpdated', sessionId, turnId: turns.at(-1)!.id, session };
}

function turn(id: TurnId, entries: readonly TurnEntry[], status: Turn['status']): Turn {
  return { id, status, entries: [{ kind: 'user_message', content: 'Fix it.' }, ...entries] };
}

describe('progress reporter', () => {
  it('prints tool calls, failures and command exits once, without the final answer', async () => {
    const lines: string[] = [];
    const report = createProgressReporter((line) => lines.push(line));
    const id = createTurnId();
    const [read, edit, run] = [createToolCallId(), createToolCallId(), createToolCallId()];
    const calls: TurnEntry = {
      kind: 'assistant_message',
      modelCallId,
      content: 'Let me look at the parser.\nMore detail.',
      toolCalls: [
        { id: read, name: 'read_file', arguments: { path: 'src/parse.ts' } },
        {
          id: edit,
          name: 'edit_file',
          arguments: { path: 'src/parse.ts', oldText: 'a', newText: 'b' },
        },
        { id: run, name: 'run_command', arguments: { command: 'pnpm', args: ['test'] } },
      ],
    };
    const results: TurnEntry[] = [
      { kind: 'tool_result', toolCallId: read, outcome: 'success', output: { content: 'x' } },
      {
        kind: 'tool_result',
        toolCallId: edit,
        outcome: 'error',
        output: { error: { code: 'access_denied', message: 'Tool execution was not authorized.' } },
      },
      { kind: 'tool_result', toolCallId: run, outcome: 'success', output: { exitCode: 1 } },
    ];
    const answer: TurnEntry = {
      kind: 'assistant_message',
      modelCallId,
      content: 'Done.',
      toolCalls: [],
    };

    await report(updated([turn(id, [], 'in_progress')]));
    await report(updated([turn(id, [calls], 'in_progress')]));
    await report(updated([turn(id, [calls, ...results], 'in_progress')]));
    await report(updated([turn(id, [calls, ...results], 'in_progress')]));
    await report(updated([turn(id, [calls, ...results, answer], 'completed')]));

    expect(lines).toEqual([
      '  Let me look at the parser.',
      '→ read_file src/parse.ts',
      '→ edit_file src/parse.ts',
      '→ run_command pnpm test',
      '  ✗ access_denied: Tool execution was not authorized.',
      '  ✗ exit 1',
    ]);
  });

  it('does not replay earlier turns of a resumed session and escapes control characters', async () => {
    const lines: string[] = [];
    const report = createProgressReporter((line) => lines.push(line));
    const call = createToolCallId();
    const old = turn(
      createTurnId(),
      [
        {
          kind: 'assistant_message',
          modelCallId,
          content: null,
          toolCalls: [{ id: call, name: 'list_files', arguments: { path: '.' } }],
        },
      ],
      'completed',
    );
    await report(updated([old]));
    expect(lines).toEqual([]);

    const current = createTurnId();
    await report(
      updated([
        old,
        turn(
          current,
          [
            {
              kind: 'assistant_message',
              modelCallId,
              content: null,
              toolCalls: [
                { id: createToolCallId(), name: 'read_file', arguments: { path: 'a\u001b[2J' } },
              ],
            },
          ],
          'in_progress',
        ),
      ]),
    );
    expect(lines).toEqual(['→ read_file a\\u001b[2J']);
  });
});
