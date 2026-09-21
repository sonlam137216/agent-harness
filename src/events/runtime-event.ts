import type { ModelCallId, SessionId, ToolCallId, TurnId } from '../ids.js';
import type { Session } from '../session/session.js';

interface Correlation {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}
type LifecycleFact =
  | { readonly type: 'SessionStarted' | 'TurnStarted' }
  | { readonly type: 'TurnCompleted'; readonly outcome: string }
  | { readonly type: 'SessionUpdated'; readonly session: Session }
  | { readonly type: 'ModelStarted'; readonly modelCallId: ModelCallId }
  | {
      readonly type: 'ModelCompleted';
      readonly modelCallId: ModelCallId;
      readonly success: boolean;
    }
  | {
      readonly type: 'ToolStarted';
      readonly modelCallId: ModelCallId;
      readonly toolCallId: ToolCallId;
    }
  | {
      readonly type: 'ToolCompleted';
      readonly modelCallId: ModelCallId;
      readonly toolCallId: ToolCallId;
      readonly success: boolean;
    };

/** Canonical in-process lifecycle facts. SessionUpdated is private application data, not telemetry. */
export type RuntimeEvent = Correlation & LifecycleFact;
