import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextBuilder } from '../../src/context/context-builder.js';
import type { ContextSourceInput } from '../../src/context/context-source.js';
import { createModelCallId, createSessionId, createTurnId } from '../../src/ids.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { ProjectRulesSource } from '../../src/project-rules/project-rules-source.js';
import {
  FileSystemError,
  type FileSystemCapability,
} from '../../src/workspace/filesystem-capability.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';

function input(): ContextSourceInput {
  const turnId = createTurnId();
  return {
    agent: { name: 'test', systemPrompt: 'System policy.', model: { modelId: 'test' } },
    turnId,
    tools: [],
    session: {
      id: createSessionId(),
      turns: [
        {
          id: turnId,
          status: 'in_progress',
          entries: [{ kind: 'user_message', content: 'Inspect.' }],
        },
      ],
    },
  };
}

describe('Project rules context source', () => {
  let directory: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let files: LocalFileSystemCapability;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'harness-rules-'));
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    await mkdir(join(directory, 'repo/src/feature'), { recursive: true });
    await mkdir(join(directory, 'repo/other'));
    files = new LocalFileSystemCapability({
      workspaceRoot: join(directory, 'repo'),
      tracer: tracing.tracer,
    });
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it('loads ancestor rules in order, excludes siblings, and accounts for rules without tracing their content', async () => {
    await writeFile(join(directory, 'repo/AGENTS.md'), 'ROOT_PRIVATE use TypeScript.');
    await writeFile(join(directory, 'repo/src/AGENTS.md'), 'SRC_PRIVATE use tabs.');
    await writeFile(
      join(directory, 'repo/src/feature/AGENTS.md'),
      'FEATURE_PRIVATE use spaces here.',
    );
    await writeFile(join(directory, 'repo/other/AGENTS.md'), 'SIBLING_PRIVATE should never load.');
    const source = new ProjectRulesSource(files, tracing.tracer, { directory: 'src/feature' });
    const result = await new ContextBuilder(tracing.tracer, { additionalSources: [source] }).build({
      ...input(),
      modelCallId: createModelCallId(),
    });
    expect(result.request.messages.slice(1, 4).map((message) => message.content)).toEqual([
      expect.stringContaining('ROOT_PRIVATE'),
      expect.stringContaining('SRC_PRIVATE'),
      expect.stringContaining('FEATURE_PRIVATE'),
    ]);
    expect(JSON.stringify(result.request)).not.toContain('SIBLING_PRIVATE');
    expect(result.accounting.sources.rules).toBeGreaterThan(0);
    await tracing.forceFlush();
    const attributes = exporter.getFinishedSpans().map((span) => span.attributes);
    expect(JSON.stringify(attributes)).not.toContain('PRIVATE');
    expect(JSON.stringify(attributes)).not.toContain('AGENTS.md');
    expect(
      exporter.getFinishedSpans().find((span) => span.name === 'context.rules')?.attributes[
        'rules.file_count'
      ],
    ).toBe(3);
  });

  it('allows absent rules but does not swallow permission, I/O or size failures', async () => {
    expect((await new ProjectRulesSource(files, tracing.tracer).load(input())).messages).toEqual(
      [],
    );
    await writeFile(join(directory, 'repo/AGENTS.md'), 'x'.repeat(20));
    await expect(
      new ProjectRulesSource(files, tracing.tracer, { maxBytes: 10 }).load(input()),
    ).rejects.toMatchObject({ code: 'source_failed' });
    const broken: FileSystemCapability = {
      readFile: () =>
        Promise.reject(
          new FileSystemError('private path', { code: 'io_error', requestedPath: 'secret' }),
        ),
      listDirectory: () => Promise.resolve([]),
    };
    await expect(
      new ProjectRulesSource(broken, tracing.tracer).load(input()),
    ).rejects.toMatchObject({ code: 'source_failed', cause: { message: 'io_error' } });
  });

  it('rejects traversal and symlink escapes through the Workspace boundary', async () => {
    for (const path of ['../outside', '/outside', 'src/../../outside', 'C:\\outside', 'src\\..']) {
      expect(() => new ProjectRulesSource(files, tracing.tracer, { directory: path })).toThrow(
        RangeError,
      );
    }
    await writeFile(join(directory, 'outside.md'), 'Outside rules.');
    await symlink(join(directory, 'outside.md'), join(directory, 'repo/AGENTS.md'));
    await expect(new ProjectRulesSource(files, tracing.tracer).load(input())).rejects.toMatchObject(
      { code: 'source_failed', cause: { message: 'outside_workspace' } },
    );
  });

  it('carries cancellation into workspace reads and stops before the next ancestor', async () => {
    const controller = new AbortController();
    const readFile = vi.fn((_path: string, options?: { signal?: AbortSignal }) => {
      expect(options?.signal).toBe(controller.signal);
      controller.abort();
      return Promise.resolve({ path: 'AGENTS.md', content: 'Rules.', sizeBytes: 6 });
    });
    const source = new ProjectRulesSource(
      { readFile, listDirectory: () => Promise.resolve([]) },
      tracing.tracer,
      { directory: 'src/feature' },
    );
    await expect(source.load({ ...input(), signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
