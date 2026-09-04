import type { SessionId } from '../ids.js';
import type { Session } from './session.js';

export interface SessionStore {
  get(sessionId: SessionId): Promise<Session | undefined>;
  save(session: Session): Promise<void>;
}
