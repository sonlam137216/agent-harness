import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseMemoryCommand, runMemoryCommand } from '../../src/cli/memory-cli.js';
import { createMemoryWriter, runPhaseOneCli } from '../../src/cli/phase-one-cli.js';
import { MEMORY_LABEL } from '../../src/context/retrieval/memory/memory-context.js';
import { createSessionId, createToolCallId, createTurnId } from '../../src/ids.js';
import { MarkdownMemoryStore } from '../../src/memory/memory-store.js';
import type { MemoryWriter } from '../../src/memory/memory-writer.js';
import type { ModelRequest, ModelResponse } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import type { PermissionRule } from '../../src/permissions/permission-engine.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';
import { LocalNoteStorage } from '../../src/workspace/local-note-storage.js';

describe('memory write path', () => {
  let root: string;
  let userRoot: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let writer: MemoryWriter;
  const notesPath = () => join(root, '.agents/memory/notes.md');
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memory-write-'));
    userRoot = join(root, 'user-memory');
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    writer = createMemoryWriter(root, userRoot, tracing.tracer);
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  describe('LocalNoteStorage', () => {
    const storage = (directory = '.agents/memory', maxBytes?: number) =>
      new LocalNoteStorage({
        root,
        directory,
        tracer: tracing.tracer,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      });

    it('creates the directory and replaces files atomically', async () => {
      const result = await storage().update('notes.md', (current) => `${current}one\n`);
      expect(result).toEqual({ path: '.agents/memory/notes.md', previous: '', next: 'one\n' });
      await storage().update('notes.md', (current) => `${current}two\n`);
      expect(await readFile(notesPath(), 'utf8')).toBe('one\ntwo\n');
      // No lock or temporary files are left behind.
      expect(await readdir(join(root, '.agents/memory'))).toEqual(['notes.md']);
    });

    it('rejects unsafe names, symlinks, oversized files, busy locks and cancellation', async () => {
      for (const name of ['../x.md', 'notes', '.hidden.md', 'Notes.md', 'a/b.md'])
        await expect(storage().update(name, () => 'x')).rejects.toMatchObject({
          code: 'invalid_name',
        });
      expect(() => storage('../outside')).toThrow();

      const outside = await mkdtemp(join(tmpdir(), 'memory-outside-'));
      try {
        await mkdir(join(root, '.agents'));
        await symlink(outside, join(root, '.agents/memory'));
        await expect(storage().update('notes.md', () => 'x')).rejects.toMatchObject({
          code: 'unsafe_path',
        });
        expect(await readdir(outside)).toEqual([]);
        await rm(join(root, '.agents/memory'));
        await mkdir(join(root, '.agents/memory'));
        await writeFile(join(outside, 'target.md'), 'outside');
        await symlink(join(outside, 'target.md'), notesPath());
        await expect(storage().update('notes.md', () => 'x')).rejects.toMatchObject({
          code: 'unsafe_path',
        });
        expect(await readFile(join(outside, 'target.md'), 'utf8')).toBe('outside');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }

      await expect(storage('.agents/other', 4).update('a.md', () => '12345')).rejects.toMatchObject(
        { code: 'size_limit' },
      );
      await mkdir(join(root, '.agents/other/.b.md.lock'), { recursive: true });
      await expect(storage('.agents/other').update('b.md', () => 'x')).rejects.toMatchObject({
        code: 'busy',
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        storage('.agents/other').update('c.md', () => 'x', { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('propagates transform errors unchanged without writing', async () => {
      await storage().update('notes.md', () => 'kept\n');
      const rejection = new Error('caller rejected');
      await expect(
        storage().update('notes.md', () => {
          throw rejection;
        }),
      ).rejects.toBe(rejection);
      expect(await readFile(notesPath(), 'utf8')).toBe('kept\n');
    });
  });

  describe('MemoryWriter', () => {
    it('appends parseable entries with provenance that the reader can find', async () => {
      const first = await writer.record({
        scope: 'workspace',
        title: 'Session storage',
        body: 'Chose versioned JSON files.\n### Why\nSingle writer per session.',
        source: { kind: 'cli' },
      });
      expect(first).toMatchObject({
        scope: 'workspace',
        path: '.agents/memory/notes.md',
        startLine: 1,
        endLine: 6,
      });
      const sessionId = createSessionId();
      const second = await writer.record({
        scope: 'user',
        file: 'prefs',
        title: 'Diff style',
        body: 'Prefer small diffs.',
        source: { kind: 'agent', sessionId },
      });
      expect(second).toMatchObject({ scope: 'user', path: 'prefs.md', startLine: 1 });
      const third = await writer.record({
        scope: 'workspace',
        title: 'Tracing',
        body: 'Console exporter only.',
        source: { kind: 'cli' },
      });
      expect(third.startLine).toBe(first.endLine + 2);
      const text = await readFile(notesPath(), 'utf8');
      expect(text).toMatch(/_Recorded \d{4}-\d{2}-\d{2} via CLI\._/u);
      expect(await readFile(join(userRoot, 'prefs.md'), 'utf8')).toContain(
        `by the agent in session ${sessionId}`,
      );

      const store = new MarkdownMemoryStore(
        [
          {
            scope: 'workspace',
            files: new LocalFileSystemCapability({ workspaceRoot: root, tracer: tracing.tracer }),
            directory: '.agents/memory',
          },
        ],
        tracing.tracer,
      );
      const found = await store.search({
        query: 'tracing exporter',
        sessionId,
        turnId: createTurnId(),
      });
      expect(found.candidates[0]).toMatchObject({
        title: 'Tracing',
        startLine: third.startLine,
        endLine: third.endLine,
      });
    });

    it('rejects input that would corrupt entry boundaries, leaving files unchanged', async () => {
      const record = (title: string, body: string, file?: string) =>
        writer.record({
          scope: 'workspace',
          title,
          body,
          ...(file === undefined ? {} : { file }),
          source: { kind: 'cli' },
        });
      for (const [title, body, file] of [
        ['', 'body'],
        ['Two\nlines', 'body'],
        ['# Heading', 'body'],
        ['Ok', ''],
        ['Ok', 'x'.repeat(4001)],
        ['Ok', 'line\n## injected heading'],
        ['Ok', '```\nunclosed'],
        ['Ok', 'body', '../escape'],
      ] as const)
        await expect(record(title, body, file)).rejects.toMatchObject({ code: 'invalid_input' });
      await mkdir(join(root, '.agents/memory'), { recursive: true });
      await writeFile(notesPath(), '## Broken\n```\nno closing fence\n');
      await expect(record('New', 'body')).rejects.toMatchObject({ code: 'invalid_input' });
      expect(await readFile(notesPath(), 'utf8')).toBe('## Broken\n```\nno closing fence\n');
      await tracing.forceFlush();
      expect(
        JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes)),
      ).not.toContain('injected heading');
    });
  });

  describe('memory add command', () => {
    it('parses, validates and records a note', async () => {
      expect(parseMemoryCommand(['--', 'sessions', 'list'], root)).toBeUndefined();
      const command = parseMemoryCommand(
        ['--', 'memory', 'add', '--title', 'Retries', '--file', 'decisions', 'No', 'tool retries.'],
        root,
      )!;
      expect(command).toMatchObject({
        scope: 'workspace',
        file: 'decisions',
        title: 'Retries',
        body: 'No tool retries.',
      });
      for (const args of [
        ['memory', 'list'],
        ['memory', 'add', 'no title'],
        ['memory', 'add', '--title', 'T', '--scope', 'global', 'x'],
        ['memory', 'add', '--title', 'T', '--bogus', 'x'],
        ['memory', 'add', '--title', 'T'],
      ])
        expect(() => parseMemoryCommand(args, root)).toThrow();
      const output: string[] = [];
      await runMemoryCommand(command, writer, (text) => output.push(text));
      expect(output).toEqual([
        'Recorded workspace memory "Retries" at .agents/memory/decisions.md:1-4',
      ]);
    });
  });

  describe('save_memory tool', () => {
    const toolCall = {
      id: createToolCallId(),
      name: 'save_memory',
      arguments: { title: 'Session storage', content: 'Chose versioned JSON files.' },
    };
    const run = (
      prompt: string,
      options: { rules?: PermissionRule[]; memory?: boolean; approve?: () => Promise<boolean> },
    ) => {
      const requests: ModelRequest[] = [];
      const result = runPhaseOneCli({
        modelId: 'fake',
        workspaceRoot: root,
        userSkillsDirectory: join(root, 'no-user-skills'),
        prompt,
        tracer: tracing.tracer,
        sessionStore: new InMemorySessionStore(),
        ...(options.memory === false ? {} : { memory: { userDirectory: userRoot } }),
        ...(options.rules === undefined ? {} : { permissionRules: options.rules }),
        ...(options.approve === undefined
          ? {}
          : { permissionMode: 'ask' as const, approve: options.approve }),
        sampler: {
          sample: (request): Promise<ModelResponse> => {
            requests.push(request);
            const saving = prompt.startsWith('Remember') && requests.length === 1;
            const note = request.messages.find((m) => m.content?.startsWith(MEMORY_LABEL));
            return Promise.resolve({
              modelCallId: request.modelCallId,
              text: saving ? null : note?.content?.includes('versioned JSON') ? 'JSON.' : 'Done.',
              toolCalls: saving ? [toolCall] : [],
              stopReason: saving ? 'tool_calls' : 'end_turn',
              usage: { inputTokens: 1, outputTokens: 1 },
            });
          },
        },
        writeOutput: () => undefined,
      });
      return { result, requests };
    };
    const savedOutcome = async (run_: ReturnType<typeof run>) => {
      const session = (await run_.result).session;
      const entry = session.turns[0]!.entries.find((e) => e.kind === 'tool_result');
      return entry?.kind === 'tool_result' ? entry : undefined;
    };

    it('is offered only with --memory and denied by the default permission mode', async () => {
      const without = run('Hello', { memory: false });
      await without.result;
      expect(without.requests[0]!.tools.map((tool) => tool.name)).not.toContain('save_memory');

      const denied = run('Remember the storage decision.', {});
      const outcome = await savedOutcome(denied);
      expect(denied.requests[0]!.tools.map((tool) => tool.name)).toContain('save_memory');
      expect(outcome?.outcome).toBe('error');
      await expect(readFile(notesPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

      const rejected = run('Remember the storage decision.', {
        approve: () => Promise.resolve(false),
      });
      expect((await savedOutcome(rejected))?.outcome).toBe('error');
      await expect(readFile(notesPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('records a note when allowed and a new session recalls it', async () => {
      const saved = run('Remember the storage decision.', {
        rules: [{ toolName: 'save_memory', decision: 'allow' }],
      });
      const outcome = await savedOutcome(saved);
      const sessionId = (await saved.result).session.id;
      expect(outcome).toMatchObject({
        outcome: 'success',
        output: { scope: 'workspace', path: '.agents/memory/notes.md', startLine: 1 },
      });
      expect(await readFile(notesPath(), 'utf8')).toContain(`in session ${sessionId}`);

      const recall = run('Why did we choose the session storage format?', {});
      expect((await recall.result).finalText).toBe('JSON.');
      await tracing.forceFlush();
      const record = exporter.getFinishedSpans().find((span) => span.name === 'memory.record')!;
      expect(record.attributes).toMatchObject({
        scope: 'workspace',
        source: 'agent',
        success: true,
      });
      expect(JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes))).not.toContain(
        'versioned JSON',
      );
    });
  });
});
