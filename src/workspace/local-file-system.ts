import { isAbsolute, relative, resolve, sep } from 'node:path';
import { open, opendir, realpath } from 'node:fs/promises';

import { SpanStatusCode } from '@opentelemetry/api';

import type { TracingHandle } from '../observability/tracing.js';
import {
  FileSystemError,
  type FileSystemCapability,
  type FileSystemEntry,
  type FileSystemEntryKind,
  type FileSystemOperationOptions,
  type ReadFileResult,
} from './filesystem-capability.js';

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 1_000;

export interface LocalFileSystemOptions {
  /** Absolute repository/workspace root. */
  readonly workspaceRoot: string;
  readonly tracer: TracingHandle['tracer'];
  readonly maxReadBytes?: number;
  readonly maxDirectoryEntries?: number;
}

interface NodeError extends Error {
  readonly code?: string;
}

function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }

  return value;
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) && pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`))
  );
}

function toWorkspacePath(root: string, target: string): string {
  const pathFromRoot = relative(root, target);
  return pathFromRoot === '' ? '.' : pathFromRoot.split(sep).join('/');
}

function entryKind(entry: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileSystemEntryKind {
  if (entry.isFile()) return 'file';
  if (entry.isDirectory()) return 'directory';
  if (entry.isSymbolicLink()) return 'symlink';
  return 'other';
}

function causeOptions(error: unknown): { readonly cause?: Error } {
  return error instanceof Error ? { cause: error } : {};
}

export class LocalFileSystemCapability implements FileSystemCapability {
  readonly #workspaceRoot: string;
  readonly #tracer: TracingHandle['tracer'];
  readonly #maxReadBytes: number;
  readonly #maxDirectoryEntries: number;

  public constructor(options: LocalFileSystemOptions) {
    if (!isAbsolute(options.workspaceRoot)) {
      throw new TypeError('workspaceRoot must be an absolute path.');
    }

    this.#workspaceRoot = resolve(options.workspaceRoot);
    this.#tracer = options.tracer;
    this.#maxReadBytes = requirePositiveInteger(
      options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
      'maxReadBytes',
    );
    this.#maxDirectoryEntries = requirePositiveInteger(
      options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES,
      'maxDirectoryEntries',
    );
  }

  public readonly readFile = async (
    requestedPath: string,
    options: FileSystemOperationOptions = {},
  ): Promise<ReadFileResult> =>
    this.#withOperation('filesystem.read_file', requestedPath, options.signal, async (span) => {
      const { root, target } = await this.#resolveContainedPath(requestedPath, options.signal);
      const file = await open(target, 'r');

      try {
        this.#throwIfCancelled(requestedPath, options.signal);
        const stats = await file.stat();
        if (!stats.isFile()) {
          throw new FileSystemError('The requested path is not a file.', {
            code: 'not_file',
            requestedPath,
          });
        }
        if (stats.size > this.#maxReadBytes) {
          throw new FileSystemError('The requested file exceeds the configured read limit.', {
            code: 'output_limit_exceeded',
            requestedPath,
          });
        }

        const buffer = Buffer.alloc(this.#maxReadBytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          this.#throwIfCancelled(requestedPath, options.signal);
          const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (chunk.bytesRead === 0) break;
          bytesRead += chunk.bytesRead;
        }
        this.#throwIfCancelled(requestedPath, options.signal);

        if (bytesRead > this.#maxReadBytes) {
          throw new FileSystemError('The requested file exceeds the configured read limit.', {
            code: 'output_limit_exceeded',
            requestedPath,
          });
        }

        span.setAttribute('filesystem.bytes_read', bytesRead);
        return {
          path: toWorkspacePath(root, target),
          content: buffer.subarray(0, bytesRead).toString('utf8'),
          sizeBytes: bytesRead,
        };
      } finally {
        await file.close();
      }
    });

  public readonly listDirectory = async (
    requestedPath: string,
    options: FileSystemOperationOptions = {},
  ): Promise<readonly FileSystemEntry[]> =>
    this.#withOperation(
      'filesystem.list_directory',
      requestedPath,
      options.signal,
      async (span) => {
        const { root, target } = await this.#resolveContainedPath(requestedPath, options.signal);
        const directory = await opendir(target);

        try {
          const entries: FileSystemEntry[] = [];
          while (true) {
            this.#throwIfCancelled(requestedPath, options.signal);
            const entry = await directory.read();
            if (entry === null) break;
            if (entries.length === this.#maxDirectoryEntries) {
              throw new FileSystemError(
                'The requested directory exceeds the configured entry limit.',
                {
                  code: 'output_limit_exceeded',
                  requestedPath,
                },
              );
            }

            entries.push({
              path: toWorkspacePath(root, resolve(target, entry.name)),
              name: entry.name,
              kind: entryKind(entry),
            });
          }
          this.#throwIfCancelled(requestedPath, options.signal);
          entries.sort((left, right) => left.name.localeCompare(right.name));
          span.setAttribute('filesystem.entry_count', entries.length);
          return entries;
        } finally {
          await directory.close();
        }
      },
    );

  async #resolveContainedPath(
    requestedPath: string,
    signal: AbortSignal | undefined,
  ): Promise<{ root: string; target: string }> {
    this.#throwIfCancelled(requestedPath, signal);
    if (isAbsolute(requestedPath)) {
      throw new FileSystemError('Absolute paths are outside the workspace path contract.', {
        code: 'outside_workspace',
        requestedPath,
      });
    }

    const candidate = resolve(this.#workspaceRoot, requestedPath);
    if (!isWithinRoot(this.#workspaceRoot, candidate)) {
      throw new FileSystemError('The requested path escapes the configured workspace root.', {
        code: 'outside_workspace',
        requestedPath,
      });
    }

    const [root, target] = await Promise.all([realpath(this.#workspaceRoot), realpath(candidate)]);
    this.#throwIfCancelled(requestedPath, signal);
    if (!isWithinRoot(root, target)) {
      throw new FileSystemError('The requested path resolves outside the workspace root.', {
        code: 'outside_workspace',
        requestedPath,
      });
    }

    return { root, target };
  }

  #throwIfCancelled(requestedPath: string, signal: AbortSignal | undefined): void {
    if (signal?.aborted === true) {
      throw new FileSystemError('The filesystem operation was cancelled.', {
        code: 'cancelled',
        requestedPath,
      });
    }
  }

  #normalizeError(
    error: unknown,
    requestedPath: string,
    signal: AbortSignal | undefined,
  ): FileSystemError {
    if (error instanceof FileSystemError) return error;
    if (signal?.aborted === true) {
      return new FileSystemError('The filesystem operation was cancelled.', {
        code: 'cancelled',
        requestedPath,
        ...causeOptions(error),
      });
    }

    const code = (error as NodeError | undefined)?.code;
    if (code === 'ENOENT') {
      return new FileSystemError('The requested path does not exist.', {
        code: 'not_found',
        requestedPath,
        ...causeOptions(error),
      });
    }
    if (code === 'ENOTDIR') {
      return new FileSystemError('The requested path is not a directory.', {
        code: 'not_directory',
        requestedPath,
        ...causeOptions(error),
      });
    }
    if (code === 'EISDIR') {
      return new FileSystemError('The requested path is not a file.', {
        code: 'not_file',
        requestedPath,
        ...causeOptions(error),
      });
    }

    return new FileSystemError('The filesystem operation failed.', {
      code: 'io_error',
      requestedPath,
      ...causeOptions(error),
    });
  }

  async #withOperation<T>(
    operation: string,
    requestedPath: string,
    signal: AbortSignal | undefined,
    run: (span: ReturnType<TracingHandle['tracer']['startSpan']>) => Promise<T>,
  ): Promise<T> {
    return this.#tracer.startActiveSpan('workspace.operation', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({
        'workspace.type': 'local',
        operation,
      });

      try {
        const result = await run(span);
        span.setAttribute('success', true);
        return result;
      } catch (error) {
        const normalized = this.#normalizeError(error, requestedPath, signal);
        span.setAttributes({ success: false, 'error.type': normalized.code });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw normalized;
      } finally {
        span.setAttribute('duration_ms', performance.now() - startedAt);
        span.end();
      }
    });
  }
}
