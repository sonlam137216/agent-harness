import type { SessionId } from '../ids.js';
import type { Session } from './session.js';
import type { SessionStore } from './session-store.js';
import { summarizeSession, type SessionSummary } from './session-history.js';
import { RecordStorageError } from '../workspace/record-storage.js';

export class InMemorySessionStore implements SessionStore {
  readonly #sessions = new Map<SessionId, Session>();
  readonly #locked = new Set<SessionId>();

  public list(): Promise<readonly SessionSummary[]> {
    return Promise.resolve([...this.#sessions.values()].map(summarizeSession));
  }
  public async withSessionLock<T>(id: SessionId, run: () => Promise<T>): Promise<T> {
    if (this.#locked.has(id)) throw new RecordStorageError('busy');
    this.#locked.add(id);
    try {
      return await run();
    } finally {
      this.#locked.delete(id);
    }
  }

  public get(sessionId: SessionId): Promise<Session | undefined> {
    return Promise.resolve(this.#sessions.get(sessionId));
  }

  public save(session: Session): Promise<void> {
    this.#sessions.set(session.id, session);
    return Promise.resolve();
  }
}
