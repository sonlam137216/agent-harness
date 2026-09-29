# Phase 11 — Sandbox

Phase 11 adds an environment boundary **below** the permission layer. An `implement`
subagent can run programs (tests, builds) with `run_command`, and the operating system
confines every process it starts. The process can write only inside its worktree and a
private temporary directory, cannot use the network, cannot read the user's home
directory (apart from the toolchain and explicit read paths), and receives only
allowlisted environment variables. The first backend is macOS Seatbelt (`sandbox-exec`).
The policy interface is backend-independent, so container or remote backends can be
added later.

## Problem and placement

Permissions decide whether the harness *starts* a tool call. They cannot limit what a
started program does: `pnpm test` runs arbitrary package scripts, and any allowed program
can spawn a shell. The sandbox bounds the effects of the whole process tree, so a
restricted session cannot bypass the policy by executing shell commands directly.

```text
implement child (worktree)
  → ToolBridge → PermissionEngine (execute allowed only in worktree children)
    → run_command tool
      → CommandCapability (Workspace port)
        → SeatbeltCommandRunner
            SandboxPolicy (paths, commands, environment, limits)
            → seatbeltProfile(policy)  → /usr/bin/sandbox-exec -p <profile> -- <program> <args>
```

`src/workspace/command-capability.ts` is the narrow port. `src/workspace/sandbox/` holds
`sandbox-policy.ts` (backend-independent policy, command and environment rules),
`seatbelt-profile.ts` (a pure policy-to-profile translation) and
`seatbelt-command-runner.ts` (process execution and toolchain detection). Runtime,
AgentLoop, ToolBridge, ContextBuilder and PermissionEngine are unchanged. The parent
agent is never offered `run_command`, and no command runs without the sandbox: if the
sandbox is unavailable, the run fails before the first model call.

## Opt in

```sh
pnpm cli -- --provider ollama --model <model-id> \
  --subagents --worktrees --sandbox --worktree-link node_modules \
  "Fix the failing parser test and run the test suite."
```

| Flag | Meaning |
| --- | --- |
| `--sandbox` | Offer `run_command` to implement children (requires `--worktrees`, macOS) |
| `--sandbox-command <name>` | Add an allowed command (repeatable) |
| `--worktree-link <path>` | Link a main-tree directory read-only into each worktree (repeatable) |

The default command allowlist is `node`, `npm`, `npx`, `pnpm`, `yarn`, `python3`, `make`.

A worktree is a fresh checkout without ignored directories such as `node_modules`, and
installs need the network, which is denied. `--worktree-link node_modules` symlinks the
main tree's directory into each checkout so tests can resolve dependencies. The link is
excluded from every snapshot, so it is never committed. The sandbox makes its target
readable but not writable, and `write_file` refuses to write through it.

## run_command

`run_command { command, args?, cwd?, timeoutSeconds? }` (`accessKind: 'execute'`):

- `command` is a bare allowlisted name (`pnpm`, not `/usr/bin/…`, `./x` or `a; b`). There
  is no shell: pipes, redirects and globbing are not interpreted. Up to 64 arguments of up
  to 4096 characters each.
- `cwd` is a directory inside the worktree (default `.`).
- `timeoutSeconds` is 1–600 (default 120). On timeout or cancellation the whole process
  group is killed with SIGKILL, and background descendants are killed when the command
  exits.
- The result is `{ exitCode, signal, timedOut, durationMs, stdout, stderr,
  stdoutTruncated, stderrTruncated }`, with the last 16 KiB of each stream. A non-zero
  exit is a successful tool result carrying the exit code. Refusals (`command_not_allowed`,
  `invalid_cwd`, `invalid_arguments`) and start failures are error results.

The runner adds an `execute` allow rule only inside worktree children, next to the Phase
10 `write` rule. Parent rules still win: `--deny-tool run_command`, or an `ask` rule
(children have no approval handler), blocks it.

## Policy

```ts
interface SandboxPolicy {
  root: string;               // worktree: readable, writable, only cwd tree
  readPaths: string[];        // toolchain, linked dependency targets
  privatePaths: string[];     // home directory: unreadable unless re-allowed
  protectedPaths: string[];   // <worktree>/.git: never writable
  network: 'deny';
  commands: string[];         // bare allowlisted names
  environment: { allow: string[]; set: Record<string, string> };
  defaultTimeoutMs; maxTimeoutMs; maxOutputBytes;
}
```

| Rule | Enforcement |
| --- | --- |
| Reads | System readable; home private; worktree, per-command temp dir, toolchain and linked targets re-allowed |
| Writes | Worktree (minus its `.git` link), temp dir, `/dev/null`, `/dev/zero`, `/dev/tty`, `/dev/fd/*` |
| Network | Denied (no network rule is ever emitted; DNS and direct IP both fail) |
| Processes | Fork/exec allowed, all descendants inherit the sandbox; signals only within it |
| Mach services | Only user lookup, notifications and logging (no resolver, launch services or Apple events) |
| Environment | `PATH`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM` copied; `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`; `HOME`/`TMPDIR` = private temp dir |
| Commands | Top-level program must be a bare allowlisted name; no shell |

Each command gets a fresh temporary directory, which is also its `HOME`, removed
afterwards. API keys and other host variables are never passed. Paths are canonicalized
before the profile is built (Seatbelt matches real paths, e.g. `/private/var`). Paths
containing quotes, backslashes, newlines or `..` are rejected, so they cannot alter the
profile.

**Toolchain detection.** Every absolute `PATH` entry is readable, and for each allowed
command found on `PATH` the install prefix of its real executable is readable too (e.g.
`~/.local/share/fnm/node-versions/v22/installation`). A version-managed Node inside the
home directory therefore works while the rest of the home directory stays private.

## Limits and non-goals

- The command allowlist restricts only the **first** program. Allowed programs can run
  others (package scripts, shells), and the OS policy is what confines them. Tests cover
  an allowed `sh` that tries to write outside, read a private file and write inside.
- Paths outside the home directory (e.g. `/etc`, other volumes) are readable. Add
  sensitive locations to `privatePaths` if they matter.
- Seatbelt is macOS-only, and Apple marks `sandbox-exec` deprecated, though it works on
  macOS 15. Other platforms get a clear startup error. A container backend can implement
  the same `SandboxPolicy` later.
- Parent-level commands, MCP stdio servers and the harness's own Git operations are not
  sandboxed in this phase. The model still has no command access outside implement
  children.
- CPU and memory limits are not enforced; only time and output are bounded.

## Observability

Each command is a `workspace.operation` span with `operation=sandbox.command`,
`sandbox.backend=seatbelt`, `command.name` (from the allowlist), `command.exit_code`,
`command.timed_out`, stdout/stderr truncation, `success`, `error.type` and `duration_ms`.
Arguments, output, paths and environment values are never recorded. `run_command` calls
also produce the usual `tool.execute` span and permission decision.

## Verification

```sh
pnpm exec vitest run test/sandbox
pnpm validate
```

`test/sandbox/sandbox.test.ts` runs real `sandbox-exec` (skipped on non-macOS hosts).

- **Policy:** path, command and limit validation; bare-name command rules; the
  environment allowlist (API keys removed); and deny-by-default profile rendering.
- **Runner:** writes inside the root; refused writes outside it and into `.git`; private
  files unreadable while explicit read paths work, with the real home directory private
  and the detected toolchain usable; direct-IP network blocked; host secrets absent; an
  allowed shell unable to escape; command, cwd and timeout refusals; timeout kill;
  cancellation; tail-preserving truncation; and span redaction.
- **Subagents:** an implement child builds a file from a linked dependency, but cannot
  write to the main repository or through the linked `node_modules`. Only the built file
  is snapshotted (the link is excluded). `run_command` is absent for the parent and
  without `--sandbox`, and the flags are validated.

## Later, when needed

A Docker/container backend and a remote backend behind the same policy, sandboxing MCP
stdio servers, opt-in network egress rules, CPU and memory limits, and a
`workspace_command_failures_total` metric.
