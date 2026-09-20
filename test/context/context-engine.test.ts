import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ContextBuilder,
  type ContextBuildInput,
  type ContextBuilderOptions,
} from '../../src/context/context-builder.js';
import {
  contributionTokens,
  REQUEST_FRAMING_TOKENS,
  utf8TokenEstimate,
} from '../../src/context/context-budget.js';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import type { ModelRequest, ModelResponse } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import type { Session } from '../../src/session/session.js';
import type { Turn } from '../../src/session/turn.js';

function oldTurn(content = 'Evidence and constraints. '.repeat(25)): Turn {
  return {
    id: createTurnId(),
    status: 'completed',
    entries: [
      { kind: 'user_message', content },
      {
        kind: 'assistant_message',
        modelCallId: createModelCallId(),
        content: 'Decision: use SQLite.',
        toolCalls: [],
      },
    ],
  };
}

function buildInput(history: readonly Turn[] = []): ContextBuildInput {
  const turnId = createTurnId();
  return {
    agent: {
      name: 'test',
      systemPrompt: 'Respect the user constraints.',
      model: { modelId: 'test' },
    },
    session: {
      id: createSessionId(),
      turns: [
        ...history,
        {
          id: turnId,
          status: 'in_progress',
          entries: [{ kind: 'user_message', content: 'Continue the plan.' }],
        },
      ],
    },
    turnId,
    modelCallId: createModelCallId(),
    tools: [],
  };
}

function summary(request: ModelRequest, overrides: Partial<ModelResponse> = {}): ModelResponse {
  return {
    modelCallId: request.modelCallId,
    text: 'Decision: use SQLite. Continue the plan.',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 50, outputTokens: 10 },
    ...overrides,
  };
}

function toolTurn(output: string, status: Turn['status'] = 'completed'): Turn {
  const a = createToolCallId();
  const b = createToolCallId();
  return {
    id: createTurnId(),
    status,
    entries: [
      { kind: 'user_message', content: 'Read both files.' },
      {
        kind: 'assistant_message',
        modelCallId: createModelCallId(),
        content: null,
        toolCalls: [
          { id: a, name: 'read_file', arguments: { path: 'one.txt' } },
          { id: b, name: 'read_file', arguments: { path: 'two.txt' } },
        ],
      },
      { kind: 'tool_result', toolCallId: b, outcome: 'error', output },
      { kind: 'tool_result', toolCallId: a, outcome: 'success', output },
    ],
  };
}

describe('Phase 2 context engine', () => {
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
  });
  afterEach(async () => {
    await tracing.shutdown();
  });
  const options: ContextBuilderOptions = {
    budget: { windowTokens: 2400, outputReserveTokens: 300 },
    summaryMaxTokens: 200,
  };

  it('accounts for UTF-8, schemas and framing, and enforces the exact input boundary', async () => {
    const input = {
      ...buildInput(),
      tools: [{ name: 'read', description: 'Đọc 日本語', inputSchema: { type: 'object' } }],
    };
    const first = await new ContextBuilder(tracing.tracer).build(input);
    const expected =
      REQUEST_FRAMING_TOKENS +
      contributionTokens(utf8TokenEstimate, first.request.messages, first.request.tools);
    expect(first.accounting.totalTokens).toBe(expected);
    expect(
      Object.values(first.accounting.sources).reduce(
        (a, b) => a + b,
        first.accounting.framingTokens,
      ),
    ).toBe(expected);
    expect(first.accounting.sources.tools).toBeGreaterThan(0);
    const exact = new ContextBuilder(tracing.tracer, {
      budget: { windowTokens: expected + 100, outputReserveTokens: 100 },
    });
    expect((await exact.build(input)).request.maxOutputTokens).toBe(100);
    const tooSmall = new ContextBuilder(tracing.tracer, {
      budget: { windowTokens: expected + 99, outputReserveTokens: 100 },
    });
    await expect(tooSmall.build(input)).rejects.toMatchObject({ code: 'budget_exceeded' });
    const hugeSchema = { ...input, tools: [{ ...input.tools[0]!, description: 'x'.repeat(4000) }] };
    await expect(exact.build(hugeSchema)).rejects.toMatchObject({ code: 'budget_exceeded' });
  });

  it('keeps mandatory rules and active input and refuses overflow before summarizing', async () => {
    const sample = vi.fn((request: ModelRequest) => Promise.resolve(summary(request)));
    const builder = new ContextBuilder(tracing.tracer, {
      ...options,
      sampler: { sample },
      additionalSources: [
        {
          name: 'rules',
          load: () => ({
            messages: [{ role: 'system', content: 'secret-rule '.repeat(300) }],
            tools: [],
          }),
        },
      ],
    });
    await expect(builder.build(buildInput([oldTurn(), oldTurn()]))).rejects.toMatchObject({
      code: 'budget_exceeded',
    });
    expect(sample).not.toHaveBeenCalled();
    await tracing.forceFlush();
    expect(
      JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes)),
    ).not.toContain('secret-rule');
  });

  it('prunes only historical outputs, retaining every call, result ID, outcome and the raw transcript', async () => {
    const old = toolTurn('secret-output '.repeat(400));
    const current = toolTurn('current evidence', 'in_progress');
    const base = buildInput();
    const input = {
      ...base,
      turnId: current.id,
      session: { ...base.session, turns: [old, current] },
    };
    const original = structuredClone(input.session);
    const result = await new ContextBuilder(tracing.tracer, {
      budget: { windowTokens: 4000, outputReserveTokens: 300 },
      toolResultMaxChars: 40,
    }).build(input);
    expect(result.accounting.prunedResults).toBe(2);
    expect(result.accounting.totalTokens).toBeLessThan(result.accounting.baselineTokens);
    expect(result.session).toBe(input.session);
    expect(result.session).toEqual(original);
    const toolMessages = result.request.messages.filter((message) => message.role === 'tool');
    expect(toolMessages).toHaveLength(4);
    expect(toolMessages[0]?.content).toContain('"outcome":"error"');
    expect(toolMessages[0]?.content).toContain('"pruned":true');
    expect(toolMessages[1]?.toolCallId).toBe(
      old.entries[1]?.kind === 'assistant_message' ? old.entries[1].toolCalls[0]?.id : 'missing',
    );
    expect(toolMessages[2]?.content).not.toContain('pruned');
    expect(toolMessages[2]?.content).toContain('current evidence');
  });

  it('compacts a closed prefix, preserves recent turns and reuses its checkpoint without resampling', async () => {
    const sample = vi.fn((request: ModelRequest) => Promise.resolve(summary(request)));
    const builder = new ContextBuilder(tracing.tracer, { ...options, sampler: { sample } });
    const input = buildInput([oldTurn(), oldTurn(), oldTurn(), oldTurn()]);
    const result = await builder.build(input);
    expect(sample.mock.calls.length).toBeGreaterThan(0);
    expect(result.accounting.totalTokens).toBeLessThanOrEqual(2100);
    expect(result.session.turns).toBe(input.session.turns);
    expect(input.session.contextCheckpoint).toBeUndefined();
    const checkpoint = result.session.contextCheckpoint!;
    expect(checkpoint.coveredTurnIds).toEqual(
      input.session.turns.slice(0, checkpoint.coveredTurnIds.length).map((turn) => turn.id),
    );
    expect(checkpoint.coveredTurnIds).not.toContain(input.session.turns.at(-2)?.id);
    expect(result.request.messages.at(-1)).toEqual({ role: 'user', content: 'Continue the plan.' });
    expect(
      result.request.messages.find((message) => message.content?.includes(checkpoint.summary))
        ?.role,
    ).toBe('user');
    for (const [request] of sample.mock.calls) {
      expect(request.tools).toEqual([]);
      expect(request.maxOutputTokens).toBe(200);
      expect(
        REQUEST_FRAMING_TOKENS + contributionTokens(utf8TokenEstimate, request.messages, []) + 200,
      ).toBeLessThanOrEqual(2400);
    }
    const calls = sample.mock.calls.length;
    const again = await builder.build({
      ...input,
      session: result.session,
      modelCallId: createModelCallId(),
    });
    expect(sample).toHaveBeenCalledTimes(calls);
    expect(again.accounting.compactedTurns).toBe(0);
    expect(again.session.contextCheckpoint).toBe(checkpoint);
    await tracing.forceFlush();
    const spans = exporter.getFinishedSpans();
    const compaction = spans.find((span) => span.name === 'compaction')!;
    const model = spans.find((span) => span.attributes['model.purpose'] === 'compaction')!;
    expect(model.parentSpanContext?.spanId).toBe(compaction.spanContext().spanId);
    expect(model.attributes['model_call.id']).toBeDefined();
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
      'Decision: use SQLite',
    );
  });

  it('packs short terminal turns together so summary framing does not prevent progress', async () => {
    const sample = vi.fn((request: ModelRequest) => Promise.resolve(summary(request)));
    const input = buildInput(Array.from({ length: 25 }, () => oldTurn('Keep SQLite.')));
    const result = await new ContextBuilder(tracing.tracer, {
      ...options,
      sampler: { sample },
    }).build(input);
    expect(result.accounting.totalTokens).toBeLessThanOrEqual(2100);
    expect(result.session.contextCheckpoint?.coveredTurnIds.length).toBeGreaterThan(1);
    expect(result.session.turns).toEqual(input.session.turns);
    expect(sample.mock.calls.length).toBeLessThan(result.accounting.compactedTurns);
  });

  it.each([
    { text: '' },
    { text: null },
    { stopReason: 'max_output_tokens' as const },
    { modelCallId: createModelCallId() },
    { text: 'x'.repeat(201) },
    { toolCalls: [{ id: createToolCallId(), name: 'read', arguments: {} }] },
  ])('rejects invalid summaries atomically: %j', async (overrides) => {
    const sample = vi.fn((request: ModelRequest) => Promise.resolve(summary(request, overrides)));
    const input = buildInput([oldTurn(), oldTurn(), oldTurn(), oldTurn()]);
    const snapshot = structuredClone(input.session);
    await expect(
      new ContextBuilder(tracing.tracer, { ...options, sampler: { sample } }).build(input),
    ).rejects.toMatchObject({ code: 'compaction_failed' });
    expect(sample).toHaveBeenCalledTimes(1);
    expect(input.session).toEqual(snapshot);
  });

  it('keeps the previous checkpoint if a later summary fails and never retries it', async () => {
    const input = buildInput([oldTurn(), oldTurn(), oldTurn(), oldTurn(), oldTurn(), oldTurn()]);
    const checkpoint = {
      version: 1 as const,
      coveredTurnIds: [input.session.turns[0]!.id],
      summary: 'Previous decision.',
      modelCallId: createModelCallId(),
    };
    const session: Session = { ...input.session, contextCheckpoint: checkpoint };
    const sample = vi
      .fn((request: ModelRequest) => Promise.resolve(summary(request)))
      .mockImplementationOnce((request) => Promise.resolve(summary(request)))
      .mockRejectedValueOnce(new Error('private provider body'));
    await expect(
      new ContextBuilder(tracing.tracer, { ...options, sampler: { sample } }).build({
        ...input,
        session,
      }),
    ).rejects.toMatchObject({ code: 'compaction_failed', cause: { message: 'sampler_failed' } });
    expect(sample).toHaveBeenCalledTimes(2);
    expect(session.contextCheckpoint).toBe(checkpoint);
  });

  it('propagates cancellation and the absolute deadline to summary calls without committing a checkpoint', async () => {
    const controller = new AbortController();
    const deadlineMs = Date.now() + 60000;
    const sample = vi.fn((request: ModelRequest) => {
      controller.abort();
      return Promise.resolve(summary(request));
    });
    const input = {
      ...buildInput([oldTurn(), oldTurn(), oldTurn(), oldTurn()]),
      signal: controller.signal,
      deadlineMs,
    };
    await expect(
      new ContextBuilder(tracing.tracer, { ...options, sampler: { sample } }).build(input),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(sample).toHaveBeenCalledWith(expect.anything(), {
      signal: controller.signal,
      deadlineMs,
    });
    expect(input.session.contextCheckpoint).toBeUndefined();
    await expect(
      new ContextBuilder(tracing.tracer).build({ ...buildInput(), deadlineMs: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: 'deadline_exceeded' });
  });

  it('rejects orphan tool results, incomplete batches and stale checkpoints before compaction', async () => {
    const complete = toolTurn('evidence');
    const incomplete = { ...complete, entries: complete.entries.slice(0, -1) };
    const orphan = { ...complete, entries: complete.entries.slice(2) };
    const sample = vi.fn((request: ModelRequest) => Promise.resolve(summary(request)));
    const builder = new ContextBuilder(tracing.tracer, { ...options, sampler: { sample } });
    for (const turn of [incomplete, orphan])
      await expect(builder.build(buildInput([turn]))).rejects.toMatchObject({
        code: 'invalid_state',
      });
    const input = buildInput([oldTurn()]);
    await expect(
      builder.build({
        ...input,
        session: {
          ...input.session,
          contextCheckpoint: {
            version: 1,
            coveredTurnIds: [createTurnId()],
            summary: 'Old summary.',
            modelCallId: createModelCallId(),
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_state' });
    expect(sample).not.toHaveBeenCalled();
  });

  it('fails explicitly when a historical turn cannot fit a summary request', async () => {
    const sample = vi.fn((request: ModelRequest) => Promise.resolve(summary(request)));
    await expect(
      new ContextBuilder(tracing.tracer, {
        ...options,
        sampler: { sample },
        keepRecentTurns: 0,
      }).build(buildInput([oldTurn('x'.repeat(5000))])),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(sample).not.toHaveBeenCalled();
  });

  it('contains source failures and validates budget and source configuration', async () => {
    const input = buildInput();
    await expect(
      new ContextBuilder(tracing.tracer, {
        additionalSources: [
          {
            name: 'custom',
            load: () => {
              throw new Error('secret source data');
            },
          },
        ],
      }).build(input),
    ).rejects.toMatchObject({ code: 'source_failed', cause: { message: 'source_load_failed' } });
    expect(
      () =>
        new ContextBuilder(tracing.tracer, {
          budget: { windowTokens: 10, outputReserveTokens: 10 },
        }),
    ).toThrow(RangeError);
    expect(
      () =>
        new ContextBuilder(tracing.tracer, {
          additionalSources: [{ name: 'system', load: () => ({ messages: [], tools: [] }) }],
        }),
    ).toThrow(RangeError);
    await expect(
      new ContextBuilder(tracing.tracer, {
        tokenCounter: { name: 'invalid', count: () => NaN },
      }).build(input),
    ).rejects.toThrow(RangeError);
  });
});
