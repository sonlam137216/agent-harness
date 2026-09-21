import { SpanStatusCode } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { ReadFileTool } from '../../src/tools/builtin/read-file.tool.js';
import { ToolBridge } from '../../src/tools/tool-bridge.js';
import type { Tool } from '../../src/tools/tool.interface.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import type { FileSystemCapability } from '../../src/workspace/filesystem-capability.js';
import { PermissionEngine } from '../../src/permissions/permission-engine.js';
import { HookRegistry } from '../../src/hooks/hook-registry.js';

function executionContext(signal?: AbortSignal) {
  return {
    sessionId: createSessionId(),
    turnId: createTurnId(),
    modelCallId: createModelCallId(),
    ...(signal === undefined ? {} : { signal }),
  };
}

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

  it('never asks approval or invokes pre-hooks for invalid input', async () => {
    const approve = vi.fn(() => true);
    const hooks = new HookRegistry();
    const pre = vi.fn();
    hooks.register('PreToolUse', pre);
    const execute = vi.fn<Tool['execute']>();
    registry.register({
      definition: { name: 'edit', accessKind: 'write', description: 'test', inputSchema: {} },
      validateInput: () => ({ valid: false, message: 'invalid' }),
      execute,
    });
    const bridge = new ToolBridge(registry, tracing.tracer, {
      hooks,
      permissions: new PermissionEngine({ mode: 'ask', approve }),
    });
    await bridge.execute(
      { id: createToolCallId(), name: 'edit', arguments: {} },
      executionContext(),
    );
    expect(approve).not.toHaveBeenCalled();
    expect(pre).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('authorizes and executes the same snapshot even if the caller changes its original arguments', async () => {
    const call = { id: createToolCallId(), name: 'edit', arguments: { path: 'original' } };
    const execute = vi.fn<Tool['execute']>((value) =>
      Promise.resolve({ toolCallId: value.id, outcome: 'success', output: null }),
    );
    registry.register({
      definition: { name: 'edit', accessKind: 'write', description: 'test', inputSchema: {} },
      validateInput: () => ({ valid: true }),
      execute,
    });
    const bridge = new ToolBridge(registry, tracing.tracer, {
      permissions: new PermissionEngine({
        mode: 'ask',
        approve: (request) => {
          expect(request.call.arguments.path).toBe('original');
          call.arguments.path = 'changed';
          return true;
        },
      }),
    });
    await bridge.execute(call, executionContext());
    expect(execute.mock.calls[0]?.[0].arguments.path).toBe('original');
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
    const modelCallId = createModelCallId();
    const toolCallId = createToolCallId();

    const result = await bridge.execute(
      {
        id: toolCallId,
        name: 'read_file',
        arguments: { path: 'private-file.txt' },
      },
      { sessionId, turnId, modelCallId, signal: controller.signal },
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
    const allSpans = exporter.getFinishedSpans();
    const spans = allSpans.filter((span) => span.name === 'tool.execute');
    expect(spans).toHaveLength(1);
    expect(allSpans.filter((span) => span.name === 'permission.evaluate')).toHaveLength(1);
    expect(spans[0]?.name).toBe('tool.execute');
    expect(spans[0]?.attributes).toEqual(
      expect.objectContaining({
        'session.id': sessionId,
        'turn.id': turnId,
        'model_call.id': modelCallId,
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
      executionContext(),
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
      executionContext(),
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
      executionContext(),
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
    const span = exporter.getFinishedSpans().find((candidate) => candidate.name === 'tool.execute');
    expect(span?.attributes['error.type']).toBe('tool_execution_error');
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
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
      executionContext(controller.signal),
    );

    expect(result).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'cancelled' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies unmatched non-read tools by default without executing them', async () => {
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
      executionContext(),
    );

    expect(result).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'access_denied' } },
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
