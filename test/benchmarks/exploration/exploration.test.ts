import { resolve } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createModelCallId,
  createSessionId,
  createTurnId,
  createToolCallId,
} from '../../../src/ids.js';
import { ContextBuilder } from '../../../src/context/context-builder.js';
import { createTracing } from '../../../src/observability/tracing.js';
import type { Session } from '../../../src/session/session.js';
import type { Sampler } from '../../../src/model/sampler.interface.js';
import type { ModelRequest } from '../../../src/model/sampling-types.js';
import {
  runBenchmarkTask,
  SamplingMeasurements,
  scriptedSampler,
  median,
  summarizeSpans,
} from './benchmark.js';
import { parseBenchmarkArguments } from './cli.js';
import { contentDigest, createFixture } from './fixture.js';
import { explorationTasks } from './tasks.js';

describe('exploration baseline', () => {
  let fixture: Awaited<ReturnType<typeof createFixture>>;
  beforeAll(async () => {
    fixture = await createFixture(resolve('.'));
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const run = (task = explorationTasks[0]!, sampler: Sampler = scriptedSampler(task)) =>
    runBenchmarkTask({
      ...fixture,
      task,
      sampler,
      modelId: 'scripted-exploration-v1',
      mode: 'scripted',
      repeat: 1,
      contextBudget: { windowTokens: 131_072, outputReserveTokens: 4_096 },
      timeoutMs: 10_000,
    });

  it.each(explorationTasks)(
    'runs $id through CLI, real workspace reads and accounting',
    async (task) => {
      const result = await run(task);
      expect(result.outcome).toBe('completed');
      expect(result.failure).toBeNull();
      expect(result.evidenceFileReads.fraction).toBe(1);
      expect(result.metrics).not.toBeNull();
      expect(result.metrics!.toolCalls).toMatchObject({
        search_text: 1,
        read_file: task.evidence.length,
      });
      expect(result.metrics!.iterations).toBe(task.evidence.length + 2);
      expect(result.metrics!.toolFailures).toBe(0);
      expect(result.metrics!.filesystemReadSuccesses).toBeGreaterThan(
        result.metrics!.toolCalls.read_file!,
      );
      expect(result.metrics!.filesystemBytesRead).toBeGreaterThan(0);
      expect(result.metrics!.estimatedSourceTokens.rules).toBeGreaterThan(0);
      expect(result.sampling.estimatedRequestTokens).toBe(
        result.metrics!.estimatedBuiltContextTokens,
      );
      expect(
        Object.values(result.metrics!.estimatedSourceTokens).reduce(
          (sum, value) => sum + value,
          result.metrics!.estimatedFramingTokens,
        ),
      ).toBe(result.metrics!.estimatedBuiltContextTokens);
      expect(result.sampling.providerUsage).toBeNull();
      expect(result.quality.status).toBe('not_evaluated_scripted');
      expect(result).not.toHaveProperty('answer');
      expect(result.correlation.sessionId).toBeTruthy();
      expect(result.correlation.traceId).toMatch(/^[a-f\d]{32}$/u);
    },
  );

  it('repeats the same workload with equal deterministic costs and fresh sessions', async () => {
    const task = explorationTasks[2]!;
    const first = await run(task);
    const second = await run(task);
    expect(first.sampling).toEqual(second.sampling);
    expect(first.metrics).toEqual(second.metrics);
    expect(first.correlation.sessionId).not.toBe(second.correlation.sessionId);
  });

  it('keeps failures and missing provider usage visible without leaking raw errors', async () => {
    const result = await run(explorationTasks[0], {
      sample: () => Promise.reject(new Error('secret-provider-body')),
    });
    expect(result.outcome).toBe('failed');
    expect(result.failure).toBe('run_failed');
    expect(result.sampling.attempts).toBe(1);
    expect(result.evidenceFileReads.fraction).toBe(0);
    expect(JSON.stringify(result)).not.toContain('secret-provider-body');
  });

  it('cancels timed-out sampling and records a failed run', async () => {
    const sampler: Sampler = {
      sample: (_request, options) =>
        new Promise((_resolve, reject) => {
          if (options?.signal?.aborted) reject(new Error('aborted'));
          else
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
        }),
    };
    const result = await runBenchmarkTask({
      ...fixture,
      task: explorationTasks[0]!,
      sampler,
      modelId: 'fake',
      mode: 'scripted',
      repeat: 1,
      contextBudget: { windowTokens: 131_072, outputReserveTokens: 4096 },
      timeoutMs: 100,
    });
    expect(result.outcome).toBe('cancelled');
    expect(result.failure).toBe('timeout');
  });

  it('counts every request, including tool-free summaries, and flags partial usage', async () => {
    let count = 0;
    const measured = new SamplingMeasurements({
      sample: (request) => {
        count += 1;
        if (count === 3) return Promise.reject(new Error('transport failure'));
        return Promise.resolve({
          modelCallId: request.modelCallId,
          text: 'answer or summary',
          toolCalls: [],
          stopReason: 'end_turn',
          usage: { inputTokens: count * 10, outputTokens: count },
        });
      },
    });
    const request: ModelRequest = {
      modelCallId: createModelCallId(),
      modelId: 'fake',
      messages: [{ role: 'user', content: 'Summarize.' }],
      tools: [],
    };
    await measured.sample(request);
    await measured.sample({ ...request, modelCallId: createModelCallId() });
    await expect(measured.sample(request)).rejects.toThrow();
    expect(measured.attempts).toBe(3);
    expect(measured.estimatedRequestTokens).toBeGreaterThan(0);
    expect(measured.usage('live')).toMatchObject({
      inputTokens: 30,
      outputTokens: 3,
      responseCount: 2,
      complete: false,
      cachedInputTokens: null,
    });
    expect(measured.usage('scripted')).toBeNull();
  });

  it('captures actual ContextBuilder compaction calls in the all-request total', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({ exporter });
    try {
      const measured = new SamplingMeasurements({
        sample: (request) =>
          Promise.resolve({
            modelCallId: request.modelCallId,
            text: 'Keep SQLite.',
            toolCalls: [],
            stopReason: 'end_turn',
            usage: { inputTokens: 100, outputTokens: 10 },
          }),
      });
      const turnId = createTurnId();
      const session: Session = {
        id: createSessionId(),
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
          {
            id: turnId,
            status: 'in_progress',
            entries: [{ kind: 'user_message', content: 'Continue.' }],
          },
        ],
      };
      const builder = new ContextBuilder(tracing.tracer, {
        sampler: measured,
        budget: { windowTokens: 2600, outputReserveTokens: 400 },
        summaryMaxTokens: 200,
      });
      const built = await builder.build({
        agent: {
          name: 'benchmark-test',
          systemPrompt: 'Keep constraints.',
          model: { modelId: 'fake' },
        },
        session,
        turnId,
        modelCallId: createModelCallId(),
        tools: [],
      });
      await measured.sample(built.request);
      await tracing.forceFlush();
      const summaryCalls = summarizeSpans(exporter.getFinishedSpans()).compactionModelCalls;
      expect(summaryCalls).toBeGreaterThan(0);
      expect(measured.attempts).toBe(summaryCalls + 1);
      expect(measured.usage('live')?.inputTokens).toBe((summaryCalls + 1) * 100);
      expect(measured.estimatedRequestTokens).toBeGreaterThan(built.accounting.totalTokens);
    } finally {
      await tracing.shutdown();
    }
  });

  it('retains tool failures and exposes answers only for requested review', async () => {
    let calls = 0;
    const sampler: Sampler = {
      sample: (request) => {
        expect(JSON.stringify(request.messages)).not.toContain(
          'Wrapper permission is insufficient.',
        );
        calls += 1;
        return Promise.resolve({
          modelCallId: request.modelCallId,
          text: calls === 1 ? null : 'No evidence found.',
          toolCalls:
            calls === 1
              ? [{ id: createToolCallId(), name: 'read_file', arguments: { path: 'missing.ts' } }]
              : [],
          stopReason: calls === 1 ? 'tool_calls' : 'end_turn',
          usage: { inputTokens: 10, outputTokens: 2 },
        });
      },
    };
    const result = await runBenchmarkTask({
      ...fixture,
      task: explorationTasks[0]!,
      sampler,
      modelId: 'fake',
      mode: 'live',
      repeat: 1,
      contextBudget: { windowTokens: 131_072, outputReserveTokens: 4096 },
      timeoutMs: 10000,
      includeAnswers: true,
    });
    expect(result.outcome).toBe('completed');
    expect(result.metrics?.toolFailures).toBe(1);
    expect(result.evidenceFileReads.fraction).toBe(0);
    expect(result.answer).toBe('No evidence found.');
    expect(result.quality.status).toBe('pending_human_review');
    expect(result.sampling.providerUsage).toMatchObject({ inputTokens: 20, complete: true });
  });

  it('invalidates fixture identity when source content changes', () => {
    expect(contentDigest([{ path: 'a.ts', content: 'before' }])).not.toBe(
      contentDigest([{ path: 'a.ts', content: 'after' }]),
    );
    expect(fixture.files.length).toBeGreaterThan(10);
    expect(fixture.digest).toMatch(/^[a-f\d]{64}$/u);
  });

  it('requires live opt-in and rejects ambiguous or unbounded configurations', () => {
    expect(parseBenchmarkArguments([], '.')).toMatchObject({ mode: 'scripted', repeats: 1 });
    expect(
      parseBenchmarkArguments(['--live', '--provider', 'ollama', '--model', 'test'], '.'),
    ).toMatchObject({ mode: 'live', provider: 'ollama', modelId: 'test' });
    for (const args of [
      ['--live'],
      ['--model', 'test'],
      ['--repeats', '0'],
      ['--repeats', '11'],
      ['--task', 'unknown'],
      ['--timeout-ms', 'Infinity'],
      ['--context-window', '100'],
      ['--task', 'deny-precedence', '--task', 'search-bounds'],
    ]) {
      expect(() => parseBenchmarkArguments(args, '.')).toThrow();
    }
    expect(median([])).toBeNull();
    expect(median([4, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
