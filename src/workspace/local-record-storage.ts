import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { RecordStorageError, validRecordKey, type RecordStorage } from './record-storage.js';

const MAX_BYTES = 16 * 1024 * 1024;
function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Flat UUID namespace under a private application directory, with no symlink following. */
export class LocalRecordStorage implements RecordStorage {
  public constructor(
    private readonly directory: string,
    private readonly maxBytes = MAX_BYTES,
  ) {
    if (!isAbsolute(directory)) throw new RecordStorageError('invalid_root');
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
      throw new RangeError('maxBytes must be positive.');
  }
  #key(key: string): void {
    if (!validRecordKey(key)) throw new RecordStorageError('invalid_key');
  }
  async #root(create: boolean): Promise<string | undefined> {
    try {
      if (create) await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new RecordStorageError('invalid_root');
      return await realpath(this.directory);
    } catch (error) {
      if (!create && code(error) === 'ENOENT') return undefined;
      throw error instanceof RecordStorageError ? error : new RecordStorageError('io_error', error);
    }
  }
  public async read(key: string): Promise<string | undefined> {
    this.#key(key);
    const root = await this.#root(false);
    if (root === undefined) return undefined;
    try {
      const file = await open(
        join(root, `${key}.json`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new RecordStorageError('unsafe_file');
        if (info.size > this.maxBytes) throw new RecordStorageError('size_limit');
        const buffer = Buffer.alloc(Math.min(info.size + 1, this.maxBytes + 1));
        let offset = 0;
        while (offset < buffer.length) {
          const result = await file.read(buffer, offset, buffer.length - offset, null);
          if (result.bytesRead === 0) break;
          offset += result.bytesRead;
        }
        if (offset > info.size || offset > this.maxBytes)
          throw new RecordStorageError('size_limit');
        return buffer.subarray(0, offset).toString('utf8');
      } finally {
        await file.close();
      }
    } catch (error) {
      if (code(error) === 'ENOENT') return undefined;
      throw error instanceof RecordStorageError
        ? error
        : new RecordStorageError(code(error) === 'ELOOP' ? 'unsafe_file' : 'io_error', error);
    }
  }
  public async writeAtomic(key: string, content: string): Promise<void> {
    this.#key(key);
    if (Buffer.byteLength(content, 'utf8') > this.maxBytes)
      throw new RecordStorageError('size_limit');
    const root = (await this.#root(true))!;
    const target = join(root, `${key}.json`);
    const temporary = join(root, `.${key}.${randomUUID()}.tmp`);
    try {
      try {
        if (!(await lstat(target)).isFile()) throw new RecordStorageError('unsafe_file');
      } catch (error) {
        if (code(error) !== 'ENOENT') throw error;
      }
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(content, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, target);
      const directory = await open(root, constants.O_RDONLY);
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      throw error instanceof RecordStorageError ? error : new RecordStorageError('io_error', error);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  public async listKeys(): Promise<readonly string[]> {
    const root = await this.#root(false);
    if (root === undefined) return [];
    try {
      const entries = await opendir(root);
      const keys: string[] = [];
      let count = 0;
      for await (const entry of entries) {
        if (++count > 10_000) throw new RecordStorageError('size_limit');
        if (entry.name.endsWith('.json') && validRecordKey(entry.name.slice(0, -5)))
          keys.push(entry.name.slice(0, -5));
      }
      return keys.sort();
    } catch (error) {
      throw error instanceof RecordStorageError ? error : new RecordStorageError('io_error', error);
    }
  }
  public async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    this.#key(key);
    const root = (await this.#root(true))!;
    const lock = join(root, `.${key}.lock`);
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error) {
      throw new RecordStorageError(code(error) === 'EEXIST' ? 'busy' : 'io_error', error);
    }
    let failed = false;
    try {
      return await run();
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        await rmdir(lock);
      } catch (error) {
        if (!failed) throw new RecordStorageError('io_error', error);
      }
    }
  }
}
