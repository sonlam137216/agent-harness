import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import { createTracing } from '../../src/observability/tracing.js';
import { FileSessionStore } from '../../src/session/file-session-store.js';
import { decodeSession, encodeSession } from '../../src/session/session-codec.js';
import { recoverInterruptedSession, rewindSession } from '../../src/session/session-history.js';
import type { Session } from '../../src/session/session.js';
import { LocalRecordStorage } from '../../src/workspace/local-record-storage.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
function fixture(): Session {
  const modelCallId = createModelCallId();
  const turnId = createTurnId();
  const toolCallId = createToolCallId();
  return {
    id: createSessionId(),
    metadata: {
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      agent: { name: 'test', systemPrompt: 'private-instructions', model: { modelId: 'model' } },
      workspaceRoot: '/workspace',
      provider: 'ollama',
    },
    turns: [
      {
        id: turnId,
        status: 'completed',
        traceId: '1'.repeat(32),
        entries: [
          { kind: 'user_message', content: 'private-prompt' },
          {
            kind: 'assistant_message',
            modelCallId,
            content: null,
            toolCalls: [{ id: toolCallId, name: 'read_file', arguments: { path: 'private-path' } }],
          },
          {
            kind: 'tool_result',
            toolCallId,
            outcome: 'success',
            output: { text: 'private-result' },
          },
        ],
      },
    ],
    usage: [
      {
        modelCallId,
        turnId,
        modelId: 'model',
        purpose: 'response',
        tokens: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 },
        stopReason: 'tool_calls',
      },
    ],
    contextCheckpoint: {
      version: 1,
      coveredTurnIds: [turnId],
      modelCallId: createModelCallId(),
      summary: 'private-summary',
    },
  };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'session-store-'));
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({ exporter });
  cleanup.push(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, 'sessions');
  const storage = new LocalRecordStorage(directory);
  return {
    directory,
    exporter,
    storage,
    store: new FileSessionStore(storage, tracing.tracer),
    reopen: () => new FileSessionStore(new LocalRecordStorage(directory), tracing.tracer),
  };
}

describe('FileSessionStore', () => {
  it('round-trips metadata, tools, usage, checkpoint and correlation through a new store instance', async () => {
    const f = await setup();
    const session = fixture();
    await f.store.withSessionLock(session.id, () => f.store.save(session));
    expect(await f.reopen().get(session.id)).toEqual(session);
    expect(await f.reopen().list()).toMatchObject([
      {
        id: session.id,
        turnCount: 1,
        status: 'completed',
        usage: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 2 },
      },
    ]);
    expect((await stat(join(f.directory, `${session.id}.json`))).mode & 0o777).toBe(0o600);
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    const spans = f.exporter.getFinishedSpans();
    expect(spans.some((span) => span.attributes['session.id'] === session.id)).toBe(true);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('private-');
  });
  it('returns empty list/missing session without creating the data directory', async () => {
    const f = await setup();
    expect(await f.store.list()).toEqual([]);
    expect(await f.store.get(createSessionId())).toBeUndefined();
    await expect(stat(f.directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['not json', '{"version":99}', '{"version":1,"session":null}'])(
    'rejects malformed/versioned data and refuses to overwrite it: %s',
    async (content) => {
      const f = await setup();
      const session = fixture();
      await f.store.save(session);
      await writeFile(join(f.directory, `${session.id}.json`), content);
      await expect(f.store.get(session.id)).rejects.toMatchObject({ name: 'SessionFormatError' });
      await expect(f.store.list()).rejects.toMatchObject({ name: 'SessionFormatError' });
      await expect(f.store.save(session)).rejects.toMatchObject({ name: 'SessionFormatError' });
      expect(await readFile(join(f.directory, `${session.id}.json`), 'utf8')).toBe(content);
    },
  );
  it('excludes a second store from a locked session and releases on error', async () => {
    const f = await setup();
    const id = createSessionId();
    await f.store.withSessionLock(id, async () => {
      await expect(f.reopen().withSessionLock(id, () => Promise.resolve())).rejects.toMatchObject({
        code: 'busy',
      });
    });
    await expect(
      f.store.withSessionLock(id, () => Promise.reject(new Error('operation failed'))),
    ).rejects.toThrow('operation failed');
    await expect(f.reopen().withSessionLock(id, () => Promise.resolve(42))).resolves.toBe(42);
  });
});

describe('session codec and history', () => {
  it('rejects a filename/session ID mismatch and malformed turn groups, usage and checkpoint', () => {
    const session = fixture();
    expect(() => decodeSession(encodeSession(session), createSessionId())).toThrow();
    const turn = session.turns[0]!;
    for (const malformed of [
      { ...session, turns: [turn, turn] },
      { ...session, turns: [{ ...turn, entries: turn.entries.slice(0, 2) }] },
      {
        ...session,
        usage: [{ ...session.usage![0]!, tokens: { inputTokens: -1, outputTokens: 0 } }],
      },
      {
        ...session,
        contextCheckpoint: { ...session.contextCheckpoint!, coveredTurnIds: [createTurnId()] },
      },
      { ...session, turns: [{ ...turn, entries: [turn.entries[0]!, turn.entries[2]!] }] },
    ])
      expect(() => encodeSession(malformed)).toThrow();
  });
  it('marks interrupted calls as execution unknown without changing recorded results or replaying tools', () => {
    const base = fixture();
    const { contextCheckpoint: _checkpoint, ...session } = base;
    void _checkpoint;
    const active: Session = {
      ...session,
      turns: [
        {
          ...session.turns[0]!,
          status: 'in_progress',
          entries: session.turns[0]!.entries.slice(0, 2),
        },
      ],
    };
    const recovered = recoverInterruptedSession(decodeSession(encodeSession(active), active.id));
    expect(recovered.turns[0]?.status).toBe('interrupted');
    expect(recovered.turns[0]?.entries[2]).toMatchObject({
      kind: 'tool_result',
      outcome: 'error',
      output: { error: { code: 'execution_unknown' } },
    });
    expect(active.turns[0]?.entries).toHaveLength(2);
    expect(recoverInterruptedSession(recovered)).toEqual(recovered);
    expect(() => encodeSession(recovered)).not.toThrow();
  });
  it('rewinds only complete turns, prunes usage and invalidates covered checkpoints', () => {
    const session = fixture();
    expect(rewindSession(session, 1).contextCheckpoint).toEqual(session.contextCheckpoint);
    const empty = rewindSession(session, 0);
    expect(empty.turns).toEqual([]);
    expect(empty.usage).toEqual([]);
    expect(empty.contextCheckpoint).toBeUndefined();
    expect(session.turns).toHaveLength(1);
    expect(() => rewindSession(session, 2)).toThrow();
    expect(() => rewindSession(session, -1)).toThrow();
    expect(() =>
      rewindSession({ ...session, turns: [{ ...session.turns[0]!, status: 'in_progress' }] }, 1),
    ).toThrow();
  });
});
