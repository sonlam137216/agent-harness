import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../../src/agent/agent-definition.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { createSessionId, createToolCallId, createTurnId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import {
  SamplingError,
  type ModelRequest,
  type ModelResponse,
  type SamplingOptions,
} from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { AgentLoop } from '../../src/runtime/agent-loop.js';
import { SessionNotFoundError, SessionRuntime } from '../../src/runtime/session-runtime.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import type { Session } from '../../src/session/session.js';
import { ReadFileTool } from '../../src/tools/builtin/read-file.tool.js';
import { ToolBridge } from '../../src/tools/tool-bridge.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { FileSystemCapability } from '../../src/workspace/filesystem-capability.js';

type FakeSample = (
  request: ModelRequest,
  options: SamplingOptions | undefined,
) => ModelResponse | Promise<ModelResponse>;

class FakeSampler implements Sampler {
  public readonly requests: ModelRequest[] = [];
  public readonly options: (SamplingOptions | undefined)[] = [];
  readonly #samples: readonly FakeSample[];

  public constructor(samples: readonly FakeSample[]) {
    this.#samples = samples;
  }

  public async sample(request: ModelRequest, options?: SamplingOptions): Promise<ModelResponse> {
    const sample = this.#samples[this.requests.length];
    this.requests.push(request);
    this.options.push(options);
    if (sample === undefined) throw new Error('FakeSampler has no response for this call.');
    return sample(request, options);
  }
}

const agent: AgentDefinition = {
  name: 'session-runtime-agent',
  systemPrompt: 'Answer with the available read-only tools.',
  model: { modelId: 'fake-model' },
};

function response(
  request: ModelRequest,
  values: Pick<ModelResponse, 'text' | 'toolCalls' | 'stopReason'>,
): ModelResponse {
  return {
    modelCallId: request.modelCallId,
    ...values,
    usage: { inputTokens: 12, outputTokens: 4 },
  };
}

function findSpan(spans: readonly ReadableSpan[], name: string): ReadableSpan {
  const span = spans.find((candidate) => candidate.name === name);
  if (span === undefined) throw new Error(`Expected a ${name} span.`);
  return span;
}

function expectChildSpan(child: ReadableSpan, parent: ReadableSpan): void {
  expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
  expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
}

describe('SessionRuntime', () => {
  let exporter: InMemorySpanExporter;
  let tracing: TracingHandle;
  let store: InMemorySessionStore;
  let registry: ToolRegistry;
  let bridge: ToolBridge;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    store = new InMemorySessionStore();
    registry = new ToolRegistry();
    bridge = new ToolBridge(registry, tracing.tracer);
  });

  afterEach(async () => {
    await tracing.shutdown();
  });

  function createRuntime(sampler: Sampler): SessionRuntime {
    const agentLoop = new AgentLoop({
      sampler,
      contextBuilder: new ContextBuilder(tracing.tracer),
      toolBridge: bridge,
      tracer: tracing.tracer,
    });
    return new SessionRuntime({ sessionStore: store, agentLoop, tracer: tracing.tracer });
  }

  it('creates and persists a session turn around an immediate final response', async () => {
    const sampler = new FakeSampler([
      (request) => response(request, { text: 'Done.', toolCalls: [], stopReason: 'end_turn' }),
    ]);
    const save = vi.spyOn(store, 'save');
    const controller = new AbortController();
    const deadlineMs = Date.now() + 60_000;

    const result = await createRuntime(sampler).run({
      agent,
      prompt: 'Finish this request.',
      tools: [],
      signal: controller.signal,
      deadlineMs,
    });
    await tracing.forceFlush();

    expect(result).toMatchObject({ outcome: 'completed', iterations: 1, finalText: 'Done.' });
    expect(result.session.turns).toEqual([
      {
        id: result.turnId,
        status: 'completed',
        entries: [
          { kind: 'user_message', content: 'Finish this request.' },
          expect.objectContaining({
            kind: 'assistant_message',
            content: 'Done.',
            toolCalls: [],
          }),
        ],
      },
    ]);
    await expect(store.get(result.session.id)).resolves.toBe(result.session);
    expect(save).toHaveBeenCalledTimes(2);
    expect(sampler.options[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(sampler.options[0]?.deadlineMs).toBe(deadlineMs);

    const spans = exporter.getFinishedSpans();
    const sessionSpan = findSpan(spans, 'session.run');
    const turnSpan = findSpan(spans, 'turn.run');
    const iterationSpan = findSpan(spans, 'agent.loop.iteration');
    const contextSpan = findSpan(spans, 'context.build');
    const modelSpan = findSpan(spans, 'model.sample');
    expect(sessionSpan.attributes).toEqual(
      expect.objectContaining({
        'session.id': result.session.id,
        'agent.name': 'session-runtime-agent',
        'model.default': 'fake-model',
        'session.created': true,
        'session.outcome': 'completed',
        success: true,
      }),
    );
    expect(turnSpan.attributes).toEqual(
      expect.objectContaining({
        'session.id': result.session.id,
        'turn.id': result.turnId,
        'turn.index': 0,
        'loop.iterations': 1,
        'turn.outcome': 'completed',
        success: true,
      }),
    );
    expectChildSpan(turnSpan, sessionSpan);
    expectChildSpan(iterationSpan, turnSpan);
    expectChildSpan(contextSpan, iterationSpan);
    expectChildSpan(modelSpan, iterationSpan);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
      'Finish this request.',
    );
  });

  it('loads an existing session and appends one new turn', async () => {
    const existing: Session = {
      id: createSessionId(),
      turns: [
        {
          id: createTurnId(),
          status: 'completed',
          entries: [{ kind: 'user_message', content: 'Earlier request.' }],
        },
      ],
    };
    await store.save(existing);
    const sampler = new FakeSampler([
      (request) => response(request, { text: 'Continued.', toolCalls: [], stopReason: 'end_turn' }),
    ]);

    const result = await createRuntime(sampler).run({
      agent,
      prompt: 'Continue.',
      tools: [],
      sessionId: existing.id,
    });

    expect(result.session.id).toBe(existing.id);
    expect(result.session.turns).toHaveLength(2);
    expect(result.session.turns[0]).toBe(existing.turns[0]);
    expect(result.session.turns[1]).toMatchObject({
      id: result.turnId,
      status: 'completed',
      entries: [
        { kind: 'user_message', content: 'Continue.' },
        { kind: 'assistant_message', content: 'Continued.', toolCalls: [] },
      ],
    });
    await expect(store.get(existing.id)).resolves.toBe(result.session);
  });

  it('persists the model-tool-model transcript produced by AgentLoop', async () => {
    const readFile = vi.fn<FileSystemCapability['readFile']>((path) =>
      Promise.resolve({ path, content: 'workspace data', sizeBytes: 14 }),
    );
    registry.register(
      new ReadFileTool({
        readFile,
        listDirectory: vi.fn<FileSystemCapability['listDirectory']>(() => Promise.resolve([])),
      }),
    );
    const toolCallId = createToolCallId();
    const sampler = new FakeSampler([
      (request) =>
        response(request, {
          text: null,
          toolCalls: [{ id: toolCallId, name: 'read_file', arguments: { path: 'notes.txt' } }],
          stopReason: 'tool_calls',
        }),
      (request) => {
        expect(request.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId });
        return response(request, {
          text: 'The file contains workspace data.',
          toolCalls: [],
          stopReason: 'end_turn',
        });
      },
    ]);

    const result = await createRuntime(sampler).run({
      agent,
      prompt: 'Read notes.txt.',
      tools: registry.getModelDefinitions(),
    });

    expect(result.outcome).toBe('completed');
    expect(result.session.turns[0]?.entries.map((entry) => entry.kind)).toEqual([
      'user_message',
      'assistant_message',
      'tool_result',
      'assistant_message',
    ]);
    expect(result.session.turns[0]?.entries[2]).toMatchObject({
      kind: 'tool_result',
      toolCallId,
      outcome: 'success',
    });
    expect(readFile).toHaveBeenCalledWith('notes.txt', {});
    await expect(store.get(result.session.id)).resolves.toBe(result.session);
  });

  it('persists a cancelled turn when cancellation is propagated to AgentLoop', async () => {
    const sample = vi.fn<Sampler['sample']>();
    const controller = new AbortController();
    controller.abort();

    const result = await createRuntime({ sample }).run({
      agent,
      prompt: 'Do not start.',
      tools: [],
      signal: controller.signal,
    });

    expect(result).toMatchObject({ outcome: 'cancelled', iterations: 0 });
    expect(result.session.turns[0]?.status).toBe('cancelled');
    expect(sample).not.toHaveBeenCalled();
    await expect(store.get(result.session.id)).resolves.toBe(result.session);
  });

  it('persists a failed turn and rethrows an AgentLoop sampling failure', async () => {
    const samplingError = new SamplingError('Sampling failed.', {
      code: 'unavailable',
      retryable: true,
    });
    const sampler = new FakeSampler([() => Promise.reject(samplingError)]);
    const runtime = createRuntime(sampler);

    await expect(runtime.run({ agent, prompt: 'Try once.', tools: [] })).rejects.toBe(
      samplingError,
    );

    const sessionSpan = findSpan(exporter.getFinishedSpans(), 'session.run');
    const sessionId = sessionSpan.attributes['session.id'];
    if (typeof sessionId !== 'string') throw new Error('Expected a session ID trace attribute.');
    const stored = await store.get(sessionId as Session['id']);
    expect(stored?.turns[0]?.status).toBe('failed');
    expect(sampler.requests).toHaveLength(1);
  });

  it('rejects a missing requested session without creating a turn', async () => {
    const sessionId = createSessionId();
    const sample = vi.fn<Sampler['sample']>();

    await expect(
      createRuntime({ sample }).run({ agent, prompt: 'Continue.', tools: [], sessionId }),
    ).rejects.toEqual(new SessionNotFoundError(sessionId));
    expect(sample).not.toHaveBeenCalled();
    await expect(store.get(sessionId)).resolves.toBeUndefined();
  });
});
