import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionId, createToolCallId, createTurnId } from '../../src/ids.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { ReadFileTool } from '../../src/tools/builtin/read-file.tool.js';
import { ToolBridge } from '../../src/tools/tool-bridge.js';
import type { Tool } from '../../src/tools/tool.interface.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { FileSystemCapability } from '../../src/workspace/filesystem-capability.js';

describe('ToolBridge', () => {
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

  it('validates, dispatches, propagates cancellation, and traces safe correlation data', async () => {
    const controller = new AbortController();
    const readFile = vi.fn<FileSystemCapability['readFile']>((path) =>
      Promise.resolve({ path, content: 'private file contents', sizeBytes: 21 }),
    );
    const fileSystem: FileSystemCapability = {
      readFile,
      listDirectory: vi.fn<FileSystemCapability['listDirectory']>(() => Promise.resolve([])),
    };
    registry.register(new ReadFileTool(fileSystem));
    const sessionId = createSessionId();
    const turnId = createTurnId();
    const toolCallId = createToolCallId();

    const result = await bridge.execute(
      {
        id: toolCallId,
        name: 'read_file',
        arguments: { path: 'private-file.txt' },
      },
      { sessionId, turnId, signal: controller.signal },
    );
    await tracing.forceFlush();

    expect(result).toEqual({
      toolCallId,
      outcome: 'success',
      output: {
        path: 'private-file.txt',
        content: 'private file contents',
        sizeBytes: 21,
      },
    });
    expect(readFile).toHaveBeenCalledWith('private-file.txt', { signal: controller.signal });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('tool.execute');
    expect(spans[0]?.attributes).toEqual(
      expect.objectContaining({
        'session.id': sessionId,
        'turn.id': turnId,
        'tool_call.id': toolCallId,
        'tool.name': 'read_file',
        'tool.kind': 'native',
        'tool.access_kind': 'read',
        'tool.result_outcome': 'success',
        success: true,
      }),
    );
    expect(JSON.stringify(spans[0]?.attributes)).not.toContain('private-file.txt');
    expect(JSON.stringify(spans[0]?.attributes)).not.toContain('private file contents');
  });

  it('returns a structured failure for an unknown tool', async () => {
    const toolCallId = createToolCallId();

    const result = await bridge.execute(
      { id: toolCallId, name: 'missing_tool', arguments: {} },
      { sessionId: createSessionId(), turnId: createTurnId() },
    );

    expect(result).toEqual({
      toolCallId,
      outcome: 'error',
      output: {
        error: {
          code: 'unknown_tool',
          message: 'No registered tool matches this call.',
        },
      },
    });
  });

  it('rejects invalid arguments before tool execution', async () => {
    const execute = vi.fn<Tool['execute']>();
    registry.register({
      definition: {
        name: 'strict_read',
        description: 'A test read tool.',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
        accessKind: 'read',
      },
      validateInput: () => ({ valid: false, message: 'Expected a string path.' }),
      execute,
    });

    const result = await bridge.execute(
      {
        id: createToolCallId(),
        name: 'strict_read',
        arguments: { path: 42, unexpected: true },
      },
      { sessionId: createSessionId(), turnId: createTurnId() },
    );

    expect(result).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'invalid_input' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('normalizes a thrown tool failure without exposing its raw message', async () => {
    const failingTool: Tool = {
      definition: {
        name: 'failing_read',
        description: 'A test read tool.',
        inputSchema: { type: 'object', additionalProperties: false },
        accessKind: 'read',
      },
      validateInput: () => ({ valid: true }),
      execute: vi.fn<Tool['execute']>(() =>
        Promise.reject(new Error('secret-token=do-not-expose')),
      ),
    };
    registry.register(failingTool);

    const result = await bridge.execute(
      { id: createToolCallId(), name: 'failing_read', arguments: {} },
      { sessionId: createSessionId(), turnId: createTurnId() },
    );
    await tracing.forceFlush();

    expect(result).toMatchObject({
      outcome: 'error',
      output: {
        error: {
          code: 'tool_execution_error',
          message: 'The tool failed unexpectedly.',
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(
      JSON.stringify(exporter.getFinishedSpans().map((span) => span.attributes)),
    ).not.toContain('secret-token');
  });

  it('returns cancellation before dispatch when the signal is already aborted', async () => {
    const execute = vi.fn<Tool['execute']>();
    registry.register({
      definition: {
        name: 'cancelled_read',
        description: 'A test read tool.',
        inputSchema: { type: 'object', additionalProperties: false },
        accessKind: 'read',
      },
      validateInput: () => ({ valid: true }),
      execute,
    });
    const controller = new AbortController();
    controller.abort();

    const result = await bridge.execute(
      { id: createToolCallId(), name: 'cancelled_read', arguments: {} },
      {
        sessionId: createSessionId(),
        turnId: createTurnId(),
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'cancelled' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies non-read tools in Phase 1 without executing them', async () => {
    const execute = vi.fn<Tool['execute']>();
    registry.register({
      definition: {
        name: 'write_file',
        description: 'A test write tool.',
        inputSchema: { type: 'object' },
        accessKind: 'write',
      },
      validateInput: () => ({ valid: true }),
      execute,
    });

    const result = await bridge.execute(
      { id: createToolCallId(), name: 'write_file', arguments: {} },
      { sessionId: createSessionId(), turnId: createTurnId() },
    );

    expect(result).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'access_denied' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
