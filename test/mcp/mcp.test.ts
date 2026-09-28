import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { McpManager } from '../../src/mcp/mcp-manager.js';
import { qualifiedName } from '../../src/mcp/tool-catalog.js';
import type { McpConnection, ExternalToolMetadata } from '../../src/mcp/mcp-client.js';
import { McpError, loadMcpConfig } from '../../src/mcp/config.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolBridge } from '../../src/tools/tool-bridge.js';
import {
  PermissionEngine,
  type PermissionEngineOptions,
} from '../../src/permissions/permission-engine.js';
import { HookRegistry } from '../../src/hooks/hook-registry.js';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import type { JsonObject } from '../../src/json.js';
import { ToolIndex } from '../../src/mcp/tool-index.js';

const schema: JsonObject = {
  type: 'object',
  properties: { value: { type: 'string' } },
  required: ['value'],
  additionalProperties: false,
};
const metadata: ExternalToolMetadata = {
  name: 'echo',
  description: 'Echo a message',
  inputSchema: schema,
  destructive: false,
};
const traces: TracingHandle[] = [];
afterEach(async () => {
  await Promise.all(traces.splice(0).map((t) => t.shutdown()));
});
function setup(
  policy: PermissionEngineOptions = {},
  tools: readonly ExternalToolMetadata[] = [metadata],
) {
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({ exporter });
  traces.push(tracing);
  const connection: McpConnection = {
    discover: vi.fn(() => Promise.resolve(tools)),
    call: vi.fn(() => Promise.resolve({ content: [{ type: 'text', text: 'SECRET_RESULT' }] })),
    close: vi.fn(() => Promise.resolve()),
  };
  const registry = new ToolRegistry();
  const hooks = new HookRegistry();
  const manager = new McpManager(new Map([['fixture', connection]]), registry, tracing.tracer);
  const bridge = new ToolBridge(registry, tracing.tracer, {
    permissions: new PermissionEngine(policy),
    hooks,
  });
  const context = {
    sessionId: createSessionId(),
    turnId: createTurnId(),
    modelCallId: createModelCallId(),
  };
  const execute = (name: string, args: JsonObject, signal?: AbortSignal) =>
    bridge.execute(
      { id: createToolCallId(), name, arguments: args },
      { ...context, ...(signal ? { signal } : {}) },
    );
  const search = () => execute('search_tools', { query: 'echo' });
  const currentVersion = () =>
    ((manager.catalog.search('echo').tools as readonly JsonObject[])[0]?.version ?? '') as string;
  const invoke = (version = currentVersion(), args: JsonObject = { value: 'SECRET_ARGUMENT' }) =>
    execute('invoke_tool', { name: qualifiedName('fixture', 'echo'), version, arguments: args });
  return {
    exporter,
    tracing,
    connection,
    registry,
    hooks,
    manager,
    bridge,
    execute,
    search,
    invoke,
    version: currentVersion,
  };
}
describe('MCP catalog and target dispatch', () => {
  it('keeps a stable two-tool surface at 100+ tools and searches by BM25', async () => {
    const fixture = setup(
      {},
      Array.from({ length: 125 }, (_, i) => ({
        ...metadata,
        name: `echo_${i}`,
        description: i === 42 ? 'Find astronomy telescope' : 'Echo text',
      })),
    );
    const before = fixture.registry.getModelDefinitions();
    await fixture.manager.refresh();
    expect(fixture.registry.getModelDefinitions()).toEqual(before);
    expect(before.map((t) => t.name)).toEqual(['search_tools', 'invoke_tool']);
    const result = await fixture.execute('search_tools', { query: 'astronomy', limit: 1 });
    expect(result.output).toMatchObject({
      tools: [{ name: 'mcp:fixture:echo_42', inputSchema: schema }],
    });
    expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThan(16_384);
    expect(
      new ToolIndex([
        { name: 'b', description: 'same' },
        { name: 'a', description: 'same' },
      ]).search('same'),
    ).toEqual(['a', 'b']);
  });
  it('defaults to denying external calls and rejects direct hidden calls', async () => {
    const f = setup();
    await f.search();
    expect(await f.invoke()).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'access_denied' } },
    });
    expect(await f.execute('mcp:fixture:echo', { value: 'x' })).toMatchObject({
      output: { error: { code: 'unknown_tool' } },
    });
    expect(f.connection.call).not.toHaveBeenCalled();
  });
  it('target deny overrides wrapper allow and always-approve', async () => {
    const f = setup({
      mode: 'always-approve',
      rules: [
        { toolName: 'invoke_tool', decision: 'allow' },
        { toolName: 'mcp:fixture:echo', decision: 'deny' },
      ],
    });
    await f.search();
    await f.invoke();
    expect(f.connection.call).not.toHaveBeenCalled();
  });
  it('wrapper deny blocks resolution even with target allow', async () => {
    const f = setup({
      mode: 'always-approve',
      rules: [{ toolName: 'invoke_tool', decision: 'deny' }],
    });
    await f.search();
    expect(await f.invoke()).toMatchObject({ output: { error: { code: 'access_denied' } } });
    expect(f.connection.call).not.toHaveBeenCalled();
  });
  it('validates target arguments before target hooks or approval', async () => {
    const approve = vi.fn(() => true);
    const f = setup({ mode: 'ask', approve });
    const pre = vi.fn();
    f.hooks.register('PreToolUse', pre);
    await f.search();
    pre.mockClear();
    expect(await f.invoke(f.version(), { value: 2 })).toMatchObject({
      output: { error: { code: 'invalid_input' } },
    });
    expect(approve).not.toHaveBeenCalled();
    expect(pre).toHaveBeenCalledTimes(1);
    expect(f.connection.call).not.toHaveBeenCalled();
  });
  it('requires approval for destructive tools even in always-approve', async () => {
    const f = setup({ mode: 'always-approve' }, [{ ...metadata, destructive: true }]);
    await f.search();
    await f.invoke();
    expect(f.connection.call).not.toHaveBeenCalled();
  });
  it('runs target hooks, preserves call identity, and emits safe nested traces', async () => {
    const approve = vi.fn(() => true);
    const f = setup({ mode: 'ask', approve });
    const seen: string[] = [];
    f.hooks.register('PreToolUse', (input) => {
      if (input.name === 'PreToolUse') seen.push(`pre:${input.call.name}`);
    });
    f.hooks.register('PostToolUse', (input) => {
      if (input.name === 'PostToolUse') seen.push(`post:${input.call.name}`);
    });
    await f.search();
    seen.length = 0;
    const id = createToolCallId();
    const result = await f.bridge.execute(
      {
        id,
        name: 'invoke_tool',
        arguments: {
          name: 'mcp:fixture:echo',
          version: f.version(),
          arguments: { value: 'SECRET_ARGUMENT' },
        },
      },
      { sessionId: createSessionId(), turnId: createTurnId(), modelCallId: createModelCallId() },
    );
    expect(result).toMatchObject({
      toolCallId: id,
      outcome: 'success',
      output: { target: 'mcp:fixture:echo', version: f.version() },
    });
    expect(seen).toEqual(['pre:invoke_tool', 'pre:mcp:fixture:echo', 'post:mcp:fixture:echo']);
    expect(approve.mock.calls).toHaveLength(1);
    await f.tracing.forceFlush();
    const spans = f.exporter.getFinishedSpans();
    expect(spans.filter((s) => s.name === 'tool.execute')).toHaveLength(2);
    expect(spans.some((s) => s.name === 'mcp.call')).toBe(true);
    const external = spans.find((s) => s.name === 'mcp.call');
    expect(external?.attributes['session.id']).toBeDefined();
    expect(external?.attributes['model_call.id']).toBeDefined();
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toMatch(
      /SECRET_ARGUMENT|SECRET_RESULT/u,
    );
  });
  it('rejects stale generation and refresh during target approval', async () => {
    let invalidated = false;
    const f = setup({
      mode: 'ask',
      approve: () => {
        if (!invalidated) {
          invalidated = true;
          f.connection.onInvalidated?.();
        }
        return true;
      },
    });
    await f.search();
    const oldVersion = f.version();
    expect(await f.invoke(oldVersion)).toMatchObject({
      output: { error: { code: 'stale_target' } },
    });
    expect(f.connection.call).not.toHaveBeenCalled();
    await f.search();
    expect(await f.invoke(oldVersion)).toMatchObject({
      output: { error: { code: 'stale_target' } },
    });
    expect((await f.invoke()).outcome).toBe('success');
  });
  it('rejects a persisted handle after a new manager starts', async () => {
    const original = setup({ mode: 'always-approve' });
    await original.search();
    const oldVersion = original.version();
    await original.manager.close();
    const resumed = setup({ mode: 'always-approve' });
    await resumed.search();
    expect(resumed.version()).not.toBe(oldVersion);
    expect(await resumed.invoke(oldVersion)).toMatchObject({
      output: { error: { code: 'stale_target' } },
    });
    expect(resumed.connection.call).not.toHaveBeenCalled();
    expect((await resumed.invoke()).outcome).toBe('success');
  });
  it('fails closed on target hook veto and cancellation', async () => {
    const f = setup({ mode: 'always-approve' });
    await f.search();
    f.hooks.register('PreToolUse', (input) => {
      if (input.name === 'PreToolUse' && input.call.name.startsWith('mcp:'))
        throw new Error('veto');
    });
    expect(await f.invoke()).toMatchObject({ output: { error: { code: 'hook_failed' } } });
    const controller = new AbortController();
    controller.abort();
    await f.execute(
      'invoke_tool',
      { name: 'mcp:fixture:echo', version: f.version(), arguments: {} },
      controller.signal,
    );
    expect(f.connection.call).not.toHaveBeenCalled();
  });
  it('publishes refresh atomically, rejects duplicates and keeps qualified identities distinct', async () => {
    const f = setup();
    await f.search();
    expect(qualifiedName('a', 'b:c')).not.toBe(qualifiedName('a-b', 'c'));
    expect(() =>
      f.manager.catalog.publish('fixture', [metadata, metadata], f.connection),
    ).toThrow();
    expect(f.manager.catalog.resolve('mcp:fixture:echo', f.version())).toBeDefined();
    expect(() =>
      f.manager.catalog.publish(
        'fixture',
        [{ ...metadata, inputSchema: { type: 'object', $ref: 'https://secret/schema' } }],
        f.connection,
      ),
    ).toThrow();
    f.connection.onInvalidated?.();
    vi.mocked(f.connection.discover).mockRejectedValueOnce(new Error('SECRET_TRANSPORT'));
    expect(await f.search()).toMatchObject({ outcome: 'error' });
    expect(f.registry.get('mcp:fixture:echo')).toBeUndefined();
    expect((await f.search()).outcome).toBe('success');
  });
  it('keeps identical raw names distinct across servers and rejects unsupported schemas', async () => {
    const f = setup();
    await f.search();
    f.manager.catalog.publish('second', [metadata], f.connection);
    expect(f.registry.get('mcp:fixture:echo')).toBeDefined();
    expect(f.registry.get('mcp:second:echo')).toBeDefined();
    for (const inputSchema of [
      { type: 'object', mysteryAssertion: true },
      { type: 'object', properties: { value: { type: 'string', pattern: '(a+)+' } } },
      { type: 'object', description: 'x'.repeat(16_000) },
    ])
      expect(() =>
        f.manager.catalog.publish('second', [{ ...metadata, inputSchema }], f.connection),
      ).toThrow();
    // A property name is user data, not a schema keyword.
    expect(() =>
      f.manager.catalog.publish(
        'second',
        [
          {
            ...metadata,
            inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
          },
        ],
        f.connection,
      ),
    ).not.toThrow();
  });
  it('normalizes media/errors, bounds result size and never retries failures', async () => {
    const f = setup({ mode: 'always-approve' });
    await f.search();
    vi.mocked(f.connection.call).mockResolvedValueOnce({
      content: [{ type: 'image', data: 'base64-secret', mimeType: 'image/png' }],
      isError: true,
    });
    const media = await f.invoke();
    expect(media.outcome).toBe('error');
    expect(JSON.stringify(media)).toContain('omitted');
    expect(JSON.stringify(media)).not.toContain('base64-secret');
    vi.mocked(f.connection.call).mockResolvedValueOnce({
      content: [{ type: 'text', text: 'x'.repeat(70_000) }],
    });
    expect(await f.invoke()).toMatchObject({ output: { error: { code: 'result_limit' } } });
    vi.mocked(f.connection.call).mockRejectedValueOnce(new McpError('timeout'));
    await f.invoke();
    expect(f.connection.call).toHaveBeenCalledTimes(3);
  });
});

describe('MCP configuration', () => {
  it('selects only explicit environment variables and rejects ambiguous/untrusted configuration', async () => {
    const files = (raw: unknown) => ({
      readFile: () =>
        Promise.resolve({ content: JSON.stringify(raw), path: 'mcp.json', sizeBytes: 0 }),
      listDirectory: () => Promise.resolve([]),
    });
    const config = {
      servers: [{ alias: 'local', transport: 'stdio', command: '/usr/bin/node', env: ['SAFE'] }],
    };
    expect(
      await loadMcpConfig(files(config), 'mcp.json', { SAFE: 'yes', SECRET: 'no' }),
    ).toMatchObject([{ process: { environment: { SAFE: 'yes' } } }]);
    for (const servers of [
      [config.servers[0], config.servers[0]],
      [{ alias: 'bad', transport: 'http', url: 'http://example.com' }],
      [{ alias: 'bad', transport: 'http', url: 'https://user:secret@example.com' }],
    ]) {
      await expect(loadMcpConfig(files({ servers }), 'mcp.json', {})).rejects.toThrow(McpError);
    }
  });
});
