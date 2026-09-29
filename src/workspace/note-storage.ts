export interface NoteUpdateResult {
  /** Path relative to the storage's containing root, using forward slashes. */
  readonly path: string;
  readonly previous: string;
  readonly next: string;
}

/**
 * Locked read-modify-write of Markdown notes in one directory. This is a narrow
 * application-owned capability for memory notes, not a general file write: names
 * are flat `*.md` files and paths cannot leave the configured directory. An error
 * thrown by `transform` propagates unchanged and nothing is written.
 */
export interface NoteStorage {
  readonly update: (
    name: string,
    transform: (current: string) => string,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<NoteUpdateResult>;
}

export type NoteStorageErrorCode =
  'invalid_name' | 'unsafe_path' | 'size_limit' | 'busy' | 'cancelled' | 'io_error';

export class NoteStorageError extends Error {
  public override readonly name = 'NoteStorageError';
  public readonly retryable = false;
  public constructor(
    public readonly code: NoteStorageErrorCode,
    cause?: unknown,
  ) {
    super(
      code === 'busy'
        ? 'Another writer holds this note file. Retry after it finishes.'
        : code === 'size_limit'
          ? 'The note file would exceed its size limit; use another file.'
          : `Note storage operation failed (${code}).`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export const isNoteFileName = (name: string): boolean =>
  /^[a-z0-9][a-z0-9_-]{0,63}\.md$/u.test(name);
