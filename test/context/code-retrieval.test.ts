import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { utf8TokenEstimate } from '../../src/context/context-budget.js';
import { LexicalCodeRetriever } from '../../src/context/retrieval/code/lexical-code-retriever.js';
import {
  retrievalRoots,
  type CodeRetriever,
  type CodeRetrievalInput,
} from '../../src/context/retrieval/code/code-retriever.js';
import { createModelCallId, createSessionId, createTurnId } from '../../src/ids.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';
import type { FileSystemCapability } from '../../src/workspace/filesystem-capability.js';
import type { Session } from '../../src/session/session.js';

describe('bounded lexical code retrieval', () => {
  let root: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let files: FileSystemCapability;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'code-retrieval-'));
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    files = new LocalFileSystemCapability({ workspaceRoot: root, tracer: tracing.tracer });
    await mkdir(join(root, 'src'));
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const input = (query = 'checkpoint budget'): CodeRetrievalInput => ({
    query,
    counter: utf8TokenEstimate,
    sessionId: createSessionId(),
    turnId: createTurnId(),
    modelCallId: createModelCallId(),
  });
  const retriever = (
    options: Partial<ConstructorParameters<typeof LexicalCodeRetriever>[2]> = {},
    fs = files,
  ) => new LexicalCodeRetriever(fs, tracing.tracer, { roots: ['src'], ...options });
  const buildInput = () => {
    const turnId = createTurnId();
    return {
      agent: { name: 'test', systemPrompt: 'Follow rules.', model: { modelId: 'fake' } },
      session: {
        id: createSessionId(),
        turns: [
          {
            id: turnId,
            status: 'in_progress' as const,
            entries: [{ kind: 'user_message' as const, content: 'Explain checkpoint budget.' }],
          },
        ],
      },
      turnId,
      modelCallId: createModelCallId(),
      tools: [],
    };
  };

  it('ranks deterministically, cites exact lines and selects non-overlapping windows', async () => {
    await put(
      'src/b.ts',
      'const checkpoint = 1;\nconst budget = 2;\nexport { checkpoint, budget };',
    );
    await put(
      'src/a.ts',
      'const checkpoint = 1;\nconst budget = 2;\nexport { checkpoint, budget };',
    );
    await put('src/z.ts', 'const checkpoint = 0;');
    const result = await retriever().retrieve(input());
    expect(result.candidates.map((c) => c.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/z.ts']);
    expect(result.candidates[0]).toMatchObject({ startLine: 1, endLine: 3, score: 8 });
    expect(result.candidates[0]!.content.split('\n')).toHaveLength(3);
    expect(result.partialReasons).toEqual([]);
    await put('src/blanks.ts', '\n\nconst checkpoint = budget;');
    const blankExcerpt = (await retriever().retrieve(input())).candidates.find(
      (candidate) => candidate.path === 'src/blanks.ts',
    );
    expect(blankExcerpt).toMatchObject({
      startLine: 1,
      endLine: 3,
      content: '\n\nconst checkpoint = budget;',
    });
    await put(
      'src/a.ts',
      Array.from({ length: 20 }, (_, i) => `const checkpoint${i} = budget;`).join('\n'),
    );
    const windows = (await retriever().retrieve(input())).candidates
      .filter((c) => c.path === 'src/a.ts')
      .sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < windows.length; i++)
      expect(windows[i]!.startLine).toBeGreaterThan(windows[i - 1]!.endLine);
  });

  it('skips excluded code, binary data, symlinks and unloaded nested rules', async () => {
    await put('src/good.ts', 'const checkpoint = budget;');
    for (const path of [
      'src/node_modules/a.ts',
      'src/dist/a.ts',
      'src/.private/a.ts',
      'src/secrets/a.ts',
      'src/credentials.ts',
      'src/.env.ts',
    ])
      await put(path, 'secret checkpoint budget');
    await put('src/binary.ts', '\0checkpoint budget');
    await put('src/nested/AGENTS.md', 'Nested rules.');
    await put('src/nested/hidden.ts', 'nested checkpoint budget');
    await symlink(join(root, 'src/good.ts'), join(root, 'src/link.ts'));
    const result = await retriever().retrieve(input());
    expect(result.candidates.map((c) => c.path)).toEqual(['src/good.ts']);
    expect(result.partialReasons).toContain('nested_rules');
    expect(
      (await retriever({ roots: ['src/nested'], rulesDirectory: 'src/nested' }).retrieve(input()))
        .candidates[0]?.path,
    ).toBe('src/nested/hidden.ts');
    await symlink(join(root, 'src'), join(root, 'alias'));
    await expect(retriever({ roots: ['alias'] }).retrieve(input())).rejects.toMatchObject({
      code: 'source_failed',
    });
    expect(() => retrievalRoots(['test'], 'src')).toThrow();
    expect(() => retrievalRoots(['../src'])).toThrow();
    expect(() => retrievalRoots(['src/node_modules'])).toThrow();
    expect(retrievalRoots(['src/a', 'src', './src'])).toEqual(['src']);
  });

  it('reports scan limits, bounds read bytes, and retains the highest-ranked candidates', async () => {
    await put('src/a.ts', 'const checkpoint = 1;');
    await put('src/z.ts', 'const checkpoint = budget;');
    expect((await retriever({ maxFiles: 1 }).retrieve(input())).partialReasons).toContain('files');
    expect((await retriever({ maxEntries: 1 }).retrieve(input())).partialReasons).toContain(
      'entries',
    );
    expect((await retriever({ maxFileBytes: 10 }).retrieve(input())).partialReasons).toContain(
      'file_size',
    );
    const bounded = await retriever({ maxBytes: 10 }).retrieve(input());
    expect(bounded.partialReasons).toContain('bytes');
    expect(bounded.bytesRead).toBeLessThanOrEqual(10);
    const best = await retriever({ maxCandidates: 1 }).retrieve(input());
    expect(best.candidates[0]?.path).toBe('src/z.ts');
    // Dropping lower-ranked matches after a complete scan is not a coverage gap.
    expect(best.selectionLimits).toEqual(['candidates']);
    expect(best.partialReasons).toEqual([]);
    await put('src/a.ts', 'checkpoint '.repeat(400));
    const long = await retriever().retrieve(input('checkpoint'));
    expect(long.selectionLimits).toContain('snippet');
    expect(long.partialReasons).toEqual([]);
    expect(
      (await retriever().retrieve(input('checkpoint '.repeat(1000)))).partialReasons,
    ).toContain('query');
    const smallDirectory = new LocalFileSystemCapability({
      workspaceRoot: root,
      tracer: tracing.tracer,
      maxDirectoryEntries: 1,
    });
    expect((await retriever({}, smallDirectory).retrieve(input())).partialReasons).toContain(
      'directory_size',
    );
  });

  it('returns empty for no matches and refreshes changed files without a cache', async () => {
    await put('src/a.ts', 'const apple = 1;');
    const code = retriever();
    expect((await code.retrieve(input())).candidates).toEqual([]);
    await put('src/a.ts', 'const checkpoint = budget;');
    expect((await code.retrieve(input())).candidates[0]?.content).toContain('checkpoint');
    await rm(join(root, 'src/a.ts'));
    expect((await code.retrieve(input())).candidates).toEqual([]);
    await expect(retriever({ roots: ['missing'] }).retrieve(input())).rejects.toMatchObject({
      code: 'source_failed',
    });
  });

  it('distinguishes optional scan timeout from parent cancellation and sanitizes errors', async () => {
    const slow: FileSystemCapability = {
      readFile: files.readFile,
      listDirectory: (_path, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(new Error('secret timeout body')),
            { once: true },
          );
        }),
    };
    expect(
      (await retriever({ maxDurationMs: 10 }, slow).retrieve(input())).partialReasons,
    ).toContain('time');
    const controller = new AbortController();
    controller.abort();
    await expect(
      retriever().retrieve({ ...input(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    await expect(
      retriever().retrieve({ ...input(), deadlineMs: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
    const bad: FileSystemCapability = {
      readFile: files.readFile,
      listDirectory: () => Promise.reject(new Error('secret path body')),
    };
    await expect(retriever({}, bad).retrieve(input())).rejects.toMatchObject({
      code: 'source_failed',
      cause: { message: 'retrieval_failed' },
    });
    await tracing.forceFlush();
    const serialized = JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes));
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('checkpoint');
    expect(
      exporter.getFinishedSpans().some((span) => span.attributes['error.type'] === 'cancelled'),
    ).toBe(true);
  });

  it('packs complete excerpts using only spare budget and leaves transcript and required context intact', async () => {
    await put('src/a.ts', 'const checkpoint = budget;');
    const request = buildInput();
    const original = structuredClone(request.session);
    const baseline = await new ContextBuilder(tracing.tracer).build(request);
    const code = retriever();
    const enabled = await new ContextBuilder(tracing.tracer, {
      codeRetrieval: { retriever: code, maxTokens: 700 },
    }).build(request);
    expect(enabled.accounting.sources.retrieval).toBeGreaterThan(0);
    expect(enabled.accounting.sources.retrieval).toBeLessThanOrEqual(700);
    expect(enabled.accounting.totalTokens - baseline.accounting.totalTokens).toBe(
      enabled.accounting.sources.retrieval,
    );
    expect(
      enabled.request.messages.filter((m) => !m.content?.startsWith('Repository excerpts:')),
    ).toEqual(baseline.request.messages);
    expect(request.session).toEqual(original);
    expect(enabled.session).toEqual(original);
    const retrieve = vi.fn(code.retrieve.bind(code));
    const full = await new ContextBuilder(tracing.tracer, {
      budget: { windowTokens: baseline.accounting.totalTokens + 64, outputReserveTokens: 64 },
      codeRetrieval: { retriever: { retrieve } },
    }).build(request);
    expect(full.request.messages).toEqual(baseline.request.messages);
    expect(full.accounting.sources.retrieval).toBe(0);
    expect(retrieve).not.toHaveBeenCalled();
    const tiny = await new ContextBuilder(tracing.tracer, {
      codeRetrieval: { retriever: code, maxTokens: 1 },
    }).build(request);
    expect(tiny.accounting.sources.retrieval).toBe(0);
    await expect(
      new ContextBuilder(tracing.tracer, {
        budget: { windowTokens: baseline.accounting.totalTokens + 63, outputReserveTokens: 64 },
        codeRetrieval: { retriever: { retrieve } },
      }).build(request),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('never adds compaction calls and uses only the current user query after compaction', async () => {
    const request = buildInput();
    const session: Session = {
      ...request.session,
      turns: [
        ...Array.from({ length: 4 }, () => ({
          id: createTurnId(),
          status: 'completed' as const,
          entries: [
            { kind: 'user_message' as const, content: 'Keep SQLite. '.repeat(45) },
            {
              kind: 'assistant_message' as const,
              modelCallId: createModelCallId(),
              content: 'Agreed. '.repeat(20),
              toolCalls: [],
            },
          ],
        })),
        ...request.session.turns,
      ],
    };
    const sample = vi.fn((r: { modelCallId: ReturnType<typeof createModelCallId> }) =>
      Promise.resolve({
        modelCallId: r.modelCallId,
        text: 'Keep SQLite.',
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 1 },
        stopReason: 'end_turn' as const,
      }),
    );
    const baseOptions = {
      sampler: { sample },
      budget: { windowTokens: 2600, outputReserveTokens: 400 },
      summaryMaxTokens: 200,
    };
    const baseline = await new ContextBuilder(tracing.tracer, baseOptions).build({
      ...request,
      session,
    });
    const calls = sample.mock.calls.length;
    sample.mockClear();
    const retrieve = vi.fn<CodeRetriever['retrieve']>(() =>
      Promise.resolve({
        candidates: [],
        partialReasons: [],
        selectionLimits: [],
        filesConsidered: 0,
        bytesRead: 0,
      }),
    );
    const result = await new ContextBuilder(tracing.tracer, {
      ...baseOptions,
      codeRetrieval: { retriever: { retrieve } },
    }).build({ ...request, session });
    expect(sample).toHaveBeenCalledTimes(calls);
    expect(result.accounting.compactedTurns).toBe(baseline.accounting.compactedTurns);
    expect(retrieve.mock.calls[0]?.[0].query).toBe('Explain checkpoint budget.');
    expect(result.session.turns).toEqual(session.turns);
  });

  it('tells the model only about coverage gaps, not selection limits', async () => {
    await put('src/a.ts', 'const checkpoint = 1;');
    await put('src/z.ts', 'const checkpoint = budget;');
    const notice = async (options: Parameters<typeof retriever>[0]) => {
      const built = await new ContextBuilder(tracing.tracer, {
        codeRetrieval: { retriever: retriever(options) },
      }).build(buildInput());
      const content = built.request.messages.find((m) =>
        m.content?.startsWith('Repository excerpts:'),
      )?.content;
      return JSON.parse(content!.slice(content!.indexOf('{'))) as { partialReasons: string[] };
    };
    expect((await notice({ maxCandidates: 1 })).partialReasons).toEqual([]);
    expect((await notice({ maxFiles: 1 })).partialReasons).toEqual(['files']);
  });

  it('scans once per turn, repacks cached candidates and never caches failures', async () => {
    await put('src/a.ts', 'const checkpoint = budget;');
    const code = retriever();
    const retrieve = vi.fn(code.retrieve.bind(code));
    const builder = new ContextBuilder(tracing.tracer, {
      codeRetrieval: { retriever: { retrieve } },
    });
    const first = buildInput();
    const a = await builder.build(first);
    const b = await builder.build({ ...first, modelCallId: createModelCallId() });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(b.accounting.sources.retrieval).toBe(a.accounting.sources.retrieval);

    // A new turn rescans and observes edits made since the previous turn.
    await put('src/a.ts', 'const checkpoint = budget; // edited');
    const nextTurnId = createTurnId();
    const second = await builder.build({
      ...first,
      session: {
        ...first.session,
        turns: [
          { ...first.session.turns[0]!, status: 'completed' as const },
          {
            id: nextTurnId,
            status: 'in_progress' as const,
            entries: [{ kind: 'user_message' as const, content: 'Explain checkpoint budget.' }],
          },
        ],
      },
      turnId: nextTurnId,
      modelCallId: createModelCallId(),
    });
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(second.request.messages)).toContain('edited');

    await tracing.forceFlush();
    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === 'context.code_retrieval')
        .map((span) => span.attributes['cache.hit']),
    ).toEqual([false, true, false]);

    const flaky = vi
      .fn<CodeRetriever['retrieve']>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockImplementation(code.retrieve.bind(code));
    const retrying = new ContextBuilder(tracing.tracer, {
      codeRetrieval: { retriever: { retrieve: flaky } },
    });
    const request = buildInput();
    await expect(retrying.build(request)).rejects.toMatchObject({ code: 'source_failed' });
    await retrying.build(request);
    await retrying.build(request);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('enforces per-read byte limits without increasing the adapter limit', async () => {
    await put('src/a.ts', '12345');
    await expect(files.readFile('src/a.ts', { maxBytes: 4 })).rejects.toMatchObject({
      code: 'output_limit_exceeded',
    });
    expect((await files.readFile('src/a.ts', { maxBytes: 5 })).content).toBe('12345');
    const bounded = new LocalFileSystemCapability({
      workspaceRoot: root,
      tracer: tracing.tracer,
      maxReadBytes: 4,
    });
    await expect(bounded.readFile('src/a.ts', { maxBytes: 100 })).rejects.toMatchObject({
      code: 'output_limit_exceeded',
    });
  });
});
