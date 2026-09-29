import { spawn } from 'node:child_process';
import { lstat, mkdir, realpath, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';

import type { TracingHandle } from '../observability/tracing.js';
import {
  GitError,
  type GitDiffStat,
  type GitOperationOptions,
  type GitWorktreeCapability,
} from './git-worktree-capability.js';

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 16 * 1024;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const BRANCH = /^[a-z0-9][a-z0-9/_-]{0,127}$/u;

/**
 * Repository hooks, fsmonitor and signing are disabled so harness Git operations never run
 * repository-provided programs. The environment is an explicit allowlist.
 */
const SAFE_CONFIG = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'user.name=agent-harness',
  '-c',
  'user.email=agent-harness@localhost',
];

export interface LocalGitWorktreesOptions {
  readonly tracer: TracingHandle['tracer'];
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
  /** Defaults to `process.env`; only PATH and HOME are forwarded. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

interface GitRun {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly input?: string;
  readonly signal: AbortSignal | undefined;
  /** Exit codes treated as success; defaults to 0 only. */
  readonly accept?: readonly number[];
}

/** Repository-relative directory names that may be linked into a worktree. */
export function isLinkPath(path: string): boolean {
  const segments = path.split('/');
  return (
    /^[A-Za-z0-9._@+/-]{1,255}$/u.test(path) &&
    segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    !segments.some((segment) => segment.toLowerCase() === '.git')
  );
}

function requireAbsolute(path: string): void {
  if (!isAbsolute(path)) throw new GitError('git_failed', 'Git paths must be absolute.');
}
function requireCommit(value: string): string {
  if (!COMMIT.test(value)) throw new GitError('git_failed', 'Git returned an invalid commit.');
  return value;
}

export class LocalGitWorktrees implements GitWorktreeCapability {
  readonly #tracer: TracingHandle['tracer'];
  readonly #maxOutputBytes: number;
  readonly #timeoutMs: number;
  readonly #environment: Record<string, string>;

  public constructor(options: LocalGitWorktreesOptions) {
    this.#tracer = options.tracer;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    for (const [name, value] of [
      ['maxOutputBytes', this.#maxOutputBytes],
      ['timeoutMs', this.#timeoutMs],
    ] as const)
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError(`${name} must be a positive safe integer.`);
    const source = options.environment ?? process.env;
    this.#environment = {
      LC_ALL: 'C',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      ...(source.PATH === undefined ? {} : { PATH: source.PATH }),
      ...(source.HOME === undefined ? {} : { HOME: source.HOME }),
    };
  }

  public repositoryRoot(
    directory: string,
    options: GitOperationOptions = {},
  ): Promise<{ readonly root: string; readonly isTopLevel: boolean }> {
    return this.#operation('git.repository_root', async () => {
      requireAbsolute(directory);
      const result = await this.#git({
        args: ['rev-parse', '--show-toplevel', '--show-prefix'],
        cwd: directory,
        signal: options.signal,
      });
      const [root = '', prefix = ''] = result.stdout.split('\n');
      return { root: await realpath(root), isTopLevel: prefix === '' };
    });
  }

  public resolveCommit(
    repository: string,
    ref: string,
    options: GitOperationOptions = {},
  ): Promise<string> {
    return this.#operation('git.resolve_commit', async () => {
      requireAbsolute(repository);
      if (ref !== 'HEAD' && !COMMIT.test(ref) && !BRANCH.test(ref))
        throw new GitError('git_failed', 'Unsupported Git reference.');
      const result = await this.#git({
        args: ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`],
        cwd: repository,
        signal: options.signal,
      });
      return requireCommit(result.stdout.trim());
    });
  }

  public addWorktree(
    repository: string,
    worktree: {
      readonly path: string;
      readonly branch: string;
      readonly base: string;
      readonly links?: readonly string[];
    },
    options: GitOperationOptions = {},
  ): Promise<void> {
    return this.#operation('git.worktree_add', async () => {
      requireAbsolute(repository);
      requireAbsolute(worktree.path);
      if (!BRANCH.test(worktree.branch)) throw new GitError('git_failed', 'Invalid branch name.');
      const links = worktree.links ?? [];
      if (!links.every(isLinkPath)) throw new GitError('git_failed', 'Invalid linked path.');
      await this.#git({
        args: [
          'worktree',
          'add',
          '--quiet',
          '-b',
          worktree.branch,
          '--',
          worktree.path,
          requireCommit(worktree.base),
        ],
        cwd: repository,
        signal: options.signal,
      });
      for (const link of links) {
        const source = join(repository, link);
        const target = join(worktree.path, link);
        const info = await lstat(source).catch(() => undefined);
        // Only real directories of the main tree are linked; a checked-out path wins.
        if (info === undefined || !info.isDirectory()) continue;
        if ((await lstat(target).catch(() => undefined)) !== undefined) continue;
        await mkdir(dirname(target), { recursive: true });
        await symlink(source, target, 'dir');
      }
    });
  }

  public snapshot(
    worktree: string,
    message: string,
    exclude: readonly string[] = [],
    options: GitOperationOptions = {},
  ): Promise<string | undefined> {
    return this.#operation('git.snapshot', async () => {
      requireAbsolute(worktree);
      if (!exclude.every(isLinkPath)) throw new GitError('git_failed', 'Invalid excluded path.');
      await this.#git({
        args: ['add', '--all', '--', '.', ...exclude.map((path) => `:(exclude,literal)${path}`)],
        cwd: worktree,
        signal: options.signal,
      });
      const staged = await this.#git({
        args: ['diff', '--cached', '--quiet'],
        cwd: worktree,
        signal: options.signal,
        accept: [0, 1],
      });
      if (staged.code === 0) return undefined;
      await this.#git({
        args: ['commit', '--quiet', '--no-verify', '--file', '-'],
        cwd: worktree,
        input: message,
        signal: options.signal,
      });
      const head = await this.#git({
        args: ['rev-parse', 'HEAD'],
        cwd: worktree,
        signal: options.signal,
      });
      return requireCommit(head.stdout.trim());
    });
  }

  public diffStat(
    repository: string,
    base: string,
    head: string,
    options: GitOperationOptions = {},
  ): Promise<GitDiffStat> {
    return this.#operation('git.diff_stat', async () => {
      requireAbsolute(repository);
      const result = await this.#git({
        args: ['diff', '--numstat', '--no-renames', requireCommit(base), requireCommit(head)],
        cwd: repository,
        signal: options.signal,
      });
      let files = 0;
      let insertions = 0;
      let deletions = 0;
      for (const line of result.stdout.split('\n')) {
        const [added, removed] = line.split('\t');
        if (added === undefined || removed === undefined) continue;
        files += 1;
        // Binary files report "-" for both counts.
        insertions += Number(added) || 0;
        deletions += Number(removed) || 0;
      }
      return { files, insertions, deletions };
    });
  }

  public diff(
    repository: string,
    base: string,
    head: string,
    options: GitOperationOptions = {},
  ): Promise<string> {
    return this.#operation('git.diff', async () => {
      requireAbsolute(repository);
      const result = await this.#git({
        args: ['diff', '--binary', '--no-renames', requireCommit(base), requireCommit(head)],
        cwd: repository,
        signal: options.signal,
      });
      return result.stdout;
    });
  }

  public applyPatch(
    repository: string,
    patch: string,
    options: GitOperationOptions = {},
  ): Promise<void> {
    return this.#operation('git.apply', async () => {
      requireAbsolute(repository);
      if (patch === '') return;
      // `git apply` is atomic without --reject: every hunk applies or nothing changes.
      const result = await this.#git({
        args: ['apply', '--whitespace=nowarn', '-'],
        cwd: repository,
        input: patch,
        signal: options.signal,
        accept: [0, 1],
      });
      if (result.code !== 0)
        throw new GitError(
          'conflict',
          'The changes do not apply cleanly to the current working tree; nothing was changed.',
        );
    });
  }

  public removeWorktree(
    repository: string,
    path: string,
    options: GitOperationOptions = {},
  ): Promise<void> {
    return this.#operation('git.worktree_remove', async () => {
      requireAbsolute(repository);
      requireAbsolute(path);
      await this.#git({
        args: ['worktree', 'remove', '--force', '--', path],
        cwd: repository,
        signal: options.signal,
      });
    });
  }

  public deleteBranch(
    repository: string,
    branch: string,
    options: GitOperationOptions = {},
  ): Promise<void> {
    return this.#operation('git.branch_delete', async () => {
      requireAbsolute(repository);
      if (!BRANCH.test(branch)) throw new GitError('git_failed', 'Invalid branch name.');
      await this.#git({
        args: ['branch', '--quiet', '-D', '--', branch],
        cwd: repository,
        signal: options.signal,
      });
    });
  }

  #git(run: GitRun): Promise<{ readonly code: number; readonly stdout: string }> {
    return new Promise((resolve, reject) => {
      if (run.signal?.aborted === true) {
        reject(new GitError('cancelled', 'The Git operation was cancelled.'));
        return;
      }
      const child = spawn('git', [...SAFE_CONFIG, ...run.args], {
        cwd: run.cwd,
        env: this.#environment,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let failure: GitError | undefined;
      const stop = (error: GitError): void => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const timer = setTimeout(
        () => stop(new GitError('timeout', 'The Git operation timed out.')),
        this.#timeoutMs,
      );
      const abort = (): void => stop(new GitError('cancelled', 'The Git operation was cancelled.'));
      run.signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.#maxOutputBytes)
          stop(new GitError('output_limit_exceeded', 'Git output exceeded the configured limit.'));
        else stdout.push(chunk);
      });
      // stderr may contain paths; it is bounded and never surfaced.
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > MAX_STDERR_BYTES) child.stderr.removeAllListeners('data');
      });
      child.stdin.on('error', () => undefined);
      child.stdin.end(run.input ?? '');
      child.on('error', (error: NodeJS.ErrnoException) => {
        failure ??=
          error.code === 'ENOENT'
            ? new GitError('git_unavailable', 'Git is not installed or not on PATH.', error)
            : new GitError('git_failed', 'Git could not be started.', error);
      });
      child.on('close', (exitCode) => {
        clearTimeout(timer);
        run.signal?.removeEventListener('abort', abort);
        if (failure !== undefined) return reject(failure);
        const code = exitCode ?? -1;
        if (!(run.accept ?? [0]).includes(code)) {
          const notRepository = run.args[0] === 'rev-parse' && code === 128;
          return reject(
            new GitError(
              notRepository ? 'not_repository' : 'git_failed',
              notRepository
                ? 'The directory is not inside a Git repository.'
                : `Git ${run.args[0]} failed.`,
            ),
          );
        }
        resolve({ code, stdout: Buffer.concat(stdout).toString('utf8') });
      });
    });
  }

  #operation<T>(operation: string, run: () => Promise<T>): Promise<T> {
    return this.#tracer.startActiveSpan('workspace.operation', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({ 'workspace.type': 'local', operation });
      try {
        const result = await run();
        span.setAttribute('success', true);
        return result;
      } catch (error) {
        const normalized =
          error instanceof GitError ? error : new GitError('git_failed', 'Git failed.', error);
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
