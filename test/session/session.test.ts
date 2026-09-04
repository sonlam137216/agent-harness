import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import type { JsonValue } from '../../src/json.js';
import type { Session } from '../../src/session/session.js';
import type { Turn, TurnEntry } from '../../src/session/turn.js';

describe('session state', () => {
  it('represents a provider-neutral model/tool transcript', () => {
    const toolCallId = createToolCallId();
    const entries = [
      {
        kind: 'user_message',
        content: 'Read package.json',
      },
      {
        kind: 'assistant_message',
        modelCallId: createModelCallId(),
        content: null,
        toolCalls: [
          {
            id: toolCallId,
            name: 'read_file',
            arguments: { path: 'package.json' },
          },
        ],
      },
      {
        kind: 'tool_result',
        toolCallId,
        outcome: 'success',
        output: { content: '{"name":"agent-harness"}' },
      },
      {
        kind: 'assistant_message',
        modelCallId: createModelCallId(),
        content: 'The package is named agent-harness.',
        toolCalls: [],
      },
    ] satisfies readonly TurnEntry[];
    const turn: Turn = {
      id: createTurnId(),
      status: 'completed',
      entries,
    };
    const session: Session = {
      id: createSessionId(),
      turns: [turn],
    };

    expect(session.turns[0]?.entries).toEqual(entries);
    expect(entries[2]?.toolCallId).toBe(toolCallId);
  });

  it('keeps transcript payloads JSON-shaped and immutable by contract', () => {
    expectTypeOf<Turn['entries']>().toEqualTypeOf<readonly TurnEntry[]>();
    expectTypeOf<JsonValue>().toMatchTypeOf<
      string | number | boolean | null | readonly JsonValue[] | Readonly<Record<string, JsonValue>>
    >();
  });
});
