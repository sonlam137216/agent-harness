# Phase 4 — Persistent Sessions

Phase 4 uses a versioned JSON file store. CLI runs now survive process exit, and the same
SessionRuntime/AgentLoop path serves new and resumed sessions. No new dependency or database is
required. Native tools remain read-only; application-owned session writes are not model-facing tools.

## CLI

```sh
# Create a persistent session; its ID is printed to stderr.
pnpm cli -- --provider ollama --model YOUR_MODEL --workspace /path/to/project "Inspect the project"

# Restore the saved workspace, agent/model, provider, context budget and rules directory.
pnpm cli -- --resume SESSION_ID "Continue the previous work"

# These commands require neither a model nor provider credentials.
pnpm cli -- sessions list
pnpm cli -- sessions show SESSION_ID
pnpm cli -- sessions rewind SESSION_ID --keep-turns 2
```

The default data directory is `~/.agent-harness/sessions`. Every command accepts
`--session-dir /absolute/or/relative/path`. Relative paths resolve from the current directory.
`--resume` starts a new user turn; it does not replay the previous turn. Saved configuration is the
default, and explicit model/provider/budget/rules flags can override it. A resumed session cannot
silently switch workspace; start a new session for another workspace. Permissions are configured
fresh for the invocation. Saved files never grant approval or carry provider credentials.

`sessions list` shows IDs, timestamps, workspace/model, turn count/status and recorded token totals.
`sessions show` explicitly prints the full stored session, including conversation and tool results.
The existing console tracing output is still enabled. The programmatic composition helper accepts
an injected SessionStore and defaults to in-memory storage when none is supplied; the executable
CLI selects FileSessionStore.

## Storage and boundaries

```text
CLI → SessionRuntime → SessionStore → FileSessionStore → RecordStorage (Workspace)
                           ↑
              required SessionUpdated subscriber
```

- `SessionStore` remains the only session persistence port. It supports get, save, list, and a
  session-scoped exclusive operation. InMemorySessionStore also implements these operations.
- `FileSessionStore` validates and serializes Session. It never opens files itself.
- `LocalRecordStorage` owns filesystem operations in a flat UUID-keyed namespace under one
  configured absolute root. It rejects traversal keys, a symlinked storage root, symlinked records,
  non-regular records and oversized data. The directory and records are created with modes 0700
  and 0600; existing directory permissions are not silently changed.
- A record is bounded to 16 MiB and listing scans at most 10,000 directory entries. Corrupted
  records make reads/listing fail explicitly. The store refuses to overwrite an existing corrupted
  or unsupported-version document.
- Writes create a unique temporary file in the same directory, write and fsync it, rename it over
  the target, then fsync the directory. A reader sees an old or new complete record. Temporary
  files left by abrupt exit are ignored by listing. Directory fsync failure can occur after rename,
  so a failed save may already be committed; no tool is retried because of this uncertainty.

Records have the envelope `{ "version": 1, "session": ... }`. Version 1 validates known fields,
IDs, statuses, entry shapes, tool call/result pairing, non-negative usage counters and checkpoint
prefixes. Unknown fields or unsupported envelope versions are rejected rather than guessed or
migrated. There were no durable session files before this phase.

Session contains:

- original ordered turns and user/assistant/tool entries;
- creation/update timestamps, agent definition, workspace and explicit client configuration;
- per-response provider-neutral usage records with model/turn IDs and response/compaction purpose;
- the current context checkpoint, including its summary call identity and usage;
- the trace ID for each new turn, plus existing session/turn/model/tool correlation IDs.

Usage records represent normalized responses retained by the harness. Transport failures and a
compaction build that fails before committing its resulting context do not promise billing-complete
usage. Totals after rewind cover retained turns, not lifetime account spend. Provider secrets,
environment variables, permission approvals and transport payloads are not configuration fields.
Transcripts/tool outputs may themselves contain sensitive user data; session files are private
application data, not telemetry or encrypted storage.

## Save points and interruption

SessionRuntime persists the initial user turn before model work and the terminal state afterward.
AgentLoop reports progress back to Runtime after a successful context checkpoint, after appending
each assistant response/usage record and before tool dispatch, and after each appended tool result.
Runtime publishes these snapshots to the existing required persistence subscriber. AgentLoop never
calls the store or filesystem directly. A failed progress save stops the loop; Runtime attempts to
save the latest failed state, preserving known results, and surfaces the original failure if that
save succeeds. It never reruns the model/tool operation to repair a save.

On resume, an in-progress turn becomes `interrupted`. A failed/cancelled turn with unresolved calls
also becomes interrupted. Each missing result receives an explicit `execution_unknown` error record:
no durable result was observed and the operation **may have executed**. This is a marked recovery
placeholder, not an inferred success or proof of failure. Existing entries/results are retained,
the context receives valid tool call/result groups, and no old tool is dispatched automatically.
Malformed orphan/duplicate results are rejected by schema validation rather than repaired.

## Locking and rewind

SessionRuntime holds one exclusive lock across load, recovery, run and saves. Rewind takes the same
lock. A competing process fails with `busy`; there is no waiting queue or concurrent actor runtime.
The file adapter uses an exclusive `.<session-id>.lock` directory inside the session directory.
Graceful completion, failure and Ctrl-C release it. Abrupt process death can leave a stale lock.

There is deliberately no automatic stale-lock eviction. After verifying that **all processes using
that session have stopped**, the operator can remove its empty lock directory and resume:

```sh
rmdir /path/to/session-directory/.SESSION_ID.lock
pnpm cli -- --session-dir /path/to/session-directory --resume SESSION_ID "Continue"
```

Never clear that directory while another process may still be executing. This is a local cooperative
lock, not an OS sandbox, distributed lock, or defense against hostile modification of the store.
Programmatic callers must use `withSessionLock` around read/modify/save sequences.

Rewind retains the first N whole turns. It rejects invalid counts and retention of an in-progress
turn, removes usage belonging to dropped turns, and discards a checkpoint if its covered prefix is
no longer entirely retained. Retaining zero turns resets conversation state but preserves session
identity/configuration. Rewind does not undo file changes, external effects or model charges, and
does not create a backup branch. Inspection/listing read atomic snapshots and do not require locks.

## Tracing and checks

`session.store` records operation, session ID, duration, normalized error and success; `session.rewind`
records session ID and retained turn count. Turn trace IDs survive process restart. Neither span
serializes conversation, summaries, paths, usage payloads, configuration or raw exception messages.
Existing model/tool spans remain unique and correlated.

`pnpm validate` includes format, lint, types, all tests, build, and `smoke:persistence`. The smoke
test starts separate Node processes with FakeSampler: create/read/save → exit → reopen/resume,
then forced exit after a saved tool request → operator clears the known-dead child's lock → resume
without replay. Unit/integration tests also cover invalid files/versions, path/symlink boundaries,
limits, overlapping runs, progress-save failures, durable compaction/usage, inspect and rewind.
No live model service or credentials are required for these checks.

Phase 5 skills, native file editing/commands, distributed locking, encryption, schema migration,
event sourcing and exactly-once external effects remain separate capabilities.
