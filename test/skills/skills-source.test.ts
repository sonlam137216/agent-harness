import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextBuilder, type ContextBuildInput } from '../../src/context/context-builder.js';
import { createModelCallId, createSessionId, createTurnId } from '../../src/ids.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import {
  SkillsSource,
  type SkillRoot,
  type SkillsOptions,
} from '../../src/skills/skills-source.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';
import {
  FileSystemError,
  type FileSystemCapability,
} from '../../src/workspace/filesystem-capability.js';

function input(prompt = '$review'): ContextBuildInput {
  const turnId = createTurnId();
  return {
    agent: { name: 'test', systemPrompt: 'System policy', model: { modelId: 'fake' } },
    modelCallId: createModelCallId(),
    turnId,
    tools: [],
    session: {
      id: createSessionId(),
      turns: [
        { id: turnId, status: 'in_progress', entries: [{ kind: 'user_message', content: prompt }] },
      ],
    },
  };
}

describe('skills context source', () => {
  let root: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let roots: SkillRoot[];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'harness-skills-'));
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    roots = ['project', 'user'].map((scope) => ({
      scope: scope as 'project' | 'user',
      directory: 'skills',
      files: new LocalFileSystemCapability({
        workspaceRoot: join(root, scope),
        tracer: tracing.tracer,
      }),
    }));
    await Promise.all(['project', 'user'].map((scope) => mkdir(join(root, scope))));
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  async function skill(scope: string, name: string, body = 'PRIVATE workflow', folder = name) {
    const directory = join(root, scope, 'skills', folder);
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Review code changes\n---\n${body}`,
    );
  }
  const source = (options: SkillsOptions = {}) => new SkillsSource(roots, tracing.tracer, options);

  it('discovers project and user skills with project precedence independent of root order', async () => {
    await skill('project', 'review', 'PROJECT_PRIVATE');
    await skill('user', 'review', 'SHADOWED_PRIVATE');
    await skill('user', 'test', 'USER_PRIVATE');
    await skill('project', 'unused', 'UNSELECTED_PRIVATE');
    await mkdir(join(root, 'project', 'skills', 'empty'));
    const result = await source().load(input('$review $test $review'));
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.content).toContain('PROJECT_PRIVATE');
    expect(result.messages[1]?.content).toContain('USER_PRIVATE');
    expect(JSON.stringify(result)).not.toMatch(/SHADOWED_PRIVATE|UNSELECTED_PRIVATE/u);
    expect(result.tools).toEqual([]);
  });

  it('budgets complete selected skills and emits correlated metadata without content or paths', async () => {
    await skill('project', 'review');
    const buildInput = input();
    const result = await new ContextBuilder(tracing.tracer, {
      additionalSources: [source()],
    }).build(buildInput);
    expect(result.accounting.sources.skills).toBeGreaterThan(0);
    const before = JSON.stringify(buildInput.session);
    await expect(
      new ContextBuilder(tracing.tracer, {
        additionalSources: [source()],
        budget: { windowTokens: 200, outputReserveTokens: 100 },
      }).build(buildInput),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(JSON.stringify(buildInput.session)).toBe(before);
    await tracing.forceFlush();
    const spans = exporter.getFinishedSpans();
    const skillsSpan = spans.find((span) => span.name === 'context.skills')!;
    expect(skillsSpan.attributes).toMatchObject({
      'session.id': buildInput.session.id,
      'turn.id': buildInput.turnId,
      'model_call.id': buildInput.modelCallId,
      'skills.selected_count': 1,
      success: true,
    });
    expect(skillsSpan.parentSpanContext?.spanId).toBe(
      spans.find((span) => span.name === 'context.build')?.spanContext().spanId,
    );
    expect(skillsSpan.events.map((event) => event.name)).toEqual([
      'skills.selected',
      'skills.injected',
    ]);
    expect(
      JSON.stringify(spans.map((span) => ({ attributes: span.attributes, events: span.events }))),
    ).not.toMatch(/PRIVATE|SKILL.md|review|harness-skills-/u);
  });

  it('does not activate historical invocations, assistant content, or nested skill instructions', async () => {
    await skill('project', 'review', 'Follow $missing now.');
    const current = input('continue');
    const history = {
      ...current,
      session: {
        ...current.session,
        turns: [
          {
            id: createTurnId(),
            status: 'completed' as const,
            entries: [{ kind: 'user_message' as const, content: '$review' }],
          },
          {
            ...current.session.turns[0]!,
            entries: [
              ...current.session.turns[0]!.entries,
              {
                kind: 'assistant_message' as const,
                modelCallId: createModelCallId(),
                content: '$review',
                toolCalls: [],
              },
            ],
          },
        ],
      },
    };
    expect((await source().load(history)).messages).toEqual([]);
    expect((await source().load(input())).messages).toHaveLength(1);
    expect((await source({ automatic: true }).load(input('Review code'))).messages).toHaveLength(1);
  });

  it('allows missing roots and files but surfaces unknown invocations and malformed or duplicate skills', async () => {
    expect((await source().load(input('plain prompt'))).messages).toEqual([]);
    await expect(source().load(input())).rejects.toThrow('not found');
    await skill('project', 'review');
    await skill('project', 'review', 'Duplicate', 'another-folder');
    await expect(source().load(input())).rejects.toThrow('Duplicate skill');
    await writeFile(join(root, 'project/skills/another-folder/SKILL.md'), 'Malformed PRIVATE');
    await expect(source().load(input())).rejects.toThrow('Invalid SKILL.md');
  });

  it.each([{ maxFileBytes: 10 }, { maxTotalBytes: 10 }, { maxSkills: 1 }])(
    'enforces discovery limits: %j',
    async (options) => {
      await skill('project', 'review');
      await skill('user', 'test');
      await expect(source(options).load(input())).rejects.toThrow('configured limit');
    },
  );

  it('rejects traversal and escaped skill files and skips symlink directories', async () => {
    for (const directory of ['../outside', '/outside', 'C:\\outside', 'skills/../../out']) {
      expect(() => new SkillsSource([{ ...roots[0]!, directory }], tracing.tracer)).toThrow(
        RangeError,
      );
    }
    await skill('user', 'review');
    await mkdir(join(root, 'project/skills'), { recursive: true });
    await symlink(join(root, 'user/skills/review'), join(root, 'project/skills/linked'));
    const project = new SkillsSource([roots[0]!], tracing.tracer);
    expect((await project.load(input('plain'))).messages).toEqual([]);
    await mkdir(join(root, 'project/skills/review'));
    await symlink(
      join(root, 'user/skills/review/SKILL.md'),
      join(root, 'project/skills/review/SKILL.md'),
    );
    await expect(project.load(input())).rejects.toMatchObject({
      code: 'source_failed',
      cause: { message: 'outside_workspace' },
    });
  });

  it('propagates cancellation and deadlines, normalizes I/O errors and rejects invalid configuration', async () => {
    const controller = new AbortController();
    const readFile = vi.fn<FileSystemCapability['readFile']>();
    const files: FileSystemCapability = {
      readFile,
      listDirectory: (_path, options) => {
        expect(options?.signal).toBe(controller.signal);
        controller.abort();
        return Promise.resolve([]);
      },
    };
    const cancelled = new SkillsSource(
      [{ scope: 'project', directory: '.', files }],
      tracing.tracer,
    );
    await expect(cancelled.load({ ...input(), signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(readFile).not.toHaveBeenCalled();
    await expect(source().load({ ...input(), deadlineMs: Date.now() - 1 })).rejects.toMatchObject({
      code: 'deadline_exceeded',
    });
    const broken = new SkillsSource(
      [
        {
          scope: 'project',
          directory: '.',
          files: {
            readFile,
            listDirectory: () =>
              Promise.reject(
                new FileSystemError('SECRET', { code: 'io_error', requestedPath: 'PRIVATE' }),
              ),
          },
        },
      ],
      tracing.tracer,
    );
    await expect(broken.load(input())).rejects.toMatchObject({
      code: 'source_failed',
      cause: { message: 'io_error' },
    });
    expect(() => source({ maxSkills: 0 })).toThrow(RangeError);
    expect(() => new SkillsSource([roots[0]!, roots[0]!], tracing.tracer)).toThrow(RangeError);
  });
});
