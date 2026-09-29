export interface GitOperationOptions {
  readonly signal?: AbortSignal;
}

export interface GitDiffStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

/**
 * The narrow Git surface needed for disposable worktrees; deliberately not a generic
 * `git(...)` escape hatch. Repository and worktree arguments are absolute paths chosen by
 * the application, never by the model. Failures are `GitError`s.
 */
export interface GitWorktreeCapability {
  /** Canonical top level of the repository containing `directory`, and whether it is that level. */
  repositoryRoot(
    directory: string,
    options?: GitOperationOptions,
  ): Promise<{ readonly root: string; readonly isTopLevel: boolean }>;
  resolveCommit(repository: string, ref: string, options?: GitOperationOptions): Promise<string>;
  addWorktree(
    repository: string,
    worktree: { readonly path: string; readonly branch: string; readonly base: string },
    options?: GitOperationOptions,
  ): Promise<void>;
  /** Commits every change in the worktree; returns the commit, or undefined when clean. */
  snapshot(
    worktree: string,
    message: string,
    options?: GitOperationOptions,
  ): Promise<string | undefined>;
  diffStat(
    repository: string,
    base: string,
    head: string,
    options?: GitOperationOptions,
  ): Promise<GitDiffStat>;
  /** Binary-safe patch from `base` to `head`, bounded by the adapter's output limit. */
  diff(
    repository: string,
    base: string,
    head: string,
    options?: GitOperationOptions,
  ): Promise<string>;
  /** Applies all hunks to the working tree or none (`conflict`); never touches the index. */
  applyPatch(repository: string, patch: string, options?: GitOperationOptions): Promise<void>;
  removeWorktree(repository: string, path: string, options?: GitOperationOptions): Promise<void>;
  deleteBranch(repository: string, branch: string, options?: GitOperationOptions): Promise<void>;
}

export type GitErrorCode =
  | 'not_repository'
  | 'conflict'
  | 'output_limit_exceeded'
  | 'cancelled'
  | 'timeout'
  | 'git_unavailable'
  | 'git_failed';

export class GitError extends Error {
  public override readonly name = 'GitError';
  public readonly retryable = false;
  public constructor(
    public readonly code: GitErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
