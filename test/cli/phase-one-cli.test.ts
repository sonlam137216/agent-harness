import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
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

  it('parses model, workspace, and prompt without introducing provider config into AgentDefinition', () => {
    expect(
      parsePhaseOneCliArguments(
        ['--', '--model', 'flag-model', '--workspace', 'repo', 'inspect', 'package.json'],
        { AGENT_HARNESS_MODEL: 'environment-model' },
        '/workspace',
      ),
    ).toEqual({
      help: false,
      config: {
        modelId: 'flag-model',
        workspaceRoot: '/workspace/repo',
        prompt: 'inspect package.json',
      },
    });
  });

  it('uses the model environment fallback and rejects incomplete invocations', () => {
    expect(
      parsePhaseOneCliArguments(['answer'], { AGENT_HARNESS_MODEL: 'env-model' }, '/workspace'),
    ).toEqual({
      help: false,
      config: { modelId: 'env-model', workspaceRoot: '/workspace', prompt: 'answer' },
    });
    expect(() => parsePhaseOneCliArguments(['answer'], {}, '/workspace')).toThrow(CliUsageError);
    expect(() => parsePhaseOneCliArguments(['--model', 'model-only'], {}, '/workspace')).toThrow(
      'Provide a non-empty user prompt.',
    );
  });

  it('runs the complete read-only harness with a FakeSampler and no external credentials', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'agent-harness-cli-'));
    temporaryDirectories.push(workspaceRoot);
    await writeFile(join(workspaceRoot, 'fixture.txt'), 'phase-one fixture\n', 'utf8');

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
});
