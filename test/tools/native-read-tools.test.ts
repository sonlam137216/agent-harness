import { describe, expect, it, vi } from 'vitest';

import { createToolCallId } from '../../src/ids.js';
import { ListFilesTool } from '../../src/tools/builtin/list-files.tool.js';
import { ReadFileTool } from '../../src/tools/builtin/read-file.tool.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import {
  FileSystemError,
  type FileSystemCapability,
} from '../../src/workspace/filesystem-capability.js';

function createFileSystem(): {
  capability: FileSystemCapability;
  readFile: ReturnType<typeof vi.fn<FileSystemCapability['readFile']>>;
  listDirectory: ReturnType<typeof vi.fn<FileSystemCapability['listDirectory']>>;
} {
  const readFile = vi.fn<FileSystemCapability['readFile']>((path) =>
    Promise.resolve({ path, content: 'file contents', sizeBytes: 13 }),
  );
  const listDirectory = vi.fn<FileSystemCapability['listDirectory']>(() =>
    Promise.resolve([{ path: 'src', name: 'src', kind: 'directory' }]),
  );
  return { capability: { readFile, listDirectory }, readFile, listDirectory };
}

describe('Phase 1 read-only filesystem tools', () => {
  it('reads a file and lists files through FileSystemCapability', async () => {
    const fileSystem = createFileSystem();
    const readFile = new ReadFileTool(fileSystem.capability);
    const listFiles = new ListFilesTool(fileSystem.capability);
    const readCallId = createToolCallId();
    const listCallId = createToolCallId();

    const readResult = await readFile.execute({
      id: readCallId,
      name: 'read_file',
      arguments: { path: 'README.md' },
    });
    const listResult = await listFiles.execute({
      id: listCallId,
      name: 'list_files',
      arguments: {},
    });

    expect(readResult).toEqual({
      toolCallId: readCallId,
      outcome: 'success',
      output: { path: 'README.md', content: 'file contents', sizeBytes: 13 },
    });
    expect(listResult).toEqual({
      toolCallId: listCallId,
      outcome: 'success',
      output: { entries: [{ path: 'src', name: 'src', kind: 'directory' }] },
    });
    expect(fileSystem.readFile).toHaveBeenCalledWith('README.md', {});
    expect(fileSystem.listDirectory).toHaveBeenCalledWith('.', {});
  });

  it('publishes strict schemas and read-only model-facing definitions', () => {
    const fileSystem = createFileSystem();
    const registry = new ToolRegistry();
    registry.register(new ReadFileTool(fileSystem.capability));
    registry.register(new ListFilesTool(fileSystem.capability));

    const definitions = registry.getModelDefinitions();
    expect(definitions.map(({ name, description }) => ({ name, description }))).toEqual([
      {
        name: 'read_file',
        description: 'Read one UTF-8 text file within the workspace.',
      },
      {
        name: 'list_files',
        description: 'List immediate entries in one workspace directory.',
      },
    ]);
    expect(definitions[0]?.inputSchema).toMatchObject({
      type: 'object',
      required: ['path'],
      additionalProperties: false,
    });
    expect(definitions[1]?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(registry.get('read_file')?.definition.accessKind).toBe('read');
    expect(registry.get('list_files')?.definition.accessKind).toBe('read');
  });

  it('returns structured failures for invalid input without touching the workspace', async () => {
    const fileSystem = createFileSystem();
    const readFile = new ReadFileTool(fileSystem.capability);
    const listFiles = new ListFilesTool(fileSystem.capability);

    const readResult = await readFile.execute({
      id: createToolCallId(),
      name: 'read_file',
      arguments: { path: 42 },
    });
    const listResult = await listFiles.execute({
      id: createToolCallId(),
      name: 'list_files',
      arguments: { path: '.', recursive: true },
    });

    expect(readResult).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'invalid_input' } },
    });
    expect(listResult).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'invalid_input' } },
    });
    expect(fileSystem.readFile).not.toHaveBeenCalled();
    expect(fileSystem.listDirectory).not.toHaveBeenCalled();
  });

  it('normalizes workspace errors, including bounded-read failures', async () => {
    const fileSystem = createFileSystem();
    const readFile = new ReadFileTool(fileSystem.capability);
    fileSystem.readFile
      .mockRejectedValueOnce(
        new FileSystemError('The requested path does not exist.', {
          code: 'not_found',
          requestedPath: 'missing.txt',
        }),
      )
      .mockRejectedValueOnce(
        new FileSystemError('The requested file exceeds the configured read limit.', {
          code: 'output_limit_exceeded',
          requestedPath: 'large.txt',
        }),
      );

    const missing = await readFile.execute({
      id: createToolCallId(),
      name: 'read_file',
      arguments: { path: 'missing.txt' },
    });
    const tooLarge = await readFile.execute({
      id: createToolCallId(),
      name: 'read_file',
      arguments: { path: 'large.txt' },
    });

    expect(missing).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'not_found' } },
    });
    expect(tooLarge).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'output_limit_exceeded' } },
    });
  });
});
