import type { FileSystemOperationOptions } from './filesystem-capability.js';

export interface WriteFileResult {
  /** Workspace-relative path using forward slashes. */
  readonly path: string;
  readonly sizeBytes: number;
  readonly created: boolean;
}

/**
 * Whole-file UTF-8 writes beneath one root. Implementations must keep writes contained
 * (no absolute paths, `..`, symlinks or Git metadata), bound content size and replace
 * files atomically. Failures are `FileSystemError`s. Phase 10 binds this capability only
 * to disposable Git worktrees, never to the user's main working tree.
 */
export interface FileWriteCapability {
  readonly writeFile: (
    path: string,
    content: string,
    options?: FileSystemOperationOptions,
  ) => Promise<WriteFileResult>;
}
