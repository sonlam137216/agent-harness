import { randomUUID } from 'node:crypto';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
  type ModelCallId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from '../src/ids.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('application correlation IDs', () => {
  it('creates opaque UUID values', () => {
    const ids = [createSessionId(), createTurnId(), createModelCallId(), createToolCallId()];

    expect(ids).toHaveLength(new Set(ids).size);
    for (const id of ids) {
      expect(id).toMatch(UUID_PATTERN);
    }

    expect(randomUUID()).toMatch(UUID_PATTERN);
  });

  it('keeps ID categories distinct at compile time', () => {
    expectTypeOf<SessionId>().not.toEqualTypeOf<TurnId>();
    expectTypeOf<ModelCallId>().not.toEqualTypeOf<ToolCallId>();
  });
});
