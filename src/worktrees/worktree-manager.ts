import { isAbsolute, join, relative, sep } from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';

import type { TracingHandle } from '../observability/tracing.js';
import {
  GitError,
  type GitDiffStat,
  type GitWorktreeCapability,
} from '../workspace/git-worktree-capability.js';
import { validRecordKey, type RecordStorage } from '../workspace/record-storage.js';

/** active: a child may still be writing; ready: snapshot committed; applied / removed: final. */
export type WorktreeStatus = 'active' | 'ready' | 'applied' | 'removed';

export interface WorktreeRecord {
  readonly id: string;
  readonly repositoryRoot: string;
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly status: WorktreeStatus;
  readonly changes: GitDiffStat;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentSessionId?: string;
  readonly sessionId?: string;
}

export type WorktreeErrorCode =
  | 'not_repository_root'
  | 'invalid_directory'
  | 'not_found'
  | 'invalid_record'
  | 'active'
  | 'not_ready'
  | 'already_applied'
  | 'unapplied_changes';

export class WorktreeError extends Error {
  public override readonly name = 'WorktreeError';
  public readonly retryable = false;
  public constructor(
    public readonly code: WorktreeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface WorktreeManagerOptions {
  readonly git: GitWorktreeCapability;
  /** Application-owned records; never exposed to model-facing tools. */
  readonly records: RecordStorage;
  /** Absolute top-level directory of the repository whose changes are isolated. */
  readonly repositoryRoot: string;
  /** Absolute directory for worktree checkouts; must be outside the repository. */
  readonly worktreeDirectory: string;
  readonly tracer: TracingHandle['tracer'];
}

const STATUSES: readonly WorktreeStatus[] = ['active', 'ready', 'applied', 'removed'];
const ZERO: GitDiffStat = { files: 0, insertions: 0, deletions: 0 };

function decode(content: string, id: string): WorktreeRecord {
  const invalid = (): never => {
    throw new WorktreeError('invalid_record', 'The saved worktree record is invalid.');
  };
  let document: unknown;
  try {
    document = JSON.parse(content);
  } catch {
    invalid();
  }
  const record = (document as { version?: unknown; worktree?: Record<string, unknown> } | null)
    ?.worktree;
  if ((document as { version?: unknown }).version !== 1 || typeof record !== 'object' || !record)
    return invalid();
  for (const key of ['id', 'repositoryRoot', 'path', 'branch', 'baseCommit', 'headCommit'])
    if (typeof record[key] !== 'string' || record[key] === '') invalid();
  const changes = record.changes as Record<string, unknown> | undefined;
  if (
    record.id !== id ||
    !STATUSES.includes(record.status as WorktreeStatus) ||
    typeof changes !== 'object' ||
    !['files', 'insertions', 'deletions'].every((key) => Number.isSafeInteger(changes[key]))
  )
    invalid();
  return record as unknown as WorktreeRecord;
}

function encode(record: WorktreeRecord): string {
  return JSON.stringify({ version: 1, worktree: record });
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/**
 * Lifecycle of disposable worktrees: one branch per child, a snapshot commit when the child
 * ends, and user-driven apply/remove that never discards unapplied changes without force.
 */
export class WorktreeManager {
  readonly #git: GitWorktreeCapability;
  readonly #records: RecordStorage;
  readonly #repositoryRoot: string;
  readonly #directory: string;
  readonly #tracer: TracingHandle['tracer'];
  #verified: Promise<string> | undefined;

  public constructor(options: WorktreeManagerOptions) {
    if (!isAbsolute(options.repositoryRoot) || !isAbsolute(options.worktreeDirectory))
      throw new TypeError('Worktree paths must be absolute.');
    this.#git = options.git;
    this.#records = options.records;
    this.#repositoryRoot = options.repositoryRoot;
    this.#directory = options.worktreeDirectory;
    this.#tracer = options.tracer;
  }

  /** Confirms the workspace is a repository top level and checkouts land outside it. */
  public verify(signal?: AbortSignal): Promise<string> {
    this.#verified ??= (async () => {
      let repository: { readonly root: string; readonly isTopLevel: boolean };
      try {
        repository = await this.#git.repositoryRoot(
          this.#repositoryRoot,
          signal === undefined ? {} : { signal },
        );
      } catch (error) {
        if (error instanceof GitError && error.code === 'not_repository')
          throw new WorktreeError(
            'not_repository_root',
            'Worktrees require a Git repository workspace.',
          );
        throw error;
      }
      const root = repository.root;
      if (!repository.isTopLevel)
        throw new WorktreeError(
          'not_repository_root',
          'Worktrees require the workspace to be the repository top level.',
        );
      if (isInside(root, this.#directory) || isInside(this.#repositoryRoot, this.#directory))
        throw new WorktreeError(
          'invalid_directory',
          'The worktree directory must be outside the repository.',
        );
      return root;
    })();
    const verified = this.#verified;
    verified.catch(() => {
      if (this.#verified === verified) this.#verified = undefined;
    });
    return verified;
  }

  public create(
    input: { readonly id: string; readonly parentSessionId?: string },
    signal?: AbortSignal,
  ): Promise<WorktreeRecord> {
    return this.#span('create', input.id, async () => {
      if (!validRecordKey(input.id)) throw new WorktreeError('not_found', 'Invalid worktree ID.');
      const options = signal === undefined ? {} : { signal };
      const repositoryRoot = await this.verify(signal);
      const base = await this.#git.resolveCommit(repositoryRoot, 'HEAD', options);
      const now = new Date().toISOString();
      const record: WorktreeRecord = {
        id: input.id,
        repositoryRoot,
        path: join(this.#directory, 'trees', input.id),
        branch: `agent-harness/${input.id}`,
        baseCommit: base,
        headCommit: base,
        status: 'active',
        changes: ZERO,
        createdAt: now,
        updatedAt: now,
        ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      };
      // Record first so no checkout or branch can exist untracked, then let the checkout
      // finish: killing `git worktree add` midway could leave a half-created worktree.
      await this.#records.writeAtomic(record.id, encode(record));
      try {
        await this.#git.addWorktree(repositoryRoot, {
          path: record.path,
          branch: record.branch,
          base,
        });
      } catch (error) {
        await this.#git.removeWorktree(repositoryRoot, record.path).catch(() => undefined);
        await this.#git.deleteBranch(repositoryRoot, record.branch).catch(() => undefined);
        await this.#records.writeAtomic(
          record.id,
          encode({ ...record, status: 'removed', updatedAt: new Date().toISOString() }),
        );
        throw error;
      }
      return record;
    });
  }

  /** Commits whatever the child wrote. Deliberately ignores cancellation so work is kept. */
  public finalize(
    id: string,
    input: { readonly sessionId?: string } = {},
  ): Promise<WorktreeRecord> {
    return this.#span('finalize', id, () =>
      this.#update(id, async (record) => {
        if (record.status !== 'active')
          throw new WorktreeError('not_ready', 'Only an active worktree can be finalized.');
        const head =
          (await this.#git.snapshot(record.path, `agent-harness: changes from worktree ${id}`)) ??
          record.baseCommit;
        const changes =
          head === record.baseCommit
            ? ZERO
            : await this.#git.diffStat(record.repositoryRoot, record.baseCommit, head);
        return {
          ...record,
          headCommit: head,
          changes,
          status: 'ready',
          ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        };
      }),
    );
  }

  /** Records for this repository, newest first; removed ones only when asked. */
  public async list(
    options: { readonly includeRemoved?: boolean } = {},
  ): Promise<readonly WorktreeRecord[]> {
    const root = await this.verify();
    const records: WorktreeRecord[] = [];
    for (const key of await this.#records.listKeys()) {
      const content = await this.#records.read(key);
      if (content === undefined) continue;
      const record = decode(content, key);
      if (record.repositoryRoot !== root) continue;
      if (record.status === 'removed' && options.includeRemoved !== true) continue;
      records.push(record);
    }
    return records.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
  }

  public async get(id: string): Promise<WorktreeRecord> {
    const root = await this.verify();
    const content = validRecordKey(id) ? await this.#records.read(id) : undefined;
    const record = content === undefined ? undefined : decode(content, id);
    if (record === undefined || record.repositoryRoot !== root)
      throw new WorktreeError('not_found', 'No worktree with this ID exists for this repository.');
    return record;
  }

  public async diff(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ record: WorktreeRecord; patch: string }> {
    const record = await this.get(id);
    if (record.status === 'active' || record.status === 'removed')
      throw new WorktreeError(
        'not_ready',
        record.status === 'active'
          ? `The worktree is still active or its run was interrupted; inspect ${record.path} directly.`
          : 'The worktree was removed.',
      );
    const patch =
      record.headCommit === record.baseCommit
        ? ''
        : await this.#git.diff(
            record.repositoryRoot,
            record.baseCommit,
            record.headCommit,
            signal === undefined ? {} : { signal },
          );
    return { record, patch };
  }

  /** Applies the snapshot to the main working tree atomically; refuses on conflict. */
  public apply(id: string, signal?: AbortSignal): Promise<WorktreeRecord> {
    return this.#span('apply', id, () =>
      this.#update(id, async (record) => {
        if (record.status === 'applied')
          throw new WorktreeError('already_applied', 'These changes were already applied.');
        if (record.status !== 'ready')
          throw new WorktreeError('not_ready', 'Only a finished worktree can be applied.');
        if (record.headCommit !== record.baseCommit) {
          const options = signal === undefined ? {} : { signal };
          const patch = await this.#git.diff(
            record.repositoryRoot,
            record.baseCommit,
            record.headCommit,
            options,
          );
          await this.#git.applyPatch(record.repositoryRoot, patch, options);
        }
        return { ...record, status: 'applied' };
      }),
    );
  }

  /** Deletes the checkout and branch. Unapplied or active work needs `force`. */
  public remove(id: string, options: { readonly force?: boolean } = {}): Promise<WorktreeRecord> {
    return this.#span('remove', id, () =>
      this.#update(id, async (record) => {
        const force = options.force === true;
        if (record.status === 'removed')
          throw new WorktreeError('not_found', 'The worktree was already removed.');
        if (record.status === 'active' && !force)
          throw new WorktreeError(
            'active',
            'The worktree may still be in use; pass --force to remove it.',
          );
        if (record.status === 'ready' && record.changes.files > 0 && !force)
          throw new WorktreeError(
            'unapplied_changes',
            'The worktree has unapplied changes; apply them or pass --force to discard them.',
          );
        for (const step of [
          () => this.#git.removeWorktree(record.repositoryRoot, record.path),
          () => this.#git.deleteBranch(record.repositoryRoot, record.branch),
        ]) {
          try {
            await step();
          } catch (error) {
            // A checkout or branch deleted by hand is already gone; only force tolerates it.
            if (!force || !(error instanceof GitError) || error.code !== 'git_failed') throw error;
          }
        }
        return { ...record, status: 'removed' };
      }),
    );
  }

  async #update(
    id: string,
    change: (record: WorktreeRecord) => Promise<WorktreeRecord>,
  ): Promise<WorktreeRecord> {
    await this.get(id);
    return this.#records.withLock(id, async () => {
      const next = { ...(await change(await this.get(id))), updatedAt: new Date().toISOString() };
      await this.#records.writeAtomic(id, encode(next));
      return next;
    });
  }

  #span(
    operation: string,
    id: string,
    run: () => Promise<WorktreeRecord>,
  ): Promise<WorktreeRecord> {
    return this.#tracer.startActiveSpan('worktree.operation', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({ 'worktree.operation': operation, 'worktree.id': id });
      try {
        const record = await run();
        span.setAttributes({
          success: true,
          'worktree.status': record.status,
          'worktree.changed_files': record.changes.files,
          'worktree.insertions': record.changes.insertions,
          'worktree.deletions': record.changes.deletions,
        });
        return record;
      } catch (error) {
        span.setAttributes({
          success: false,
          'error.type':
            error instanceof WorktreeError || error instanceof GitError
              ? error.code
              : 'worktree_error',
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.setAttribute('duration_ms', performance.now() - startedAt);
        span.end();
      }
    });
  }
}
