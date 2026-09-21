import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { runPhaseOneCli } from '../../src/cli/phase-one-cli.js';
import { parseSessionCommand, prepareSessionRun } from '../../src/cli/session-cli.js';
import { HookRegistry } from '../../src/hooks/hook-registry.js';
import { createToolCallId, type SessionId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import { createTracing } from '../../src/observability/tracing.js';
import { FileSessionStore } from '../../src/session/file-session-store.js';
import { LocalRecordStorage } from '../../src/workspace/local-record-storage.js';

const stage = process.argv[2];
if (stage === undefined) {
  const root = await mkdtemp(join(tmpdir(), 'phase-four-process-smoke-'));
  try {
    await mkdir(join(root, 'workspace'));
    await writeFile(join(root, 'workspace', 'fixture.txt'), 'evidence across processes');
    const run = (stage: string, id?: string): string => {
      const result = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), stage, root, ...(id === undefined ? [] : [id])],
        { cwd: root, encoding: 'utf8', timeout: 30_000 },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return result.stdout.trim();
    };
    const id = run('create');
    assert.equal(run('resume', id), 'resumed');
    const interruptedId = run('crash');
    assert.equal(
      (await stat(join(root, 'sessions', `.${interruptedId}.lock`))).isDirectory(),
      true,
    );
    // This child has exited; only the test operator removes its stale lock, never the runtime.
    await rmdir(join(root, 'sessions', `.${interruptedId}.lock`));
    assert.equal(run('recover', interruptedId), 'recovered');
    process.stdout.write(
      'Persistent session smoke passed: process restart, transcript/usage, and interrupted-call recovery.\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else {
  const root = process.argv[3]!;
  const tracing = createTracing({ exporter: new InMemorySpanExporter() });
  const store = new FileSessionStore(
    new LocalRecordStorage(join(root, 'sessions')),
    tracing.tracer,
  );
  try {
    if (stage === 'create' || stage === 'crash') {
      let calls = 0;
      const hooks = new HookRegistry();
      if (stage === 'crash')
        hooks.register('AfterModel', (context) => {
          process.stdout.write(`${context.sessionId}\n`);
          process.exit(0);
        });
      const sampler: Sampler = {
        sample: (request) => {
          calls += 1;
          return Promise.resolve({
            modelCallId: request.modelCallId,
            usage: { inputTokens: 8, outputTokens: 2 },
            ...(calls === 1
              ? {
                  text: null,
                  stopReason: 'tool_calls' as const,
                  toolCalls: [
                    {
                      id: createToolCallId(),
                      name: 'read_file',
                      arguments: { path: 'fixture.txt' },
                    },
                  ],
                }
              : {
                  text: 'Remember evidence across processes.',
                  stopReason: 'end_turn' as const,
                  toolCalls: [],
                }),
          });
        },
      };
      const result = await runPhaseOneCli({
        modelId: 'fake',
        provider: 'ollama',
        prompt: 'Read fixture.txt.',
        workspaceRoot: join(root, 'workspace'),
        userSkillsDirectory: join(root, 'user-skills'),
        tracer: tracing.tracer,
        sampler,
        hooks,
        sessionStore: store,
        writeOutput: () => undefined,
      });
      assert.equal(result.session.usage?.length, 2);
      process.stdout.write(`${result.session.id}\n`);
    } else {
      const id = process.argv[4] as SessionId;
      const command = parseSessionCommand(
        ['--resume', id, 'Continue from the recorded evidence.'],
        root,
      );
      assert.equal(command.kind, 'run');
      if (command.kind !== 'run') throw new Error('Expected resume');
      const prepared = await prepareSessionRun(command, {}, root, store);
      assert.equal(prepared.parsed.help, false);
      if (prepared.parsed.help) throw new Error('Expected config');
      assert.equal(prepared.parsed.config.modelId, 'fake');
      assert.equal(prepared.parsed.config.workspaceRoot, join(root, 'workspace'));
      let calls = 0;
      const sampler: Sampler = {
        sample: (request) => {
          calls += 1;
          const history = JSON.stringify(request.messages);
          assert.ok(
            history.includes(
              stage === 'recover' ? 'execution_unknown' : 'Remember evidence across processes.',
            ),
          );
          return Promise.resolve({
            modelCallId: request.modelCallId,
            text: 'Continued.',
            toolCalls: [],
            usage: { inputTokens: 11, outputTokens: 3 },
            stopReason: 'end_turn',
          });
        },
      };
      const result = await runPhaseOneCli({
        ...prepared.parsed.config,
        userSkillsDirectory: join(root, 'user-skills'),
        sessionId: id,
        sessionStore: store,
        savedAgent: prepared.savedAgent!,
        provider: prepared.parsed.provider,
        tracer: tracing.tracer,
        sampler,
        writeOutput: () => undefined,
      });
      assert.equal(calls, 1);
      assert.equal(result.session.turns.length, 2);
      assert.equal(result.session.usage?.length, stage === 'recover' ? 2 : 3);
      assert.equal(
        result.session.turns[0]?.status,
        stage === 'recover' ? 'interrupted' : 'completed',
      );
      assert.deepEqual(await store.get(id), result.session);
      process.stdout.write(stage === 'recover' ? 'recovered\n' : 'resumed\n');
    }
  } finally {
    await tracing.shutdown();
  }
}
