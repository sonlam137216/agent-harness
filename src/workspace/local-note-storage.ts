import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { TracingHandle } from '../observability/tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  isNoteFileName,
  NoteStorageError,
  type NoteStorage,
  type NoteUpdateResult,
} from './note-storage.js';

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export interface LocalNoteStorageOptions {
  /** Absolute containing root, e.g. the workspace or the user memory directory. */
  readonly root: string;
  /** Directory relative to `root` that holds the notes (`.` for the root itself). */
  readonly directory: string;
  readonly tracer: TracingHandle['tracer'];
  /** Limit for the complete file after an update. Matches the memory reader's default. */
  readonly maxBytes?: number;
}

/**
 * Local note storage. Creates the notes directory on first write, verifies its
 * canonical path stays under the root, serializes writers with a lock directory
 * and replaces files atomically. Containment is checked, not sandboxed.
 */
export class LocalNoteStorage implements NoteStorage {
  readonly #root: string;
  readonly #directory: string;
  readonly #tracer: TracingHandle['tracer'];
  readonly #maxBytes: number;

  public constructor(options: LocalNoteStorageOptions) {
    if (!isAbsolute(options.root)) throw new NoteStorageError('unsafe_path');
    if (
      options.directory === '' ||
      options.directory.startsWith('/') ||
      /[\\:\0]/u.test(options.directory) ||
      options.directory.split('/').includes('..')
    )
      throw new NoteStorageError('unsafe_path');
    this.#root = options.root;
    this.#directory = options.directory;
    this.#tracer = options.tracer;
    this.#maxBytes = options.maxBytes ?? 65_536;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1)
      throw new RangeError('maxBytes must be positive.');
  }

  public update(
    name: string,
    transform: (current: string) => string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<NoteUpdateResult> {
    return this.#tracer.startActiveSpan('workspace.operation', async (span) => {
      const started = performance.now();
      span.setAttribute('operation', 'notes.update');
      // The caller's own validation failure is its error, not a storage failure.
      let transformError: { readonly error: unknown } | undefined;
      const checkCancelled = (): void => {
        if (options.signal?.aborted === true) throw new NoteStorageError('cancelled');
      };
      try {
        if (!isNoteFileName(name)) throw new NoteStorageError('invalid_name');
        checkCancelled();
        const directory = await this.#prepareDirectory();
        const lock = join(directory, `.${name}.lock`);
        try {
          await mkdir(lock, { mode: 0o700 });
        } catch (error) {
          throw new NoteStorageError(code(error) === 'EEXIST' ? 'busy' : 'io_error', error);
        }
        let result: NoteUpdateResult;
        try {
          // Last cancellation point: once the lock is held the write completes.
          checkCancelled();
          const target = join(directory, name);
          const previous = await this.#read(target);
          let next: string;
          try {
            next = transform(previous);
          } catch (error) {
            transformError = { error };
            throw error;
          }
          const bytes = Buffer.byteLength(next, 'utf8');
          if (bytes > this.#maxBytes) throw new NoteStorageError('size_limit');
          await this.#writeAtomic(directory, target, next);
          const path = this.#directory === '.' ? name : `${this.#directory}/${name}`;
          result = { path: path.replace(/^\.\//u, ''), previous, next };
          span.setAttributes({ bytes_written: bytes });
        } finally {
          await rmdir(lock).catch(() => undefined);
        }
        span.setAttribute('success', true);
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        if (transformError !== undefined) {
          span.setAttributes({ success: false, 'error.type': 'transform_rejected' });
          throw transformError.error;
        }
        const failure =
          error instanceof NoteStorageError ? error : new NoteStorageError('io_error', error);
        span.setAttributes({ success: false, 'error.type': failure.code });
        throw failure;
      } finally {
        span.setAttribute('duration_ms', performance.now() - started);
        span.end();
      }
    });
  }

  async #prepareDirectory(): Promise<string> {
    try {
      await mkdir(this.#root, { recursive: true });
      const root = await realpath(this.#root);
      // Create one segment at a time, refusing symlinks, so nothing is created outside root.
      let candidate = root;
      for (const segment of this.#directory.split('/').filter((part) => part && part !== '.')) {
        candidate = join(candidate, segment);
        try {
          await mkdir(candidate);
        } catch (error) {
          if (code(error) !== 'EEXIST') throw error;
        }
        const info = await lstat(candidate);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new NoteStorageError('unsafe_path');
      }
      const canonical = await realpath(candidate);
      const inside = relative(root, canonical);
      if (inside.startsWith('..') || isAbsolute(inside) || inside.split(sep).includes('..'))
        throw new NoteStorageError('unsafe_path');
      return canonical;
    } catch (error) {
      if (error instanceof NoteStorageError) throw error;
      throw new NoteStorageError(code(error) === 'ENOENT' ? 'unsafe_path' : 'io_error', error);
    }
  }

  async #read(target: string): Promise<string> {
    let file;
    try {
      file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (code(error) === 'ENOENT') return '';
      throw new NoteStorageError(code(error) === 'ELOOP' ? 'unsafe_path' : 'io_error', error);
    }
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new NoteStorageError('unsafe_path');
      if (info.size > this.#maxBytes) throw new NoteStorageError('size_limit');
      return await file.readFile('utf8');
    } finally {
      await file.close();
    }
  }

  async #writeAtomic(directory: string, target: string, content: string): Promise<void> {
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o644);
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      const handle = await open(directory, constants.O_RDONLY);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
