import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePhaseOneCliArguments, runPhaseOneCli } from '../../src/cli/phase-one-cli.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { MEMORY_LABEL } from '../../src/context/retrieval/memory/memory-context.js';
import { createModelCallId, createSessionId, createTurnId } from '../../src/ids.js';
import { memoryTerms, rankMemories } from '../../src/memory/memory-index.js';
import { parseMemoryEntries } from '../../src/memory/memory-parser.js';
import { MarkdownMemoryStore, type MemoryRoot } from '../../src/memory/memory-store.js';
import type { ModelRequest } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import type { FileSystemCapability } from '../../src/workspace/filesystem-capability.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';

describe('memory parsing and ranking', () => {
  it('splits entries at level-2 headings with exact line ranges', () => {
    const entries = parseMemoryEntries(
      '﻿# Decisions\r\nPreamble note.\r\n\r\n## Storage\r\nUse JSON files.\r\n```md\r\n## not a heading\r\n```\r\n\r\n## Empty\r\n\r\n## Retries ##\r\nNo tool retries.\r\n',
    );
    expect(entries.map(({ title, startLine, endLine }) => ({ title, startLine, endLine }))).toEqual(
      [
        { title: '', startLine: 1, endLine: 2 },
        { title: 'Storage', startLine: 4, endLine: 8 },
        { title: 'Empty', startLine: 10, endLine: 10 },
        { title: 'Retries', startLine: 12, endLine: 13 },
      ],
    );
    expect(entries[1]!.content).toContain('## not a heading');
    expect(parseMemoryEntries('\n\n  \n')).toEqual([]);
  });

  it('ranks deterministically with BM25 and ignores stop words', () => {
    expect(memoryTerms('Why does sessionStore use JSON?')).toEqual(['session', 'store', 'json']);
    const docs = ['Use SQLite for session data.', 'Session store uses JSON files.', 'Other.'];
    expect(rankMemories(docs, 'session store json').map((item) => item.index)).toEqual([1, 0]);
    // No stemming: plural forms are distinct terms.
    expect(rankMemories(['Many sessions.'], 'session')).toEqual([]);
    expect(rankMemories(docs, 'what is the')).toEqual([]);
    expect(rankMemories(['alpha note', 'alpha note'], 'alpha').map((item) => item.index)).toEqual([
      0, 1,
    ]);
  });
});

describe('Markdown memory store and context', () => {
  let root: string;
  let userRoot: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let files: FileSystemCapability;
  let userFiles: FileSystemCapability;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memory-'));
    userRoot = join(root, 'user-home-memory');
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    files = new LocalFileSystemCapability({ workspaceRoot: root, tracer: tracing.tracer });
    userFiles = new LocalFileSystemCapability({ workspaceRoot: userRoot, tracer: tracing.tracer });
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const put = async (path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const roots = (): MemoryRoot[] => [
    { scope: 'user', files: userFiles, directory: '.' },
    { scope: 'workspace', files, directory: '.agents/memory' },
  ];
  const store = (options: ConstructorParameters<typeof MarkdownMemoryStore>[2] = {}) =>
    new MarkdownMemoryStore(roots(), tracing.tracer, options);
  const search = (query: string, s = store()) =>
    s.search({ query, sessionId: createSessionId(), turnId: createTurnId() });
  const buildInput = (prompt: string) => {
    const turnId = createTurnId();
    return {
      agent: { name: 'test', systemPrompt: 'Follow rules.', model: { modelId: 'fake' } },
      session: {
        id: createSessionId(),
        turns: [
          {
            id: turnId,
            status: 'in_progress' as const,
            entries: [{ kind: 'user_message' as const, content: prompt }],
          },
        ],
      },
      turnId,
      modelCallId: createModelCallId(),
      tools: [],
    };
  };

  it('treats missing memory directories as empty', async () => {
    expect(await search('session storage')).toEqual({
      candidates: [],
      partialReasons: [],
      filesRead: 0,
      bytesRead: 0,
      entriesIndexed: 0,
    });
  });

  it('ranks workspace and user notes together with provenance, skipping non-notes', async () => {
    await put('.agents/memory/decisions.md', '## Session storage\nKeep versioned JSON files.\n');
    await put('.agents/memory/.hidden.md', '## Session storage\nhidden');
    await put('.agents/memory/notes.txt', 'session storage');
    await put('.agents/memory/nested/deep.md', '## Session storage\nnested');
    await put('user-home-memory/prefs.md', '## Style\nPrefer small session storage diffs.');
    await symlink(join(root, '.agents/memory/decisions.md'), join(root, '.agents/memory/alias.md'));
    const result = await search('How is session storage persisted?');
    expect(result.candidates.map(({ scope, path, title }) => ({ scope, path, title }))).toEqual([
      { scope: 'workspace', path: '.agents/memory/decisions.md', title: 'Session storage' },
      { scope: 'user', path: 'prefs.md', title: 'Style' },
    ]);
    expect(result.candidates[0]).toMatchObject({ startLine: 1, endLine: 2 });
    expect(result.filesRead).toBe(2);
    expect(result.partialReasons).toEqual([]);
  });

  it('reports discovery bounds as partial instead of failing', async () => {
    await put('.agents/memory/a.md', '## A\nalpha note');
    await put('.agents/memory/b.md', `## B\n${'alpha '.repeat(40)}`);
    expect((await search('alpha', store({ maxFiles: 1 }))).partialReasons).toEqual(['files']);
    expect((await search('alpha', store({ maxFileBytes: 32 }))).partialReasons).toEqual([
      'file_size',
    ]);
    const bytes = await search('alpha', store({ maxBytes: 20 }));
    expect(bytes.partialReasons).toContain('bytes');
    expect(bytes.bytesRead).toBeLessThanOrEqual(20);
    expect((await search('alpha', store({ maxEntries: 1 }))).partialReasons).toEqual(['entries']);
    expect((await search('alpha', store({ maxResults: 1 }))).candidates).toHaveLength(1);
  });

  it('fails explicitly on unsafe reads and propagates cancellation, without leaking content', async () => {
    await put('outside/secret.md', '## Secret\nsecret storage');
    await mkdir(join(root, '.agents'), { recursive: true });
    await symlink(join(root, 'outside'), join(root, '.agents/memory'));
    const escaped = new LocalFileSystemCapability({
      workspaceRoot: join(root, '.agents'),
      tracer: tracing.tracer,
    });
    await expect(
      new MarkdownMemoryStore(
        [{ scope: 'workspace', files: escaped, directory: 'memory' }],
        tracing.tracer,
      ).search({ query: 'storage', sessionId: createSessionId(), turnId: createTurnId() }),
    ).rejects.toMatchObject({ code: 'source_failed', cause: { message: 'outside_workspace' } });
    const controller = new AbortController();
    controller.abort();
    await expect(
      store().search({
        query: 'storage',
        sessionId: createSessionId(),
        turnId: createTurnId(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(() => new MarkdownMemoryStore([...roots(), ...roots()], tracing.tracer)).toThrow();
    expect(
      () =>
        new MarkdownMemoryStore([{ scope: 'workspace', files, directory: '../x' }], tracing.tracer),
    ).toThrow();
    await tracing.forceFlush();
    expect(
      JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes)),
    ).not.toContain('secret');
  });

  it('packs matching notes into spare budget only, before code evidence, never into Session', async () => {
    await put('.agents/memory/decisions.md', '## Session storage\nKeep versioned JSON files.\n');
    const request = buildInput('How is session storage persisted?');
    const original = structuredClone(request.session);
    const baseline = await new ContextBuilder(tracing.tracer).build(request);
    const enabled = await new ContextBuilder(tracing.tracer, {
      memory: { store: store() },
      codeRetrieval: {
        retriever: {
          retrieve: () =>
            Promise.resolve({
              candidates: [
                {
                  path: 'src/a.ts',
                  startLine: 1,
                  endLine: 1,
                  content: 'x',
                  score: 1,
                  estimatedTokens: 1,
                },
              ],
              partialReasons: [],
              selectionLimits: [],
              filesConsidered: 1,
              bytesRead: 1,
            }),
        },
      },
    }).build(request);
    const memoryIndex = enabled.request.messages.findIndex((m) =>
      m.content?.startsWith(MEMORY_LABEL),
    );
    expect(memoryIndex).toBeGreaterThan(-1);
    expect(enabled.request.messages[memoryIndex + 1]?.content).toMatch(/^Repository excerpts:/u);
    expect(enabled.request.messages[memoryIndex]!.content).toContain('Keep versioned JSON files.');
    expect(enabled.accounting.totalTokens - baseline.accounting.totalTokens).toBe(
      enabled.accounting.sources.memory! + enabled.accounting.sources.retrieval!,
    );
    expect(enabled.session).toEqual(original);

    const unrelated = await new ContextBuilder(tracing.tracer, {
      memory: { store: store() },
    }).build(buildInput('Explain the tracing exporter.'));
    expect(unrelated.accounting.sources.memory).toBe(0);

    // No spare room: memory is skipped without searching or failing the request.
    let searched = false;
    const tight = await new ContextBuilder(tracing.tracer, {
      budget: { windowTokens: baseline.accounting.totalTokens + 64, outputReserveTokens: 64 },
      memory: {
        store: {
          search: () => {
            searched = true;
            return Promise.reject(new Error('not reached'));
          },
        },
      },
    }).build(request);
    expect(tight.accounting.sources.memory).toBe(0);
    expect(searched).toBe(false);
  });

  it('lets a new session recall a recorded decision through the CLI', async () => {
    await writeFile(join(root, 'AGENTS.md'), 'Preserve rules.');
    await put(
      '.agents/memory/decisions.md',
      '# Decisions\n\n## Session storage\nChose versioned JSON files over SQLite (2026-09-22).\n\n## Tracing\nConsole exporter only.\n',
    );
    const requests: ModelRequest[] = [];
    const run = (prompt: string, memory = true) =>
      runPhaseOneCli({
        modelId: 'fake',
        workspaceRoot: root,
        userSkillsDirectory: join(root, 'no-user-skills'),
        prompt,
        tracer: tracing.tracer,
        sessionStore: new InMemorySessionStore(),
        ...(memory ? { memory: { userDirectory: userRoot } } : {}),
        sampler: {
          sample: (request) => {
            requests.push(request);
            const note = request.messages.find((m) => m.content?.startsWith(MEMORY_LABEL));
            return Promise.resolve({
              modelCallId: request.modelCallId,
              text: note?.content?.includes('versioned JSON') ? 'JSON files.' : 'Unknown.',
              toolCalls: [],
              stopReason: 'end_turn' as const,
              usage: { inputTokens: 1, outputTokens: 1 },
            });
          },
        },
        writeOutput: () => undefined,
      });
    const recalled = await run('Why did we choose the session storage format?');
    expect(recalled.finalText).toBe('JSON files.');
    expect(requests[0]!.messages.find((m) => m.content?.startsWith(MEMORY_LABEL))?.role).toBe(
      'user',
    );
    expect(JSON.stringify(recalled.session)).not.toContain('versioned JSON');
    expect(requests[0]!.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_files',
      'search_text',
    ]);
    expect((await run('Why did we choose the session storage format?', false)).finalText).toBe(
      'Unknown.',
    );
    await tracing.forceFlush();
    const spans = exporter.getFinishedSpans();
    const selection = spans.find((span) => span.name === 'context.memory')!;
    const scan = spans.find((span) => span.name === 'memory.search')!;
    expect(scan.parentSpanContext?.spanId).toBe(selection.spanContext().spanId);
    expect(selection.attributes.selected_items).toBe(1);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('SQLite');
  });

  it('parses memory flags and requires --memory for its options', () => {
    const parse = (args: string[]) =>
      parsePhaseOneCliArguments(['--model', 'fake', ...args, 'prompt'], {}, root);
    expect(parse([])).not.toHaveProperty('config.memory');
    expect(parse(['--memory'])).toMatchObject({ config: { memory: {} } });
    expect(
      parse(['--memory', '--memory-tokens', '500', '--user-memory-directory', 'mem']),
    ).toMatchObject({ config: { memory: { maxTokens: 500, userDirectory: join(root, 'mem') } } });
    for (const args of [
      ['--memory-tokens', '500'],
      ['--user-memory-directory', 'mem'],
      ['--memory', '--memory-tokens', '0'],
    ])
      expect(() => parse(args)).toThrow();
  });
});
