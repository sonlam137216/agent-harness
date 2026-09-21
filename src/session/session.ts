import type { ModelCallId, SessionId, TurnId } from '../ids.js';
import type { Turn } from './turn.js';
import type { AgentDefinition } from '../agent/agent-definition.js';
import type { StopReason, TokenUsage } from '../model/sampling-types.js';

export interface SessionMetadata {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly agent: AgentDefinition;
  readonly workspaceRoot?: string;
  /** Opaque application label, never provider credentials or SDK configuration. */
  readonly provider?: string;
  readonly contextBudget?: { readonly windowTokens: number; readonly outputReserveTokens: number };
  readonly rulesDirectory?: string;
}

export interface ModelUsageRecord {
  readonly modelCallId: ModelCallId;
  readonly turnId: TurnId;
  readonly modelId: string;
  readonly purpose: 'response' | 'compaction';
  readonly tokens: TokenUsage;
  readonly stopReason: StopReason;
}

export interface Session {
  readonly id: SessionId;
  readonly turns: readonly Turn[];
  readonly contextCheckpoint?: ContextCheckpoint;
  readonly metadata?: SessionMetadata;
  readonly usage?: readonly ModelUsageRecord[];
}

/** A model-facing summary of a terminal prefix; the original turns remain intact. */
export interface ContextCheckpoint {
  readonly version: 1;
  readonly coveredTurnIds: readonly TurnId[];
  readonly summary: string;
  readonly modelCallId: ModelCallId;
  readonly usage?: TokenUsage;
}
