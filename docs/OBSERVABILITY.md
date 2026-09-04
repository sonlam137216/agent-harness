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

Target hierarchy as capabilities are introduced:

```text
Session Trace
│
├── Turn Span
│   │
│   ├── context.build
│   │   ├── context.rules
│   │   ├── context.skills
│   │   ├── context.memory
│   │   └── context.code_retrieval
│   │
│   ├── model.sample
│   │
│   ├── tool.execute
│   │   ├── permission.evaluate
│   │   └── workspace.operation
│   │
│   ├── mcp.search
│   ├── mcp.call
│   ├── compaction
│   └── retry.wait
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

Phase 1 records structural message and tool counts. Phase 2 adds token budgeting, rules, compaction, and other source-specific attributes.

```text
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
```

AgentLoop owns the canonical `model.sample` span and records runtime correlation, model, latency, normalized usage, stop reason, and outcome. `OpenAIResponsesSampler` enriches that active span with `provider = openai`, `retry_count`, and the provider request ID when returned; it does not create a duplicate model span. Do not record API keys, authorization headers, complete prompts, tool arguments, raw response bodies, or raw model failures by default.

### `tool.execute`

```text
session.id
turn.id
tool.name
tool.kind
tool_call.id
tool.access_kind
tool.result_outcome
permission.decision
success
duration_ms
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
```

Filesystem paths and contents are not recorded by default. For commands, record sanitized metadata rather than blindly storing full environment or secrets.

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

Phase 2.

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
