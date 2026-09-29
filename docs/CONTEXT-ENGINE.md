# Phase 2 — Context Engine

The Context Engine decides what is sent to the model. It never executes tools, grants permissions,
or changes the raw conversation. Runtime adopts the Session returned by Context and saves it
through the existing SessionStore. The CLI remains one-shot and read-only.

Phase 5 adds a `SkillsSource` through the same `additionalSources` boundary. It loads bounded
project/user workflows, applies explicit or opt-in automatic selection, and injects selected bodies
after project rules. Skill contributions count as `context.skills_tokens` and are mandatory during
budget enforcement. See [PHASE-5.md](PHASE-5.md) for invocation, precedence and format limits.

Phase 7.2 adds optional `ContextBuilderOptions.codeRetrieval`, separate from
mandatory `additionalSources`. Required context fits first, with the existing
pruning/compaction behavior unchanged. Context then retrieves code from the active
user request and packs complete excerpts within `min(maxTokens, remaining input)`.
The default cap is 4096 estimated units; zero remaining space skips retrieval.
Oversized excerpts are omitted, never split to force them into the request.
No retrieval content can trigger additional compaction or evict required context.

Excerpts are labeled untrusted repository data in a user-role message before the
conversation, preserving all original message and call/result groups. Phase 7.3b
scans once per turn and repacks that scan on later builds of the turn; excerpts are
never appended to Session or stored in checkpoints. CLI roots must be supplied again on resume. Errors abort the build
without committing a prospective checkpoint; cancellation/deadlines propagate.
`accounting.sources.retrieval` and `context.retrieval_tokens` count the full injected
message including labels/metadata. `baselineTokens` remains the pre-retrieval,
pre-pruning baseline; `totalTokens` includes selected excerpts. See [PHASE-7.md](PHASE-7.md).

Phase 8.1 adds optional `ContextBuilderOptions.memory` on the same spare-budget terms:
memory takes `min(maxTokens, remaining input)` (default cap 2048) first, then code
retrieval receives what is left. Memory notes are a labeled user-role message placed
before code excerpts, reloaded from files on every build and never written to Session.
They count as `accounting.sources.memory` / `context.memory_tokens`. See
[PHASE-8.md](PHASE-8.md).

## Configuration

```sh
pnpm cli -- --provider ollama --model qwen3:1.7b \
  --context-window 8192 --output-reserve 1024 \
  --rules-directory src/context \
  "Inspect the context engine and explain its responsibilities."
```

Choose a context window supported by the model/server you use. The example is an application
budget, not an assertion about the model's maximum window. No model-name inference takes place.

| Setting | Default | Meaning |
| --- | --- | --- |
| `--context-window` | 32768 | Total context allowance |
| `--output-reserve` | 4096 | Space reserved for generated output; also sent as the provider output limit |
| `--rules-directory` | `.` | Directory scope relative to `--workspace` |
| `ContextBuilderOptions.toolResultMaxChars` | 1024 | Preview size for large historical tool results when over budget |
| `ContextBuilderOptions.summaryMaxTokens` | min(1024, output reserve) | Estimated summary size cap and provider output cap |
| `ContextBuilderOptions.keepRecentTurns` | 1 | Terminal turns kept alongside the entire active turn |

Input allowance equals context window minus output reserve. The default counter counts UTF-8
bytes of serialized provider-neutral messages and schemas, plus 8 units per item and 32 units per
request for framing. It is a deliberately conservative **estimate**, not an exact tokenizer or
a guarantee for every provider wire format. Inject a `TokenCounter` to replace it. Provider usage
continues to come from Sampler responses and is recorded separately.

## Sources and project rules

`ContextSource` returns ordered messages and tool definitions. Built-in sources cover system
instructions, conversation and tool definitions. `additionalSources` inserts sources after system
instructions and before conversation; names must be unique stable identifiers. Source contributions
and request framing add up to the returned `accounting.totalTokens`.

The CLI supplies a `ProjectRulesSource` through the existing read-only Workspace capability. For
`--rules-directory src/context`, it tries these paths in order:

1. `AGENTS.md`
2. `src/AGENTS.md`
3. `src/context/AGENTS.md`

Missing files are optional. I/O, path containment, cancellation and size errors fail explicitly.
The aggregate rules limit is 64 KiB, configurable through `ProjectRulesOptions.maxBytes`; filesystem
per-file limits also apply. Empty files add no message. Deeper rules take precedence only in their
scope. Sibling directories are excluded. Rules never override harness permissions.

Scope is explicit application configuration. Phase 2 does not infer applicable directories from
prompt prose or automatically discover rules for every path a tool might later read.

## Overflow behavior

1. Load sources, validate the transcript and compute the baseline input estimate.
2. Ensure mandatory system/rules/selected-skills/schema/current-turn content fits. Never truncate these sources.
3. If necessary, shorten oversized tool results from prior terminal turns in the model-facing
   projection. Keep result outcomes and call IDs, mark pruning explicitly, and preserve current-turn
   results verbatim. Apply the projection only when the counter measures a reduction.
4. If still too large and a Sampler is configured, summarize the oldest eligible prefix. Pack whole
   terminal turns into a summary request that fits its own input/output budget. Keep the configured
   recent tail and all current-turn entries. Summaries merge the previous checkpoint and new prefix.
5. Validate summary correlation ID, complete text stop reason, absence of tool calls, size and
   actual estimated savings. Repeat with another bounded batch only if needed.
6. Return the request, accounting and new immutable Session together. Commit no checkpoint if any
   part fails or is cancelled. Runtime persists successful context state even if later sampling fails.

The builder rejects dangling tool calls, duplicate call IDs within a turn and orphan tool results.
It never silently drops part of a multi-tool batch or fabricates missing results. A prior failed or
cancelled turn can be summarized only if its tool groups are closed.

Summary model calls have no tools and use the provider-neutral Sampler, with the same cancellation
signal and absolute deadline. Provider transport retries remain in the adapter; Context adds no
retry loop for invalid summaries. A summary is historical data in a user message, not a system
instruction. It is inherently lossy; exact source details may need to be read again.

## Checkpoints and failures

`Session.contextCheckpoint` contains version 1, covered prefix turn IDs, summary and summary model
call ID. Reuse verifies that it still matches a terminal prefix of the Session. Raw turns remain
available unchanged. Phase 2 originally kept checkpoints in memory. Phase 4 now persists them, along with committed compaction usage, through SessionStore. Resume restores the checkpoint; rewind invalidates it if covered turns are removed. See PHASE-4.md.

`ContextError` surfaces normalized `invalid_state`, `source_failed`, `budget_exceeded` or
`compaction_failed`. Cancellation/deadline use the existing normalized sampling error contract.
The CLI prints these safe messages. Traces exclude source contents, paths, arguments and summaries.

Explicit limits:

- An oversized active turn, mandatory rules/schema, protected recent tail or single historical
  turn too large for a summary request can still fail. Phase 2 does not split turns or compact an
  active tool exchange. Reduce source size, the configured recent tail, or adjust the model budget.
- Without a Sampler injected into ContextBuilder, pruning works but summary compaction is disabled.
  The CLI supplies its Sampler automatically.
- Summary size and savings are checked, but factual fidelity is not automatically provable. Tests
  use deterministic summaries. A targeted Ollama live check passed compaction and fact recall;
  broader model quality and exact tokenizer calibration remain separate work. See
  [OLLAMA-PHASE2-VERIFICATION.md](OLLAMA-PHASE2-VERIFICATION.md), including its tool-selection failure.
- Multiple batches are bounded by the number of eligible turns and the caller's deadline. CLI
  cancellation remains available through Ctrl-C; no new background work or concurrency is added.

## Verification

`pnpm validate` checks formatting, lint, types, tests and build. Phase 2 tests cover exact budget
boundaries, UTF-8/schema accounting, mandatory rules, pruning of multiple tool results, checkpoint
reuse, invalid summaries, atomic failure/cancellation, summary batching, Workspace rule containment,
adapter output-limit mapping and long multi-turn continuation through SessionRuntime. The existing
CLI test now checks automatic rules loading along its model → filesystem tool → model path.
