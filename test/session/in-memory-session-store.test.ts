import { describe, expect, it } from 'vitest';

import { createSessionId, createTurnId } from '../../src/ids.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import type { Session } from '../../src/session/session.js';

describe('InMemorySessionStore', () => {
  it('returns undefined when a session does not exist', async () => {
    const store = new InMemorySessionStore();

    await expect(store.get(createSessionId())).resolves.toBeUndefined();
  });

  it('saves and retrieves a session by its branded ID', async () => {
    const store = new InMemorySessionStore();
    const session: Session = {
      id: createSessionId(),
      turns: [],
    };

    await store.save(session);

    await expect(store.get(session.id)).resolves.toBe(session);
  });

  it('replaces the state stored under the same session ID', async () => {
    const store = new InMemorySessionStore();
    const sessionId = createSessionId();
    const initial: Session = {
      id: sessionId,
      turns: [],
    };
    const updated: Session = {
      id: sessionId,
      turns: [
        {
          id: createTurnId(),
          status: 'in_progress',
          entries: [],
        },
      ],
    };

    await store.save(initial);
    await store.save(updated);

    await expect(store.get(sessionId)).resolves.toBe(updated);
  });
});
