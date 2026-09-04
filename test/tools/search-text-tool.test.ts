import { describe, expect, it, vi } from 'vitest';

import { createToolCallId } from '../../src/ids.js';
import { SearchTextTool } from '../../src/tools/builtin/search-text.tool.js';
import {
  FileSystemError,
  type FileSystemCapability,
} from '../../src/workspace/filesystem-capability.js';

function createSearchFileSystem(): FileSystemCapability {
  return {
    listDirectory: vi.fn<FileSystemCapability['listDirectory']>((path) => {
      if (path === '.') {
        return Promise.resolve([
          { path: 'README.md', name: 'README.md', kind: 'file' },
          { path: 'src', name: 'src', kind: 'directory' },
        ]);
      }
      return Promise.resolve([{ path: 'src/index.ts', name: 'index.ts', kind: 'file' }]);
    }),
    readFile: vi.fn<FileSystemCapability['readFile']>((path) => {
      if (path === 'README.md') {
        return Promise.resolve({ path, content: 'needle in readme', sizeBytes: 16 });
      }
      return Promise.resolve({ path, content: 'first line\nneedle in source', sizeBytes: 27 });
    }),
  };
}

describe('SearchTextTool', () => {
  it('recursively finds literal text through FileSystemCapability', async () => {
    const fileSystem = createSearchFileSystem();
    const tool = new SearchTextTool(fileSystem);
    const toolCallId = createToolCallId();

    expect(tool.definition).toMatchObject({
      accessKind: 'read',
      inputSchema: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
      },
    });

    const result = await tool.execute({
      id: toolCallId,
      name: 'search_text',
      arguments: { query: 'needle' },
    });

    expect(result).toEqual({
      toolCallId,
      outcome: 'success',
      output: {
        matches: [
          {
            path: 'README.md',
            lineNumber: 1,
            columnNumber: 1,
            text: 'needle in readme',
            snippetStartColumn: 1,
            textTruncated: false,
          },
          {
            path: 'src/index.ts',
            lineNumber: 2,
            columnNumber: 1,
            text: 'needle in source',
            snippetStartColumn: 1,
            textTruncated: false,
          },
        ],
        filesSearched: 2,
        truncated: false,
      },
    });
    expect(fileSystem.listDirectory).toHaveBeenCalledTimes(2);
    expect(fileSystem.readFile).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid input before filesystem access', async () => {
    const fileSystem = createSearchFileSystem();
    const tool = new SearchTextTool(fileSystem);

    const result = await tool.execute({
      id: createToolCallId(),
      name: 'search_text',
      arguments: { query: '', regularExpression: true },
    });

    expect(result).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'invalid_input' } },
    });
    expect(fileSystem.listDirectory).not.toHaveBeenCalled();
    expect(fileSystem.readFile).not.toHaveBeenCalled();
  });

  it('returns structured workspace failures', async () => {
    const fileSystem = createSearchFileSystem();
    vi.mocked(fileSystem.listDirectory).mockRejectedValueOnce(
      new FileSystemError('The requested path does not exist.', {
        code: 'not_found',
        requestedPath: 'missing',
      }),
    );
    const tool = new SearchTextTool(fileSystem);

    const result = await tool.execute({
      id: createToolCallId(),
      name: 'search_text',
      arguments: { query: 'needle', path: 'missing' },
    });

    expect(result).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'not_found' } },
    });
  });

  it('bounds match count and snippet size', async () => {
    const fileSystem = createSearchFileSystem();
    const tool = new SearchTextTool(fileSystem, {
      maxMatches: 1,
      maxSnippetCharacters: 8,
    });

    const result = await tool.execute({
      id: createToolCallId(),
      name: 'search_text',
      arguments: { query: 'needle' },
    });

    expect(result).toMatchObject({
      outcome: 'success',
      output: {
        matches: [{ text: 'needle i', textTruncated: true }],
        filesSearched: 1,
        truncated: true,
      },
    });
  });
});
