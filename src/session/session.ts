import type { ModelCallId, SessionId, TurnId } from '../ids.js';
import type { Turn } from './turn.js';

export interface Session {
  readonly id: SessionId;
  readonly turns: readonly Turn[];
  readonly contextCheckpoint?: ContextCheckpoint;
}

/** A model-facing summary of a terminal prefix; the original turns remain intact. */
export interface ContextCheckpoint {
  readonly version: 1;
  readonly coveredTurnIds: readonly TurnId[];
  readonly summary: string;
  readonly modelCallId: ModelCallId;
}
