import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { TracingHandle } from '../observability/tracing.js';
import type { IsolatedWorkspaceProvider } from '../subagents/subagent-runner.js';
import { EditFileTool } from '../tools/builtin/edit-file.tool.js';
import { ListFilesTool } from '../tools/builtin/list-files.tool.js';
import { ReadFileTool } from '../tools/builtin/read-file.tool.js';
import { SearchTextTool } from '../tools/builtin/search-text.tool.js';
import { WriteFileTool } from '../tools/builtin/write-file.tool.js';
import { validRecordKey } from '../workspace/record-storage.js';
import { LocalFileSystemCapability } from '../workspace/local-file-system.js';
import { LocalFileWriter } from '../workspace/local-file-writer.js';
import { LocalGitWorktrees } from '../workspace/local-git-worktrees.js';
import { LocalRecordStorage } from '../workspace/local-record-storage.js';
import { WorktreeManager } from '../worktrees/worktree-manager.js';
import { RunCommandTool } from '../tools/builtin/run-command.tool.js';
import { SeatbeltCommandRunner } from '../workspace/sandbox/seatbelt-command-runner.js';
import { CliUsageError } from './phase-one-cli.js';

export const DEFAULT_WORKTREE_DIRECTORY = join(homedir(), '.agent-harness', 'worktrees');

/** Checkouts live in `<directory>/trees`, lifecycle records in `<directory>/records`. */
export function createWorktreeManager(
  workspaceRoot: string,
  worktreeDirectory: string,
  tracer: TracingHandle['tracer'],
  environment?: Readonly<Record<string, string | undefined>>,
  linkedPaths?: readonly string[],
): WorktreeManager {
  return new WorktreeManager({
    git: new LocalGitWorktrees({ tracer, ...(environment === undefined ? {} : { environment }) }),
    records: new LocalRecordStorage(join(worktreeDirectory, 'records')),
    repositoryRoot: workspaceRoot,
    worktreeDirectory,
    tracer,
    ...(linkedPaths === undefined ? {} : { linkedPaths }),
  });
}

export interface WorktreeSandboxSettings {
  /** Allowlisted bare command names. */
  readonly commands: readonly string[];
  /** Readable toolchain directories (see detectToolchainPaths). */
  readonly toolchainPaths: readonly string[];
  /** Never readable except where re-allowed; normally the user's home directory. */
  readonly privatePaths: readonly string[];
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

/**
 * Binds each implement child to its own worktree with tools rooted inside the checkout.
 * With sandbox settings, it also gets run_command, confined by a per-worktree policy.
 */
export function createWorktreeProvider(
  manager: WorktreeManager,
  tracer: TracingHandle['tracer'],
  sandbox?: WorktreeSandboxSettings,
): IsolatedWorkspaceProvider {
  return {
    create: async ({ subagentId, parentSessionId }, signal) => {
      const record = await manager.create({ id: subagentId, parentSessionId }, signal);
      const files = new LocalFileSystemCapability({ workspaceRoot: record.path, tracer });
      const writer = new LocalFileWriter({ root: record.path, tracer });
      const commands =
        sandbox === undefined
          ? []
          : [
              new RunCommandTool(
                new SeatbeltCommandRunner({
                  tracer,
                  ...(sandbox.environment === undefined
                    ? {}
                    : { environment: sandbox.environment }),
                  policy: {
                    root: record.path,
                    readPaths: [
                      ...sandbox.toolchainPaths,
                      // Linked dependencies resolve into the main tree: readable, not writable.
                      ...(record.linkedPaths ?? []).map((path) =>
                        join(record.repositoryRoot, path),
                      ),
                    ],
                    privatePaths: sandbox.privatePaths,
                    protectedPaths: [join(record.path, '.git')],
                    network: 'deny',
                    commands: sandbox.commands,
                    environment: {
                      allow: ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'],
                      set: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
                    },
                    defaultTimeoutMs: 120_000,
                    maxTimeoutMs: 600_000,
                    maxOutputBytes: 16_384,
                  },
                }),
              ),
            ];
      return {
        id: record.id,
        branch: record.branch,
        root: record.path,
        tools: [
          new ReadFileTool(files),
          new ListFilesTool(files),
          new SearchTextTool(files),
          new WriteFileTool(writer),
          new EditFileTool(files, writer),
          ...commands,
        ],
      };
    },
    finalize: async (id, { sessionId }) =>
      (await manager.finalize(id, sessionId === undefined ? {} : { sessionId })).changes,
  };
}

export type WorktreeCommand = {
  readonly workspaceRoot: string;
  readonly worktreeDirectory: string;
} & (
  | { readonly kind: 'list'; readonly all: boolean }
  | { readonly kind: 'diff'; readonly id: string }
  | { readonly kind: 'apply'; readonly id: string }
  | { readonly kind: 'remove'; readonly id: string; readonly force: boolean }
);

/** Returns undefined when the arguments are not a `worktrees` command. */
export function parseWorktreeCommand(
  arguments_: readonly string[],
  cwd: string,
): WorktreeCommand | undefined {
  const args = arguments_.filter((argument) => argument !== '--');
  if (args[0] !== 'worktrees') return undefined;
  let workspaceRoot = cwd;
  let worktreeDirectory = DEFAULT_WORKTREE_DIRECTORY;
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--workspace' || argument === '--worktree-dir') {
      const value = args[++index];
      if (value === undefined || value.startsWith('--'))
        throw new CliUsageError(`${argument} requires a value.`);
      if (argument === '--workspace') workspaceRoot = resolve(cwd, value);
      else worktreeDirectory = resolve(cwd, value);
    } else if (argument === '--all' || argument === '--force') flags.add(argument);
    else if (argument.startsWith('-')) throw new CliUsageError(`Unknown option: ${argument}`);
    else positional.push(argument);
  }
  const [kind, id, ...extra] = positional;
  const base = { workspaceRoot, worktreeDirectory };
  const usage = new CliUsageError(
    'Use worktrees list [--all], worktrees diff <id>, worktrees apply <id>, or worktrees remove <id> [--force].',
  );
  if (extra.length > 0) throw usage;
  if (kind === 'list' && id === undefined && !flags.has('--force'))
    return { ...base, kind, all: flags.has('--all') };
  if (kind !== 'diff' && kind !== 'apply' && kind !== 'remove') throw usage;
  if (id === undefined || !validRecordKey(id)) throw new CliUsageError('Provide a worktree ID.');
  if (flags.has('--all') || (flags.has('--force') && kind !== 'remove')) throw usage;
  return kind === 'remove'
    ? { ...base, kind, id, force: flags.has('--force') }
    : { ...base, kind, id };
}

export async function runWorktreeCommand(
  command: WorktreeCommand,
  manager: WorktreeManager,
  writeOutput: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (command.kind === 'list') {
    const records = await manager.list({ includeRemoved: command.all });
    writeOutput(
      JSON.stringify(
        records.map(
          ({ id, status, branch, path, changes, createdAt, parentSessionId, sessionId }) => ({
            id,
            status,
            branch,
            path,
            changes,
            createdAt,
            ...(parentSessionId === undefined ? {} : { parentSessionId }),
            ...(sessionId === undefined ? {} : { sessionId }),
          }),
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (command.kind === 'diff') {
    const { patch } = await manager.diff(command.id, signal);
    writeOutput(patch === '' ? 'No changes.' : patch.trimEnd());
    return;
  }
  if (command.kind === 'apply') {
    const record = await manager.apply(command.id, signal);
    writeOutput(
      `Applied ${record.changes.files} changed file(s) from worktree ${record.id} to the working tree (not staged).`,
    );
    return;
  }
  const record = await manager.remove(command.id, { force: command.force });
  writeOutput(`Removed worktree ${record.id} and branch ${record.branch}.`);
}
