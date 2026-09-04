import type { JsonValue } from '../../json.js';
import type { FileSystemCapability } from '../../workspace/filesystem-capability.js';
import type { Tool } from '../tool.interface.js';
import { fileSystemToolFailure, invalidToolInput, toolSuccess } from '../tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from '../tool-types.js';
import { validateSearchTextInput } from './input-validation.js';

const DEFAULT_MAX_MATCHES = 100;
const DEFAULT_MAX_VISITED_ENTRIES = 5_000;
const DEFAULT_MAX_SNIPPET_CHARACTERS = 500;

export interface SearchTextToolOptions {
  readonly maxMatches?: number;
  readonly maxVisitedEntries?: number;
  readonly maxSnippetCharacters?: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
}

function matchSnippet(
  line: string,
  matchIndex: number,
  maxCharacters: number,
): { text: string; startColumn: number; truncated: boolean } {
  if (line.length <= maxCharacters) {
    return { text: line, startColumn: 1, truncated: false };
  }

  const start = Math.max(0, matchIndex - Math.floor(maxCharacters / 2));
  return {
    text: line.slice(start, start + maxCharacters),
    startColumn: start + 1,
    truncated: true,
  };
}

export class SearchTextTool implements Tool {
  public readonly definition = {
    name: 'search_text',
    description: 'Recursively find case-sensitive literal text in workspace files.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 1_000 },
        path: { type: 'string', minLength: 1, maxLength: 4_096 },
      },
      required: ['query'],
      additionalProperties: false,
    },
    accessKind: 'read',
  } as const;

  readonly #maxMatches: number;
  readonly #maxVisitedEntries: number;
  readonly #maxSnippetCharacters: number;

  public constructor(
    private readonly fileSystem: FileSystemCapability,
    options: SearchTextToolOptions = {},
  ) {
    this.#maxMatches = positiveInteger(options.maxMatches ?? DEFAULT_MAX_MATCHES, 'maxMatches');
    this.#maxVisitedEntries = positiveInteger(
      options.maxVisitedEntries ?? DEFAULT_MAX_VISITED_ENTRIES,
      'maxVisitedEntries',
    );
    this.#maxSnippetCharacters = positiveInteger(
      options.maxSnippetCharacters ?? DEFAULT_MAX_SNIPPET_CHARACTERS,
      'maxSnippetCharacters',
    );
  }

  public readonly validateInput: Tool['validateInput'] = (input) => validateSearchTextInput(input);

  public readonly execute = async (
    call: ToolCall,
    options: ToolExecutionOptions = {},
  ): Promise<ToolResult> => {
    const input = validateSearchTextInput(call.arguments);
    if (!input.valid) return invalidToolInput(call.id, input.message);

    try {
      const directories = [input.value.path];
      const matches: JsonValue[] = [];
      let filesSearched = 0;
      let visitedEntries = 0;
      let truncated = false;

      while (directories.length > 0 && !truncated) {
        const directory = directories.shift();
        if (directory === undefined) break;
        const entries = await this.fileSystem.listDirectory(directory, options);

        for (const entry of entries) {
          visitedEntries += 1;
          if (visitedEntries > this.#maxVisitedEntries) {
            truncated = true;
            break;
          }
          if (entry.kind === 'directory') {
            directories.push(entry.path);
            continue;
          }
          if (entry.kind !== 'file') continue;

          const file = await this.fileSystem.readFile(entry.path, options);
          filesSearched += 1;
          if (file.content.includes('\0')) continue;

          const lines = file.content.split(/\r?\n/u);
          for (const [lineIndex, line] of lines.entries()) {
            const matchIndex = line.indexOf(input.value.query);
            if (matchIndex < 0) continue;
            const snippet = matchSnippet(line, matchIndex, this.#maxSnippetCharacters);
            matches.push({
              path: file.path,
              lineNumber: lineIndex + 1,
              columnNumber: matchIndex + 1,
              text: snippet.text,
              snippetStartColumn: snippet.startColumn,
              textTruncated: snippet.truncated,
            });
            if (matches.length === this.#maxMatches) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
      }

      return toolSuccess(call.id, {
        matches,
        filesSearched,
        truncated,
      });
    } catch (error) {
      return fileSystemToolFailure(call.id, error);
    }
  };
}
