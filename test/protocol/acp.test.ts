import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runAcpServer } from '../../src/cli/acp-cli.js';
import { runPhaseOneCli } from '../../src/cli/phase-one-cli.js';
import { createToolCallId, type SessionId } from '../../src/ids.js';
import type { JsonObject } from '../../src/json.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import type { ModelRequest, ModelResponse } from '../../src/model/sampling-types.js';
import { StderrSpanExporter } from '../../src/observability/stderr-span-exporter.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';

type Message = Record<string, unknown> & { id?: number; method?: string; params?: JsonObject };

/** A minimal ACP client: sends requests, records every line, answers agent requests. */
class TestClient {
  readonly toAgent = new PassThrough();
  readonly fromAgent = new PassThrough();
  readonly lines: string[] = [];
  readonly notifications: Message[] = [];
  readonly agentRequests: Message[] = [];
  #nextId = 1;
  #waiting = new Map<number, (message: Message) => void>();
  #buffer = '';

  constructor(private readonly answer: (request: Message) => unknown = () => null) {
    this.fromAgent.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString('utf8');
      let newline = this.#buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.lines.push(line);
        this.#receive(JSON.parse(line) as Message);
        newline = this.#buffer.indexOf('\n');
      }
    });
  }

  #receive(message: Message): void {
    if (message.method !== undefined && message.id !== undefined) {
      this.agentRequests.push(message);
      this.write({ jsonrpc: '2.0', id: message.id, result: this.answer(message) });
    } else if (message.method !== undefined) this.notifications.push(message);
    else if (typeof message.id === 'number') this.#waiting.get(message.id)?.(message);
  }

  write(message: unknown): void {
    this.toAgent.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  }

  request(method: string, params: unknown): Promise<Message> {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#waiting.set(id, resolve);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  updates(sessionId: string): JsonObject[] {
    return this.notifications
      .filter((n) => n.method === 'session/update' && n.params?.sessionId === sessionId)
      .map((n) => n.params!.update as JsonObject);
  }
}

function call(name: string, args: JsonObject) {
  return { id: createToolCallId(), name, arguments: args };
}
function reply(request: ModelRequest, text: string | null, calls: ReturnType<typeof call>[] = []) {
  return {
    modelCallId: request.modelCallId,
    text,
    toolCalls: calls,
    stopReason: calls.length > 0 ? ('tool_calls' as const) : ('end_turn' as const),
    usage: { inputTokens: 1, outputTokens: 1 },
  } satisfies ModelResponse;
}
const lastUser = (request: ModelRequest) =>
  request.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
const hasToolResult = (request: ModelRequest) => request.messages.at(-1)?.role === 'tool';

describe('ACP server', () => {
  let root: string;
  let tracing: TracingHandle;
  let store: InMemorySessionStore;
  let diagnostics: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'acp-'));
    await writeFile(join(root, 'README.md'), 'ACP readme contents');
    tracing = createTracing({ exporter: new InMemorySpanExporter() });
    store = new InMemorySessionStore();
    diagnostics = [];
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  /** Scripted model: reads README when asked about it, records a memory when asked to. */
  const sampler: Sampler = {
    sample: (request) => {
      const prompt = lastUser(request);
      if (hasToolResult(request)) return Promise.resolve(reply(request, 'Finished.'));
      if (prompt.includes('readme'))
        return Promise.resolve(
          reply(request, 'Let me look.', [call('read_file', { path: 'README.md' })]),
        );
      if (prompt.includes('remember'))
        return Promise.resolve(
          reply(request, null, [call('save_memory', { title: 'Decision', content: 'Use ACP.' })]),
        );
      if (prompt.includes('hang')) return new Promise<never>(() => undefined);
      return Promise.resolve(reply(request, `Echo: ${prompt}`));
    },
  };

  function start(client: TestClient, args: string[] = []) {
    return runAcpServer({
      arguments: ['--model', 'fake', '--provider', 'ollama', ...args],
      environment: {},
      cwd: root,
      sessionStore: store,
      createSampler: () => ({
        sample: (request, options) => {
          // Honour cancellation like real adapters do.
          return new Promise<ModelResponse>((resolve, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
            sampler.sample(request, options).then(resolve, reject);
          });
        },
      }),
      tracer: tracing.tracer,
      input: client.toAgent,
      output: client.fromAgent,
      diagnostics: (message) => diagnostics.push(message),
    });
  }

  async function initialized(client: TestClient): Promise<void> {
    const response = await client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    expect(response.result).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
      authMethods: [],
    });
  }

  async function newSession(client: TestClient): Promise<SessionId> {
    const response = await client.request('session/new', { cwd: root, mcpServers: [] });
    return (response.result as { sessionId: SessionId }).sessionId;
  }

  it('rejects malformed traffic with JSON-RPC errors', async () => {
    const client = new TestClient();
    const server = start(client);
    expect((await client.request('session/new', { cwd: root })).error).toMatchObject({
      code: -32600,
    });
    client.write('{not json');
    await initialized(client);
    expect((await client.request('session/set_mode', {})).error).toMatchObject({ code: -32601 });
    expect((await client.request('session/new', { cwd: 'relative' })).error).toMatchObject({
      code: -32602,
    });
    expect(
      (await client.request('session/prompt', { sessionId: 'nope', prompt: [] })).error,
    ).toMatchObject({ code: -32602 });
    const parseError = client.lines
      .map((line) => JSON.parse(line) as Message)
      .find((message) => (message.error as { code?: number } | undefined)?.code === -32700);
    expect(parseError).toMatchObject({ id: null });
    client.toAgent.end();
    await server;
  });

  it('streams message and tool updates before the prompt response', async () => {
    const client = new TestClient();
    const server = start(client);
    await initialized(client);
    const sessionId = await newSession(client);
    expect((await store.get(sessionId))?.metadata?.workspaceRoot).toBe(root);

    const response = await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'What does the readme say?' }],
    });
    expect(response.result).toEqual({ stopReason: 'end_turn' });

    const updates = client.updates(sessionId);
    const toolCallId = (updates.find((u) => u.sessionUpdate === 'tool_call') as JsonObject)
      .toolCallId as string;
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me look.' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'read_file README.md',
        kind: 'read',
        status: 'pending',
        rawInput: { path: 'README.md' },
        locations: [{ path: join(root, 'README.md') }],
      },
      { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress' },
      expect.objectContaining({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
      }),
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Finished.' } },
    ]);
    expect(JSON.stringify(updates[3])).toContain('ACP readme contents');
    // Every update precedes the response on the wire, and every line is JSON-RPC.
    const responseLine = client.lines.findIndex((line) => line.includes(`"id":${3}`));
    expect(
      client.lines.slice(responseLine + 1).some((line) => line.includes('session/update')),
    ).toBe(false);
    expect(client.lines.every((line) => (JSON.parse(line) as Message).jsonrpc === '2.0')).toBe(
      true,
    );

    client.toAgent.end();
    await server;
  });

  it('round-trips permission requests for gated tools', async () => {
    const memory = join(root, 'user-memory');
    const run = async (optionId: 'allow' | 'reject') => {
      const client = new TestClient((request) =>
        request.method === 'session/request_permission'
          ? { outcome: { outcome: 'selected', optionId } }
          : null,
      );
      const server = start(client, ['--memory', '--user-memory-directory', memory]);
      await initialized(client);
      const sessionId = await newSession(client);
      const response = await client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Please remember this decision.' }],
      });
      client.toAgent.end();
      await server;
      return { client, sessionId, response };
    };

    const rejected = await run('reject');
    expect(rejected.response.result).toEqual({ stopReason: 'end_turn' });
    expect(rejected.client.agentRequests[0]).toMatchObject({
      method: 'session/request_permission',
      params: {
        sessionId: rejected.sessionId,
        toolCall: { title: 'save_memory Decision', kind: 'edit', status: 'pending' },
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'reject', kind: 'reject_once' },
        ],
      },
    });
    expect(rejected.client.updates(rejected.sessionId)).toContainEqual(
      expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'failed' }),
    );
    await expect(readFile(join(root, '.agents/memory/notes.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const allowed = await run('allow');
    expect(allowed.client.updates(allowed.sessionId)).toContainEqual(
      expect.objectContaining({ sessionUpdate: 'tool_call_update', status: 'completed' }),
    );
    expect(await readFile(join(root, '.agents/memory/notes.md'), 'utf8')).toContain('Use ACP.');
  });

  it('cancels a running prompt and refuses concurrent prompts on one session', async () => {
    const client = new TestClient();
    const server = start(client);
    await initialized(client);
    const sessionId = await newSession(client);
    const running = client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Please hang forever.' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      (await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'x' }] }))
        .error,
    ).toMatchObject({ code: -32600 });
    client.notify('session/cancel', { sessionId });
    expect((await running).result).toEqual({ stopReason: 'cancelled' });
    expect((await store.get(sessionId))!.turns.at(-1)!.status).toBe('cancelled');
    client.toAgent.end();
    await server;
  });

  it('cancels running prompts and saves their state when the client disconnects', async () => {
    const client = new TestClient();
    const server = start(client);
    await initialized(client);
    const sessionId = await newSession(client);
    void client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Please hang forever.' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.toAgent.end();
    await server;
    expect((await store.get(sessionId))!.turns.at(-1)!.status).toBe('cancelled');
  });

  it('shares sessions with the CLI and replays them on session/load', async () => {
    const first = new TestClient();
    let server = start(first);
    await initialized(first);
    const sessionId = await newSession(first);
    await first.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'What does the readme say?' }],
    });
    first.toAgent.end();
    await server;

    // The one-shot CLI continues the same session through the same runtime.
    const saved = await store.get(sessionId);
    await runPhaseOneCli({
      modelId: 'fake',
      prompt: 'hello from the terminal',
      workspaceRoot: root,
      userSkillsDirectory: join(root, 'no-skills'),
      sessionStore: store,
      sessionId,
      savedAgent: saved!.metadata!.agent,
      sampler,
      tracer: tracing.tracer,
      writeOutput: () => undefined,
    });

    const second = new TestClient();
    server = start(second);
    await initialized(second);
    const loaded = await second.request('session/load', {
      sessionId,
      cwd: root,
      mcpServers: [{ name: 'editor', command: 'x', args: [], env: [] }],
    });
    expect(loaded.result).toBeNull();
    const replay = second.updates(sessionId).map((u) => u.sessionUpdate);
    expect(replay).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'agent_message_chunk',
      'user_message_chunk',
      'agent_message_chunk',
    ]);
    expect(second.updates(sessionId).at(-1)).toMatchObject({
      content: { text: 'Echo: hello from the terminal' },
    });
    expect(diagnostics[0]).toContain('Ignoring 1 client-provided MCP server');
    expect(
      (await second.request('session/load', { sessionId, cwd: join(root, 'elsewhere') })).error,
    ).toMatchObject({ code: -32602 });
    second.toAgent.end();
    await server;
  });

  it('keeps spans off stdout', () => {
    const lines: string[] = [];
    const exporter = new StderrSpanExporter({ write: (text: string) => lines.push(text) });
    const local = createTracing({ exporter });
    local.tracer.startActiveSpan('protocol.prompt', (span) => {
      span.setAttribute('protocol.name', 'acp');
      span.end();
    });
    expect(JSON.parse(lines[0]!)).toMatchObject({
      span: 'protocol.prompt',
      attributes: { 'protocol.name': 'acp' },
    });
  });
});
