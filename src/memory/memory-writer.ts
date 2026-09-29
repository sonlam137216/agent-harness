import { SpanStatusCode } from '@opentelemetry/api';
import type { SessionId } from '../ids.js';
import type { TracingHandle } from '../observability/tracing.js';
import { NoteStorageError, type NoteStorage } from '../workspace/note-storage.js';
import { parseMemoryEntries } from './memory-parser.js';
import type { MemoryScope } from './memory-store.js';

export const MAX_MEMORY_TITLE_CHARACTERS = 120;
export const MAX_MEMORY_BODY_CHARACTERS = 4_000;

export interface MemoryRecordInput {
  readonly scope: MemoryScope;
  /** Flat file stem such as `decisions`; `.md` is added. Defaults to `notes`. */
  readonly file?: string;
  readonly title: string;
  readonly body: string;
  /** Provenance written with the entry. */
  readonly source:
    | { readonly kind: 'cli' }
    | { readonly kind: 'agent'; readonly sessionId: SessionId }
    | {
        readonly kind: 'session_summary';
        readonly sessionId: SessionId;
        readonly modelId: string;
        readonly turnCount: number;
      };
  readonly signal?: AbortSignal;
}

/** Provenance marker that identifies a session's summary within a note file. */
export const summaryMarker = (sessionId: SessionId): string => `from session ${sessionId}`;

export interface RecordedMemory {
  readonly scope: MemoryScope;
  readonly path: string;
  readonly title: string;
  readonly startLine: number;
  readonly endLine: number;
}

export class MemoryWriteError extends Error {
  public override readonly name = 'MemoryWriteError';
  public constructor(
    public readonly code:
      | 'invalid_input'
      | 'scope_unavailable'
      | 'busy'
      | 'size_limit'
      | 'storage_failed'
      | 'cancelled'
      | 'duplicate',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Returns a reason when the input cannot be stored as exactly one parseable entry. */
export function memoryInputProblem(
  input: Pick<MemoryRecordInput, 'title' | 'body' | 'file'>,
): string | undefined {
  const title = input.title.trim();
  const body = input.body.trim();
  if (title === '' || title.length > MAX_MEMORY_TITLE_CHARACTERS || /[\r\n]/u.test(title))
    return `Title must be one line of 1-${MAX_MEMORY_TITLE_CHARACTERS} characters.`;
  if (title.startsWith('#')) return 'Title must not start with "#".';
  if (body === '' || body.length > MAX_MEMORY_BODY_CHARACTERS)
    return `Body must contain 1-${MAX_MEMORY_BODY_CHARACTERS} characters.`;
  const lines = body.split(/\r?\n/u);
  // Either would split or swallow entries when the file is parsed again.
  if (lines.some((line) => /^## /u.test(line)))
    return 'Body lines must not start with "## " (use "###" for sub-headings).';
  if (lines.filter((line) => /^\s{0,3}(?:```|~~~)/u.test(line)).length % 2 !== 0)
    return 'Body has an unclosed code fence.';
  if (input.file !== undefined && !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(input.file))
    return 'File must be a lowercase name of letters, digits, "-" or "_" (no extension).';
  return undefined;
}

/** Appends validated entries; reading and ranking stay in MarkdownMemoryStore. */
export class MemoryWriter {
  public constructor(
    private readonly storage: Partial<Record<MemoryScope, NoteStorage>>,
    private readonly tracer: TracingHandle['tracer'],
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async record(input: MemoryRecordInput): Promise<RecordedMemory> {
    return this.tracer.startActiveSpan('memory.record', async (span) => {
      const started = performance.now();
      span.setAttributes({ scope: input.scope, source: input.source.kind });
      if (input.source.kind !== 'cli') span.setAttribute('session.id', input.source.sessionId);
      try {
        const problem = memoryInputProblem(input);
        if (problem !== undefined) throw new MemoryWriteError('invalid_input', problem);
        const storage = this.storage[input.scope];
        if (storage === undefined)
          throw new MemoryWriteError(
            'scope_unavailable',
            `The ${input.scope} scope is not writable.`,
          );
        const title = input.title.trim();
        const date = this.now().toISOString().slice(0, 10);
        const source = input.source;
        if (source.kind === 'session_summary' && /[\r\n]/u.test(source.modelId))
          throw new MemoryWriteError('invalid_input', 'Model ID must be one line.');
        const provenance =
          source.kind === 'cli'
            ? `_Recorded ${date} via CLI._`
            : source.kind === 'agent'
              ? `_Recorded ${date} by the agent in session ${source.sessionId}._`
              : `_Summarized ${date} ${summaryMarker(source.sessionId)} (${source.turnCount} turns) by model ${source.modelId}._`;
        const entry = `## ${title}\n${input.body.trim().replace(/\r\n/gu, '\n')}\n\n${provenance}\n`;
        let recorded: { startLine: number; endLine: number } | undefined;
        const updated = await storage.update(
          `${input.file ?? 'notes'}.md`,
          (current) => {
            if (
              source.kind === 'session_summary' &&
              current.includes(summaryMarker(source.sessionId))
            )
              throw new MemoryWriteError(
                'duplicate',
                'This session is already summarized in that file; edit the existing entry instead.',
              );
            const base = current.replace(/\s*$/u, '');
            const next = base === '' ? entry : `${base}\n\n${entry}`;
            const startLine = next.slice(0, next.length - entry.length).split('\n').length;
            // Refuse before writing unless the file parses back with this as its last entry
            // (e.g. an existing unclosed code fence would swallow it).
            const parsed = parseMemoryEntries(next).at(-1);
            if (parsed === undefined || parsed.title !== title || parsed.startLine !== startLine)
              throw new MemoryWriteError(
                'invalid_input',
                'The existing note file would not keep this entry separate; fix the file or use another.',
              );
            recorded = parsed;
            return next;
          },
          input.signal === undefined ? {} : { signal: input.signal },
        );
        span.setAttributes({ success: true, bytes: Buffer.byteLength(entry, 'utf8') });
        return {
          scope: input.scope,
          path: updated.path,
          title,
          startLine: recorded!.startLine,
          endLine: recorded!.endLine,
        };
      } catch (error) {
        const failure =
          error instanceof MemoryWriteError
            ? error
            : error instanceof NoteStorageError
              ? new MemoryWriteError(
                  error.code === 'busy' || error.code === 'size_limit' || error.code === 'cancelled'
                    ? error.code
                    : 'storage_failed',
                  error.message,
                  { cause: new Error(error.code) },
                )
              : new MemoryWriteError('storage_failed', 'Memory could not be recorded.', {
                  cause: new Error('memory_write_failed'),
                });
        span.setAttributes({ success: false, 'error.type': failure.code });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw failure;
      } finally {
        span.setAttribute('duration_ms', performance.now() - started);
        span.end();
      }
    });
  }
}
