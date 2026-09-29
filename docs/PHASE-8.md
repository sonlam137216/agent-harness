# Phase 8 — Memory

Phase 8.1 (the read path) is implemented: Markdown memory notes in workspace and user
scopes, deterministic BM25 ranking against the active request, and optional budgeted
context injection. Writing memory from the agent, session summaries and a persistent
full-text index are later slices. Native tools remain read-only.

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
subdirectories, other extensions and symlinks are skipped. In this slice, notes are
written by people (or by the agent in a later slice); there is no model-facing write tool.

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

## Next slices

1. **8.2 — Write path:** an application-owned way to record notes (CLI command first,
   then a permission-gated model tool writing only to memory storage, never the workspace
   through a general write capability).
2. **8.3 — Session summaries:** summarize completed sessions into memory entries with
   provenance to the session ID.
3. **Later, when measured:** persistent SQLite FTS index, embeddings/hybrid retrieval,
   temporal decay and deduplication.
