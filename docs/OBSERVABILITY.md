# Observability and Tracing Architecture

## 1. Goal

Observability should answer:

1. What did the agent do?
2. Why is a turn slow?
3. Where were tokens spent?
4. Which tools were called?
5. Why did the agent retry or loop?
6. Which context sources dominated the prompt?
7. Where did an error occur?
8. How do parent and subagent executions relate?

Observability consists of:

```text
Logs + Metrics + Traces
```

Tracing is the primary execution-debugging view.

This document includes the target trace vocabulary for later roadmap phases. Phase 0 implements only correlation IDs, structured logging, a basic tracer, and console export.

---

## 2. Trace Hierarchy

Phase 1–2 hierarchy, with later-phase child spans shown where they will attach:

```text
Session Trace
│
├── Turn Span
│   │
│   └── agent.loop.iteration
│       ├── context.build
│       │   ├── context.rules          (Phase 2)
│       │   │   └── workspace.operation
│       │   ├── compaction             (Phase 2, on overflow)
│       │   │   └── model.sample       (purpose: compaction)
│       │   ├── context.skills         (Phase 5)
│       │   ├── context.memory         (Phase 8)
│       │   └── context.code_retrieval (Phase 7)
│       ├── model.sample
│       └── tool.execute
│           ├── permission.evaluate    (Phase 3)
│           └── workspace.operation
│
└── Turn Span
```

When Phase 9 introduces subagents, they should create child or linked traces:

```text
Parent Turn
    │
    └── subagent.spawn
            │
            └── Child Session Trace
```

---

## 3. Correlation IDs

Phase 0 generates explicit IDs for:

```text
session_id
turn_id
model_call_id
tool_call_id
```

Add these only with their owning capabilities:

```text
loop_iteration   (Phase 1 counter, not a globally unique ID)
subagent_id
workspace_id
```

These IDs should appear consistently in:

- logs
- trace attributes
- persisted session events
- UI/CLI diagnostics

Do not rely only on automatically generated tracing span IDs for application-level correlation.

---

## 4. Span Vocabulary by Phase

Do not emit spans for capabilities that do not exist yet. The following names become canonical when their owning phase is implemented.

### `session.run`

Phase 1 emits one span for each synchronous `SessionRuntime.run` call. The current implementation records only attributes already owned by the runtime slice.

Useful attributes:

```text
session.id
agent.name
model.default
session.created
session.outcome
success
duration_ms
workspace.type
permission.mode
```

### `turn.run`

Phase 1 nests one turn span under `session.run`. `turn.index` is zero-based.

```text
session.id
turn.id
turn.index
loop.iterations
turn.outcome
success
duration_ms
```

### `agent.loop.iteration`

Phase 1 records one span per model/tool iteration:

```text
session.id
turn.id
loop.iteration
loop.outcome
duration_ms
```

### `context.build`

Phase 1 records structural message and tool counts. Phase 2 records estimated source contributions,
input/window/output budgets, baseline versus final context size, pruned result counts and checkpoint
reuse. Estimates are explicitly marked and are not provider-reported token usage. Failed budget
checks also retain safe baseline accounting. Names for skills/memory/retrieval below remain future
attributes until those sources exist; Phase 5 now implements `context.skills_tokens`.

Phase 2 additional attributes:

```text
context.input_limit
context.output_reserve
context.baseline_tokens
context.framing_tokens
context.token_counter
context.tokens_estimated
context.pruned_results
context.checkpoint_reused
success
error.type
duration_ms
```

`context.rules` records session/turn IDs, rule file count, aggregate bytes, duration and normalized
outcome. Paths and rule content remain excluded. Its filesystem reads create normal Workspace spans.

```text
session.id
turn.id
model_call.id
context.message_count
context.system_message_count
context.conversation_message_count
context.tool_count
context.window_limit
context.total_tokens
context.system_tokens
context.conversation_tokens
context.tool_tokens
context.rules_tokens
context.skills_tokens
context.memory_tokens
context.retrieval_tokens
context.compaction_applied
```

### `model.sample`

```text
session.id
turn.id
model_call.id
loop.iteration
provider
model
input_tokens
output_tokens
cached_input_tokens
reasoning_tokens
latency_ms
stop_reason
retry_count
success
error.type
sampling.retryable
```

AgentLoop owns the canonical `model.sample` span for normal loop sampling and records runtime correlation, model, latency, normalized usage, stop reason, and outcome. Each provider adapter enriches that active span with its provider name and `retry_count`; hosted adapters also record the provider request ID when returned. Adapters do not create duplicate model spans. Do not record API keys, authorization headers, complete prompts, tool arguments, raw response bodies, or raw model failures by default.

Context compaction owns a separate `model.sample` for each real summary call, nested under
`context.build → compaction`. It carries a fresh `model_call.id`, the current session/turn IDs,
`model.purpose=compaction`, estimated input size, provider usage, stop reason and latency. The
provider adapter enriches this active span just as for a normal sample; there are no duplicate
spans for a single provider call. Summary calls do not consume AgentLoop iteration counters.

### `tool.execute`

```text
session.id
turn.id
model_call.id
tool.name
tool.kind
tool_call.id
tool.access_kind
tool.result_outcome
permission.decision
success
duration_ms
error.type
input_size_bytes
output_size_bytes
```

Phase 1 records correlation, native/read-only classification, outcome, and duration. Input/output sizes and permission decisions are added with their owning capabilities. Do not store sensitive tool arguments, outputs, or raw unexpected exception messages by default.

### `workspace.operation`

```text
workspace.type
operation
duration_ms
success
filesystem.bytes_read
filesystem.entry_count
error.type
```

Filesystem paths and contents are not recorded by default. Failed filesystem operations record only a normalized `error.type` and error span status; they do not record raw exception messages or stacks. For commands, record sanitized metadata rather than blindly storing full environment or secrets.

### `mcp.search`

Phase 6.

```text
query_length
catalog_size
result_count
latency_ms
```

### `mcp.call`

Phase 6.

```text
server
tool
duration_ms
success
result_size_bytes
```

### `retrieval.code`

Phase 7.

```text
retriever
query_tokens
candidates
selected_items
selected_tokens
latency_ms
cache_hit
```

This becomes important when adding GitNexus, AST indexes, or semantic search.

### `compaction`

Phase 2 emits one span for each build that attempts compaction. It records session/turn IDs,
`reason=context_budget`, before/after counts on success, `compaction.turn_count`, duration and
normalized failure status. Failed builds do not commit partial checkpoints. No transcript or
summary text is recorded.

```text
tokens_before
tokens_after
messages_before
messages_after
reason
duration_ms
```

---

## 5. Runtime Events vs Traces

Use both once Phase 3 introduces runtime events.

Before Phase 3, Runtime and ToolBridge may create spans directly. When event subscribers are added, choose one instrumentation path for each operation so a single model/tool call does not produce duplicate spans or logs.

### Events

Events describe lifecycle facts:

```text
ToolStarted
ToolCompleted
TurnStarted
TurnCompleted
```

They are useful for:

- persistence
- UI
- audit history
- asynchronous subscribers

### Traces

Traces describe execution relationships and timing:

```text
Turn
 ├── Model Call
 ├── Tool Call
 └── Model Call
```

They are useful for:

- debugging
- performance
- token optimization
- root-cause analysis

Rule:

```text
Events = what happened
Traces = how execution flowed
```

---

## 6. Metrics

When metrics are introduced, begin with measurements for boundaries that already exist:

```text
agent_sessions_total
agent_turns_total

model_calls_total
model_call_duration_ms
model_input_tokens_total
model_output_tokens_total

tool_calls_total
tool_call_duration_ms
tool_errors_total

context_tokens
agent_retries_total
agent_loop_iterations
```

Later:

```text
context_compactions_total
mcp_searches_total
mcp_calls_total
retrieval_tokens_saved_estimate
tool_catalog_size
subagent_runs_total
permission_denials_total
workspace_command_failures_total
```

---

## 7. Logging

Use structured logs.

Example shape:

```json
{
  "level": "info",
  "event": "tool.completed",
  "session_id": "...",
  "turn_id": "...",
  "tool_call_id": "...",
  "tool": "read_file",
  "duration_ms": 12,
  "success": true
}
```

Logs should not be the only observability mechanism.

---

## 8. Sensitive Data Rules

Never log by default:

- API keys
- Authorization headers
- cookies
- access tokens
- refresh tokens
- secret environment variables
- full `.env` contents
- raw credentials
- arbitrary full model prompts
- arbitrary full tool outputs

Use:

```text
size
hash
type
count
path category
sanitized preview
```

instead when possible.

Tracing must never become a data-exfiltration path.

---

## 9. Recommended Technology

For the Node.js/TypeScript implementation:

```text
OpenTelemetry API/SDK
```

is a good default abstraction.

Initially export to:

```text
console
or
local OTLP collector
```

Later support:

```text
Jaeger
Grafana Tempo
Honeycomb
Datadog
other OTLP backends
```

Instrumentation should use the OpenTelemetry API. Provider setup and exporter selection stay in one Observability module; do not add a second harness-specific tracer abstraction in Phase 0.

The Node.js tracing setup installs the standard async context manager once so nested runtime operations preserve their parent-child trace relationships.

---

## 10. Phase 0 and Phase 1 Minimum

Do not overbuild observability initially.

Phase 0 only needs:

```text
structured JSON logger
basic tracer setup
console span export
```

and these application correlation ID types:

```text
session_id
turn_id
model_call_id
tool_call_id
```

Phase 1 adds:

```text
session span
turn span
context.build span
model.sample span
tool.execute span
workspace.operation span
```

The Phase 1 CLI uses this existing hierarchy and adds no presentation-specific span. Its real-provider entry point uses the console exporter, while the credential-free smoke path injects an in-memory exporter and verifies the same session → model → tool → workspace hierarchy. Final answer text is presentation output, not a trace attribute.

Tracing initialization and exporter failures must be contained, with a no-op fallback when setup cannot complete. Phase 1 verifies that observability failures do not alter real turn outcomes. If this foundation is present from the start, later MCP, retrieval, memory, subagents, and compaction can attach naturally to the same trace tree.


## Phase 3 instrumentation

`permission.evaluate` is a child of `tool.execute`, with session/turn/model/tool call IDs,
`permission.mode`, `permission.decision`, `permission.allowed`, `permission.reason`, and duration.
The parent tool span carries the same decision metadata. An ask decision and its resolved approval
are separate attributes; a deny is a policy outcome, not a broken evaluator.

`hook.run` is emitted when a registry constructed with a tracer has matching callbacks. It records
hook name/count, applicable correlation IDs, duration, success and normalized error type. It never
records hook inputs or exception text. The CLI wires this tracer. Post-tool and TurnEnd notification
failures also set `hook.post_tool_failed` / `hook.turn_end_failed` on the owning spans without losing
an executed result.

The tracing event subscriber adds metadata-only OpenTelemetry events to the active existing span.
It never serializes the RuntimeEvent object, SessionUpdated transcript, tool arguments, model text,
or approval payload, and does not create a second span for a model/tool call. Started/completed
model and tool facts include normalized success, including failure and cancellation paths. Model
facts concern normal AgentLoop sampling; Context retains its own compaction tracing.

Persistence is the required SessionUpdated subscriber. Its failures surface with a retained cause;
ordinary event observer failures and timeouts are contained. No metrics backend or durable event
log is introduced in Phase 3.


## Phase 4 persistence correlation

`session.store` owns get/save/list timing for the file adapter. It records `session.store.operation`,
`session.id` where applicable, `success`, `error.type`, and `duration_ms`. Errors preserve causes for
callers but raw errors, storage paths and JSON payloads are excluded from tracing. `session.rewind`
records session ID and retained-turn count. Lock contention is surfaced within the calling runtime's
`session.run` span. No duplicate model/tool spans are created.

Each new Turn stores the session-run trace ID, while assistant entries, tool entries and usage records
retain their existing model/tool/turn identities. Resume creates a new trace for a new turn under the
same durable session ID. SessionUpdated now also carries progress after a committed context build,
each assistant response and each tool result. The tracing subscriber still serializes only metadata.

Normalized usage records for committed response/compaction calls are persisted in Session, separate
from estimated context accounting. Rewind removes usage belonging to removed turns; these totals are
retained-history statistics, not a complete billing ledger. See PHASE-4.md for failure limits.

## Phase 5 skill instrumentation

`context.skills` is nested under `context.build` and carries `session.id`, `turn.id` and
`model_call.id`. Discovery reads use existing `workspace.operation` spans. It records
`skills.discovered_count`, `skills.catalog_count`, `skills.selected_count`, `skills.bytes_read`,
`skills.injected_bytes`, `skills.automatic_enabled`, `duration_ms`, `success` and normalized
`error.type` on failure. Counts include shadowed files in discovery and exclude them from the catalog.

The `skills.selected` span event records explicit and automatic counts. `skills.injected` records
the count and bytes of the source contribution, before the enclosing builder verifies the complete
request budget. A successful source span alone does not imply model sampling occurred.
`context.build` accounts for the full contribution with `context.skills_tokens`, including labels.
Names, paths, descriptions, bodies, prompts and raw filesystem errors are excluded from traces.
Selection and injection do not create runtime lifecycle events or duplicate model/tool spans.
