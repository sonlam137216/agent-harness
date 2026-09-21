import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/events/event-bus.js';
import { persistenceSubscriber } from '../../src/events/persistence-subscriber.js';
import { createModelCallId, createSessionId, createTurnId } from '../../src/ids.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';

const correlation = { sessionId: createSessionId(), turnId: createTurnId() };

describe('EventBus', () => {
  it('bounds an observer that never settles and still delivers to later observers', async () => {
    const bus = new EventBus(10);
    const seen = vi.fn();
    bus.subscribe(() => new Promise(() => undefined));
    bus.subscribe(seen);
    await bus.publish({ type: 'TurnStarted', ...correlation });
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it('isolates observer errors, freezes data, and supports unsubscribe', async () => {
    const bus = new EventBus();
    const seen = vi.fn();
    bus.subscribe(() => {
      throw new Error('observer failure');
    });
    bus.subscribe((event) => {
      expect(Object.isFrozen(event)).toBe(true);
    });
    const remove = bus.subscribe(seen);
    await bus.publish({ type: 'TurnStarted', ...correlation });
    remove();
    await bus.publish({ type: 'TurnStarted', ...correlation });
    expect(seen).toHaveBeenCalledTimes(1);
  });
  it('persists only canonical snapshots through SessionStore', async () => {
    const store = new InMemorySessionStore();
    const bus = new EventBus();
    bus.subscribe(persistenceSubscriber(store), { required: true });
    await bus.publish({ type: 'TurnStarted', ...correlation });
    expect(await store.get(correlation.sessionId)).toBeUndefined();
    const session = { id: correlation.sessionId, turns: [] };
    await bus.publish({ type: 'SessionUpdated', ...correlation, session });
    expect(await store.get(session.id)).toEqual(session);
  });
  it('surfaces required persistence failures while still notifying other subscribers', async () => {
    const bus = new EventBus();
    const seen = vi.fn();
    const cause = new Error('storage failure');
    bus.subscribe(
      () => {
        throw cause;
      },
      { required: true },
    );
    bus.subscribe(seen);
    await expect(
      bus.publish({
        type: 'SessionUpdated',
        ...correlation,
        session: { id: correlation.sessionId, turns: [] },
      }),
    ).rejects.toMatchObject({ name: 'EventSubscriberError', cause });
    expect(seen).toHaveBeenCalledTimes(1);
    await expect(
      bus.publish({ type: 'ModelStarted', ...correlation, modelCallId: createModelCallId() }),
    ).resolves.toBeUndefined();
  });
});
