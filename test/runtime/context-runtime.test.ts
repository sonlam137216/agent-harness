import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContextBuilder } from '../../src/context/context-builder.js';
import { createModelCallId, createSessionId, createTurnId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import {
  SamplingError,
  type ModelRequest,
  type ModelResponse,
  type SamplingOptions,
} from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { AgentLoop } from '../../src/runtime/agent-loop.js';
import { SessionRuntime } from '../../src/runtime/session-runtime.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import type { SessionStore } from '../../src/session/session-store.js';
import { FileSessionStore } from '../../src/session/file-session-store.js';
import { LocalRecordStorage } from '../../src/workspace/local-record-storage.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../../src/session/session.js';
import { ToolBridge } from '../../src/tools/tool-bridge.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';

const agent = {
  name: 'context-test',
  systemPrompt: 'Keep project constraints.',
  model: { modelId: 'fake-model' },
};
const isSummary = (request: ModelRequest): boolean =>
  request.messages[0]?.content?.startsWith('Summarize historical conversation') === true;
function answer(request: ModelRequest, text: string): ModelResponse {
  return {
    modelCallId: request.modelCallId,
    text,
    toolCalls: [],
    stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 30 },
  };
}
function history(): Session {
  return {
    id: createSessionId(),
    turns: Array.from({ length: 4 }, () => ({
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
  };
}

describe('Context through SessionRuntime', () => {
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let store: InMemorySessionStore;
  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    store = new InMemorySessionStore();
  });
  afterEach(async () => {
    await tracing.shutdown();
  });
  function runtime(sampler: Sampler, targetStore: SessionStore = store): SessionRuntime {
    return new SessionRuntime({
      sessionStore: targetStore,
      tracer: tracing.tracer,
      agentLoop: new AgentLoop({
        sampler,
        tracer: tracing.tracer,
        toolBridge: new ToolBridge(new ToolRegistry(), tracing.tracer),
        contextBuilder: new ContextBuilder(tracing.tracer, {
          sampler,
          budget: { windowTokens: 2600, outputReserveTokens: 400 },
          summaryMaxTokens: 200,
        }),
      }),
    });
  }

  it('persists compaction usage and reuses the checkpoint after reopening the file store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'durable-context-'));
    try {
      const reopen = () => new FileSessionStore(new LocalRecordStorage(directory), tracing.tracer);
      const initial = history();
      await reopen().save(initial);
      let summaries = 0;
      const sampler: Sampler = {
        sample: (request) => {
          if (isSummary(request)) {
            summaries += 1;
            return Promise.resolve(answer(request, 'Preserve SQLite.'));
          }
          expect(JSON.stringify(request.messages)).toContain('Preserve SQLite.');
          return Promise.resolve(answer(request, 'Continued.'));
        },
      };
      const firstRuntime = runtime(sampler, reopen());
      const first = await firstRuntime.run({
        agent,
        sessionId: initial.id,
        tools: [],
        prompt: 'Continue.',
      });
      firstRuntime.dispose();
      const checkpoint = first.session.contextCheckpoint;
      expect(checkpoint).toBeDefined();
      expect(first.session.usage?.filter((record) => record.purpose === 'compaction')).toHaveLength(
        summaries,
      );
      expect(
        first.session.usage?.find((record) => record.modelCallId === checkpoint?.modelCallId)
          ?.tokens,
      ).toEqual({ inputTokens: 100, outputTokens: 30 });
      const secondRuntime = runtime(sampler, reopen());
      const second = await secondRuntime.run({
        agent,
        sessionId: initial.id,
        tools: [],
        prompt: 'Next.',
      });
      secondRuntime.dispose();
      expect(second.session.contextCheckpoint).toEqual(checkpoint);
      expect(second.session.usage?.filter((record) => record.purpose === 'response')).toHaveLength(
        2,
      );
      expect(await reopen().get(initial.id)).toEqual(second.session);
      expect(second.session.turns.slice(0, initial.turns.length)).toEqual(initial.turns);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('continues a long multi-turn session using saved checkpoints while retaining every original entry', async () => {
    let summaries = 0;
    let answers = 0;
    const requests: ModelRequest[] = [];
    const sampler: Sampler = {
      sample: (request) => {
        requests.push(request);
        if (isSummary(request)) {
          summaries += 1;
          return Promise.resolve(answer(request, 'User requires SQLite. Continue implementation.'));
        }
        answers += 1;
        expect(request.messages.at(-1)?.content).toContain(`Turn ${answers}`);
        if (summaries > 0)
          expect(JSON.stringify(request.messages)).toContain('User requires SQLite');
        return Promise.resolve(answer(request, 'SQLite remains the chosen store. '.repeat(25)));
      },
    };
    const runner = runtime(sampler);
    let previous: Session | undefined;
    for (let index = 1; index <= 6; index += 1) {
      const result = await runner.run({
        agent,
        tools: [],
        prompt: `Turn ${index}: Continue using SQLite.`,
        ...(previous === undefined ? {} : { sessionId: previous.id }),
      });
      expect(result.outcome).toBe('completed');
      expect(result.iterations).toBe(1);
      expect(result.session.turns).toHaveLength(index);
      if (previous !== undefined) expect(result.session.turns.slice(0, -1)).toEqual(previous.turns);
      expect(await store.get(result.session.id)).toBe(result.session);
      previous = result.session;
    }
    expect(answers).toBe(6);
    expect(summaries).toBeGreaterThan(0);
    expect(previous?.contextCheckpoint).toBeDefined();
    expect(requests.filter(isSummary).every((request) => request.tools.length === 0)).toBe(true);
    await tracing.forceFlush();
    const contextSpans = exporter
      .getFinishedSpans()
      .filter((span) => span.name === 'context.build');
    expect(contextSpans).toHaveLength(6);
    for (const span of contextSpans)
      expect(span.attributes['context.total_tokens']).toBeLessThanOrEqual(2200);
  });

  it('persists a successful checkpoint and the full transcript when the next normal model call fails', async () => {
    const initial = history();
    await store.save(initial);
    const failure = new SamplingError('Provider unavailable.', {
      code: 'unavailable',
      retryable: true,
    });
    const sampler: Sampler = {
      sample: (request) =>
        isSummary(request)
          ? Promise.resolve(answer(request, 'Keep SQLite.'))
          : Promise.reject(failure),
    };
    await expect(
      runtime(sampler).run({ agent, tools: [], sessionId: initial.id, prompt: 'Continue.' }),
    ).rejects.toBe(failure);
    const saved = (await store.get(initial.id))!;
    expect(saved.contextCheckpoint).toBeDefined();
    expect(saved.turns.slice(0, -1)).toEqual(initial.turns);
    expect(saved.turns.at(-1)?.status).toBe('failed');
    expect(initial.contextCheckpoint).toBeUndefined();
  });

  it('cancels during compaction, records cancellation and preserves the previous checkpoint', async () => {
    const initial = history();
    const previous = {
      version: 1 as const,
      coveredTurnIds: [initial.turns[0]!.id],
      summary: 'Keep SQLite.',
      modelCallId: createModelCallId(),
    };
    await store.save({ ...initial, contextCheckpoint: previous });
    const controller = new AbortController();
    let calls = 0;
    const sampler: Sampler = {
      sample: (request, options?: SamplingOptions) => {
        calls += 1;
        expect(isSummary(request)).toBe(true);
        expect(options?.deadlineMs).toBeDefined();
        controller.abort();
        expect(options?.signal?.aborted).toBe(true);
        return Promise.resolve(answer(request, 'New summary.'));
      },
    };
    const result = await runtime(sampler).run({
      agent,
      tools: [],
      sessionId: initial.id,
      prompt: 'Continue.',
      signal: controller.signal,
      deadlineMs: Date.now() + 60000,
    });
    expect(result.outcome).toBe('cancelled');
    expect(calls).toBe(1);
    expect(result.session.contextCheckpoint).toBe(previous);
    expect(result.session.turns.slice(0, -1)).toEqual(initial.turns);
    expect((await store.get(initial.id))?.turns.at(-1)?.status).toBe('cancelled');
  });
});
