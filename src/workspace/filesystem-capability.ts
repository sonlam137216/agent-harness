export interface FileSystemOperationOptions {
  readonly signal?: AbortSignal;
}

export interface ReadFileResult {
  /** Workspace-relative path using forward slashes. */
  readonly path: string;
  readonly content: string;
  readonly sizeBytes: number;
}

export type FileSystemEntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface FileSystemEntry {
  /** Workspace-relative path using forward slashes. */
  readonly path: string;
  readonly name: string;
  readonly kind: FileSystemEntryKind;
}

/**
 * Read-only access to paths beneath one configured workspace root.
 * Paths are workspace-relative; `.` addresses the workspace root.
 * Implementations must bound returned content and entry counts, reporting
 * `output_limit_exceeded` instead of returning unbounded or silently partial data.
 */
export interface FileSystemCapability {
  readonly readFile: (
    path: string,
    options?: FileSystemOperationOptions,
  ) => Promise<ReadFileResult>;
  readonly listDirectory: (
    path: string,
    options?: FileSystemOperationOptions,
  ) => Promise<readonly FileSystemEntry[]>;
}

export type FileSystemErrorCode =
  | 'outside_workspace'
  | 'not_found'
  | 'not_file'
  | 'not_directory'
  | 'output_limit_exceeded'
  | 'cancelled'
  | 'io_error';

export interface FileSystemErrorOptions {
  readonly code: FileSystemErrorCode;
  readonly requestedPath: string;
  readonly cause?: Error;
}

export class FileSystemError extends Error {
  public override readonly name = 'FileSystemError';
  public readonly code: FileSystemErrorCode;
  public readonly requestedPath: string;
  public override readonly cause: Error | undefined;

  public constructor(message: string, options: FileSystemErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.requestedPath = options.requestedPath;
    this.cause = options.cause;
  }
}
