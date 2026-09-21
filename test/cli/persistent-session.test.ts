import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseSessionCommand,
  prepareSessionRun,
  runSessionCommand,
} from '../../src/cli/session-cli.js';
import { runPhaseOneCli } from '../../src/cli/phase-one-cli.js';
import { HookRegistry } from '../../src/hooks/hook-registry.js';
import { createSessionId, createToolCallId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import { createTracing } from '../../src/observability/tracing.js';
import { FileSessionStore } from '../../src/session/file-session-store.js';
import { LocalRecordStorage } from '../../src/workspace/local-record-storage.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'persistent-cli-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  await writeFile(join(workspace, 'fixture.txt'), 'persistent evidence');
  const tracing = createTracing({ exporter: new InMemorySpanExporter() });
  cleanups.push(async () => {
    await tracing.shutdown();
    await rm(root, { force: true, recursive: true });
  });
  const openStore = () =>
    new FileSessionStore(new LocalRecordStorage(join(root, 'sessions')), tracing.tracer);
  const store = openStore();
  return {
    root,
    workspace,
    tracing,
    store,
    openStore,
    options: {
      modelId: 'fake',
      prompt: 'read fixture',
      workspaceRoot: workspace,
      userSkillsDirectory: join(root, 'user-skills'),
      tracer: tracing.tracer,
      sessionStore: store,
      provider: 'ollama' as const,
      writeOutput: () => undefined,
    },
  };
}
const finalSampler: Sampler = {
  sample: (request) =>
    Promise.resolve({
      modelCallId: request.modelCallId,
      text: 'finished',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 2 },
      stopReason: 'end_turn',
    }),
};

describe('persistent CLI sessions', () => {
  it.each(['assistant_message', 'tool_result'] as const)(
    'stops on a failed %s save without repeating tools or losing known results',
    async (kind) => {
      const f = await setup();
      const originalSave = f.store.save.bind(f.store);
      let failed = false;
      vi.spyOn(f.store, 'save').mockImplementation(async (session) => {
        if (!failed && session.turns.at(-1)?.entries.at(-1)?.kind === kind) {
          failed = true;
          throw new Error('storage unavailable');
        }
        await originalSave(session);
      });
      const hooks = new HookRegistry();
      const pre = vi.fn();
      hooks.register('PreToolUse', pre);
      let id = createSessionId();
      const sample = vi.fn<Sampler['sample']>((request) =>
        Promise.resolve({
          modelCallId: request.modelCallId,
          text: null,
          toolCalls: [
            { id: createToolCallId(), name: 'read_file', arguments: { path: 'fixture.txt' } },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'tool_calls',
        }),
      );
      await expect(
        runPhaseOneCli({
          ...f.options,
          hooks,
          sampler: { sample },
          onSessionId: (value) => {
            id = value;
          },
        }),
      ).rejects.toMatchObject({ name: 'EventSubscriberError' });
      expect(sample).toHaveBeenCalledTimes(1);
      expect(pre).toHaveBeenCalledTimes(kind === 'tool_result' ? 1 : 0);
      const saved = await f.openStore().get(id);
      expect(saved?.turns[0]?.status).toBe('failed');
      expect(saved?.turns[0]?.entries.at(-1)?.kind).toBe(kind);
      if (kind === 'tool_result')
        expect(saved?.turns[0]?.entries.at(-1)).toMatchObject({ outcome: 'success' });
    },
  );
  it('saves each model/tool boundary, restores configuration/history, lists, inspects and rewinds', async () => {
    const f = await setup();
    let step = 0;
    const hooks = new HookRegistry();
    let id = createSessionId();
    hooks.register('PreToolUse', async () => {
      const snapshot = await f.openStore().get(id);
      expect(snapshot?.turns.at(-1)?.entries.at(-1)?.kind).toBe('assistant_message');
      expect(snapshot?.usage).toHaveLength(1);
    });
    const sampler: Sampler = {
      sample: async (request) => {
        step += 1;
        if (step === 1)
          return {
            modelCallId: request.modelCallId,
            text: null,
            toolCalls: [
              { id: createToolCallId(), name: 'read_file', arguments: { path: 'fixture.txt' } },
            ],
            usage: { inputTokens: 10, outputTokens: 2 },
            stopReason: 'tool_calls',
          };
        const durable = await f.openStore().get(id);
        expect(durable?.turns[0]?.entries.at(-1)).toMatchObject({
          kind: 'tool_result',
          outcome: 'success',
        });
        return {
          modelCallId: request.modelCallId,
          text: 'persistent evidence found',
          toolCalls: [],
          usage: { inputTokens: 20, outputTokens: 3 },
          stopReason: 'end_turn',
        };
      },
    };
    const first = await runPhaseOneCli({
      ...f.options,
      sampler,
      hooks,
      onSessionId: (value) => {
        id = value;
      },
    });
    const command = parseSessionCommand(
      ['--resume', first.session.id, 'continue'],
      '/different-cwd',
    );
    if (command.kind !== 'run') throw new Error('expected run');
    const prepared = await prepareSessionRun(command, {}, '/different-cwd', f.openStore());
    if (prepared.parsed.help) throw new Error('expected config');
    expect(prepared.parsed.config.workspaceRoot).toBe(f.workspace);
    expect(prepared.parsed.provider).toBe('ollama');
    const sample = vi.fn<Sampler['sample']>((request) => {
      expect(JSON.stringify(request.messages)).toContain('persistent evidence found');
      expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'continue' });
      return finalSampler.sample(request);
    });
    const second = await runPhaseOneCli({
      ...f.options,
      ...prepared.parsed.config,
      sampler: { sample },
      sessionStore: f.openStore(),
      sessionId: first.session.id,
      savedAgent: prepared.savedAgent!,
    });
    expect(second.session.turns).toHaveLength(2);
    expect(second.session.metadata?.createdAt).toBe(first.session.metadata?.createdAt);
    expect(second.session.usage).toHaveLength(3);
    const output: string[] = [];
    await runSessionCommand(
      { kind: 'list', directory: '' },
      f.openStore(),
      f.tracing.tracer,
      (text) => output.push(text),
    );
    expect(JSON.parse(output[0]!) as unknown).toMatchObject([
      { id, turnCount: 2, usage: { inputTokens: 35, outputTokens: 7 } },
    ]);
    await runSessionCommand(
      { kind: 'show', directory: '', sessionId: id },
      f.openStore(),
      f.tracing.tracer,
      (text) => output.push(text),
    );
    expect(JSON.parse(output[1]!) as unknown).toEqual(second.session);
    await runSessionCommand(
      { kind: 'rewind', directory: '', sessionId: id, keepTurns: 1 },
      f.openStore(),
      f.tracing.tracer,
      () => undefined,
    );
    const rewound = await f.openStore().get(id);
    expect(rewound?.turns).toHaveLength(1);
    expect(rewound?.usage).toHaveLength(2);
    const third = await runPhaseOneCli({
      ...f.options,
      sessionId: id,
      sampler: finalSampler,
      prompt: 'new branch',
    });
    expect(third.session.turns).toHaveLength(2);
    expect(third.session.turns[1]?.entries[0]).toMatchObject({ content: 'new branch' });
  });
  it('resumes an unresolved failed call as unknown without replaying it', async () => {
    const f = await setup();
    const hooks = new HookRegistry();
    let id = createSessionId();
    hooks.register('AfterModel', () => {
      throw new Error('interrupted after model');
    });
    await expect(
      runPhaseOneCli({
        ...f.options,
        hooks,
        onSessionId: (value) => {
          id = value;
        },
        sampler: {
          sample: (request) =>
            Promise.resolve({
              modelCallId: request.modelCallId,
              text: null,
              toolCalls: [
                { id: createToolCallId(), name: 'read_file', arguments: { path: 'fixture.txt' } },
              ],
              usage: { inputTokens: 1, outputTokens: 1 },
              stopReason: 'tool_calls',
            }),
        },
      }),
    ).rejects.toThrow('AfterModel');
    const sample = vi.fn<Sampler['sample']>((request) => {
      expect(JSON.stringify(request.messages)).toContain('execution_unknown');
      return finalSampler.sample(request);
    });
    const result = await runPhaseOneCli({
      ...f.options,
      sessionStore: f.openStore(),
      sessionId: id,
      sampler: { sample },
    });
    expect(result.session.turns[0]?.status).toBe('interrupted');
    expect(sample).toHaveBeenCalledTimes(1);
  });
  it('rejects overlapping runtime turns and workspace changes before sampling', async () => {
    const f = await setup();
    const first = await runPhaseOneCli({ ...f.options, sampler: finalSampler });
    let release: () => void = () => undefined;
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = runPhaseOneCli({
      ...f.options,
      sessionId: first.session.id,
      sampler: {
        sample: async (request) => {
          entered();
          await gate;
          return finalSampler.sample(request);
        },
      },
    });
    await started;
    const sample = vi.fn<Sampler['sample']>();
    await expect(
      runPhaseOneCli({
        ...f.options,
        sessionStore: f.openStore(),
        sessionId: first.session.id,
        sampler: { sample },
      }),
    ).rejects.toMatchObject({ code: 'busy' });
    release();
    await pending;
    await expect(
      runPhaseOneCli({
        ...f.options,
        workspaceRoot: f.root,
        sessionId: first.session.id,
        sampler: { sample },
      }),
    ).rejects.toThrow('original workspace');
    expect(sample).not.toHaveBeenCalled();
  });
  it('parses model-free management commands and rejects ambiguous/unsafe arguments', () => {
    const id = createSessionId();
    expect(
      parseSessionCommand(['sessions', 'list', '--session-dir', 'data'], '/cwd'),
    ).toMatchObject({ kind: 'list', directory: '/cwd/data' });
    expect(
      parseSessionCommand(['sessions', 'rewind', id, '--keep-turns', '0'], '/cwd'),
    ).toMatchObject({ kind: 'rewind', keepTurns: 0 });
    for (const args of [
      ['--resume', '../escape'],
      ['sessions', 'rewind', id, '--keep-turns', '-1'],
      ['sessions', 'list', '--resume', id],
      ['sessions', 'show'],
      ['--session-dir'],
      ['--resume', id, '--resume', id],
    ]) {
      expect(() => parseSessionCommand(args, '/cwd')).toThrow();
    }
  });
});
