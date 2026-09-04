import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDefinition } from '../../src/agent/agent-definition.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { createSessionId, createToolCallId, createTurnId, type TurnId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import {
  SamplingError,
  type ModelRequest,
  type ModelResponse,
  type SamplingOptions,
} from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { AgentLoop } from '../../src/runtime/agent-loop.js';
import type { Session } from '../../src/session/session.js';
import type { Turn } from '../../src/session/turn.js';
import { ReadFileTool } from '../../src/tools/builtin/read-file.tool.js';
import { ToolBridge } from '../../src/tools/tool-bridge.js';
import type { Tool } from '../../src/tools/tool.interface.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { FileSystemCapability } from '../../src/workspace/filesystem-capability.js';

/*
 * FakeSampler deliberately operates on only the shared contract. These tests
 * exercise orchestration without introducing any provider adapter behavior.
 */
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
  name: 'phase-one-agent',
  systemPrompt: 'Use tools only when needed.',
  model: { modelId: 'fake-model' },
};

function response(
  request: ModelRequest,
  values: Pick<ModelResponse, 'text' | 'toolCalls' | 'stopReason'>,
): ModelResponse {
  return {
    modelCallId: request.modelCallId,
    ...values,
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function createActiveSession(): { readonly session: Session; readonly turnId: TurnId } {
  const turnId = createTurnId();
  return {
    turnId,
    session: {
      id: createSessionId(),
      turns: [
        {
          id: turnId,
          status: 'in_progress',
          entries: [{ kind: 'user_message', content: 'Inspect the workspace.' }],
        },
      ],
    },
  };
}

function getTurn(session: Session, turnId: TurnId): Turn {
  const turn = session.turns.find((candidate) => candidate.id === turnId);
  if (turn === undefined) throw new Error('Expected the turn to exist.');
  return turn;
}

describe('AgentLoop', () => {
  let exporter: InMemorySpanExporter;
  let tracing: TracingHandle;
  let registry: ToolRegistry;
  let bridge: ToolBridge;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    registry = new ToolRegistry();
    bridge = new ToolBridge(registry, tracing.tracer);
  });

  afterEach(async () => {
    await tracing.shutdown();
  });

  function createLoop(sampler: Sampler, maxIterations?: number): AgentLoop {
    return new AgentLoop({
      sampler,
      contextBuilder: new ContextBuilder(tracing.tracer),
      toolBridge: bridge,
      tracer: tracing.tracer,
      ...(maxIterations === undefined ? {} : { maxIterations }),
    });
  }

  it('stops after an immediate final answer and traces safe loop/model data', async () => {
    const sampler = new FakeSampler([
      (request) =>
        response(request, { text: 'The answer is ready.', toolCalls: [], stopReason: 'end_turn' }),
    ]);
    const { session, turnId } = createActiveSession();
    const deadlineMs = Date.now() + 60_000;

    const result = await createLoop(sampler).run({
      agent,
      session,
      turnId,
      tools: [],
      deadlineMs,
    });
    await tracing.forceFlush();

    expect(result).toMatchObject({
      outcome: 'completed',
      iterations: 1,
      finalText: 'The answer is ready.',
    });
    expect(getTurn(result.session, turnId)).toMatchObject({
      status: 'completed',
      entries: [
        { kind: 'user_message', content: 'Inspect the workspace.' },
        {
          kind: 'assistant_message',
          content: 'The answer is ready.',
          toolCalls: [],
        },
      ],
    });
    expect(session.turns[0]?.entries).toHaveLength(1);
    expect(sampler.options[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(sampler.options[0]?.deadlineMs).toBe(deadlineMs);

    const spans = exporter.getFinishedSpans();
    const iterationSpan = spans.find((span) => span.name === 'agent.loop.iteration');
    const modelSpan = spans.find((span) => span.name === 'model.sample');
    expect(iterationSpan?.attributes).toEqual(
      expect.objectContaining({
        'session.id': session.id,
        'turn.id': turnId,
        'loop.iteration': 1,
        'loop.outcome': 'completed',
      }),
    );
    expect(modelSpan?.attributes).toEqual(
      expect.objectContaining({
        'session.id': session.id,
        'turn.id': turnId,
        'loop.iteration': 1,
        model: 'fake-model',
        success: true,
        input_tokens: 10,
        output_tokens: 5,
        stop_reason: 'end_turn',
      }),
    );
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
      'Inspect the workspace.',
    );
  });

  it('executes read_file, includes its normalized result in the next request, then stops', async () => {
    const readFile = vi.fn<FileSystemCapability['readFile']>((path) =>
      Promise.resolve({ path, content: 'hello from the workspace', sizeBytes: 24 }),
    );
    const fileSystem: FileSystemCapability = {
      readFile,
      listDirectory: vi.fn<FileSystemCapability['listDirectory']>(() => Promise.resolve([])),
    };
    registry.register(new ReadFileTool(fileSystem));
    const toolCallId = createToolCallId();
    const sampler = new FakeSampler([
      (request) =>
        response(request, {
          text: null,
          toolCalls: [{ id: toolCallId, name: 'read_file', arguments: { path: 'README.md' } }],
          stopReason: 'tool_calls',
        }),
      (request) => {
        expect(request.messages.at(-2)).toMatchObject({
          role: 'assistant',
          toolCalls: [{ id: toolCallId, name: 'read_file' }],
        });
        expect(request.messages.at(-1)).toEqual({
          role: 'tool',
          toolCallId,
          content:
            '{"outcome":"success","output":{"path":"README.md","content":"hello from the workspace","sizeBytes":24}}',
        });
        return response(request, {
          text: 'README.md says hello.',
          toolCalls: [],
          stopReason: 'end_turn',
        });
      },
    ]);
    const { session, turnId } = createActiveSession();

    const result = await createLoop(sampler).run({
      agent,
      session,
      turnId,
      tools: registry.getModelDefinitions(),
    });

    expect(result).toMatchObject({
      outcome: 'completed',
      iterations: 2,
      finalText: 'README.md says hello.',
    });
    expect(readFile).toHaveBeenCalledWith('README.md', {});
    expect(getTurn(result.session, turnId).entries.map((entry) => entry.kind)).toEqual([
      'user_message',
      'assistant_message',
      'tool_result',
      'assistant_message',
    ]);
    expect(getTurn(result.session, turnId).entries[2]).toEqual({
      kind: 'tool_result',
      toolCallId,
      outcome: 'success',
      output: {
        path: 'README.md',
        content: 'hello from the workspace',
        sizeBytes: 24,
      },
    });
  });

  it('feeds an unknown-tool failure back to the model without failing the loop', async () => {
    const toolCallId = createToolCallId();
    const sampler = new FakeSampler([
      (request) =>
        response(request, {
          text: null,
          toolCalls: [{ id: toolCallId, name: 'missing_tool', arguments: {} }],
          stopReason: 'tool_calls',
        }),
      (request) => {
        expect(request.messages.at(-1)).toEqual({
          role: 'tool',
          toolCallId,
          content:
            '{"outcome":"error","output":{"error":{"code":"unknown_tool","message":"No registered tool matches this call."}}}',
        });
        return response(request, {
          text: 'That tool is unavailable.',
          toolCalls: [],
          stopReason: 'end_turn',
        });
      },
    ]);
    const { session, turnId } = createActiveSession();

    const result = await createLoop(sampler).run({ agent, session, turnId, tools: [] });

    expect(result.outcome).toBe('completed');
    expect(getTurn(result.session, turnId).entries[2]).toMatchObject({
      kind: 'tool_result',
      toolCallId,
      outcome: 'error',
      output: { error: { code: 'unknown_tool' } },
    });
  });

  it('feeds a normalized tool execution failure back to the model', async () => {
    const failingTool: Tool = {
      definition: {
        name: 'failing_read',
        description: 'Always fails for this test.',
        inputSchema: { type: 'object', additionalProperties: false },
        accessKind: 'read',
      },
      validateInput: () => ({ valid: true }),
      execute: () => Promise.reject(new Error('private failure details')),
    };
    registry.register(failingTool);
    const toolCallId = createToolCallId();
    const sampler = new FakeSampler([
      (request) =>
        response(request, {
          text: null,
          toolCalls: [{ id: toolCallId, name: 'failing_read', arguments: {} }],
          stopReason: 'tool_calls',
        }),
      (request) => {
        expect(request.messages.at(-1)).toMatchObject({
          role: 'tool',
          toolCallId,
          content:
            '{"outcome":"error","output":{"error":{"code":"tool_execution_error","message":"The tool failed unexpectedly."}}}',
        });
        return response(request, {
          text: 'The tool failed safely.',
          toolCalls: [],
          stopReason: 'end_turn',
        });
      },
    ]);
    const { session, turnId } = createActiveSession();

    const result = await createLoop(sampler).run({
      agent,
      session,
      turnId,
      tools: registry.getModelDefinitions(),
    });

    expect(result.outcome).toBe('completed');
    expect(JSON.stringify(result.session)).not.toContain('private failure details');
  });

  it('stops at the configured maximum iteration count', async () => {
    const calls = [createToolCallId(), createToolCallId()];
    const sampler = new FakeSampler(
      calls.map(
        (toolCallId) => (request: ModelRequest) =>
          response(request, {
            text: null,
            toolCalls: [{ id: toolCallId, name: 'missing_tool', arguments: {} }],
            stopReason: 'tool_calls',
          }),
      ),
    );
    const { session, turnId } = createActiveSession();

    const result = await createLoop(sampler, 2).run({ agent, session, turnId, tools: [] });

    expect(result).toMatchObject({ outcome: 'max_iterations', iterations: 2, finalText: null });
    expect(sampler.requests).toHaveLength(2);
    expect(getTurn(result.session, turnId).status).toBe('failed');
    expect(getTurn(result.session, turnId).entries.map((entry) => entry.kind)).toEqual([
      'user_message',
      'assistant_message',
      'tool_result',
      'assistant_message',
      'tool_result',
    ]);
  });

  it('surfaces a provider-neutral sampling failure without retrying it', async () => {
    const samplingError = new SamplingError('The provider adapter is unavailable.', {
      code: 'unavailable',
      retryable: true,
    });
    const sampler = new FakeSampler([() => Promise.reject(samplingError)]);
    const { session, turnId } = createActiveSession();

    await expect(createLoop(sampler).run({ agent, session, turnId, tools: [] })).rejects.toBe(
      samplingError,
    );
    expect(sampler.requests).toHaveLength(1);
    expect(getTurn(session, turnId).status).toBe('in_progress');
  });

  it('honors an already-cancelled signal before sampling', async () => {
    const sample = vi.fn<Sampler['sample']>();
    const controller = new AbortController();
    controller.abort();
    const { session, turnId } = createActiveSession();

    const result = await createLoop({ sample }).run({
      agent,
      session,
      turnId,
      tools: [],
      signal: controller.signal,
    });

    expect(result).toMatchObject({ outcome: 'cancelled', iterations: 0, finalText: null });
    expect(getTurn(result.session, turnId).status).toBe('cancelled');
    expect(sample).not.toHaveBeenCalled();
  });

  it('honors an elapsed deadline before sampling', async () => {
    const sample = vi.fn<Sampler['sample']>();
    const { session, turnId } = createActiveSession();

    const result = await createLoop({ sample }).run({
      agent,
      session,
      turnId,
      tools: [],
      deadlineMs: Date.now() - 1,
    });

    expect(result).toMatchObject({ outcome: 'deadline_exceeded', iterations: 0 });
    expect(getTurn(result.session, turnId).status).toBe('cancelled');
    expect(sample).not.toHaveBeenCalled();
  });
});
