# Phase 10 — Worktrees and Isolation

Phase 10 lets independent agents modify code safely. An `implement` subagent edits files
only inside its own disposable Git worktree and branch. When it ends, its work is
committed to that branch. The user reviews the diff and applies it to the main working
tree with a CLI command. Two children can therefore change the same file at the same
time without sharing working-tree state. The parent agent and the user's working tree
are never written by the model.

## Problem and placement

Phase 9 children are read-only because several agents editing one working tree would
overwrite each other and mix unreviewed changes into the user's files. A worktree gives
each editing child a private checkout of the last commit and a private branch.

```text
CLI composition (--subagents --worktrees)
  → SubagentRunner (implement role)
    → IsolatedWorkspaceProvider port  ── implemented in cli/worktree-cli.ts
        → WorktreeManager (src/worktrees: lifecycle, records, apply/remove rules)
            → GitWorktreeCapability (Workspace: narrow git operations)
            → RecordStorage        (Workspace: lifecycle records)
        → child tools rooted at the checkout:
            read_file / list_files / search_text → FileSystemCapability(worktree)
            write_file / edit_file              → FileWriteCapability(worktree)

CLI `worktrees list|diff|apply|remove` → WorktreeManager
```

A "GitWorktreeWorkspace" is therefore not a new class. It is the existing Workspace
capabilities bound to a worktree root, plus the Git capability that creates and snapshots
that root. Runtime, AgentLoop, ToolBridge, ContextBuilder and the permission engine are
unchanged.

## Opt in

```sh
pnpm cli -- --provider ollama --model <model-id> --subagents --worktrees \
  "Add input validation to parseSessionCommand and explain the change."
```

| Flag | Meaning |
| --- | --- |
| `--worktrees` | Also offer the `implement` role (requires `--subagents`) |
| `--worktree-dir <path>` | Checkouts (`trees/`) and records (`records/`); default `~/.agent-harness/worktrees` |

The workspace must be the **top level of a Git repository with at least one commit**, and
the worktree directory must be outside it. The run checks both before the first model
call and fails with `not_repository_root` / `invalid_directory` otherwise. Without
`--worktrees`, `implement` is not listed in `delegate_task`.

## The implement role

`delegate_task { role: "implement", task, background? }` creates worktree `<id>` (the
subagent ID) at `<worktree-dir>/trees/<id>`, on branch `agent-harness/<id>` from the
current `HEAD`. The checkout starts from the last commit, so uncommitted changes in the
main working tree are **not** visible to the child. The child then runs with
`read_file`, `list_files`, `search_text`, `write_file` and `edit_file`, all rooted at the
checkout, and a 12-iteration limit. It cannot run commands or tests. Its session's
`workspaceRoot` is the checkout path.

- `write_file { path, content }` creates or replaces a UTF-8 file (≤ 1,000,000
  characters) and creates parent directories.
- `edit_file { path, oldText, newText }` replaces exactly one occurrence. A missing
  (`no_match`) or repeated (`ambiguous_match`) `oldText` changes nothing.

Both are `write` tools. Inside an implement child the runner adds an allow rule for
`write` access, because the writes cannot reach the main tree until the user applies them.
Parent rules still win: `--deny-tool write_file` (or an `ask` rule, since children have no
approval handler) blocks them. Shared roles (`explore`, `plan`, `review`) stay read-only,
and the parent is never offered write tools.

When the child ends for any reason (completed, failed, iteration or token limit,
cancelled), the harness commits everything in the checkout to its branch. Partial work is
kept, not discarded. The handoff adds:

```json
"worktree": { "id": "…", "branch": "agent-harness/…",
              "changes": { "files": 1, "insertions": 3, "deletions": 1 } }
```

`changes` is absent if the final commit failed; the files are still in the checkout.

## Reviewing and applying

```sh
pnpm cli -- worktrees list [--all]         # ready/applied records; --all includes removed
pnpm cli -- worktrees diff <id>            # binary-safe patch base..snapshot
pnpm cli -- worktrees apply <id>           # apply to the main working tree
pnpm cli -- worktrees remove <id> [--force]
```

All commands accept `--workspace <path>` and `--worktree-dir <path>`.

| Status | Meaning |
| --- | --- |
| `active` | Created; a child may still be writing, or its process died |
| `ready` | Snapshot committed; changes known |
| `applied` | Applied to the main working tree |
| `removed` | Checkout and branch deleted; record kept for history |

- **apply** runs `git apply` of the base..snapshot patch in the main working tree. It is
  atomic: either every hunk applies or nothing changes (`conflict`), including files that
  would have applied cleanly. Changes land in the working tree only; nothing is staged or
  committed. Applying twice is refused (`already_applied`).
- **remove** deletes the checkout and the branch. It refuses `ready` records with changes
  (`unapplied_changes`) and `active` records (`active`) unless `--force`, so cleanup never
  silently loses unreviewed work. With `--force`, a checkout or branch already deleted by
  hand is tolerated.
- **diff/apply** of an `active` record are refused, with the checkout path for manual
  inspection. An interrupted run's changes stay in that checkout until removed with
  `--force`.

Records live under `<worktree-dir>/records` and are scoped by canonical repository root,
so one directory can serve several repositories. Mutating operations take a per-record
lock, and contention fails as `busy`.

## Git safety

`GitWorktreeCapability` is a fixed set of operations: repository root, resolve commit,
worktree add/remove, snapshot, diff stat, diff, apply and branch delete. It is not a
generic `git` escape hatch, and only the application chooses its arguments (absolute
paths, validated branch names and commit IDs). `LocalGitWorktrees` runs `git` directly
without a shell, with:

- `core.hooksPath=/dev/null`, `core.fsmonitor=false` and `commit.gpgSign=false`, so
  repository hooks and helpers never run. Commits use the identity
  `agent-harness <agent-harness@localhost>` and `--no-verify`;
- an environment allowlist (`PATH`, `HOME`, `LC_ALL=C`, `GIT_TERMINAL_PROMPT=0`,
  `GIT_CONFIG_NOSYSTEM=1`);
- a 60 s timeout, cancellation (SIGKILL), 4 MiB stdout limit, and bounded, never-surfaced
  stderr.

Content filters configured in the user's Git configuration (e.g. LFS) still run on
checkout and add. This is not a sandbox: see Phase 11.

`LocalFileWriter` refuses absolute paths, empty/`.`/`..` segments, any `.git` segment
(`protected_path`), symlinked parent segments or targets, and non-file targets. It creates
parents one segment at a time and replaces files atomically (temporary file, fsync,
rename). Content is limited to 1 MiB.

Worktree creation writes the `active` record before running `git worktree add`, so no
checkout or branch can exist untracked. Once started, the checkout is allowed to finish
instead of being killed partway. If it fails, the harness cleans up best-effort and marks
the record `removed`.

## Observability

- `worktree.operation` (create/finalize/apply/remove) records `worktree.id`, resulting
  status, changed files, insertions, deletions, `success` and a normalized `error.type`.
- Every Git call is a nested `workspace.operation` (`git.worktree_add`, `git.snapshot`,
  `git.apply`, …). Writes are `filesystem.write_file` with `bytes_written` and
  `filesystem.created`.
- `subagent.spawn` adds `subagent.worktree_id`, `subagent.changed_files` or
  `subagent.snapshot_failed`.

Paths, branch names, patch text and file contents are never recorded.

## Verification

```sh
pnpm exec vitest run test/worktrees
pnpm validate
```

`test/worktrees/worktrees.test.ts` uses real Git repositories in temporary directories.
It covers:

- **Writes:** contained writes and every refused target (nothing written outside), and
  exact-match editing.
- **Setup checks:** a repository top level is required, and the worktree directory must
  be outside the repository.
- **Lifecycle:** create, snapshot, diff, refused remove, apply (unstaged), refused
  re-apply, then remove.
- **Conflicts:** an atomic conflict refusal that leaves non-conflicting files untouched,
  and protection of `active` records.
- **Hooks:** repository hooks never run.
- **Exit criteria:** two background implement children edit the same line differently.
  The main tree stays unchanged, each checkout holds its own variant, and applying one
  then refuses the other as a conflict.
- **CLI and runtime:** `implement` is offered only with `--worktrees`, parent deny rules
  apply, a cancelled child's partial work is kept, and the run fails before sampling
  when the workspace cannot host worktrees. Flags and command parsing are covered too.

## Later, when needed

Running tests inside a worktree (needs command execution and ideally Phase 11
sandboxing), a three-way merge that can resolve some conflicts, bringing uncommitted
main-tree changes into a checkout, automatic cleanup policies, and a parent-facing
worktree inspection tool.
