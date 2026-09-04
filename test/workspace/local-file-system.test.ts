import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import type { FileSystemError } from '../../src/workspace/filesystem-capability.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';

describe('LocalFileSystemCapability', () => {
  let workspaceRoot: string;
  let outsideRoot: string;
  let exporter: InMemorySpanExporter;
  let tracing: TracingHandle;

  beforeEach(async () => {
    workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-harness-workspace-'));
    outsideRoot = await mkdtemp(join(tmpdir(), 'agent-harness-outside-'));
    await mkdir(join(workspaceRoot, 'src'));
    await writeFile(join(workspaceRoot, 'README.md'), 'hello workspace', 'utf8');
    await writeFile(join(workspaceRoot, 'src', 'index.ts'), 'export {};', 'utf8');
    await writeFile(join(outsideRoot, 'secret.txt'), 'outside', 'utf8');
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
  });

  afterEach(async () => {
    await tracing.shutdown();
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  it('reads files and lists immediate directory entries beneath the root', async () => {
    const fileSystem = new LocalFileSystemCapability({
      workspaceRoot,
      tracer: tracing.tracer,
    });

    const file = await fileSystem.readFile('README.md');
    const entries = await fileSystem.listDirectory('.');
    await tracing.forceFlush();

    expect(file).toEqual({
      path: 'README.md',
      content: 'hello workspace',
      sizeBytes: 15,
    });
    expect(entries).toEqual([
      { path: 'README.md', name: 'README.md', kind: 'file' },
      { path: 'src', name: 'src', kind: 'directory' },
    ]);
    expect(exporter.getFinishedSpans().map((span) => span.attributes)).toEqual([
      expect.objectContaining({
        'workspace.type': 'local',
        operation: 'filesystem.read_file',
        success: true,
        'filesystem.bytes_read': 15,
      }),
      expect.objectContaining({
        'workspace.type': 'local',
        operation: 'filesystem.list_directory',
        success: true,
        'filesystem.entry_count': 2,
      }),
    ]);
    expect(
      JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes)),
    ).not.toContain('hello workspace');
  });

  it('normalizes missing file and directory failures', async () => {
    const fileSystem = new LocalFileSystemCapability({
      workspaceRoot,
      tracer: tracing.tracer,
    });

    await expect(fileSystem.readFile('missing.txt')).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'not_found',
      requestedPath: 'missing.txt',
    });
    await expect(fileSystem.listDirectory('missing')).rejects.toMatchObject({
      name: 'FileSystemError',
      code: 'not_found',
      requestedPath: 'missing',
    });
  });

  it('rejects lexical, absolute, and symlink escapes outside the workspace root', async () => {
    await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'linked-secret.txt'));
    const fileSystem = new LocalFileSystemCapability({
      workspaceRoot,
      tracer: tracing.tracer,
    });

    const attempts = [
      fileSystem.readFile('../secret.txt'),
      fileSystem.readFile(join(outsideRoot, 'secret.txt')),
      fileSystem.readFile('linked-secret.txt'),
    ];

    for (const attempt of attempts) {
      await expect(attempt).rejects.toMatchObject({
        name: 'FileSystemError',
        code: 'outside_workspace',
      });
    }
  });

  it('fails explicitly when bounded output limits are exceeded', async () => {
    const fileSystem = new LocalFileSystemCapability({
      workspaceRoot,
      tracer: tracing.tracer,
      maxReadBytes: 4,
      maxDirectoryEntries: 1,
    });

    await expect(fileSystem.readFile('README.md')).rejects.toMatchObject({
      code: 'output_limit_exceeded',
    });
    await expect(fileSystem.listDirectory('.')).rejects.toMatchObject({
      code: 'output_limit_exceeded',
    });
  });

  it('honors cancellation before starting filesystem work', async () => {
    const fileSystem = new LocalFileSystemCapability({
      workspaceRoot,
      tracer: tracing.tracer,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(fileSystem.readFile('README.md', { signal: controller.signal })).rejects.toEqual(
      expect.objectContaining<Partial<FileSystemError>>({
        name: 'FileSystemError',
        code: 'cancelled',
      }),
    );
  });
});
