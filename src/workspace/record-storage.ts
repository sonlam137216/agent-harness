/** Application-owned records; never expose this capability to model-facing tools. */
export interface RecordStorage {
  read(key: string): Promise<string | undefined>;
  writeAtomic(key: string, content: string): Promise<void>;
  listKeys(): Promise<readonly string[]>;
  withLock<T>(key: string, run: () => Promise<T>): Promise<T>;
}

export type RecordStorageErrorCode =
  'invalid_key' | 'invalid_root' | 'unsafe_file' | 'size_limit' | 'busy' | 'io_error';
export class RecordStorageError extends Error {
  public override readonly name = 'RecordStorageError';
  public readonly retryable = false;
  public constructor(
    public readonly code: RecordStorageErrorCode,
    cause?: unknown,
  ) {
    super(
      code === 'busy'
        ? 'This session is locked. Stop other users before clearing a stale lock.'
        : `Session storage operation failed (${code}).`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export function validRecordKey(key: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(key);
}
