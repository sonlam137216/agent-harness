import type { SessionStore } from '../session/session-store.js';
import type { EventSubscriber } from './event-bus.js';

export function persistenceSubscriber(store: SessionStore): EventSubscriber {
  return async (event) => {
    if (event.type === 'SessionUpdated') await store.save(event.session);
  };
}
