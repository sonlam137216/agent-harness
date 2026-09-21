import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CliUsageError,
  parsePhaseOneCliArguments,
  runPhaseOneCli,
} from '../../src/cli/phase-one-cli.js';
import { createToolCallId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import type { ModelRequest, ModelResponse } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';

class ReadThenAnswerFakeSampler implements Sampler {
  public readonly requests: ModelRequest[] = [];
  readonly #toolCallId = createToolCallId();

  public sample(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    if (this.requests.length === 1) {
      return Promise.resolve({
        modelCallId: request.modelCallId,
        text: null,
        toolCalls: [
          { id: this.#toolCallId, name: 'read_file', arguments: { path: 'fixture.txt' } },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: 'tool_calls',
      });
    }

    const toolMessage = request.messages.find(
      (message) => message.role === 'tool' && message.toolCallId === this.#toolCallId,
    );
    if (
      toolMessage === undefined ||
      toolMessage.role !== 'tool' ||
      !toolMessage.content.includes('phase-one fixture')
    ) {
      throw new Error('The fake model did not receive the read_file result.');
    }

    return Promise.resolve({
      modelCallId: request.modelCallId,
      text: 'fixture.txt contains “phase-one fixture”.',
      toolCalls: [],
      usage: { inputTokens: 30, outputTokens: 8 },
      stopReason: 'end_turn',
    });
  }
}

describe('Phase 1 CLI', () => {
  const temporaryDirectories: string[] = [];
  const tracingHandles: TracingHandle[] = [];

  afterEach(async () => {
    await Promise.all(tracingHandles.splice(0).map((tracing) => tracing.shutdown()));
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it('parses explicit permission modes and repeated exact-name rules', () => {
    const parsed = parsePhaseOneCliArguments(
      [
        '--model',
        'fake',
        '--permission-mode',
        'ask',
        '--allow-tool',
        'read_file',
        '--ask-tool',
        'read_file',
        '--deny-tool',
        'search_text',
        'inspect',
      ],
      {},
      '/workspace',
    );
    expect(parsed).toMatchObject({
      config: {
        permissionMode: 'ask',
        permissionRules: [
          { toolName: 'read_file', decision: 'allow' },
          { toolName: 'read_file', decision: 'ask' },
          { toolName: 'search_text', decision: 'deny' },
        ],
      },
    });
    expect(() =>
      parsePhaseOneCliArguments(
        ['--model', 'fake', '--permission-mode', 'unsafe', 'inspect'],
        {},
        '/workspace',
      ),
    ).toThrow(CliUsageError);
  });

  it.each([true, false])(
    'runs the CLI approval path end-to-end (approved=%s)',
    async (approved) => {
      const directory = await mkdtemp(join(tmpdir(), 'phase-three-cli-'));
      temporaryDirectories.push(directory);
      await writeFile(join(directory, 'fixture.txt'), 'approved file content');
      const tracing = createTracing({ exporter: new InMemorySpanExporter() });
      tracingHandles.push(tracing);
      let iteration = 0;
      const approve = vi.fn(() => approved);
      const sample: Sampler['sample'] = (request) => {
        iteration += 1;
        if (iteration === 1)
          return Promise.resolve({
            modelCallId: request.modelCallId,
            text: null,
            toolCalls: [
              { id: createToolCallId(), name: 'read_file', arguments: { path: 'fixture.txt' } },
            ],
            usage: { inputTokens: 1, outputTokens: 1 },
            stopReason: 'tool_calls',
          });
        const message = request.messages.at(-1);
        expect(message?.role).toBe('tool');
        if (message?.role === 'tool')
          expect(message.content).toContain(approved ? 'approved file content' : 'access_denied');
        return Promise.resolve({
          modelCallId: request.modelCallId,
          text: 'Finished',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
          stopReason: 'end_turn',
        });
      };
      const result = await runPhaseOneCli({
        modelId: 'fake',
        prompt: 'read fixture',
        workspaceRoot: directory,
        userSkillsDirectory: join(directory, 'user-skills'),
        tracer: tracing.tracer,
        sampler: { sample },
        writeOutput: () => undefined,
        approve,
        permissionMode: 'always-approve',
        permissionRules: [{ decision: 'ask', toolName: 'read_file' }],
      });
      expect(result.outcome).toBe('completed');
      expect(approve).toHaveBeenCalledTimes(1);
    },
  );

  it('parses model, workspace, and prompt without introducing provider config into AgentDefinition', () => {
    expect(
      parsePhaseOneCliArguments(
        ['--', '--model', 'flag-model', '--workspace', 'repo', 'inspect', 'package.json'],
        { AGENT_HARNESS_MODEL: 'environment-model' },
        '/workspace',
      ),
    ).toEqual({
      help: false,
      provider: 'openai',
      config: {
        modelId: 'flag-model',
        workspaceRoot: '/workspace/repo',
        prompt: 'inspect package.json',
      },
    });
  });

  it('uses the model environment fallback and rejects incomplete invocations', () => {
    expect(
      parsePhaseOneCliArguments(
        ['answer'],
        { AGENT_HARNESS_MODEL: 'env-model', AGENT_HARNESS_PROVIDER: 'ollama' },
        '/workspace',
      ),
    ).toEqual({
      help: false,
      provider: 'ollama',
      config: { modelId: 'env-model', workspaceRoot: '/workspace', prompt: 'answer' },
    });
    expect(() => parsePhaseOneCliArguments(['answer'], {}, '/workspace')).toThrow(CliUsageError);
    expect(() => parsePhaseOneCliArguments(['--model', 'model-only'], {}, '/workspace')).toThrow(
      'Provide a non-empty user prompt.',
    );
    expect(() =>
      parsePhaseOneCliArguments(
        ['--provider', 'unknown', '--model', 'model', 'answer'],
        {},
        '/workspace',
      ),
    ).toThrow('Unknown provider');
  });

  it('accepts explicit context budgets and rule scope and rejects invalid settings', () => {
    const parsed = parsePhaseOneCliArguments(
      [
        '--model',
        'test',
        '--context-window',
        '8000',
        '--output-reserve',
        '1000',
        '--rules-directory',
        'src/feature',
        'Inspect',
      ],
      {},
      '/workspace',
    );
    expect(parsed).toMatchObject({
      config: {
        contextBudget: { windowTokens: 8000, outputReserveTokens: 1000 },
        rulesDirectory: 'src/feature',
      },
    });
    for (const args of [
      ['--context-window', '3000'],
      ['--output-reserve', '0'],
      ['--context-window', '1.5'],
      ['--rules-directory', '../outside'],
    ]) {
      expect(() =>
        parsePhaseOneCliArguments(['--model', 'test', ...args, 'Inspect'], {}, '/workspace'),
      ).toThrow(CliUsageError);
    }
  });

  it('runs the complete read-only harness with a FakeSampler and no external credentials', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-harness-cli-'));
    temporaryDirectories.push(workspaceRoot);
    await writeFile(join(workspaceRoot, 'fixture.txt'), 'phase-one fixture\n', 'utf8');
    await writeFile(join(workspaceRoot, 'AGENTS.md'), 'Use fixture evidence in your answer.');

    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({ exporter });
    tracingHandles.push(tracing);
    const sampler = new ReadThenAnswerFakeSampler();
    const writeOutput = vi.fn<(text: string) => void>();

    const result = await runPhaseOneCli({
      modelId: 'fake-model',
      prompt: 'Read fixture.txt and report its contents.',
      workspaceRoot,
      sampler,
      userSkillsDirectory: join(workspaceRoot, 'user-skills'),
      tracer: tracing.tracer,
      writeOutput,
    });
    await tracing.forceFlush();

    expect(result).toMatchObject({
      outcome: 'completed',
      iterations: 2,
      finalText: 'fixture.txt contains “phase-one fixture”.',
    });
    expect(writeOutput).toHaveBeenCalledOnce();
    expect(writeOutput).toHaveBeenCalledWith('fixture.txt contains “phase-one fixture”.');
    expect(sampler.requests).toHaveLength(2);
    expect(sampler.requests[0]?.maxOutputTokens).toBe(4096);
    expect(
      sampler.requests[0]?.messages.some(
        (message) => message.role === 'system' && message.content.includes('Use fixture evidence'),
      ),
    ).toBe(true);
    expect(sampler.requests[0]?.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_files',
      'search_text',
    ]);

    const spanNames = exporter.getFinishedSpans().map((span) => span.name);
    expect(spanNames).toEqual(
      expect.arrayContaining([
        'session.run',
        'turn.run',
        'agent.loop.iteration',
        'context.build',
        'model.sample',
        'tool.execute',
        'workspace.operation',
      ]),
    );
  });

  it('completes the full read-only harness when trace export fails', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-harness-cli-'));
    temporaryDirectories.push(workspaceRoot);
    await writeFile(join(workspaceRoot, 'fixture.txt'), 'phase-one fixture\n', 'utf8');

    const failures: unknown[] = [];
    const exporter: SpanExporter = {
      export: () => {
        throw new Error('trace export failed');
      },
      shutdown: () => Promise.resolve(),
    };
    const tracing = createTracing({ exporter, onError: (error) => failures.push(error) });
    tracingHandles.push(tracing);
    const writeOutput = vi.fn<(text: string) => void>();

    const result = await runPhaseOneCli({
      modelId: 'fake-model',
      prompt: 'Read fixture.txt and report its contents.',
      workspaceRoot,
      sampler: new ReadThenAnswerFakeSampler(),
      userSkillsDirectory: join(workspaceRoot, 'user-skills'),
      tracer: tracing.tracer,
      writeOutput,
    });
    await tracing.forceFlush();

    expect(result).toMatchObject({
      outcome: 'completed',
      finalText: 'fixture.txt contains “phase-one fixture”.',
    });
    expect(writeOutput).toHaveBeenCalledWith('fixture.txt contains “phase-one fixture”.');
    expect(failures.length).toBeGreaterThan(0);
  });
});
