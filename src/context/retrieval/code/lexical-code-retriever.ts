import { SpanStatusCode } from '@opentelemetry/api';
import { createCancellationScope, waitForCallback } from '../../../cancellation.js';
import { SamplingError } from '../../../model/sampling-types.js';
import type { TracingHandle } from '../../../observability/tracing.js';
import {
  FileSystemError,
  type FileSystemCapability,
} from '../../../workspace/filesystem-capability.js';
import {
  checkContextCancellation,
  ContextError,
  countTokens,
  positiveInteger,
} from '../../context-budget.js';
import {
  excludedDirectory,
  normalizedDirectory,
  retrievalRoots,
  within,
  type CodeCandidate,
  type CodeRetriever,
  type CodeRetrievalInput,
  type CodeRetrievalResult,
  type PartialReason,
  type SelectionLimit,
} from './code-retriever.js';

const STOP_WORDS = new Set(
  'a an and are as at be by can code do does explain file files for from how i in is it of on or please show source that the their this to use what when where which with would'.split(
    ' ',
  ),
);
function terms(text: string): string[] {
  return [
    ...new Set(
      text
        .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
        .toLowerCase()
        .match(/[a-z][a-z\d]{1,63}/gu) ?? [],
    ),
  ].filter((word) => !STOP_WORDS.has(word));
}
const codeFile = (name: string) =>
  !name.startsWith('.') &&
  !/(?:^|[._-])(secret|secrets|credentials)(?:[._-]|$)/iu.test(name) &&
  /\.(?:[cm]?jsx?|tsx?|py|go|rs|java|kt|swift|rb|[ch]|cpp|hpp|cs|php|sh|sql|vue|svelte)$/iu.test(
    name,
  );
const compare = (a: CodeCandidate, b: CodeCandidate) =>
  b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.startLine - b.startLine);

export interface LexicalCodeOptions {
  readonly roots: readonly string[];
  readonly rulesDirectory?: string;
  readonly maxFiles?: number;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
  readonly maxFileBytes?: number;
  readonly maxCandidates?: number;
  readonly maxDurationMs?: number;
}

export class LexicalCodeRetriever implements CodeRetriever {
  readonly #roots: readonly string[];
  readonly #scope: string;
  readonly #limits;
  public constructor(
    private readonly files: FileSystemCapability,
    private readonly tracer: TracingHandle['tracer'],
    options: LexicalCodeOptions,
  ) {
    this.#scope = normalizedDirectory(options.rulesDirectory ?? '.');
    this.#roots = retrievalRoots(options.roots, this.#scope);
    this.#limits = {
      files: options.maxFiles ?? 128,
      entries: options.maxEntries ?? 2000,
      bytes: options.maxBytes ?? 1_048_576,
      fileBytes: options.maxFileBytes ?? 65_536,
      candidates: options.maxCandidates ?? 128,
      duration: options.maxDurationMs ?? 500,
    };
    for (const [name, value] of Object.entries(this.#limits)) positiveInteger(name, value);
  }

  public async retrieve(input: CodeRetrievalInput): Promise<CodeRetrievalResult> {
    return this.tracer.startActiveSpan('retrieval.code', async (span) => {
      const started = performance.now();
      const deadline = Math.min(input.deadlineMs ?? Infinity, Date.now() + this.#limits.duration);
      const cancellation = createCancellationScope(input.signal, deadline);
      const partial = new Set<PartialReason>();
      const limited = new Set<SelectionLimit>();
      const candidates: CodeCandidate[] = [];
      let filesConsidered = 0;
      let bytesRead = 0;
      let entriesVisited = 0;
      span.setAttributes({
        'session.id': input.sessionId,
        'turn.id': input.turnId,
        'model_call.id': input.modelCallId,
        retriever: 'lexical',
        'cache.enabled': false,
      });
      try {
        checkContextCancellation(input);
        const allTerms = terms(input.query.slice(0, 4096));
        if (input.query.length > 4096 || allTerms.length > 32) partial.add('query');
        const query = new Set(allTerms.slice(0, 32));
        // Walk from the workspace root, inspecting each directory segment rather
        // than following a user-selected symlink root or an unloaded rules scope.
        const queue = query.size === 0 ? [] : ['.'];
        const reached = new Set<string>();
        while (queue.length > 0) {
          checkContextCancellation(input);
          if (performance.now() - started >= this.#limits.duration) {
            partial.add('time');
            break;
          }
          const directory = queue.shift()!;
          let entries;
          try {
            entries = [
              ...(await waitForCallback(
                () => this.files.listDirectory(directory, { signal: cancellation.signal! }),
                cancellation.signal,
              )),
            ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
          } catch (error) {
            if (error instanceof FileSystemError && error.code === 'output_limit_exceeded') {
              partial.add('directory_size');
              continue;
            }
            throw error;
          }
          checkContextCancellation(input);
          if (
            within(directory, this.#scope) &&
            directory !== this.#scope &&
            entries.some((entry) => entry.name === 'AGENTS.md')
          ) {
            partial.add('nested_rules');
            continue;
          }
          if (this.#roots.includes(directory)) reached.add(directory);
          for (const entry of entries) {
            checkContextCancellation(input);
            if (performance.now() - started >= this.#limits.duration) {
              partial.add('time');
              break;
            }
            if (++entriesVisited > this.#limits.entries) {
              partial.add('entries');
              break;
            }
            const relevant = this.#roots.some(
              (root) => within(entry.path, root) || within(root, entry.path),
            );
            if (!relevant) continue;
            if (entry.kind === 'symlink') {
              if (this.#roots.some((root) => within(root, entry.path)))
                throw new ContextError(
                  'source_failed',
                  'A retrieval root cannot contain a symlink.',
                );
              continue;
            }
            if (entry.kind === 'directory') {
              if (!excludedDirectory(entry.name)) queue.push(entry.path);
              continue;
            }
            if (
              entry.kind !== 'file' ||
              !this.#roots.some((root) => within(entry.path, root)) ||
              !codeFile(entry.name)
            )
              continue;
            if (filesConsidered >= this.#limits.files) {
              partial.add('files');
              break;
            }
            if (bytesRead >= this.#limits.bytes) {
              partial.add('bytes');
              break;
            }
            filesConsidered += 1;
            let file;
            const remaining = this.#limits.bytes - bytesRead;
            try {
              file = await waitForCallback(
                () =>
                  this.files.readFile(entry.path, {
                    signal: cancellation.signal!,
                    maxBytes: Math.min(remaining, this.#limits.fileBytes),
                  }),
                cancellation.signal,
              );
            } catch (error) {
              if (error instanceof FileSystemError && error.code === 'output_limit_exceeded') {
                partial.add(remaining < this.#limits.fileBytes ? 'bytes' : 'file_size');
                continue;
              }
              throw error;
            }
            checkContextCancellation(input);
            bytesRead += file.sizeBytes;
            // Reject canonical aliases (including symlink races) before selection.
            if (file.path !== entry.path)
              throw new ContextError(
                'source_failed',
                'A retrieval source changed its canonical path.',
              );
            if (file.content.includes('\0')) continue;
            const pathHits = terms(file.path).filter((term) => query.has(term)).length;
            const lines = file.content.split(/\r?\n/u);
            let previousEnd = -1;
            for (let index = 0; index < lines.length; index += 1) {
              checkContextCancellation(input);
              if (performance.now() - started >= this.#limits.duration) {
                partial.add('time');
                break;
              }
              if (index <= previousEnd) continue;
              const hits = terms(lines[index]!).filter((term) => query.has(term)).length;
              if (hits === 0 && !(index === 0 && pathHits > 0)) continue;
              const start = Math.max(previousEnd + 1, index - 2);
              const end = Math.min(lines.length - 1, index + 2);
              let content = '';
              let last = start - 1;
              for (let line = start; line <= end; line += 1) {
                const next = content + (line === start ? '' : '\n') + lines[line]!;
                if (next.length > 1800) {
                  limited.add('snippet');
                  break;
                }
                content = next;
                last = line;
              }
              previousEnd = Math.max(index, last);
              if (last < index || content.trim() === '') continue;
              candidates.push({
                path: file.path,
                startLine: start + 1,
                endLine: last + 1,
                content,
                score: terms(content).filter((term) => query.has(term)).length * 4 + pathHits * 2,
                estimatedTokens: countTokens(input.counter, content),
              });
              candidates.sort(compare);
              if (candidates.length > this.#limits.candidates) {
                candidates.pop();
                limited.add('candidates');
              }
            }
          }
          if (
            partial.has('entries') ||
            partial.has('files') ||
            partial.has('bytes') ||
            partial.has('time')
          )
            break;
        }
        checkContextCancellation(input);
        if (query.size > 0 && partial.size === 0 && this.#roots.some((root) => !reached.has(root)))
          throw new ContextError(
            'source_failed',
            'A configured retrieval root is missing or is not a directory.',
          );
        span.setAttribute('success', true);
      } catch (error) {
        let failure = error;
        try {
          checkContextCancellation(input);
        } catch (cancelled) {
          failure = cancelled;
        }
        if (
          !(failure instanceof SamplingError) &&
          cancellation.deadlineReached() &&
          !(failure instanceof ContextError) &&
          (!(failure instanceof FileSystemError) || failure.code === 'cancelled')
        ) {
          partial.add('time');
          span.setAttribute('success', true);
        } else {
          span.setAttributes({
            success: false,
            'error.type': failure instanceof SamplingError ? failure.code : 'source_failed',
          });
          span.setStatus({ code: SpanStatusCode.ERROR });
          if (failure instanceof ContextError || failure instanceof SamplingError) throw failure;
          throw new ContextError(
            'source_failed',
            'Code retrieval could not read its configured scope safely.',
            {
              cause: new Error(error instanceof FileSystemError ? error.code : 'retrieval_failed'),
            },
          );
        }
      } finally {
        cancellation.dispose();
        span.setAttributes({
          candidates: candidates.length,
          files_considered: filesConsidered,
          bytes_read: bytesRead,
          entries_visited: entriesVisited,
          partial: partial.size > 0,
          partial_reasons: [...partial],
          selection_limits: [...limited],
          duration_ms: performance.now() - started,
        });
        span.end();
      }
      return {
        candidates,
        partialReasons: [...partial],
        selectionLimits: [...limited],
        filesConsidered,
        bytesRead,
      };
    });
  }
}
