import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePhaseOneCliArguments, runPhaseOneCli } from '../../src/cli/phase-one-cli.js';
import { parseSessionCommand, prepareSessionRun } from '../../src/cli/session-cli.js';
import type { ModelRequest } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import { parseBenchmarkArguments } from '../benchmarks/exploration/cli.js';

describe('retrieval CLI', () => {
  let root: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'retrieval-cli-'));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'AGENTS.md'), 'Preserve rules.');
    await writeFile(join(root, 'src/value.ts'), 'export const checkpointBudget = 42;');
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('requires explicit bounded roots within the configured rules directory', () => {
    const parse = (args: string[]) =>
      parsePhaseOneCliArguments(
        ['--model', 'fake', ...args, 'Explain checkpoint budget'],
        {},
        root,
      );
    expect(parse([])).not.toHaveProperty('config.retrieval');
    expect(
      parse(['--retrieval-root', 'src', '--retrieval-root', 'test', '--retrieval-tokens', '1000']),
    ).toMatchObject({ config: { retrieval: { roots: ['src', 'test'], maxTokens: 1000 } } });
    for (const args of [
      ['--retrieval-tokens', '1000'],
      ['--retrieval-root', '../outside'],
      ['--retrieval-root', 'src', '--retrieval-tokens', '0'],
      ['--retrieval-root', 'test', '--rules-directory', 'src'],
      ['--retrieval-root', '.git'],
    ])
      expect(() => parse(args)).toThrow();
    expect(parseBenchmarkArguments(['--code-retrieval'], root)).toMatchObject({
      retrieval: { roots: ['src', 'test'], maxTokens: 4096 },
    });
    expect(() => parseBenchmarkArguments(['--retrieval-tokens', '1000'], root)).toThrow();
  });

  it('answers from retrieved evidence, preserves the tool surface and reloads on resume', async () => {
    const store = new InMemorySessionStore();
    const requests: ModelRequest[] = [];
    const run = (sessionId?: Parameters<typeof runPhaseOneCli>[0]['sessionId']) =>
      runPhaseOneCli({
        modelId: 'fake',
        workspaceRoot: root,
        userSkillsDirectory: join(root, 'no-user-skills'),
        prompt: 'Explain checkpoint budget.',
        tracer: tracing.tracer,
        sessionStore: store,
        ...(sessionId === undefined ? {} : { sessionId }),
        retrieval: { roots: ['src'], maxTokens: 2000 },
        sampler: {
          sample: (request) => {
            requests.push(request);
            const evidence = request.messages.find((message) =>
              message.content?.startsWith('Repository excerpts:'),
            );
            expect(evidence?.role).toBe('user');
            expect(evidence?.content).toContain('src/value.ts');
            expect(evidence?.content).toContain('"startLine":1');
            const found = evidence?.content?.includes('= 43') ? '43' : '42';
            return Promise.resolve({
              modelCallId: request.modelCallId,
              text: `src/value.ts:1 declares checkpointBudget = ${found}.`,
              toolCalls: [],
              stopReason: 'end_turn',
              usage: { inputTokens: 10, outputTokens: 2 },
            });
          },
        },
        writeOutput: () => undefined,
      });
    const first = await run();
    expect(first.finalText).toContain('42');
    expect(JSON.stringify(first.session)).not.toContain('Repository excerpts:');
    expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_files',
      'search_text',
    ]);
    await writeFile(join(root, 'src/value.ts'), 'export const checkpointBudget = 43;');
    const second = await run(first.session.id);
    expect(second.finalText).toContain('43');
    expect(second.session.turns).toHaveLength(2);
    const command = parseSessionCommand(
      ['--resume', first.session.id, 'Explain checkpoint budget.'],
      root,
    );
    if (command.kind !== 'run') throw new Error('Expected run');
    const prepared = await prepareSessionRun(command, {}, root, store);
    expect(prepared.parsed).not.toHaveProperty('config.retrieval');
    await tracing.forceFlush();
    const spans = exporter.getFinishedSpans();
    const selection = spans.find((span) => span.name === 'context.code_retrieval')!;
    const scan = spans.find((span) => span.name === 'retrieval.code')!;
    expect(scan.parentSpanContext?.spanId).toBe(selection.spanContext().spanId);
    expect(selection.attributes.selected_tokens).toBeGreaterThan(0);
    expect(scan.attributes.files_considered).toBe(1);
    expect(spans.some((span) => span.name === 'tool.execute')).toBe(false);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('checkpointBudget');
  });

  it('injects a partial-coverage notice when an unloaded rules subtree is skipped', async () => {
    await writeFile(join(root, 'src/AGENTS.md'), 'Nested instructions.');
    await runPhaseOneCli({
      modelId: 'fake',
      workspaceRoot: root,
      userSkillsDirectory: join(root, 'no-user-skills'),
      prompt: 'checkpoint budget',
      tracer: tracing.tracer,
      retrieval: { roots: ['src'] },
      sampler: {
        sample: (request) => {
          const evidence = request.messages.find((m) =>
            m.content?.startsWith('Repository excerpts:'),
          );
          expect(evidence?.content).toContain('nested_rules');
          expect(evidence?.content).not.toContain('checkpointBudget');
          return Promise.resolve({
            modelCallId: request.modelCallId,
            text: 'Scope incomplete.',
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          });
        },
      },
      writeOutput: () => undefined,
    });
  });
});
