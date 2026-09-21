import type { SessionId } from '../ids.js';
import type { Session } from './session.js';
import type { SessionSummary } from './session-history.js';

export interface SessionStore {
  get(sessionId: SessionId): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
  list(): Promise<readonly SessionSummary[]>;
  withSessionLock<T>(sessionId: SessionId, run: () => Promise<T>): Promise<T>;
}
