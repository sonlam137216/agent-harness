import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parsePhaseOneCliArguments,
  runPhaseOneCli,
  type RunPhaseOneCliOptions,
} from '../../src/cli/phase-one-cli.js';
import {
  createWorktreeManager,
  parseWorktreeCommand,
  runWorktreeCommand,
} from '../../src/cli/worktree-cli.js';
import { createSubagentId, createToolCallId } from '../../src/ids.js';
import type { JsonObject } from '../../src/json.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import type { ModelRequest, ModelResponse } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import type { Session } from '../../src/session/session.js';
import type { ToolResult } from '../../src/session/turn.js';
import { EditFileTool } from '../../src/tools/builtin/edit-file.tool.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';
import { LocalFileWriter } from '../../src/workspace/local-file-writer.js';
import type { WorktreeManager } from '../../src/worktrees/worktree-manager.js';

type Reply = Pick<ModelResponse, 'text' | 'toolCalls'>;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@localhost', ...args], {
    cwd,
    encoding: 'utf8',
  });
}
function call(name: string, args: JsonObject) {
  return { id: createToolCallId(), name, arguments: args };
}
function tools(...calls: ReturnType<typeof call>[]): Reply {
  return { text: null, toolCalls: calls };
}
function answer(text: string): Reply {
  return { text, toolCalls: [] };
}
function systemPrompt(request: ModelRequest): string {
  const system = request.messages.find((m) => m.role === 'system');
  return system?.role === 'system' ? system.content : '';
}
function task(request: ModelRequest): string {
  return request.messages.find((m) => m.role === 'user')!.content ?? '';
}
function toolOutputs(request: ModelRequest): { outcome: string; output: JsonObject }[] {
  return request.messages.flatMap((m) =>
    m.role === 'tool' ? [JSON.parse(m.content) as { outcome: string; output: JsonObject }] : [],
  );
}
function results(session: Session): ToolResult[] {
  return session.turns
    .at(-1)!
    .entries.filter((entry): entry is ToolResult => entry.kind === 'tool_result');
}
/** Parent replies by index; children reply by their task text and their own request count. */
function scripted(
  parent: (request: ModelRequest, index: number) => Reply | Promise<Reply>,
  child: (request: ModelRequest, index: number, signal?: AbortSignal) => Reply | Promise<Reply>,
) {
  const requests = { parent: [] as ModelRequest[], child: [] as ModelRequest[] };
  const perTask = new Map<string, number>();
  const sampler: Sampler = {
    sample: async (request, options) => {
      const isChild = systemPrompt(request).includes('subagent working for a parent agent');
      if (!isChild) requests.parent.push(request);
      else requests.child.push(request);
      const key = task(request);
      const index = isChild ? (perTask.get(key) ?? 0) : requests.parent.length - 1;
      if (isChild) perTask.set(key, index + 1);
      const reply = isChild
        ? await child(request, index, options?.signal)
        : await parent(request, index);
      return {
        modelCallId: request.modelCallId,
        text: reply.text,
        toolCalls: reply.toolCalls,
        stopReason: reply.toolCalls.length > 0 ? 'tool_calls' : 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
  return { sampler, requests };
}

describe('worktrees', () => {
  let root: string;
  let repo: string;
  let worktreeDirectory: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let manager: WorktreeManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'worktrees-'));
    repo = join(root, 'repo');
    worktreeDirectory = join(root, 'worktrees');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'README.md'), 'title\nline two\n');
    await writeFile(join(repo, 'src/app.ts'), 'export const value = 1;\n');
    git(repo, 'init', '--quiet', '--initial-branch=main');
    git(repo, 'add', '.');
    git(repo, 'commit', '--quiet', '-m', 'initial');
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    manager = createWorktreeManager(repo, worktreeDirectory, tracing.tracer);
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  describe('LocalFileWriter and edit_file', () => {
    it('writes contained files atomically and refuses unsafe targets', async () => {
      const writer = new LocalFileWriter({ root: repo, tracer: tracing.tracer, maxWriteBytes: 64 });
      expect(await writer.writeFile('new/deep/file.txt', 'hello')).toEqual({
        path: 'new/deep/file.txt',
        sizeBytes: 5,
        created: true,
      });
      expect(await writer.writeFile('README.md', 'replaced')).toMatchObject({ created: false });
      expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('replaced');

      const outside = join(root, 'outside');
      await mkdir(outside);
      await symlink(outside, join(repo, 'linked'));
      await symlink(join(outside, 'target.txt'), join(repo, 'link.txt'));
      for (const [path, code] of [
        ['../escape.txt', 'outside_workspace'],
        ['/etc/passwd', 'outside_workspace'],
        ['a/./b.txt', 'outside_workspace'],
        ['.git/config', 'protected_path'],
        ['sub/.GIT/x', 'protected_path'],
        ['linked/file.txt', 'outside_workspace'],
        ['link.txt', 'not_file'],
        ['src', 'not_file'],
      ] as const)
        await expect(writer.writeFile(path, 'x')).rejects.toMatchObject({ code });
      await expect(writer.writeFile('big.txt', 'x'.repeat(65))).rejects.toMatchObject({
        code: 'size_limit',
      });
      const controller = new AbortController();
      controller.abort();
      await expect(
        writer.writeFile('cancelled.txt', 'x', { signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'cancelled' });
      await expect(stat(join(outside, 'file.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(join(outside, 'target.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('edits exactly one match and changes nothing otherwise', async () => {
      const files = new LocalFileSystemCapability({ workspaceRoot: repo, tracer: tracing.tracer });
      const edit = new EditFileTool(
        files,
        new LocalFileWriter({ root: repo, tracer: tracing.tracer }),
      );
      const run = (args: JsonObject) => edit.execute(call('edit_file', args));
      await writeFile(join(repo, 'twice.txt'), 'same same');
      expect(
        await run({ path: 'README.md', oldText: 'line two', newText: 'line 2' }),
      ).toMatchObject({ outcome: 'success' });
      expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('title\nline 2\n');
      expect(await run({ path: 'README.md', oldText: 'absent', newText: 'x' })).toMatchObject({
        output: { error: { code: 'no_match' } },
      });
      expect(await run({ path: 'twice.txt', oldText: 'same', newText: 'x' })).toMatchObject({
        output: { error: { code: 'ambiguous_match' } },
      });
      expect(await readFile(join(repo, 'twice.txt'), 'utf8')).toBe('same same');
    });
  });

  describe('WorktreeManager', () => {
    const writeIn = (path: string, file: string, content: string) =>
      writeFile(join(path, file), content);

    it('requires a repository top level and a directory outside it', async () => {
      const plain = join(root, 'plain');
      await mkdir(plain);
      await expect(
        createWorktreeManager(plain, worktreeDirectory, tracing.tracer).verify(),
      ).rejects.toMatchObject({ code: 'not_repository_root' });
      await expect(
        createWorktreeManager(join(repo, 'src'), worktreeDirectory, tracing.tracer).verify(),
      ).rejects.toMatchObject({ code: 'not_repository_root' });
      await expect(
        createWorktreeManager(repo, join(repo, '.trees'), tracing.tracer).verify(),
      ).rejects.toMatchObject({ code: 'invalid_directory' });
    });

    it('isolates, snapshots, applies and removes changes without losing them', async () => {
      const record = await manager.create({ id: createSubagentId() });
      expect(record).toMatchObject({ status: 'active', branch: `agent-harness/${record.id}` });
      await writeIn(record.path, 'README.md', 'title\nchanged in worktree\n');
      await writeIn(record.path, 'NEW.md', 'new file\n');
      // The main working tree is untouched while the worktree changes.
      expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('title\nline two\n');

      const ready = await manager.finalize(record.id, {});
      expect(ready).toMatchObject({
        status: 'ready',
        changes: { files: 2, insertions: 2, deletions: 1 },
      });
      expect(ready.headCommit).not.toBe(ready.baseCommit);
      expect((await manager.diff(record.id)).patch).toContain('+changed in worktree');
      await expect(manager.remove(record.id)).rejects.toMatchObject({ code: 'unapplied_changes' });

      expect(await manager.apply(record.id)).toMatchObject({ status: 'applied' });
      expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('title\nchanged in worktree\n');
      expect(await readFile(join(repo, 'NEW.md'), 'utf8')).toBe('new file\n');
      // Applied to the working tree only; nothing is staged or committed.
      expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
      await expect(manager.apply(record.id)).rejects.toMatchObject({ code: 'already_applied' });

      expect(await manager.remove(record.id)).toMatchObject({ status: 'removed' });
      await expect(stat(record.path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(git(repo, 'branch', '--list', record.branch)).toBe('');
      expect(await manager.list()).toEqual([]);
      expect(await manager.list({ includeRemoved: true })).toHaveLength(1);
    });

    it('refuses conflicting changes atomically and protects active worktrees', async () => {
      const first = await manager.create({ id: createSubagentId() });
      const second = await manager.create({ id: createSubagentId() });
      await writeIn(first.path, 'README.md', 'title\nfirst\n');
      await writeIn(second.path, 'src/app.ts', 'export const value = 2;\n');
      await writeIn(second.path, 'README.md', 'title\nsecond\n');
      await expect(manager.remove(first.id)).rejects.toMatchObject({ code: 'active' });
      await manager.finalize(first.id);
      await manager.finalize(second.id);

      await manager.apply(first.id);
      await expect(manager.apply(second.id)).rejects.toMatchObject({ code: 'conflict' });
      // Nothing from the rejected patch was applied, including its non-conflicting file.
      expect(await readFile(join(repo, 'src/app.ts'), 'utf8')).toBe('export const value = 1;\n');
      expect((await manager.get(second.id)).status).toBe('ready');
      expect(await manager.remove(second.id, { force: true })).toMatchObject({ status: 'removed' });
    });

    it('never runs repository hooks', async () => {
      const hook = join(repo, '.git/hooks/post-checkout');
      await writeFile(hook, `#!/bin/sh\ntouch "${join(root, 'hook-ran')}"\n`);
      await chmod(hook, 0o755);
      const record = await manager.create({ id: createSubagentId() });
      await writeIn(record.path, 'README.md', 'x\n');
      await manager.finalize(record.id);
      await expect(stat(join(root, 'hook-ran'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('implement subagents', () => {
    let store: InMemorySessionStore;
    beforeEach(() => {
      store = new InMemorySessionStore();
    });

    const run = (sampler: Sampler, extra: Partial<RunPhaseOneCliOptions> = {}) =>
      runPhaseOneCli({
        modelId: 'fake',
        prompt: 'Change the readme in two different ways.',
        workspaceRoot: repo,
        userSkillsDirectory: join(root, 'no-user-skills'),
        sessionStore: store,
        subagents: { worktreeDirectory },
        sampler,
        tracer: tracing.tracer,
        writeOutput: () => undefined,
        ...extra,
      });

    it('lets two children modify the same file without sharing working-tree state', async () => {
      const { sampler, requests } = scripted(
        (request, index) => {
          if (index === 0)
            return tools(
              call('delegate_task', { role: 'implement', task: 'variant A', background: true }),
              call('delegate_task', { role: 'implement', task: 'variant B', background: true }),
            );
          if (index === 1)
            return tools(
              ...toolOutputs(request).map(({ output }) =>
                call('await_subagent', { subagentId: output.subagentId as string }),
              ),
            );
          return answer('Two variants are ready for review.');
        },
        (request, index) => {
          const variant = task(request).slice(-1);
          if (index === 0)
            return tools(
              call('edit_file', {
                path: 'README.md',
                oldText: 'line two',
                newText: `variant ${variant}`,
              }),
            );
          return answer(`Changed README.md to variant ${variant}.`);
        },
      );
      const result = await run(sampler);

      const [, , awaitedA, awaitedB] = results(result.session);
      for (const awaited of [awaitedA, awaitedB])
        expect(awaited).toMatchObject({
          outcome: 'success',
          output: {
            role: 'implement',
            outcome: 'completed',
            worktree: { changes: { files: 1, insertions: 1, deletions: 1 } },
          },
        });
      // The main working tree is unchanged; each worktree holds its own variant.
      expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('title\nline two\n');
      const records = await manager.list();
      expect(records.map((record) => record.status)).toEqual(['ready', 'ready']);
      const contents = await Promise.all(
        records.map((record) => readFile(join(record.path, 'README.md'), 'utf8')),
      );
      expect(contents.sort()).toEqual(['title\nvariant A\n', 'title\nvariant B\n']);

      // Only implement children get write tools; the parent never does.
      expect(requests.child[0]!.tools.map((tool) => tool.name)).toEqual([
        'read_file',
        'list_files',
        'search_text',
        'write_file',
        'edit_file',
      ]);
      expect(requests.parent[0]!.tools.map((tool) => tool.name)).not.toContain('write_file');
      const child = await store.get((awaitedA!.output as JsonObject).sessionId as Session['id']);
      expect(child!.metadata!.workspaceRoot).toBe(
        records.find((record) => record.sessionId === child!.id)!.path,
      );

      // The user applies one variant with the CLI; the other now conflicts and is refused.
      const output: string[] = [];
      const apply = (id: string) =>
        runWorktreeCommand(
          parseWorktreeCommand(
            ['worktrees', 'apply', id, '--worktree-dir', worktreeDirectory],
            repo,
          )!,
          manager,
          (text) => output.push(text),
        );
      await apply(records[0]!.id);
      expect(output[0]).toContain('Applied 1 changed file(s)');
      await expect(apply(records[1]!.id)).rejects.toMatchObject({ code: 'conflict' });

      await tracing.forceFlush();
      const spawn = exporter
        .getFinishedSpans()
        .find((span) => span.name === 'subagent.spawn' && span.attributes['subagent.worktree_id']);
      expect(spawn?.attributes).toMatchObject({ 'subagent.changed_files': 1, success: true });
    });

    it('offers implement only with --worktrees and honours parent deny rules', async () => {
      const plain = scripted(
        () => answer('ok'),
        () => answer('unused'),
      );
      await run(plain.sampler, { subagents: {} });
      const delegate = plain.requests.parent[0]!.tools.find(
        (tool) => tool.name === 'delegate_task',
      )!;
      expect(JSON.stringify(delegate.inputSchema)).not.toContain('implement');

      const denied = scripted(
        (_, index) =>
          index === 0
            ? tools(call('delegate_task', { role: 'implement', task: 'edit' }))
            : answer('done'),
        (_, index) =>
          index === 0
            ? tools(call('write_file', { path: 'README.md', content: 'nope' }))
            : answer('Could not write.'),
      );
      const result = await run(denied.sampler, {
        permissionRules: [{ toolName: 'write_file', decision: 'deny' }],
      });
      expect(toolOutputs(denied.requests.child[1]!)[0]).toMatchObject({
        output: { error: { code: 'access_denied' } },
      });
      expect(results(result.session)[0]!.output).toMatchObject({
        worktree: { changes: { files: 0 } },
      });
    });

    it('keeps partial work of a cancelled child', async () => {
      let markWritten: () => void = () => undefined;
      const written = new Promise<void>((resolve) => (markWritten = resolve));
      const { sampler } = scripted(
        async (request, index) => {
          if (index === 0)
            return tools(
              call('delegate_task', { role: 'implement', task: 'slow', background: true }),
            );
          const { subagentId } = toolOutputs(request)[0]!.output as { subagentId: string };
          // Cancel only after the child's write has executed.
          if (index === 1) await written;
          return index === 1 ? tools(call('cancel_subagent', { subagentId })) : answer('Stopped.');
        },
        (_, index, signal) => {
          if (index === 1) markWritten();
          return index === 0
            ? tools(call('write_file', { path: 'PARTIAL.md', content: 'partial\n' }))
            : new Promise<never>((_, reject) => {
                const fail = () => reject(new DOMException('aborted', 'AbortError'));
                if (signal?.aborted === true) fail();
                else signal?.addEventListener('abort', fail);
              });
        },
      );
      await run(sampler);
      const [record] = await manager.list();
      expect(record).toMatchObject({ status: 'ready', changes: { files: 1 } });
      expect((await manager.diff(record!.id)).patch).toContain('+partial');
    });

    it('fails before sampling when the workspace cannot host worktrees', async () => {
      const plain = join(root, 'plain');
      await mkdir(plain);
      let sampled = false;
      await expect(
        run(
          {
            sample: () => {
              sampled = true;
              return Promise.reject(new Error('unused'));
            },
          },
          { workspaceRoot: plain },
        ),
      ).rejects.toMatchObject({ code: 'not_repository_root' });
      expect(sampled).toBe(false);
    });

    it('parses run flags and worktree commands', () => {
      expect(
        parsePhaseOneCliArguments(
          ['--model', 'm', '--subagents', '--worktrees', '--worktree-dir', 'wt', 'hi'],
          {},
          root,
        ),
      ).toMatchObject({ config: { subagents: { worktreeDirectory: join(root, 'wt') } } });
      expect(() =>
        parsePhaseOneCliArguments(['--model', 'm', '--worktrees', 'hi'], {}, root),
      ).toThrow('require --subagents');
      expect(() =>
        parsePhaseOneCliArguments(
          ['--model', 'm', '--subagents', '--worktree-dir', 'x', 'hi'],
          {},
          root,
        ),
      ).toThrow('require --worktrees');

      const id = createSubagentId();
      expect(parseWorktreeCommand(['sessions', 'list'], root)).toBeUndefined();
      expect(parseWorktreeCommand(['--', 'worktrees', 'list', '--all'], root)).toMatchObject({
        kind: 'list',
        all: true,
      });
      expect(parseWorktreeCommand(['worktrees', 'remove', id, '--force'], root)).toMatchObject({
        kind: 'remove',
        id,
        force: true,
      });
      for (const args of [
        ['worktrees'],
        ['worktrees', 'apply'],
        ['worktrees', 'apply', 'not-a-uuid'],
        ['worktrees', 'apply', id, '--force'],
        ['worktrees', 'merge', id],
        ['worktrees', 'list', '--bogus'],
      ])
        expect(() => parseWorktreeCommand(args, root)).toThrow();
    });
  });
});
