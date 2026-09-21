import { validRecordKey } from '../workspace/record-storage.js';
import type { Session } from './session.js';

export class SessionFormatError extends Error {
  public override readonly name = 'SessionFormatError';
  public readonly retryable = false;
  public constructor(
    public readonly code: 'invalid_session' | 'unsupported_version',
    cause?: unknown,
  ) {
    super(
      code === 'unsupported_version'
        ? 'This session uses an unsupported file version.'
        : 'The saved session is invalid or corrupted.',
      cause === undefined ? undefined : { cause },
    );
  }
}
function fail(): never {
  throw new SessionFormatError('invalid_session');
}
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  if (keys !== undefined && Object.keys(value).some((key) => !keys.includes(key))) fail();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') fail();
  return value;
}
function nonempty(value: unknown): string {
  const result = string(value);
  if (result.trim().length === 0) fail();
  return result;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail();
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
function timestamp(value: unknown): void {
  if (!Number.isFinite(Date.parse(string(value)))) fail();
}
function usage(value: unknown): void {
  const item = object(value, [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'reasoningTokens',
  ]);
  integer(item.inputTokens);
  integer(item.outputTokens);
  if (item.cachedInputTokens !== undefined) integer(item.cachedInputTokens);
  if (item.reasoningTokens !== undefined) integer(item.reasoningTokens);
}
function json(value: unknown, depth = 0): void {
  if (depth > 100) fail();
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const child of value) json(child, depth + 1);
    return;
  }
  for (const child of Object.values(object(value))) json(child, depth + 1);
}

/** Validate before crossing the durable boundary; no provider-specific wire items are accepted. */
export function validateSession(value: unknown, expectedId?: string): asserts value is Session {
  const session = object(value, ['id', 'turns', 'metadata', 'usage', 'contextCheckpoint']);
  const id = string(session.id);
  if (!validRecordKey(id) || (expectedId !== undefined && id !== expectedId)) fail();
  const turnIds = new Set<string>();
  const modelIds = new Map<string, string>();
  const turns = array(session.turns);
  for (const [index, rawTurn] of turns.entries()) {
    const turn = object(rawTurn, ['id', 'status', 'entries', 'traceId']);
    const turnId = nonempty(turn.id);
    if (turnIds.has(turnId)) fail();
    turnIds.add(turnId);
    if (
      !['in_progress', 'completed', 'failed', 'cancelled', 'interrupted'].includes(
        string(turn.status),
      )
    )
      fail();
    if (turn.status === 'in_progress' && index !== turns.length - 1) fail();
    if (turn.traceId !== undefined && !/^[0-9a-f]{32}$/u.test(string(turn.traceId))) fail();
    const entries = array(turn.entries);
    if (entries.length === 0 || object(entries[0]).kind !== 'user_message') fail();
    const pending = new Set<string>();
    const seenCalls = new Set<string>();
    for (const [entryIndex, raw] of entries.entries()) {
      const entry = object(raw);
      if (entry.kind === 'tool_result') {
        object(entry, ['kind', 'toolCallId', 'outcome', 'output']);
        if (!pending.delete(nonempty(entry.toolCallId))) fail();
        if (entry.outcome !== 'success' && entry.outcome !== 'error') fail();
        json(entry.output);
      } else {
        if (pending.size !== 0) fail();
        if (entry.kind === 'user_message') {
          object(entry, ['kind', 'content']);
          if (entryIndex !== 0) fail();
          string(entry.content);
        } else if (entry.kind === 'assistant_message') {
          object(entry, ['kind', 'modelCallId', 'content', 'toolCalls']);
          const modelId = nonempty(entry.modelCallId);
          if (modelIds.has(modelId)) fail();
          modelIds.set(modelId, turnId);
          if (entry.content !== null) string(entry.content);
          for (const rawCall of array(entry.toolCalls)) {
            const call = object(rawCall, ['id', 'name', 'arguments']);
            const callId = nonempty(call.id);
            if (seenCalls.has(callId)) fail();
            seenCalls.add(callId);
            pending.add(callId);
            nonempty(call.name);
            object(call.arguments);
            json(call.arguments);
          }
        } else fail();
      }
    }
    if (pending.size !== 0 && turn.status === 'completed') fail();
  }
  if (session.metadata !== undefined) {
    const metadata = object(session.metadata, [
      'createdAt',
      'updatedAt',
      'agent',
      'workspaceRoot',
      'provider',
      'contextBudget',
      'rulesDirectory',
    ]);
    timestamp(metadata.createdAt);
    timestamp(metadata.updatedAt);
    const agent = object(metadata.agent, ['name', 'systemPrompt', 'model']);
    nonempty(agent.name);
    string(agent.systemPrompt);
    nonempty(object(agent.model, ['modelId']).modelId);
    for (const key of ['workspaceRoot', 'provider', 'rulesDirectory'])
      if (metadata[key] !== undefined) nonempty(metadata[key]);
    if (metadata.contextBudget !== undefined) {
      const budget = object(metadata.contextBudget, ['windowTokens', 'outputReserveTokens']);
      if (
        integer(budget.outputReserveTokens) < 1 ||
        integer(budget.windowTokens) <= integer(budget.outputReserveTokens)
      )
        fail();
    }
  }
  if (session.usage !== undefined) {
    const seenUsage = new Set<string>();
    for (const raw of array(session.usage)) {
      const record = object(raw, [
        'modelCallId',
        'turnId',
        'modelId',
        'purpose',
        'tokens',
        'stopReason',
      ]);
      const id = nonempty(record.modelCallId);
      if (seenUsage.has(id) || !turnIds.has(nonempty(record.turnId))) fail();
      seenUsage.add(id);
      nonempty(record.modelId);
      if (record.purpose !== 'response' && record.purpose !== 'compaction') fail();
      if (record.purpose === 'response' && modelIds.get(id) !== record.turnId) fail();
      if (record.purpose === 'compaction' && modelIds.has(id)) fail();
      if (
        !['end_turn', 'tool_calls', 'max_output_tokens', 'content_filtered', 'unknown'].includes(
          string(record.stopReason),
        )
      )
        fail();
      usage(record.tokens);
    }
  }
  if (session.contextCheckpoint !== undefined) {
    const checkpoint = object(session.contextCheckpoint, [
      'version',
      'coveredTurnIds',
      'summary',
      'modelCallId',
      'usage',
    ]);
    if (checkpoint.version !== 1) fail();
    nonempty(checkpoint.summary);
    nonempty(checkpoint.modelCallId);
    const covered = array(checkpoint.coveredTurnIds);
    if (covered.length === 0 || covered.length > turns.length) fail();
    for (const [index, id] of covered.entries()) {
      const turn = object(turns[index]);
      if (turn.id !== id || turn.status === 'in_progress') fail();
      const pending = new Set<string>();
      for (const raw of array(turn.entries)) {
        const entry = object(raw);
        if (entry.kind === 'assistant_message')
          for (const call of array(entry.toolCalls)) pending.add(string(object(call).id));
        if (entry.kind === 'tool_result') pending.delete(string(entry.toolCallId));
      }
      if (pending.size !== 0) fail();
    }
    if (checkpoint.usage !== undefined) usage(checkpoint.usage);
  }
}

export function decodeSession(content: string, expectedId: string): Session {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new SessionFormatError('invalid_session');
  }
  const document = object(parsed, ['version', 'session']);
  if (document.version !== 1) throw new SessionFormatError('unsupported_version');
  validateSession(document.session, expectedId);
  return document.session;
}
export function encodeSession(session: Session): string {
  validateSession(session);
  return JSON.stringify({ version: 1, session });
}
