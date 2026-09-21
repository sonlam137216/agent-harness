import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextBuilder } from '../../src/context/context-builder.js';
import { EventBus } from '../../src/events/event-bus.js';
import type { RuntimeEvent } from '../../src/events/runtime-event.js';
import { HookRegistry, type HookName } from '../../src/hooks/hook-registry.js';
import { createToolCallId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import { createTracing } from '../../src/observability/tracing.js';
import { tracingSubscriber } from '../../src/observability/tracing-subscriber.js';
import {
  PermissionEngine,
  type PermissionEngineOptions,
} from '../../src/permissions/permission-engine.js';
import { AgentLoop } from '../../src/runtime/agent-loop.js';
import { SessionRuntime } from '../../src/runtime/session-runtime.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import { ToolBridge } from '../../src/tools/tool-bridge.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { Tool } from '../../src/tools/tool.interface.js';

const agent = { name: 'test', systemPrompt: 'Use tools.', model: { modelId: 'fake' } };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function fixture(permission: PermissionEngineOptions = {}, maxIterations = 8) {
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({ exporter });
  const hooks = new HookRegistry(tracing.tracer);
  const events = new EventBus();
  const seen: RuntimeEvent[] = [];
  events.subscribe((event) => {
    seen.push(event);
  });
  events.subscribe(tracingSubscriber);
  const store = new InMemorySessionStore();
  const registry = new ToolRegistry();
  const execute = vi.fn<Tool['execute']>((call) =>
    Promise.resolve({ toolCallId: call.id, outcome: 'success', output: 'private-result' }),
  );
  registry.register({
    definition: {
      name: 'edit',
      accessKind: 'write',
      description: 'Test mutation.',
      inputSchema: { type: 'object' },
    },
    validateInput: (input) =>
      typeof input.path === 'string' ? { valid: true } : { valid: false, message: 'path required' },
    execute,
  });
  const bridge = new ToolBridge(registry, tracing.tracer, {
    hooks,
    events,
    permissions: new PermissionEngine(permission),
  });
  const sample = vi.fn<Sampler['sample']>((request) =>
    Promise.resolve({
      modelCallId: request.modelCallId,
      usage: { inputTokens: 1, outputTokens: 1 },
      ...(request.messages.some((message) => message.role === 'tool')
        ? { text: 'Done', stopReason: 'end_turn' as const, toolCalls: [] }
        : {
            text: null,
            stopReason: 'tool_calls' as const,
            toolCalls: [
              { id: createToolCallId(), name: 'edit', arguments: { path: 'private-path' } },
            ],
          }),
    }),
  );
  const loop = new AgentLoop({
    sampler: { sample },
    contextBuilder: new ContextBuilder(tracing.tracer),
    toolBridge: bridge,
    tracer: tracing.tracer,
    hooks,
    events,
    maxIterations,
  });
  const runtime = new SessionRuntime({
    sessionStore: store,
    agentLoop: loop,
    tracer: tracing.tracer,
    hooks,
    events,
  });
  cleanups.push(async () => {
    runtime.dispose();
    await tracing.shutdown();
  });
  return {
    runtime,
    hooks,
    events,
    seen,
    store,
    sample,
    execute,
    exporter,
    run: (extra: { signal?: AbortSignal; deadlineMs?: number } = {}) =>
      runtime.run({
        agent,
        prompt: 'private-prompt',
        tools: registry.getModelDefinitions(),
        ...extra,
      }),
  };
}

describe('Phase 3 end-to-end lifecycle', () => {
  it('approves once, runs ordered hooks, persists, and traces events without duplicate spans or content', async () => {
    const approve = vi.fn(() => true);
    const f = fixture({ mode: 'ask', approve });
    const order: HookName[] = [];
    for (const name of [
      'SessionStart',
      'TurnStart',
      'BeforeModel',
      'AfterModel',
      'PreToolUse',
      'PostToolUse',
      'TurnEnd',
    ] as const) {
      f.hooks.register(name, () => {
        order.push(name);
      });
    }
    const result = await f.run();
    expect(result.outcome).toBe('completed');
    expect(order).toEqual([
      'SessionStart',
      'TurnStart',
      'BeforeModel',
      'AfterModel',
      'PreToolUse',
      'PostToolUse',
      'BeforeModel',
      'AfterModel',
      'TurnEnd',
    ]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(await f.store.get(result.session.id)).toEqual(result.session);
    expect(f.seen.map((event) => event.type)).toEqual([
      'SessionUpdated',
      'SessionStarted',
      'TurnStarted',
      'ModelStarted',
      'ModelCompleted',
      'SessionUpdated',
      'ToolStarted',
      'ToolCompleted',
      'SessionUpdated',
      'ModelStarted',
      'ModelCompleted',
      'SessionUpdated',
      'SessionUpdated',
      'TurnCompleted',
    ]);
    expect(
      f.seen.every(
        (event) => event.sessionId === result.session.id && event.turnId === result.turnId,
      ),
    ).toBe(true);
    const modelEvents = f.seen.filter(
      (event) => event.type === 'ModelStarted' || event.type === 'ModelCompleted',
    );
    expect(modelEvents[0]?.modelCallId).toBe(modelEvents[1]?.modelCallId);
    const spans = f.exporter.getFinishedSpans();
    expect(spans.filter((span) => span.name === 'model.sample')).toHaveLength(2);
    expect(spans.filter((span) => span.name === 'tool.execute')).toHaveLength(1);
    const tool = spans.find((span) => span.name === 'tool.execute');
    expect(tool?.attributes).toMatchObject({
      'permission.decision': 'ask',
      'permission.allowed': true,
    });
    expect(tool?.events.map((event) => event.name)).toEqual(['ToolStarted', 'ToolCompleted']);
    expect(
      JSON.stringify(spans.map((span) => ({ attributes: span.attributes, events: span.events }))),
    ).not.toContain('private-');
  });

  it('delivers a denied tool result to the next model without executing the action', async () => {
    const f = fixture({ mode: 'always-approve', rules: [{ decision: 'deny', toolName: 'edit' }] });
    const result = await f.run();
    expect(result.outcome).toBe('completed');
    expect(f.execute).not.toHaveBeenCalled();
    expect(result.session.turns[0]?.entries[2]).toMatchObject({
      kind: 'tool_result',
      outcome: 'error',
      output: { error: { code: 'access_denied' } },
    });
    expect(f.sample.mock.calls[1]?.[0].messages.at(-1)).toMatchObject({
      role: 'tool',
      content: expect.stringContaining('access_denied') as unknown,
    });
    expect(f.seen.filter((event) => event.type === 'ToolCompleted')).toMatchObject([
      { success: false },
    ]);
  });

  it('a pre-tool veto prevents both approval and dispatch', async () => {
    const approve = vi.fn(() => true);
    const f = fixture({ mode: 'ask', approve });
    f.hooks.register('PreToolUse', () => ({ deny: true }));
    const result = await f.run();
    expect(f.execute).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(result.session.turns[0]?.entries[2]).toMatchObject({
      output: { error: { code: 'hook_failed' } },
    });
  });

  it('does not lose or retry an executed mutation when the post-tool hook throws', async () => {
    const f = fixture({ rules: [{ decision: 'allow', accessKind: 'write' }] });
    f.hooks.register('PostToolUse', () => {
      throw new Error('secret failure');
    });
    const result = await f.run();
    expect(result.outcome).toBe('completed');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(result.session.turns[0]?.entries[2]).toMatchObject({
      outcome: 'success',
      output: 'private-result',
    });
    expect(
      f.exporter.getFinishedSpans().find((span) => span.name === 'tool.execute')?.attributes[
        'hook.post_tool_failed'
      ],
    ).toBe(true);
  });

  it('runs post-tool hooks for normalized thrown tool failures without retry', async () => {
    const f = fixture({ mode: 'always-approve' });
    const post = vi.fn();
    f.execute.mockRejectedValue(new Error('secret'));
    f.hooks.register('PostToolUse', post);
    const result = await f.run();
    expect(post).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(result.session.turns[0]?.entries[2]).toMatchObject({
      output: { error: { code: 'tool_execution_error' } },
    });
  });

  it('persists sampled transcript if AfterModel fails and skips tool dispatch', async () => {
    const f = fixture();
    f.hooks.register('AfterModel', () => {
      throw new Error('private failure');
    });
    await expect(f.run()).rejects.toMatchObject({ name: 'HookError' });
    const first = f.seen[0];
    if (first === undefined) throw new Error('Missing event');
    const saved = await f.store.get(first.sessionId);
    expect(saved?.turns[0]?.status).toBe('failed');
    expect(saved?.turns[0]?.entries.map((entry) => entry.kind)).toEqual([
      'user_message',
      'assistant_message',
    ]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.seen.at(-1)).toMatchObject({ type: 'TurnCompleted', outcome: 'failed' });
  });

  it.each(['SessionStart', 'TurnStart', 'BeforeModel'] as const)(
    'fails closed on %s errors',
    async (name) => {
      const f = fixture();
      f.hooks.register(name, () => {
        throw new Error('failure');
      });
      await expect(f.run()).rejects.toMatchObject({ name: 'HookError', hookName: name });
      expect(f.sample).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
      const saved = f.seen.filter((event) => event.type === 'SessionUpdated').at(-1);
      expect(saved?.session.turns[0]?.status).toBe('failed');
    },
  );

  it('keeps a completed turn when TurnEnd or an event observer fails', async () => {
    const f = fixture();
    f.events.subscribe(() => {
      throw new Error('observer');
    });
    f.hooks.register('TurnEnd', () => {
      throw new Error('end hook');
    });
    const result = await f.run();
    expect(result.outcome).toBe('completed');
    expect(await f.store.get(result.session.id)).toEqual(result.session);
  });

  it('cancels while awaiting approval without dispatch or another model call', async () => {
    const controller = new AbortController();
    const f = fixture({
      mode: 'ask',
      approve: () => {
        controller.abort();
        return new Promise(() => undefined);
      },
    });
    const result = await f.run({ signal: controller.signal });
    expect(result.outcome).toBe('cancelled');
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.sample).toHaveBeenCalledTimes(1);
    expect(result.session.turns[0]?.entries[2]).toMatchObject({
      output: { error: { code: 'cancelled' } },
    });
  });

  it('enforces the deadline while a start hook ignores cancellation', async () => {
    const f = fixture();
    f.hooks.register('SessionStart', () => new Promise(() => undefined));
    const result = await f.run({ deadlineMs: Date.now() + 30 });
    expect(result.outcome).toBe('deadline_exceeded');
    expect(f.sample).not.toHaveBeenCalled();
    expect((await f.store.get(result.session.id))?.turns[0]?.status).toBe('cancelled');
  });

  it('emits failed ModelCompleted for provider failures and surfaces required persistence failure', async () => {
    const f = fixture();
    f.sample.mockRejectedValue(new Error('provider'));
    await expect(f.run()).rejects.toThrow('provider');
    expect(f.seen.filter((event) => event.type === 'ModelCompleted')).toMatchObject([
      { success: false },
    ]);
    const other = fixture();
    vi.spyOn(other.store, 'save').mockRejectedValue(new Error('store'));
    await expect(other.run()).rejects.toMatchObject({ name: 'EventSubscriberError' });
    expect(other.sample).not.toHaveBeenCalled();
  });

  it('SessionStart runs once while TurnStart runs for resumed turns', async () => {
    const f = fixture();
    const start = vi.fn();
    const turn = vi.fn();
    f.hooks.register('SessionStart', start);
    f.hooks.register('TurnStart', turn);
    const first = await f.run();
    await f.runtime.run({ agent, prompt: 'continue', tools: [], sessionId: first.session.id });
    expect(start).toHaveBeenCalledTimes(1);
    expect(turn).toHaveBeenCalledTimes(2);
  });
});
