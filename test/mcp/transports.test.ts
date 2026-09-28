import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { LocalDuplexProcess } from '../../src/workspace/duplex-process.js';
import { SdkMcpConnection } from '../../src/mcp/mcp-client.js';
import { runPhaseOneCli, parsePhaseOneCliArguments } from '../../src/cli/phase-one-cli.js';
import { createToolCallId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';

// The fixture intentionally uses plain JSON-RPC to verify wire compatibility independently of the client SDK.
const fixture = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
 const message = JSON.parse(line);
 if (message.id === undefined) return;
 let result;
 if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fixture', version: '1' } };
 else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo fixture text', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { destructiveHint: false } }] };
 else if (message.method === 'tools/call') {
   if (message.params.arguments.value === 'hang') return;
   result = { content: [{ type: 'text', text: message.params.arguments.value }] };
 } else result = {};
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
});`;
let root: string;
let tracing: TracingHandle;
let processes: LocalDuplexProcess;
const connections: SdkMcpConnection[] = [];
const servers: Server[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-fixture-'));
  tracing = createTracing({ exporter: new InMemorySpanExporter() });
  processes = new LocalDuplexProcess(root, tracing.tracer);
  await writeFile(join(root, 'server.cjs'), fixture);
});
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  await tracing.shutdown();
  await rm(root, { recursive: true, force: true });
});
function stdio(timeout = 2000) {
  const connection = new SdkMcpConnection(
    {
      alias: 'fixture',
      transport: 'stdio',
      process: { command: process.execPath, args: ['server.cjs'], cwd: '.', environment: {} },
    },
    processes,
    timeout,
  );
  connections.push(connection);
  return connection;
}
async function httpFixture(
  handler: (message: Record<string, unknown>) => unknown,
  mode: 'json' | 'sse' | 'auth' = 'json',
) {
  const server = createServer((req, res) => {
    void (async () => {
      if (mode === 'auth') {
        res.writeHead(401).end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const message = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-11-25',
              capabilities: { tools: {} },
              serverInfo: { name: 'http-fixture', version: '1' },
            }
          : handler(message);
      if (result === 'disconnect') {
        req.socket.destroy();
        return;
      }
      const payload = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      if (mode === 'sse')
        res
          .writeHead(200, { 'Content-Type': 'text/event-stream' })
          .end(`event: message\ndata: ${payload}\n\n`);
      else res.writeHead(200, { 'Content-Type': 'application/json' }).end(payload);
    })().catch(() => {
      res.writeHead(500).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port.');
  const connection = new SdkMcpConnection(
    { alias: 'http', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, headers: {} },
    processes,
    2000,
  );
  connections.push(connection);
  return connection;
}
const tool = {
  name: 'echo',
  description: 'Echo text',
  inputSchema: { type: 'object' },
  annotations: { destructiveHint: false },
};

describe('real MCP transports', () => {
  it('discovers and invokes through Workspace-owned stdio, closes, and reconnects', async () => {
    const connection = stdio();
    expect(await connection.discover()).toMatchObject([{ name: 'echo' }]);
    expect(await connection.call('echo', { value: 'hello' })).toMatchObject({
      content: [{ text: 'hello' }],
    });
    await connection.close();
    expect(await connection.discover()).toHaveLength(1);
  });
  it('bounds timeout and cancellation of an in-flight stdio call', async () => {
    const connection = stdio(500);
    await connection.discover();
    await expect(connection.call('echo', { value: 'hang' })).rejects.toMatchObject({
      code: 'timeout',
    });
    await connection.discover();
    const controller = new AbortController();
    const pending = connection.call('echo', { value: 'hang' }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('runs prompt → search → external call → final answer with only five permanent schemas', async () => {
    await writeFile(
      join(root, 'mcp.json'),
      JSON.stringify({
        servers: [
          { alias: 'fixture', transport: 'stdio', command: process.execPath, args: ['server.cjs'] },
        ],
      }),
    );
    let count = 0;
    const sampler: Sampler = {
      sample: async (request) => {
        await Promise.resolve();
        count += 1;
        expect(request.tools.map((t) => t.name)).toEqual([
          'read_file',
          'list_files',
          'search_text',
          'search_tools',
          'invoke_tool',
        ]);
        const base = {
          modelCallId: request.modelCallId,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
        if (count === 1)
          return {
            ...base,
            text: null,
            toolCalls: [
              { id: createToolCallId(), name: 'search_tools', arguments: { query: 'echo' } },
            ],
            stopReason: 'tool_calls',
          };
        if (count === 2) {
          expect(request.messages.at(-1)?.content).toContain('mcp:fixture:echo');
          return {
            ...base,
            text: null,
            toolCalls: [
              {
                id: createToolCallId(),
                name: 'invoke_tool',
                arguments: {
                  name: 'mcp:fixture:echo',
                  version: (
                    JSON.parse(request.messages.at(-1)?.content ?? '{}') as {
                      output: { tools: { version: string }[] };
                    }
                  ).output.tools[0]!.version,
                  arguments: { value: 'wire-result' },
                },
              },
            ],
            stopReason: 'tool_calls',
          };
        }
        expect(request.messages.at(-1)?.content).toContain('wire-result');
        return { ...base, text: 'Finished', toolCalls: [], stopReason: 'end_turn' };
      },
    };
    const result = await runPhaseOneCli({
      modelId: 'fake',
      prompt: 'echo a message',
      workspaceRoot: root,
      userSkillsDirectory: join(root, 'missing'),
      mcpConfig: 'mcp.json',
      sampler,
      tracer: tracing.tracer,
      permissionRules: [{ toolName: 'mcp:fixture:echo', decision: 'allow' }],
      writeOutput: () => undefined,
    });
    expect(result.outcome).toBe('completed');
    expect(count).toBe(3);
    expect(
      parsePhaseOneCliArguments(['--model', 'fake', '--mcp-config', 'mcp.json', 'test'], {}, root),
    ).toMatchObject({ config: { mcpConfig: 'mcp.json' } });
  });
  it('supports HTTP pagination and rejects repeated cursors', async () => {
    let looping = false;
    const connection = await httpFixture((message) => {
      if (message.method === 'tools/list') {
        const params = message.params as { cursor?: string };
        return params.cursor
          ? { tools: [{ ...tool, name: 'second' }], ...(looping ? { nextCursor: 'page2' } : {}) }
          : { tools: [tool], nextCursor: 'page2' };
      }
      return { content: [{ type: 'text', text: 'http result' }] };
    });
    expect(await connection.discover()).toHaveLength(2);
    expect(await connection.call('echo', {})).toMatchObject({ content: [{ text: 'http result' }] });
    looping = true;
    await expect(connection.discover()).rejects.toThrow();
  });
  it('does not replay a disconnected HTTP invocation and rediscovers on next search', async () => {
    let calls = 0;
    const connection = await httpFixture((message) => {
      if (message.method === 'tools/list') return { tools: [tool] };
      calls += 1;
      return 'disconnect';
    });
    await connection.discover();
    await expect(connection.call('echo', {})).rejects.toMatchObject({ code: 'transport' });
    expect(calls).toBe(1);
    await connection.discover();
    expect(calls).toBe(1);
  });
  it('accepts Streamable HTTP SSE responses and surfaces authentication failures', async () => {
    const connection = await httpFixture(
      (message) =>
        message.method === 'tools/list'
          ? { tools: [tool] }
          : { content: [{ type: 'text', text: 'sse-result' }] },
      'sse',
    );
    await connection.discover();
    expect(await connection.call('echo', {})).toMatchObject({ content: [{ text: 'sse-result' }] });
    const auth = await httpFixture(() => ({}), 'auth');
    await expect(auth.discover()).rejects.toMatchObject({ code: 'authentication' });
  });
  it('bounds streamed HTTP response bytes before result normalization', async () => {
    let calls = 0;
    const connection = await httpFixture((message) => {
      if (message.method === 'tools/list') return { tools: [tool] };
      calls += 1;
      return { content: [{ type: 'text', text: 'x'.repeat(1_100_000) }] };
    });
    await connection.discover();
    await expect(connection.call('echo', {})).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it('enforces cwd containment including symlinks and rejects oversized stdio frames', async () => {
    await symlink(tmpdir(), join(root, 'outside'));
    const spec = { command: process.execPath, args: ['server.cjs'], environment: {} };
    const observer = { line: () => undefined, error: () => undefined, closed: () => undefined };
    for (const cwd of ['..', 'outside'])
      await expect(processes.open({ ...spec, cwd }, observer)).rejects.toThrow();
    const bounded = new LocalDuplexProcess(root, tracing.tracer, 20);
    let fail: () => void = () => undefined;
    const failed = new Promise<void>((resolve) => {
      fail = resolve;
    });
    const child = await bounded.open(
      { ...spec, args: ['-e', 'process.stdout.write("x".repeat(100))'], cwd: '.' },
      { ...observer, error: fail },
    );
    await failed;
    await child.close();
  });
});
