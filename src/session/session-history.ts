import type { SessionId } from '../ids.js';
import type { TokenUsage } from '../model/sampling-types.js';
import type { Session, SessionMetadata } from './session.js';
import type { TurnEntry, TurnStatus } from './turn.js';

export class SessionStateError extends Error {
  public override readonly name = 'SessionStateError';
}
export interface SessionSummary {
  readonly id: SessionId;
  readonly metadata?: SessionMetadata;
  readonly turnCount: number;
  readonly status: TurnStatus | 'empty';
  readonly usage: TokenUsage;
}

export function summarizeSession(session: Session): SessionSummary {
  const usage = (session.usage ?? []).reduce<TokenUsage>(
    (sum, record) => ({
      inputTokens: sum.inputTokens + record.tokens.inputTokens,
      outputTokens: sum.outputTokens + record.tokens.outputTokens,
      cachedInputTokens: (sum.cachedInputTokens ?? 0) + (record.tokens.cachedInputTokens ?? 0),
      reasoningTokens: (sum.reasoningTokens ?? 0) + (record.tokens.reasoningTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
  );
  return {
    id: session.id,
    ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
    turnCount: session.turns.length,
    status: session.turns.at(-1)?.status ?? 'empty',
    usage,
  };
}

/** Never replay pending calls. Explicitly record that a durable result is unavailable. */
export function recoverInterruptedSession(session: Session): Session {
  return {
    ...session,
    turns: session.turns.map((turn) => {
      const pending = new Set<string>();
      for (const entry of turn.entries) {
        if (entry.kind === 'assistant_message')
          for (const call of entry.toolCalls) pending.add(call.id);
        if (entry.kind === 'tool_result') pending.delete(entry.toolCallId);
      }
      if (turn.status !== 'in_progress' && pending.size === 0) return turn;
      const entries: TurnEntry[] = [...turn.entries];
      for (const entry of turn.entries) {
        if (entry.kind !== 'assistant_message') continue;
        for (const call of entry.toolCalls)
          if (pending.has(call.id))
            entries.push({
              kind: 'tool_result',
              toolCallId: call.id,
              outcome: 'error',
              output: {
                error: {
                  code: 'execution_unknown',
                  message:
                    'No durable result was recorded for this call. It may have executed. Do not automatically retry it.',
                },
              },
            });
      }
      return { ...turn, status: 'interrupted' as const, entries };
    }),
  };
}

export function rewindSession(session: Session, keepTurns: number): Session {
  if (!Number.isSafeInteger(keepTurns) || keepTurns < 0 || keepTurns > session.turns.length) {
    throw new SessionStateError(
      'Rewind requires a retained turn count within the session history.',
    );
  }
  const turns = session.turns.slice(0, keepTurns);
  if (turns.some((turn) => turn.status === 'in_progress'))
    throw new SessionStateError('Cannot retain an in-progress turn when rewinding.');
  const ids = new Set(turns.map((turn) => turn.id));
  const { contextCheckpoint, ...rest } = session;
  return {
    ...rest,
    turns,
    ...(session.metadata === undefined
      ? {}
      : { metadata: { ...session.metadata, updatedAt: new Date().toISOString() } }),
    ...(session.usage === undefined
      ? {}
      : { usage: session.usage.filter((record) => ids.has(record.turnId)) }),
    ...(contextCheckpoint !== undefined && contextCheckpoint.coveredTurnIds.length <= keepTurns
      ? { contextCheckpoint }
      : {}),
  };
}
