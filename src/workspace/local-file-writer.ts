import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';

import type { TracingHandle } from '../observability/tracing.js';
import type { FileWriteCapability, WriteFileResult } from './file-write-capability.js';
import { FileSystemError, type FileSystemOperationOptions } from './filesystem-capability.js';

const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024;

export interface LocalFileWriterOptions {
  /** Absolute root, e.g. a disposable worktree. */
  readonly root: string;
  readonly tracer: TracingHandle['tracer'];
  readonly maxWriteBytes?: number;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Creates parent directories one segment at a time and refuses any symlinked segment or
 * target, so nothing is created or replaced outside the root. Containment, not a sandbox.
 */
export class LocalFileWriter implements FileWriteCapability {
  readonly #root: string;
  readonly #tracer: TracingHandle['tracer'];
  readonly #maxBytes: number;

  public constructor(options: LocalFileWriterOptions) {
    if (!isAbsolute(options.root)) throw new TypeError('root must be an absolute path.');
    this.#maxBytes = options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0)
      throw new RangeError('maxWriteBytes must be a positive safe integer.');
    this.#root = options.root;
    this.#tracer = options.tracer;
  }

  public readonly writeFile = (
    requestedPath: string,
    content: string,
    options: FileSystemOperationOptions = {},
  ): Promise<WriteFileResult> =>
    this.#tracer.startActiveSpan('workspace.operation', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({ 'workspace.type': 'local', operation: 'filesystem.write_file' });
      const fail = (
        errorCode: 'outside_workspace' | 'protected_path' | 'not_file' | 'size_limit',
        message: string,
      ): never => {
        throw new FileSystemError(message, { code: errorCode, requestedPath });
      };
      try {
        const segments = requestedPath.split('/');
        if (
          requestedPath === '' ||
          isAbsolute(requestedPath) ||
          /[\\\0]/u.test(requestedPath) ||
          segments.some((segment) => segment === '' || segment === '.' || segment === '..')
        )
          fail('outside_workspace', 'Write paths must be plain workspace-relative file paths.');
        if (segments.some((segment) => segment.toLowerCase() === '.git'))
          fail('protected_path', 'Git metadata cannot be written.');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > this.#maxBytes) fail('size_limit', 'The content exceeds the write limit.');
        this.#checkCancelled(requestedPath, options.signal);

        let directory = await realpath(this.#root);
        for (const segment of segments.slice(0, -1)) {
          directory = join(directory, segment);
          try {
            await mkdir(directory);
          } catch (error) {
            if (code(error) !== 'EEXIST') throw error;
          }
          const info = await lstat(directory);
          if (info.isSymbolicLink() || !info.isDirectory())
            fail('outside_workspace', 'A parent path segment is not a plain directory.');
        }
        const target = join(directory, segments.at(-1)!);
        let created = false;
        try {
          const info = await lstat(target);
          if (info.isSymbolicLink() || !info.isFile())
            fail('not_file', 'The target exists and is not a regular file.');
        } catch (error) {
          if (code(error) !== 'ENOENT') throw error;
          created = true;
        }
        // Last cancellation point: once the temporary file exists the write completes.
        this.#checkCancelled(requestedPath, options.signal);
        const temporary = join(directory, `.${randomUUID()}.tmp`);
        try {
          const file = await open(
            temporary,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
            0o644,
          );
          try {
            await file.writeFile(content, 'utf8');
            await file.sync();
          } finally {
            await file.close();
          }
          await rename(temporary, target);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
        span.setAttributes({ success: true, bytes_written: bytes, 'filesystem.created': created });
        return { path: requestedPath, sizeBytes: bytes, created };
      } catch (error) {
        const normalized =
          error instanceof FileSystemError
            ? error
            : new FileSystemError('The filesystem write failed.', {
                code: code(error) === 'ENOENT' ? 'not_found' : 'io_error',
                requestedPath,
                ...(error instanceof Error ? { cause: error } : {}),
              });
        span.setAttributes({ success: false, 'error.type': normalized.code });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw normalized;
      } finally {
        span.setAttribute('duration_ms', performance.now() - startedAt);
        span.end();
      }
    });

  #checkCancelled(requestedPath: string, signal: AbortSignal | undefined): void {
    if (signal?.aborted === true)
      throw new FileSystemError('The filesystem operation was cancelled.', {
        code: 'cancelled',
        requestedPath,
      });
  }
}
