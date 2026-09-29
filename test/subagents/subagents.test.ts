import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CliRunError,
  parsePhaseOneCliArguments,
  runPhaseOneCli,
  type RunPhaseOneCliOptions,
} from '../../src/cli/phase-one-cli.js';
import { prepareSessionRun } from '../../src/cli/session-cli.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import {
  createSessionId,
  createSubagentId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import type { JsonObject } from '../../src/json.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import type { ModelRequest, ModelResponse } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { decodeSession, encodeSession } from '../../src/session/session-codec.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import type { Session } from '../../src/session/session.js';
import type { ToolResult } from '../../src/session/turn.js';
import { SubagentManager } from '../../src/subagents/subagent-manager.js';
import { SubagentRunner, type SubagentHandoff } from '../../src/subagents/subagent-runner.js';
import { DelegateTaskTool } from '../../src/subagents/subagent-tools.js';
import { ReadFileTool } from '../../src/tools/builtin/read-file.tool.js';
import { SaveMemoryTool } from '../../src/tools/builtin/save-memory.tool.js';
import type { MemoryWriter } from '../../src/memory/memory-writer.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';

const README = 'SECRET_README_BODY describes the harness.';

type Reply = Pick<ModelResponse, 'text' | 'toolCalls'> & { tokens?: number };

function call(name: string, args: JsonObject) {
  return { id: createToolCallId(), name, arguments: args };
}
function tools(...calls: ReturnType<typeof call>[]): Reply {
  return { text: null, toolCalls: calls };
}
function answer(text: string): Reply {
  return { text, toolCalls: [] };
}
function isChild(request: ModelRequest): boolean {
  return request.messages.some(
    (m) => m.role === 'system' && m.content.includes('read-only subagent working for'),
  );
}
function toolMessages(request: ModelRequest): string[] {
  return request.messages.flatMap((m) => (m.role === 'tool' ? [m.content] : []));
}
function respond(request: ModelRequest, reply: Reply): ModelResponse {
  return {
    modelCallId: request.modelCallId,
    text: reply.text,
    toolCalls: reply.toolCalls,
    stopReason: reply.toolCalls.length > 0 ? 'tool_calls' : 'end_turn',
    usage: { inputTokens: reply.tokens ?? 1, outputTokens: 0 },
  };
}
/** Hands out each role's replies by how many requests of that kind it has already seen. */
function scripted(
  parent: (request: ModelRequest, index: number) => Reply | Promise<Reply>,
  child: (request: ModelRequest, index: number, signal?: AbortSignal) => Reply | Promise<Reply>,
) {
  const requests = { parent: [] as ModelRequest[], child: [] as ModelRequest[] };
  const sampler: Sampler = {
    sample: async (request, options) => {
      if (isChild(request)) {
        requests.child.push(request);
        return respond(request, await child(request, requests.child.length - 1, options?.signal));
      }
      requests.parent.push(request);
      return respond(request, await parent(request, requests.parent.length - 1));
    },
  };
  return { sampler, requests };
}
function results(session: Session): ToolResult[] {
  return session.turns
    .at(-1)!
    .entries.filter((entry): entry is ToolResult => entry.kind === 'tool_result');
}
function blockUntilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal?.aborted === true) fail();
    else signal?.addEventListener('abort', fail);
  });
}

describe('subagents', () => {
  let root: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let store: InMemorySessionStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'subagents-'));
    await writeFile(join(root, 'README.md'), README);
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    store = new InMemorySessionStore();
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const run = (
    sampler: Sampler,
    extra: Partial<RunPhaseOneCliOptions> = {},
    withSubagents = true,
  ) =>
    runPhaseOneCli({
      modelId: 'fake',
      prompt: 'PARENT_PROMPT: what does the readme say?',
      workspaceRoot: root,
      userSkillsDirectory: join(root, 'no-user-skills'),
      sessionStore: store,
      ...(withSubagents ? { subagents: {} } : {}),
      sampler,
      tracer: tracing.tracer,
      writeOutput: () => undefined,
      ...extra,
    });

  const childSessions = async (): Promise<Session[]> =>
    (await Promise.all((await store.list()).map(async (summary) => store.get(summary.id)))).filter(
      (session): session is Session => session?.metadata?.parent !== undefined,
    );

  it('delegates in the foreground and returns a bounded report with sources', async () => {
    const { sampler, requests } = scripted(
      (_, index) =>
        index === 0
          ? tools(call('delegate_task', { role: 'explore', task: 'Summarize README.md.' }))
          : answer('Delegated.'),
      (_, index) =>
        index === 0
          ? tools(call('read_file', { path: 'README.md' }))
          : answer('README.md says it describes the harness.'),
    );
    const result = await run(sampler);

    expect(result.finalText).toBe('Delegated.');
    const [delegated] = results(result.session);
    expect(delegated).toMatchObject({
      outcome: 'success',
      output: {
        role: 'explore',
        outcome: 'completed',
        report: 'README.md says it describes the harness.',
        reportTruncated: false,
        sources: ['README.md'],
        iterations: 2,
        toolCalls: 1,
      },
    });

    // The child is an isolated, persisted session linked back to the delegating call.
    const [child] = await childSessions();
    expect(child!.id).toBe((delegated!.output as JsonObject).sessionId);
    expect(child!.metadata).toMatchObject({
      agent: { name: 'subagent-explore' },
      workspaceRoot: root,
      parent: {
        sessionId: result.session.id,
        turnId: result.turnId,
        toolCallId: delegated!.toolCallId,
        role: 'explore',
      },
    });
    expect(child!.turns[0]!.status).toBe('completed');

    // Capability restriction and depth 1: only native read tools, no delegation or memory.
    expect(requests.child[0]!.tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'list_files',
      'search_text',
    ]);
    expect(requests.parent[0]!.tools.map((tool) => tool.name)).toContain('delegate_task');
    // Context isolation: the child never sees the parent conversation, the parent never
    // sees the file body the child read.
    expect(JSON.stringify(requests.child)).not.toContain('PARENT_PROMPT');
    expect(JSON.stringify(requests.child[1])).toContain('SECRET_README_BODY');
    expect(JSON.stringify(requests.parent)).not.toContain('SECRET_README_BODY');
  });

  it('links child traces under the delegating tool call without recording the task', async () => {
    const { sampler } = scripted(
      (_, index) =>
        index === 0
          ? tools(call('delegate_task', { role: 'plan', task: 'TASK_TEXT plan it.' }))
          : answer('Done.'),
      () => answer('1. Do the thing.'),
    );
    await run(sampler);
    await tracing.forceFlush();
    const spans = exporter.getFinishedSpans();
    const spawn = spans.find((span) => span.name === 'subagent.spawn')!;
    const delegateCall = spans.find(
      (span) => span.name === 'tool.execute' && span.attributes['tool.name'] === 'delegate_task',
    )!;
    const childSession = spans.find(
      (span) =>
        span.name === 'session.run' &&
        span.parentSpanContext?.spanId === spawn.spanContext().spanId,
    );
    expect(spawn.parentSpanContext?.spanId).toBe(delegateCall.spanContext().spanId);
    expect(childSession).toBeDefined();
    expect(spawn.spanContext().traceId).toBe(delegateCall.spanContext().traceId);
    expect(spawn.attributes).toMatchObject({
      'subagent.role': 'plan',
      'subagent.outcome': 'completed',
      'subagent.background': false,
      'tool_call.id': delegateCall.attributes['tool_call.id'],
      success: true,
    });
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('TASK_TEXT');
  });

  it('is opt-in and parses its flags', () => {
    const parsed = parsePhaseOneCliArguments(
      ['--model', 'm', '--subagents', '--subagent-tokens', '500', 'hi'],
      {},
      root,
    );
    expect(parsed).toMatchObject({ config: { subagents: { maxTokens: 500 } } });
    expect(() =>
      parsePhaseOneCliArguments(['--model', 'm', '--subagent-tokens', '5', 'hi'], {}, root),
    ).toThrow('--subagent-tokens and --worktrees require --subagents.');
  });

  it('is not offered without --subagents', async () => {
    const { sampler, requests } = scripted(
      () => answer('Plain.'),
      () => answer('unused'),
    );
    await run(sampler, {}, false);
    expect(requests.parent[0]!.tools.map((tool) => tool.name)).not.toContain('delegate_task');
  });

  it('applies parent deny rules to children', async () => {
    const { sampler, requests } = scripted(
      (_, index) =>
        index === 0
          ? tools(call('delegate_task', { role: 'review', task: 'Review README.md.' }))
          : answer('Reviewed.'),
      (_, index) =>
        index === 0 ? tools(call('read_file', { path: 'README.md' })) : answer('No findings.'),
    );
    const result = await run(sampler, {
      permissionRules: [{ toolName: 'read_file', decision: 'deny' }],
    });
    expect(toolMessages(requests.child[1]!)[0]).toContain('access_denied');
    expect(results(result.session)[0]!.output).toMatchObject({ sources: [] });
  });

  it('runs background children concurrently and collects them', async () => {
    let started = 0;
    let release: () => void = () => undefined;
    const bothStarted = new Promise<void>((resolve) => (release = resolve));
    const { sampler } = scripted(
      (request, index) => {
        if (index === 0)
          return tools(
            call('delegate_task', { role: 'explore', task: 'A', background: true }),
            call('delegate_task', { role: 'explore', task: 'B', background: true }),
          );
        if (index === 1) {
          const ids = toolMessages(request).map(
            (content) =>
              (JSON.parse(content) as { output: { subagentId: string } }).output.subagentId,
          );
          return tools(...ids.map((subagentId) => call('await_subagent', { subagentId })));
        }
        return answer('Collected.');
      },
      async (request) => {
        started += 1;
        if (started === 2) release();
        // Each child waits until the other one has started: they must overlap.
        await bothStarted;
        const task = request.messages.find((m) => m.role === 'user')!.content;
        return answer(`report ${task}`);
      },
    );
    const result = await run(sampler);
    const [first, second, awaitedA, awaitedB] = results(result.session);
    expect(first!.output).toMatchObject({ status: 'running' });
    expect(second!.output).toMatchObject({ status: 'running' });
    expect(awaitedA).toMatchObject({ outcome: 'success', output: { report: 'report A' } });
    expect(awaitedB).toMatchObject({ outcome: 'success', output: { report: 'report B' } });
    expect(await childSessions()).toHaveLength(2);
  });

  it('cancels background children explicitly and when the run ends', async () => {
    const { sampler } = scripted(
      (request, index) => {
        if (index === 0)
          return tools(call('delegate_task', { role: 'explore', task: 'slow', background: true }));
        const { subagentId } = (
          JSON.parse(toolMessages(request)[0]!) as { output: { subagentId: string } }
        ).output;
        return index === 1 ? tools(call('cancel_subagent', { subagentId })) : answer('Stopped.');
      },
      (_, __, signal) => blockUntilAborted(signal),
    );
    const cancelled = await run(sampler);
    expect(results(cancelled.session)[1]!.output).toMatchObject({ outcome: 'cancelled' });

    // An unawaited background child is cancelled by cleanup before the CLI returns.
    store = new InMemorySessionStore();
    const abandoned = scripted(
      (_, index) =>
        index === 0
          ? tools(call('delegate_task', { role: 'explore', task: 'slow', background: true }))
          : answer('Left it running.'),
      (_, __, signal) => blockUntilAborted(signal),
    );
    await run(abandoned.sampler);
    const [child] = await childSessions();
    expect(child!.turns[0]!.status).toBe('cancelled');
  });

  it('cancels a foreground child when the parent run is cancelled', async () => {
    const controller = new AbortController();
    const { sampler } = scripted(
      () => tools(call('delegate_task', { role: 'explore', task: 'x' })),
      (_, __, signal) => {
        controller.abort();
        return blockUntilAborted(signal);
      },
    );
    await expect(run(sampler, { signal: controller.signal })).rejects.toBeInstanceOf(CliRunError);
    const [child] = await childSessions();
    expect(child!.turns[0]!.status).toBe('cancelled');
  });

  it('stops a child at its token budget', async () => {
    const { sampler, requests } = scripted(
      (_, index) =>
        index === 0
          ? tools(call('delegate_task', { role: 'explore', task: 'x' }))
          : answer('Budget hit.'),
      () => ({ ...tools(call('list_files', {})), tokens: 50 }),
    );
    const result = await run(sampler, { subagents: { maxTokens: 40 } });
    expect(requests.child).toHaveLength(1);
    expect(results(result.session)[0]!.output).toMatchObject({
      error: { code: 'subagent_token_budget_exceeded' },
    });
  });

  it('enforces per-run and concurrency limits', async () => {
    const handoff = (id: string): SubagentHandoff => ({
      subagentId: id as SubagentHandoff['subagentId'],
      role: 'explore',
      outcome: 'completed',
      report: 'ok',
      reportTruncated: false,
      sources: [],
      iterations: 1,
      toolCalls: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    let finish: () => void = () => undefined;
    const runner = {
      run: ({ subagentId, background }: { subagentId: string; background: boolean }) =>
        background
          ? new Promise<SubagentHandoff>((resolve) => (finish = () => resolve(handoff(subagentId))))
          : Promise.resolve(handoff(subagentId)),
    } as unknown as SubagentRunner;
    const parent = {
      sessionId: createSessionId(),
      turnId: createTurnId(),
      toolCallId: createToolCallId(),
    };
    const request = { role: 'explore' as const, task: 't', parent };

    const busy = new SubagentManager({ runner, maxConcurrent: 1 });
    const id = busy.start(request);
    await expect(busy.run(request)).rejects.toMatchObject({ code: 'subagent_busy' });
    await expect(busy.wait(id, createSessionId())).rejects.toMatchObject({
      code: 'unknown_subagent',
    });
    finish();
    expect(await busy.wait(id, parent.sessionId)).toMatchObject({ outcome: 'completed' });
    await busy.close();
    expect(() => busy.start(request)).toThrow('no longer available');

    const limited = new SubagentManager({ runner, maxPerRun: 1 });
    await limited.run(request);
    await expect(limited.run(request)).rejects.toMatchObject({ code: 'subagent_limit' });
  });

  it('refuses to give children write, external or delegation tools', () => {
    const files = new LocalFileSystemCapability({ workspaceRoot: root, tracer: tracing.tracer });
    const base = {
      sampler: { sample: () => Promise.reject(new Error('unused')) },
      contextBuilder: new ContextBuilder(tracing.tracer),
      sessionStore: store,
      tracer: tracing.tracer,
      modelId: 'fake',
    };
    expect(() => new SubagentRunner({ ...base, tools: [new ReadFileTool(files)] })).not.toThrow();
    expect(
      () =>
        new SubagentRunner({
          ...base,
          tools: [new SaveMemoryTool({} as MemoryWriter)],
        }),
    ).toThrow('native read-only');
    const manager = new SubagentManager({
      runner: new SubagentRunner({ ...base, tools: [] }),
    });
    expect(() => new SubagentRunner({ ...base, tools: [new DelegateTaskTool(manager)] })).toThrow(
      'Delegation tools',
    );
  });

  it('persists the parent link and refuses to resume a child session', async () => {
    const parentId = createSessionId();
    const child: Session = {
      id: createSessionId(),
      turns: [],
      metadata: {
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        agent: { name: 'subagent-explore', systemPrompt: 's', model: { modelId: 'fake' } },
        parent: {
          sessionId: parentId,
          turnId: createTurnId(),
          toolCallId: createToolCallId(),
          subagentId: createSubagentId(),
          role: 'explore',
        },
      },
    };
    expect(decodeSession(encodeSession(child), child.id)).toEqual(child);
    const selfLinked = {
      ...child,
      metadata: {
        ...child.metadata!,
        parent: { ...child.metadata!.parent!, sessionId: child.id },
      },
    };
    expect(() => encodeSession(selfLinked)).toThrow();

    await store.save(child);
    await expect(
      prepareSessionRun(
        { kind: 'run', directory: root, arguments: ['again'], resumeId: child.id },
        {},
        root,
        store,
      ),
    ).rejects.toThrow('Subagent sessions cannot be resumed');
  });
});
