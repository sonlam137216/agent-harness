# Phase 8 — Memory

Phase 8.1 (read path), 8.2 (write path) and 8.3 (session summaries) are implemented:
Markdown memory notes in workspace and user scopes, deterministic BM25 ranking against
the active request, optional budgeted context injection, a `memory add` CLI command, a
permission-gated `save_memory` tool and `sessions summarize`. A persistent full-text
index, embeddings and deduplication remain optional later work. Workspace file tools remain read-only; `save_memory` can only
append entries to memory note files.

## Problem and placement

A new session has no access to earlier decisions except by replaying old transcripts,
which the harness never does across sessions. Memory answers: *what knowledge from
previous work is relevant now?* It feeds Context and does not change runtime behavior.

```text
CLI composition
  → ContextBuilder
    → memoryContext (Context owns packing and budget)
      → MarkdownMemoryStore (discovery, parsing, ranking)
        → FileSystemCapability (workspace root / separate user root)
```

No Runtime, Sampler, Session schema, tool definition or permission change is needed.
Memory is not a transcript, not a compaction checkpoint and not an authorization source.

## Opt in

```sh
pnpm cli -- --provider ollama --model <model-id> --memory \
  "Why did we choose the session storage format?"
```

| Flag | Meaning |
| --- | --- |
| `--memory` | Enable memory notes for this run |
| `--memory-tokens <n>` | Cap memory context (default 2048 estimated units) |
| `--user-memory-directory <path>` | User memory root (default `~/.agents/memory`) |

The two options require `--memory`. Memory settings are run options, not saved session
configuration: pass `--memory` again when resuming.

## Writing notes

Put Markdown files directly in `<workspace>/.agents/memory/` (project decisions) or the
user memory root (personal preferences across projects):

```markdown
# Decisions

## Session storage
Chose versioned JSON files over SQLite (2026-09-22): single writer per session,
no query requirements yet. Revisit if cross-session search is needed.

## Tracing
Console exporter only; no remote backend.
```

Each `## ` heading starts one entry; text before the first heading is one untitled entry.
Headings inside fenced code blocks do not split. Entries report their scope, path,
heading and one-based line range. Only immediate `*.md` files are read: dot files,
subdirectories, other extensions and symlinks are skipped. Notes may be edited by hand
or recorded with the write path below.

## Recording notes (Phase 8.2)

From the CLI:

```sh
pnpm cli -- memory add --title "Session storage" --file decisions \
  "Chose versioned JSON files over SQLite: single writer per session."
pnpm cli -- memory add --scope user --title "Diff style" "Prefer small diffs."
```

`--scope` is `workspace` (default, `<workspace>/.agents/memory`) or `user`
(`~/.agents/memory`, or `--user-memory-directory`). `--file` names a flat file stem
(default `notes`); `--workspace` selects the workspace root. The command prints the
recorded path and line range.

From the agent: with `--memory`, the model is also offered `save_memory`
(`title`, `content`, optional `scope` and `file`). It is a `write` tool, so the default
`auto` permission mode denies it. Enable it per run with `--allow-tool save_memory`, or
use `--permission-mode ask` to approve each exact call. A denied or rejected call writes
nothing and returns an error result to the model.

```sh
pnpm cli -- --provider ollama --model <model-id> --memory --allow-tool save_memory \
  "We decided to keep JSON session files. Remember that."
```

Each write appends one entry: `## <title>`, the body, and a provenance line
(`_Recorded <date> via CLI._` or `_Recorded <date> by the agent in session <id>._`).
Titles are one line of at most 120 characters and cannot start with `#`; bodies hold
1–4000 characters, may use `###` sub-headings, and cannot contain `## ` lines or an
unclosed code fence, because either would change how the file splits into entries.
Before writing, the new file text must parse back with the new entry as its last entry;
an existing file with an unclosed fence is therefore refused unchanged.

Writes go through the Workspace `NoteStorage` capability, which only handles flat
lowercase `*.md` names inside the memory directory. It creates the directory one segment
at a time and refuses symlinked segments or files, so nothing is created or written
outside the root. A lock directory serializes writers (a concurrent writer gets `busy`),
and files are replaced atomically (temporary file, fsync, rename). A file may not exceed
64 KiB after the write, matching the reader's per-file limit; use another `--file`
when it is full. Cancellation is honored until the lock is taken; the write then
completes. Writes are not retried. This is containment checking, not a sandbox.

Recorded notes are ordinary memory: visible to the reader on the next context build,
subject to the same untrusted-data labeling, and never able to grant permissions.

## Session summaries (Phase 8.3)

```sh
pnpm cli -- sessions summarize <session-id>
pnpm cli -- sessions summarize <session-id> --scope user --file history \
  --provider ollama --model <model-id>
```

The command loads a saved session and asks the model to distill durable knowledge:
decisions with rationale, confirmed constraints or preferences, important facts with
exact identifiers, and open follow-ups, as Markdown bullets of at most 3000 characters,
or exactly `NONE` when nothing is worth keeping. It is explicit and user-triggered; the
harness never summarizes automatically, so there is no hidden model cost.

Input is built from **completed** turns only: user messages, the final answer of each
turn and the names of tools used. Tool arguments and outputs are excluded (they can be
large or sensitive), as are failed, cancelled, interrupted and in-progress turns. A
saved compaction checkpoint is included as the earlier summary. Whole turns are kept
newest-first within a 32,000-character cap; the number of omitted older turns is sent
along. The request has no tools and a 1024-token output limit. The session data is
labeled untrusted and the model is told not to follow instructions in it.

Model and provider default to those saved with the session (`--model`/`--provider`
override them); the workspace defaults to the session's saved root (`--workspace`).
The entry goes to `sessions.md` in the chosen scope (`--scope`, `--file`), titled
`Session summary: <first request>`, with provenance
`_Summarized <date> from session <id> (<n> turns) by model <model>._`.

Output handling: `#`/`##` headings are demoted to `###` so the summary stays one entry.
`NONE` writes nothing. A missing, empty, tool-calling, truncated or oversized response,
or one with an unclosed code fence, fails with `invalid_response` and writes nothing.
A session with no completed turns fails with `nothing_to_summarize`. Summarizing the
same session into the same file again is refused as `duplicate`; edit the existing
entry instead. Summary usage is reported in telemetry but not added to the session's
usage records, since the session itself is not modified. Sampling failures and
cancellation propagate; nothing is retried.

## Selection and budget

The active turn's user message is the query. Terms are lowercase identifier words with
camelCase split and a small stop-word list removed; there is no stemming, so `session`
and `sessions` are different terms. Entries are ranked together across scopes with
BM25 (k1 = 1.2, b = 0.75), ties broken workspace-first then by discovery order. The top
16 entries are candidates. Only entries sharing at least one term can match.

Memory is optional context. After required context (instructions, rules, selected skills,
tool schemas and the active turn) fits, and after existing pruning/compaction, memory may
use at most the lesser of its cap and the remaining input budget. Code retrieval then
receives what remains. Entries are packed greedily and never truncated; an entry too
large for the remaining space is skipped. Memory never causes compaction or a budget
failure. With no spare room the store is not searched.

Notes are injected as one user-role message labeled as untrusted, possibly outdated
historical notes that must be verified against the workspace. They cannot override rules,
instructions or permissions, and are never written into Session. Files are rediscovered on
every context build, so edits are visible on the next iteration; there is no cache.

## Limits and failures

| Limit | Default |
| --- | --- |
| Memory files read (both scopes) | 64 |
| Content per file | 64 KiB |
| Total content | 512 KiB |
| Indexed entries | 1024 |
| Ranked candidates | 16 |
| Context cap | 2048 estimated units |

Limits are `MarkdownMemoryStore` constructor options. Missing memory directories are
empty. Exceeded limits and oversized directories/files are partial coverage: remaining
notes are still ranked and the reasons are included with selected notes. A partial notice
is not injected on its own. Containment and I/O failures surface as
`ContextError('source_failed')` with a sanitized cause; cancellation and deadlines
propagate. The user root has its own contained filesystem capability and is never
exposed to `read_file`, `list_files` or `search_text`.

## Observability

`memory.summarize` records session ID, scope, turns included/omitted, input characters,
outcome (`recorded`/`nothing_durable`) and normalized error type, with a nested
`model.sample` span (`model.purpose=session_summary`, token usage, stop reason) and the
`memory.record` write. No transcript or summary text is recorded.

`memory.record` records scope, source (`cli`/`agent`/`session_summary`), session ID for agent writes,
entry bytes, duration and outcome; the storage write is a nested `workspace.operation`
(`notes.update`) span. `save_memory` calls also produce the usual `tool.execute` span,
hooks and permission decision.

`context.memory` (child of `context.build`) records correlation IDs, token allowance,
candidates, selected items and tokens, budget omissions, partial flag, skip reason,
duration and outcome. `memory.search` (its child) records files read, bytes read, entries
indexed, candidates, partial reasons, duration and outcome. Queries, paths, titles and
note text are never recorded. `context.memory_tokens` accounts for the full message.

## Verification

```sh
pnpm exec vitest run test/memory
pnpm validate
```

Tests cover parsing and line ranges, BM25 ordering, scope discovery and skipping,
partial bounds, containment failures, cancellation, telemetry redaction, spare-budget
packing before code excerpts, Session immutability, CLI flags and a cross-session recall
through the CLI with a fake model.

Write-path tests (`test/memory/memory-write.test.ts`) cover atomic creation, invalid
names, symlinked directories and files (nothing written outside), size limits, lock
contention, cancellation, transform rejection without writes, entry formatting and line
ranges, boundary-corrupting input, the `memory add` command, `save_memory` being absent
without `--memory`, denied by default, rejected in ask mode, and a recorded note being
recalled by a new session.

Summary tests (`test/memory/session-summary.test.ts`) cover heading normalization and
`NONE`, completed-turn selection without tool outputs, provenance, duplicate refusal,
newest-first input limits, nothing written for `NONE`/empty sessions/unusable responses,
telemetry redaction, and the CLI path using the session's saved model and provider.

## Later, when measured

Persistent SQLite FTS index, embeddings/hybrid retrieval, temporal decay, deduplication,
a model-facing memory search tool, and editing/removing entries through the CLI.
