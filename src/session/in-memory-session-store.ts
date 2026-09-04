import type { SessionId } from '../ids.js';
import type { Session } from './session.js';
import type { SessionStore } from './session-store.js';

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<SessionId, Session>();

  public get(sessionId: SessionId): Promise<Session | undefined> {
    return Promise.resolve(this.#sessions.get(sessionId));
  }

  public save(session: Session): Promise<void> {
    this.#sessions.set(session.id, session);
    return Promise.resolve();
  }
}
