import type { SessionId } from '../ids.js';
import type { Turn } from './turn.js';

export interface Session {
  readonly id: SessionId;
  readonly turns: readonly Turn[];
}
