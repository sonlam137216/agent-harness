import { SpanStatusCode } from '@opentelemetry/api';
import {
  checkContextCancellation,
  ContextError,
  positiveInteger,
} from '../context/context-budget.js';
import type { ModelCallId, SessionId, TurnId } from '../ids.js';
import { SamplingError } from '../model/sampling-types.js';
import type { TracingHandle } from '../observability/tracing.js';
import { FileSystemError, type FileSystemCapability } from '../workspace/filesystem-capability.js';
import { rankMemories } from './memory-index.js';
import { parseMemoryEntries } from './memory-parser.js';

export type MemoryScope = 'workspace' | 'user';

export interface MemoryRoot {
  readonly scope: MemoryScope;
  readonly files: FileSystemCapability;
  /** Directory relative to the capability root; only its immediate `*.md` files are read. */
  readonly directory: string;
}

export interface MemoryCandidate {
  readonly scope: MemoryScope;
  /** Path relative to the scope's filesystem root. */
  readonly path: string;
  readonly title: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly score: number;
}

/** Discovery bounds that left some memory unread. */
export type MemoryPartialReason = 'files' | 'bytes' | 'file_size' | 'directory_size' | 'entries';

export interface MemorySearchInput {
  readonly query: string;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly modelCallId?: ModelCallId;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export interface MemorySearchResult {
  readonly candidates: readonly MemoryCandidate[];
  readonly partialReasons: readonly MemoryPartialReason[];
  readonly filesRead: number;
  readonly bytesRead: number;
  readonly entriesIndexed: number;
}

export interface MemoryStoreOptions {
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxResults?: number;
}

const memoryFile = (name: string) => !name.startsWith('.') && /\.md$/iu.test(name);

/**
 * Read-only Markdown memory. Workspace and user scopes are ranked together;
 * each is read through its own contained filesystem capability.
 */
export class MarkdownMemoryStore {
  readonly #roots: readonly MemoryRoot[];
  readonly #limits;

  public constructor(
    roots: readonly MemoryRoot[],
    private readonly tracer: TracingHandle['tracer'],
    options: MemoryStoreOptions = {},
  ) {
    const scopes = new Set<MemoryScope>();
    for (const root of roots) {
      if (scopes.has(root.scope)) throw new RangeError('Provide only one memory root per scope.');
      scopes.add(root.scope);
      if (
        !root.directory ||
        root.directory.startsWith('/') ||
        /[\\:\0]/u.test(root.directory) ||
        root.directory.split('/').includes('..')
      )
        throw new RangeError('Memory directories must stay within their filesystem root.');
    }
    // Workspace first so equal scores prefer project-specific notes.
    this.#roots = [...roots].sort((a, b) =>
      a.scope === b.scope ? 0 : a.scope === 'workspace' ? -1 : 1,
    );
    this.#limits = {
      files: options.maxFiles ?? 64,
      fileBytes: options.maxFileBytes ?? 65_536,
      bytes: options.maxBytes ?? 524_288,
      entries: options.maxEntries ?? 1_024,
      results: options.maxResults ?? 16,
    };
    for (const [name, value] of Object.entries(this.#limits)) positiveInteger(name, value);
  }

  public async search(input: MemorySearchInput): Promise<MemorySearchResult> {
    return this.tracer.startActiveSpan('memory.search', async (span) => {
      const started = performance.now();
      const partial = new Set<MemoryPartialReason>();
      const entries: Omit<MemoryCandidate, 'score'>[] = [];
      let filesRead = 0;
      let bytesRead = 0;
      let candidates: MemoryCandidate[] = [];
      span.setAttributes({ 'session.id': input.sessionId, 'turn.id': input.turnId });
      if (input.modelCallId !== undefined) span.setAttribute('model_call.id', input.modelCallId);
      const options = input.signal === undefined ? {} : { signal: input.signal };
      try {
        checkContextCancellation(input);
        discovery: for (const root of this.#roots) {
          let listing;
          try {
            listing = await root.files.listDirectory(root.directory, options);
          } catch (error) {
            if (error instanceof FileSystemError && error.code === 'not_found') continue;
            if (error instanceof FileSystemError && error.code === 'output_limit_exceeded') {
              partial.add('directory_size');
              continue;
            }
            throw error;
          }
          checkContextCancellation(input);
          const files = listing
            .filter((entry) => entry.kind === 'file' && memoryFile(entry.name))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
          for (const entry of files) {
            if (filesRead >= this.#limits.files) {
              partial.add('files');
              break discovery;
            }
            const remaining = this.#limits.bytes - bytesRead;
            if (remaining <= 0) {
              partial.add('bytes');
              break discovery;
            }
            filesRead += 1;
            let file;
            try {
              file = await root.files.readFile(entry.path, {
                ...options,
                maxBytes: Math.min(remaining, this.#limits.fileBytes),
              });
            } catch (error) {
              if (error instanceof FileSystemError && error.code === 'output_limit_exceeded') {
                partial.add(remaining < this.#limits.fileBytes ? 'bytes' : 'file_size');
                continue;
              }
              if (error instanceof FileSystemError && error.code === 'not_found') continue;
              throw error;
            }
            checkContextCancellation(input);
            bytesRead += file.sizeBytes;
            for (const parsed of parseMemoryEntries(file.content)) {
              if (entries.length >= this.#limits.entries) {
                partial.add('entries');
                break discovery;
              }
              entries.push({ scope: root.scope, path: file.path, ...parsed });
            }
          }
        }
        candidates = rankMemories(
          entries.map((entry) => entry.content),
          input.query.slice(0, 4096),
        )
          .slice(0, this.#limits.results)
          .map(({ index, score }) => ({ ...entries[index]!, score }));
        span.setAttribute('success', true);
        return {
          candidates,
          partialReasons: [...partial],
          filesRead,
          bytesRead,
          entriesIndexed: entries.length,
        };
      } catch (error) {
        let failure: unknown = error;
        try {
          checkContextCancellation(input);
        } catch (cancelled) {
          failure = cancelled;
        }
        span.setAttributes({
          success: false,
          'error.type':
            failure instanceof SamplingError || failure instanceof ContextError
              ? failure.code
              : 'source_failed',
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (failure instanceof SamplingError || failure instanceof ContextError) throw failure;
        throw new ContextError('source_failed', 'Memory could not be read safely.', {
          cause: new Error(
            failure instanceof FileSystemError ? failure.code : 'memory_read_failed',
          ),
        });
      } finally {
        span.setAttributes({
          files_read: filesRead,
          bytes_read: bytesRead,
          entries_indexed: entries.length,
          candidates: candidates.length,
          partial: partial.size > 0,
          partial_reasons: [...partial],
          duration_ms: performance.now() - started,
        });
        span.end();
      }
    });
  }
}
