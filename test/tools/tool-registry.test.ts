import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createToolCallId } from '../../src/ids.js';
import type { JsonObject, JsonValue } from '../../src/json.js';
import type { Tool } from '../../src/tools/tool.interface.js';
import { DuplicateToolNameError, ToolRegistry } from '../../src/tools/tool-registry.js';
import type {
  ModelToolDefinition,
  ToolCall,
  ToolExecutionOptions,
  ToolResult,
} from '../../src/tools/tool-types.js';

function createReadTool(name = 'read_file'): Tool {
  return {
    definition: {
      name,
      description: 'Read a UTF-8 text file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      accessKind: 'read',
    },
    validateInput: () => ({ valid: true }),
    execute: vi.fn<Tool['execute']>((call) =>
      Promise.resolve({
        toolCallId: call.id,
        outcome: 'success',
        output: { content: 'file contents' },
      }),
    ),
  };
}

describe('ToolRegistry', () => {
  it('registers and looks up a tool without executing it', () => {
    const registry = new ToolRegistry();
    const tool = createReadTool();

    registry.register(tool);

    expect(registry.get('read_file')).toBe(tool);
    expect(registry.get('missing')).toBeUndefined();
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate names and preserves the original registration', () => {
    const registry = new ToolRegistry();
    const original = createReadTool();
    const duplicate = createReadTool();
    registry.register(original);

    expect(() => registry.register(duplicate)).toThrowError(
      new DuplicateToolNameError('read_file'),
    );
    expect(registry.get('read_file')).toBe(original);
    expect(original.execute).not.toHaveBeenCalled();
    expect(duplicate.execute).not.toHaveBeenCalled();
  });

  it('lists stable model-facing definitions without internal access metadata', () => {
    const registry = new ToolRegistry();
    const readFile = createReadTool('read_file');
    const listFiles = createReadTool('list_files');
    registry.register(readFile);
    registry.register(listFiles);

    const definitions = registry.getModelDefinitions();

    expect(definitions).toEqual([
      {
        name: 'read_file',
        description: 'Read a UTF-8 text file.',
        inputSchema: readFile.definition.inputSchema,
      },
      {
        name: 'list_files',
        description: 'Read a UTF-8 text file.',
        inputSchema: listFiles.definition.inputSchema,
      },
    ]);
    expect(definitions.every((definition) => !('accessKind' in definition))).toBe(true);
    expect(readFile.execute).not.toHaveBeenCalled();
    expect(listFiles.execute).not.toHaveBeenCalled();
  });
});

describe('normalized tool contracts', () => {
  it('remain provider-neutral and JSON-shaped', () => {
    expectTypeOf<Tool['execute']>().parameters.toEqualTypeOf<
      [call: ToolCall, options?: ToolExecutionOptions]
    >();
    expectTypeOf<Tool['execute']>().returns.toEqualTypeOf<Promise<ToolResult>>();
    expectTypeOf<ToolCall['arguments']>().toEqualTypeOf<JsonObject>();
    expectTypeOf<ToolResult['output']>().toEqualTypeOf<JsonValue>();
    expectTypeOf<ModelToolDefinition>().toEqualTypeOf<{
      readonly name: string;
      readonly description: string;
      readonly inputSchema: JsonObject;
    }>();

    const toolCallId = createToolCallId();
    const call: ToolCall = {
      id: toolCallId,
      name: 'read_file',
      arguments: { path: 'package.json' },
    };
    const result: ToolResult = {
      toolCallId,
      outcome: 'success',
      output: { content: 'file contents' },
    };

    expect(result.toolCallId).toBe(call.id);
  });
});
