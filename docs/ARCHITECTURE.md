# Agent Harness Architecture

## 1. Goal

Build a small but extensible AI agent harness that can evolve from a simple tool-calling loop into a production-oriented coding agent runtime.

The architecture borrows three main lessons:

- **Waku Agent:** keep the core agent loop understandable.
- **DeepSeek Harness:** use clean subsystem boundaries and lifecycle/events for extensibility.
- **Grok Build:** treat model sampling, tool execution, workspace access, context management, safety, and observability as first-class runtime concerns.

The project should optimize for learning, clarity, and replaceable components before optimizing for feature count.

This document describes both the small current implementation shape and the intended long-term boundaries. Sections marked as later-phase architecture are constraints for future work, not directories or abstractions to create in Phase 0.

---

## 2. Target High-Level Architecture

### Phase 4 implementation decision

Durability uses one versioned JSON file per session, behind the existing SessionStore port.
FileSessionStore owns schema validation and serialization; a narrow Workspace RecordStorage
capability owns bounded reads, atomic replace (temporary file, fsync, rename), listing and exclusive
per-session locks. Runtime never imports filesystem APIs. This is application-owned storage,
not a model-facing file mutation tool. No database dependency or second repository abstraction is added.

Session stores creation/update metadata, agent/workspace configuration, original turns and tool
results, context checkpoints, provider-neutral usage records and trace correlation. CLI composition
restores saved configuration when resuming, while approvals and permission grants are fresh per run.
SessionRuntime locks the entire load/run/save operation; rewind uses the same lock. Contention fails
explicitly rather than losing updates. Abrupt process death may leave a lock; it is never removed on
a timer or guessed stale while another process could still execute. Operators must clear a stale lock
only after stopping all users of that session. Graceful cancellation releases it.

On resume, interrupted turns become explicitly interrupted. Pending tool calls receive clearly
marked execution-unknown records so providers receive valid call/result groups; no tool is replayed
and no success is inferred. Rewind retains a chosen number of complete turns, drops usage tied to
removed turns, and invalidates a checkpoint when its covered prefix is removed. It does not undo
workspace effects. Persistent storage remains bounded, local, single-writer per session; no actor,
background queue, automatic replay or event sourcing is introduced.

See [PHASE-4.md](PHASE-4.md) for the file format, CLI and recovery limits.

### Phase 3 implementation decision

Phase 3 introduces three existing planned boundaries: Permissions decides whether a validated
tool call may execute; Hooks supplies ordered, trusted application callbacks at lifecycle boundaries;
Events publishes canonical lifecycle facts to subscribers. Runtime and ToolBridge consume these
boundaries without filesystem, provider, or CLI dependencies. No new dependencies are required.

`ToolBridge` validates, runs `PreToolUse`, evaluates `PermissionEngine`, then dispatches once.
Hooks receive immutable snapshots and cannot rewrite calls or override permissions. A pre-tool
hook can veto; post-tool hook failures are reported without replacing an already executed result.
Rules match exact tool names and/or access kinds, with `deny > ask > allow`. Explicit ask rules
always require approval, even in always-approve mode. Default auto mode allows reads and denies
unmatched mutations; ask mode requests approval for unmatched mutations; always-approve allows
unmatched calls. Destructive tool metadata imposes an approval floor. Missing, failed, cancelled,
or non-affirmative approval denies execution. Approval applies to one immutable call only.

Hooks are sequential and cancellation-aware. Pre-boundary failures stop that action; AfterModel
failure preserves the sampled transcript. TurnEnd is a notification after persistence and cannot
rewrite a completed turn. SessionStart runs only for a newly created session. These are trusted
in-process callbacks, not scripts or a sandbox.

One EventBus is scoped to one SessionRuntime and shared with its AgentLoop and ToolBridge by the
composition root. Events include session/turn/model/tool IDs at their owning boundaries. A required
SessionUpdated subscriber saves through SessionStore before and after each turn; persistence
failures surface. Ordinary observer failures are contained. Runtime retains orchestration and the
load boundary. Dispose the runtime to remove its persistence subscription. Phase 3 storage was in-memory; Phase 4 supplies the durable adapter.

Existing operation spans remain the single timing/parentage instrumentation path. The tracing
subscriber adds metadata-only events to active spans, never duplicate operation spans. Compaction
retains Context-owned instrumentation; model hooks/events describe normal AgentLoop sampling.

See [PHASE-3.md](PHASE-3.md) for supported policy, lifecycle and failure contracts. Native tools
remain read-only; write/command capabilities remain future work. Phase 4 implements durable sessions.

This is the target dependency shape. It is not the Phase 0 project scaffold.

```text
                        CLI / API / IDE
                              │
                              ▼
                    ┌──────────────────┐
                    │  SessionRuntime  │
                    └────────┬─────────┘
                             │
                  ┌──────────▼──────────┐
                  │     AgentLoop       │
                  └──────────┬──────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
   Context Engine         Sampler           ToolBridge
          │                  │                  │
          │                  ▼                  │
          │                 LLM                 │
          │                                     │
          │                            ┌─────────┴─────────┐
          │                            ▼                   ▼
          │                       Native Tools      MCP Tool Adapters
          │                            │                   │
          │                            ▼                   ▼
          │                        Workspace           MCP Client
          │               ┌────────────┼────────────┐
          │               ▼            ▼            ▼
          │          Filesystem      Git        Terminal
          │
          ├── Project Rules   (Phase 2)
          ├── Skills          (Phase 5)
          ├── Retrieval       (Phase 7)
          ├── Memory          (Phase 8)
          └── Compaction      (Phase 2)

Supporting concerns, introduced by roadmap phase:
Permissions • Events • Hooks • Tracing • Metrics • Logging • Persistence
```

---

## 3. Core Runtime Flow

A single user turn should follow this conceptual flow:

```text
User Prompt
    │
    ▼
SessionRuntime
    │
    ├── record input in session state
    │
    ▼
AgentLoop
    │
    ▼
ContextBuilder
    │
    ├── system instructions
    ├── project rules              (Phase 2)
    ├── relevant skills            (Phase 5)
    ├── conversation history
    ├── retrieved context          (Phase 7)
    └── model-facing tool definitions
    │
    ▼
Sampler
    │
    ▼
Model
    │
    ├── final text ───────────────► finish turn
    │
    └── tool calls
            │
            ▼
        ToolBridge
            │
            ├── pre-tool hooks     (Phase 3)
            ├── permission check   (minimal in Phase 1)
            ├── trace span
            ├── dispatch
            └── normalize result
            │
            ▼
        Tool Result
            │
            ▼
       Chat/Session State
            │
            └──────────────────────► next AgentLoop iteration
```

The most important design rule is that the loop coordinates components but does not absorb their responsibilities.

---

## 4. Subsystems

### 4.1 Runtime

Suggested location:

```text
src/runtime/
├── session-runtime.ts
└── agent-loop.ts
```

`SessionRuntime` responsibilities:

- create or load a session through `SessionStore`
- execute one user turn
- create and persist the turn's user message
- delegate model/tool iteration to `AgentLoop`
- persist the resulting session state
- own the `session.run` and `turn.run` trace spans

`AgentLoop` responsibilities:

- drive model/tool iterations
- decide whether a turn continues or stops
- enforce cancellation and loop iteration limits

The Phase 1 `SessionRuntime` is a synchronous coordinator around one call. It has no actor, mailbox, queue, background-processing, or concurrency-management semantics. If concurrency control is needed later, it must be introduced by its own roadmap capability without moving model/tool iteration out of `AgentLoop`.

`Turn` belongs to Session state. Runtime operates on it but does not define a parallel turn representation.

The Phase 1 `AgentLoop` accepts an immutable `Session` containing the target in-progress turn and returns an updated immutable Session. It does not load or save `SessionStore`; `SessionRuntime` owns loading and persistence around the loop. If a non-cancellation failure escapes after the loop has already appended model or tool entries, an internal runtime error carries the latest failed Session to `SessionRuntime`; the runtime persists it before surfacing the original cause.

Each iteration creates a model call ID, builds provider-neutral context, calls `Sampler`, appends the normalized assistant response, dispatches tool calls sequentially through `ToolBridge`, appends their normalized results, and either repeats or stops. A response completes successfully only when its normalized stop reason is `end_turn` and it contains final text. `tool_calls` continues only when normalized tool calls are present; truncated, filtered, unknown, or internally inconsistent responses fail the turn while preserving any returned text in Session state. A configurable model-iteration limit terminates runaway loops. The loop performs no provider or tool retries.

Cancellation and an absolute deadline are combined into one signal propagated to both `Sampler` and `ToolBridge`; the original absolute deadline is also passed to `Sampler`. Provider-neutral sampling failures classified as cancellation/deadline terminate the turn accordingly. Other sampling failures remain surfaced to `SessionRuntime`, which records a failed turn before rethrowing the error.

The runtime must not directly:

- read or write files
- execute shell commands
- call Git
- call a provider SDK directly
- know MCP transport details

---

### 4.2 Agent

```text
src/agent/
└── agent-definition.ts
```

An Agent describes:

```text
Identity
+ Instructions
+ Model configuration
+ Capabilities
+ Policies
```

It does not own the execution loop. Start with one immutable `AgentDefinition`. Add an `Agent` runtime object or builder only after a second construction path or behavior requires one.

Phase 1 begins with this provider-neutral contract:

```text
AgentDefinition
├── name
├── systemPrompt
└── model
    └── modelId
```

`modelId` identifies the requested model but does not name or configure a provider. Provider selection, request mapping, and SDK options remain inside the Model/Sampler boundary.

Tool profiles, permission modes, compaction policies, role hierarchies, and builders are added only with their owning roadmap capabilities. Later, different agent definitions can support explore, plan, review, or general-purpose roles.

---

### 4.3 Model / Sampler

```text
src/json.ts

src/model/
├── create-sampler.ts
├── sampler.interface.ts
├── sampling-types.ts
└── providers/
    ├── anthropic-messages-sampler.ts
    ├── ollama-chat-sampler.ts
    └── openai-responses-sampler.ts
```

`Sampler` is the only interface the runtime uses to communicate with a model.

Conceptual contract:

```text
sample(ModelRequest, SamplingOptions)
    →
ModelResponse
├── model call ID
├── text or null
├── tool calls
├── token usage
└── stop reason
```

`ModelRequest` contains a provider-neutral model ID, ordered system/user/assistant/tool messages, and model-facing tool definitions. `SamplingOptions` carries an optional `AbortSignal` and absolute deadline. Tool schemas and normalized tool arguments use the harness-owned JSON value types shared with Session.

Provider adapters must return normalized tool calls and preserve the request's model call correlation ID in the response. ModelRequest optionally carries a provider-neutral `maxOutputTokens` limit selected by Context. OpenAI maps it to `max_output_tokens`, Anthropic to `max_tokens`, and Ollama to `options.num_predict`. Invalid limits are rejected before transport. Provider wire formats, SDK request objects, raw responses, and provider-specific option types must not cross the Sampler boundary.

Provider-specific formats stay inside sampler implementations.

This makes model swapping possible without changing agent orchestration.

Phase 1 includes concrete adapters for the OpenAI Responses API, Anthropic Messages API, and Ollama Chat API. Each maps the same provider-neutral transcript, tools, correlation ID, usage, stop reasons, cancellation, and normalized errors at the provider boundary. The adapters use the platform HTTP transport directly, so no provider SDK types or transport objects cross the `Sampler` boundary. OpenAI provider-side response storage is disabled because Session owns the transcript.

`createSampler` is a composition helper used by the CLI. It selects a concrete adapter from application configuration without exposing provider selection or credentials in `AgentDefinition`, Runtime, Tools, or Session. Ollama defaults to the local `http://localhost:11434` server; hosted provider credentials remain confined to construction of their adapters.

`OpenAIResponsesSampler` owns cancellation/deadline enforcement and bounded transient retries. It retries transport unavailability and provider responses classified as transient (`408`, `409`, retryable `429`, and `5xx`), honors a bounded `Retry-After`, and defaults to at most two retries after the initial request. Invalid requests, authentication failures, exhausted quota, invalid provider payloads, and cancellation are not retried. Raw error bodies remain private; failures crossing the boundary are sanitized `SamplingError` values. AgentLoop does not inspect provider status codes or implement provider retry policy, and tool execution is never retried by the sampler.

The portable transcript contract remains provider-neutral; Phase 2 adds only the optional output-token limit needed for budget enforcement. One intentionally deferred interoperability boundary is provider-owned opaque continuation data, such as reasoning items that some model modes require to be replayed verbatim. The harness neither leaks those wire items into Session nor adds stateful provider-response chaining. Support for such modes requires a separate provider-neutral continuation design before it is enabled.

Add another adapter only when it is actually needed; do not scaffold placeholder provider files.

---

### 4.4 Session and Chat State

```text
src/session/
├── session.ts
├── turn.ts
├── session-store.ts
├── in-memory-session-store.ts
├── file-session-store.ts
├── session-codec.ts
└── session-history.ts
```

The minimal Phase 1 state is:

```text
Session
├── session ID
└── ordered turns

Turn
├── turn ID
├── status
└── ordered entries
    ├── user message
    ├── assistant message + model call ID + tool calls
    └── tool result + matching tool call ID
```

Tool arguments and results use harness-owned JSON value types. Session state must not depend on provider SDK request/response types.

Phase 2 adds an optional versioned `contextCheckpoint` containing covered turn IDs, summary text and the summarization model-call ID. Original turns remain intact; the checkpoint is persisted only through the existing SessionStore boundary.

Start with an in-memory `SessionStore`. The stable store port preserves a persistence seam, and Phase 4 now supplies FileSessionStore with versioned durable JSON records. Do not create both `SessionStore` and `SessionRepository` for the same responsibility.

Do not introduce a separate `ChatState` until it has a responsibility distinct from the session's ordered turns. Token accounting and richer model/runtime metadata are added by their owning slices.

When runtime events are introduced in Phase 3, use one canonical event model. Do not duplicate session, runtime, and global event types for the same lifecycle fact. Full event sourcing remains optional.

---

### 4.5 Context Engine

Phase 2 implementation contract:

- `ContextBuilder.build` is asynchronous and returns a provider-neutral request, source token
  accounting, and an immutable Session carrying any successful compaction checkpoint. Runtime
  adopts that Session before sampling and still owns SessionStore persistence.
- Context sources provide system instructions, conversation, tool definitions, and project rules.
  Rules read only through FileSystemCapability, from root AGENTS.md through an explicitly selected
  workspace-relative directory. Deeper rules override ancestor rules only within that scope;
  they never grant tool permissions. Other directories are not inferred from prompt text.
- Context owns an explicit context-window/output-reserve budget. The replaceable default token
  counter estimates UTF-8 serialized size conservatively; estimates are not provider usage.
  Every message, schema and framing allowance counts. No model-name window inference is used.
- On overflow, prune large results from previous terminal turns in the model-facing projection
  only. Preserve call IDs, result outcomes, current-turn results, system instructions and rules.
- If still over budget, compact the oldest eligible terminal turns through Sampler, keeping the
  current turn and a configurable recent-turn tail. Only closed tool-call/result groups qualify.
  Summary requests are budgeted and tool-free. Validate response identity, completion and size;
  commit a checkpoint only after the complete context build succeeds. Failure/cancellation never
  replaces the original transcript or checkpoint. An irreducible prompt fails explicitly.
- Checkpoints live in Session memory, cover a validated prefix of turn IDs, and are context state,
  not cross-session memory. Phase 4 persists checkpoints through SessionStore. Summaries are lossy model output
  presented as historical data, never system instructions or authorization.
- A provider-neutral optional output-token limit on ModelRequest carries the Context-selected
  reserve into adapters, including compaction calls. Provider wire mapping remains in Model.

Current implementation:

```text
src/context/
├── context-builder.ts
├── context-budget.ts
├── context-source.ts
└── compaction.ts

src/project-rules/
└── project-rules-source.ts
```

The CLI supplies the existing Sampler and a Workspace-backed ProjectRulesSource to the builder.
Summary batches contain the largest oldest prefix that fits one summary request; they never split
turns or tool-call/result groups. The default policy preserves one recent terminal turn plus the
entire active turn. Unresolved or orphan tool groups are rejected rather than repaired silently.
The model-facing checkpoint is a labeled historical user message, while current rules remain
separate system context. Raw Session entries are never deleted or rewritten by Context.

See [CONTEXT-ENGINE.md](CONTEXT-ENGINE.md) for configuration, failure behavior and limitations.

The Context Engine answers:

> What information should be sent to the model for this iteration?

Sources may include:

```text
System prompt
Project rules
Conversation
Skills
Code retrieval
Memory
Tool definitions
Runtime reminders
```

The Context Engine owns token budgeting.

Rule:

```text
SELECT information → Context / Retrieval
DO something        → Tools / Workspace
```

Future token-saving systems such as GitNexus, AST graphs, symbol indexes, semantic code search, or repository summaries belong here.

---

### 4.6 Tool Runtime

```text
src/tools/
├── tool.interface.ts
├── tool-types.ts
├── tool-result.ts
├── tool-registry.ts
├── tool-bridge.ts
└── builtin/
    ├── input-validation.ts
    ├── read-file.tool.ts
    ├── list-files.tool.ts
    └── search-text.tool.ts
```

The initial tool runtime foundation defines one provider-neutral `Tool` contract, canonical tool call/result types, and a registry. `ToolDefinition` contains the model-facing name, description, and input schema plus an internal access-kind classification. The registry projects definitions to `ModelToolDefinition` without exposing that internal classification.

`ToolRegistry` owns registration, lookup, and model-definition listing only. Duplicate names are rejected. Registration and lookup never validate arguments, evaluate permissions, emit execution spans, or invoke a tool.

`ToolBridge` is the single entry point from Runtime to Tools. Its Phase 1 execution context requires session, turn, and originating model-call correlation IDs and optionally carries an `AbortSignal`. It resolves tools only through `ToolRegistry`, validates with the selected tool's input validator, and emits one `tool.execute` span.

Phase 1 permits only tools classified as `read`; other access kinds return `access_denied` without dispatch. This is a narrow bootstrap guard, not the Phase 3 permission engine or an approval flow. Tool operations are never retried by the bridge.

Unknown tools, invalid arguments, cancellation, mismatched result correlation, and unexpected thrown failures become bounded structured `ToolResult` failures. Trace attributes include correlation IDs and safe structural classification only; raw arguments, outputs, and exception messages are not recorded.

Conceptual pipeline:

```text
ToolCall
   │
   ▼
Parse / Validate
   │
   ▼
PreToolUse Hooks (Phase 3)
   │
   ▼
Permission Policy
   │
   ▼
Tracing
   │
   ▼
Tool Dispatch
   │
   ▼
Normalize Output
   │
   ▼
PostToolUse Hooks (Phase 3)
   │
   ▼
ToolResult
```

`PreToolUse` hooks must not perform effects before authorization. If a hook transforms tool arguments, ToolBridge must validate and authorize the transformed call before dispatch.

Phase 1 built-in tools:

- `read_file`
- `list_files`
- `search_text`

`ToolBridge` owns this dispatch pipeline; do not add a separate executor until a distinct execution responsibility appears. Phase 1's inline access guard rejects every non-read tool before dispatch. `write_file`/`apply_patch` and `run_command` remain unavailable until their workspace capability and explicit permission-decision slices are implemented. Full rules, approval flows, and hooks arrive in Phase 3.

The `Tool` contract accepts a normalized `ToolCall` plus optional cancellation and returns a normalized `ToolResult`. Native tools validate their own input contract and convert capability failures into bounded structured failures. `ToolBridge` rejects invalid calls before dispatch and normalizes registry, access, or unexpected pipeline failures while preserving this canonical result shape.

These tools depend only on `FileSystemCapability`; they never import Node.js filesystem APIs. `search_text` owns literal matching, recursion, and bounded match formatting while composing the capability's read/list operations.

---

### 4.7 Workspace

```text
src/workspace/
├── filesystem-capability.ts
└── local-file-system.ts
```

Workspace represents the environment in which tools operate.

Phase 1 starts with one narrow read-only `FileSystemCapability`, not a broad `Workspace` interface. It supports bounded UTF-8 file reads and bounded, non-recursive directory listings. Paths are workspace-relative; `.` addresses the configured root. Absolute paths, lexical `..` escapes, and existing paths whose canonical targets resolve through symlinks outside the canonical workspace root are rejected.

The local adapter requires an absolute configured root. Its default limits are 1 MiB per file read and 1,000 entries per directory listing. Exceeding a limit is an explicit error rather than silent truncation. Cancellation is checked before and during bounded operations where the Node.js filesystem primitives permit it.

Text matching, recursion policy, and match formatting belong to the `search_text` tool. That tool composes this capability's read/list operations; it does not call filesystem or command APIs directly.

Each local operation emits one `workspace.operation` span at the adapter boundary. It records operation kind, success, duration, safe output counts, and a normalized error code when relevant, but not requested paths, file contents, raw exception messages, or exception stacks.

Workspace owns the environment and exposes narrow capabilities. A tool should receive only the capability it needs, for example:

```text
workspace.files.read(...)
workspace.files.write(...)
workspace.commands.run(...)
workspace.git.status(...)
```

rather than directly using:

```text
fs
child_process
simple-git
```

Future implementations:

```text
LocalWorkspace
GitWorktreeWorkspace
DockerWorkspace
SandboxWorkspace
RemoteWorkspace
```

The same tools should continue to work across these implementations.

All implementations must define:

- workspace-root and filesystem path-containment behavior
- cancellation and timeout propagation
- command output limits
- environment-variable filtering
- normalized failure results

Do not use an unbounded generic `workspace.git(...)` or `workspace.execute(...)` escape hatch.

Command `cwd` containment is not an OS sandbox. An authorized child process may still access host resources outside the workspace until Phase 11 introduces an isolation boundary.

---

### 4.8 MCP

```text
src/mcp/
├── mcp-manager.ts
├── mcp-client.ts
├── tool-catalog.ts
├── tool-index.ts
├── search-tools.tool.ts
└── invoke-tool.tool.ts
```

MCP is an external integration layer.

Do not inject every external MCP tool schema into every model request.

Target architecture:

```text
MCP Servers
    │
    ▼
Tool Catalog
    │
    ▼
Search Index
(BM25 first)
    │
    ├── search_tools
    └── invoke_tool
```

Model-facing flow:

```text
search_tools("find Linear issue")
        │
        ▼
relevant tools + schemas
        │
        ▼
invoke_tool(
  "linear__search_issues",
  {...}
)
```

This keeps the model-facing tool surface stable and reduces context/token cost.

MCP tools must still pass through permission, hooks, tracing, and result normalization.

An MCP tool adapter depends on the MCP client, not on Workspace, unless that specific integration genuinely needs a workspace capability.

---

### 4.9 Project Rules

`src/project-rules/project-rules-source.ts` implements the ContextSource contract using only the
read-only FileSystemCapability. It loads root `AGENTS.md`, then each ancestor's `AGENTS.md` up to
an explicit workspace-relative directory (CLI `--rules-directory`, default `.`). Siblings are
excluded. Missing files are optional; containment, I/O, cancellation and size failures are surfaced.
Rules are bounded by an aggregate byte limit and by the complete context input budget. They are
never truncated to make a request fit and never change the ToolBridge permission decision.

Directory scope is configured by the application, not inferred from user prose or arbitrary tool
arguments. Automatic per-tool rules discovery is not implemented in Phase 2.

---

### 4.10 Skills

```text
src/skills/
├── skill-parser.ts
├── skill-selector.ts
└── skills-source.ts
```

Phase 5 adds reusable procedural instructions through the existing ContextSource boundary.
SkillsSource depends only on read-only FileSystemCapability ports and tracing; Runtime, Tools
and provider adapters do not acquire skill discovery or selection responsibilities. The CLI
constructs separate contained filesystem capabilities for project `.agents/skills` and user
`~/.agents/skills` (overridable with `--user-skills-directory`). The user capability is never
registered as a model-facing file tool. No dependency, manager abstraction or executable tool is added.

Discovery reads immediate child directories containing SKILL.md, with bounded files, aggregate
bytes and skill counts. Missing directories/files are optional; malformed skills, duplicate names
within a scope, containment and I/O failures are explicit Context errors with sanitized causes.
Project names override user names. A small documented frontmatter subset supports required name
and description strings and a nonempty Markdown body; unsupported metadata is rejected.

Only the active turn's user message can explicitly invoke `$skill-name`. CLI `--skill` flags are
stored as equivalent invocations in that user message, retaining intent across persistence without
changing the session format. Historical messages, tool output and skill bodies cannot select more
skills. Automatic lexical selection is opt-in, deterministic and capped. Bodies of selected skills
are injected as labeled system context after project rules and cannot override rules or permission
policy. All selected content counts against the existing Context budget and is never silently
truncated. No scripts execute and no referenced resource files are automatically loaded.

Skills are rediscovered on each context build; resume uses current files and requires fresh
invocations for the new turn. Skill contents and automatic-selection configuration are not session
snapshots. `context.skills` records selection/injection counts and sizes, while `context.build`
records skill token contribution. Neither records prompts, names, paths or instruction text.

See [PHASE-5.md](PHASE-5.md) for the supported format, selection and limits.

---

### 4.11 Memory

Later phase:

```text
src/memory/
├── memory-store.ts
├── memory-index.ts
├── memory-search.ts
└── memory-manager.ts
```

Memory answers:

> What knowledge from previous sessions is relevant now?

Start with:

```text
Markdown storage
+
SQLite FTS/BM25
```

Add embeddings only when text retrieval is working and measurable.

Memory feeds Context. It should not mutate runtime behavior directly.

---

### 4.12 Subagents

Later phase:

```text
src/subagents/
├── subagent-manager.ts
├── subagent-runner.ts
└── subagent-definition.ts
```

Subagents are child sessions with independent context.

Initial rule:

```text
max nesting depth = 1
```

Possible roles:

- explore
- plan
- test
- review
- general-purpose

Worktree isolation can be added later for agents that modify files.

---

### 4.13 Permissions

```text
src/permissions/
├── permission-engine.ts
└── access-kind.ts
```

Initial modes:

```text
ask
auto
always-approve
```

Rule severity:

```text
deny > ask > allow
```

Permissions are enforced by the harness, not the model.

Phase 1 has no mutating capabilities and keeps a narrow inline ToolBridge guard that rejects non-read access kinds. Phase 3 introduces this subsystem before any mutating tool becomes executable, adding explicit decisions, rule composition, ask flows, modes, and richer policy evaluation.

---

### 4.14 Hooks

```text
src/hooks/
└── hook-registry.ts
```

Initial lifecycle hooks:

```text
SessionStart
TurnStart
BeforeModel
AfterModel
PreToolUse
PostToolUse
TurnEnd
```

Hooks extend behavior without modifying the core loop.

Phase 3 supplies an ordered registry of trusted in-process hooks. Hooks receive immutable snapshots and cannot transform tool arguments. Start/pre hooks fail closed; AfterModel failure preserves the sampled transcript; PostToolUse and TurnEnd failures are recorded without changing an executed result. SessionEnd is deferred because the current runtime has no persistent session lifecycle.

---

### 4.15 Events

```text
src/events/
├── event-bus.ts
├── persistence-subscriber.ts
└── runtime-event.ts
```

Phase 3 events:

```text
SessionStarted
TurnStarted
SessionUpdated
ModelStarted
ModelCompleted
ToolStarted
ToolCompleted
TurnCompleted
```

Context/compaction and session-end event extensions are deferred. The event bus bounds ordinary observer callbacks to one second each by default, contains their failures, and propagates required SessionUpdated persistence failures. Callbacks are trusted application code; cancellation cannot undo callback effects.

Consumers may include:

- CLI/UI
- session persistence
- tracing
- telemetry
- debugging

This is the only canonical runtime lifecycle event model. Session state may store these events later, but it must not redefine equivalent event types.

---

### 4.16 Observability

```text
src/observability/
├── tracing/
├── metrics/
└── logging/
```

Observability is cross-cutting.

See `OBSERVABILITY.md`.

The initial implementation may instrument boundaries directly. When event subscribers are introduced, ensure they do not create duplicate spans or logs for the same operation.

---

### 4.17 Errors, Retries, and Cancellation

Boundary ownership:

```text
Provider transport retry      → provider-specific Sampler adapter
Loop continuation and limits  → Runtime
Tool argument/dispatch error  → ToolBridge
Filesystem/command failure    → Workspace implementation
Turn cancellation             → Runtime, propagated through every active boundary
```

Mutating tool calls are not retried automatically unless the operation has an explicit idempotency guarantee. Boundary errors should be normalized for callers while retaining their cause, category, and retryability for diagnostics. Runtime must preserve the latest Session transcript before surfacing an error that occurs after completed model/tool iterations.

---

### 4.18 Composition Root

The executable entry point owns dependency construction:

```text
CLI composition root
  → creates Sampler, SessionStore, ContextBuilder, ToolBridge, Workspace
  → injects them into SessionRuntime / AgentLoop
```

Do not hide initial wiring behind a dependency-injection framework. Runtime components consume interfaces and must not instantiate provider SDKs, concrete workspaces, or telemetry backends themselves.

The Phase 1 composition root lives in `src/cli/phase-one-cli.ts`. It constructs the in-memory `SessionStore`, `ContextBuilder`, `AgentLoop`, read-only tool registry and bridge, and local filesystem capability around an injected `Sampler` and tracer. The same path works with OpenAI, Anthropic, Ollama or a deterministic fake. Phase 2 adds explicit context budget configuration and a Workspace-backed project rules source here. Phase 4 lets this helper accept a SessionStore; main.ts constructs FileSessionStore over LocalRecordStorage, while session-cli.ts handles configuration restoration and management commands. There is still one agent runtime path.

### 4.19 Phase 1 CLI

```text
src/cli/
├── main.ts
└── phase-one-cli.ts
```

The CLI is a one-shot presentation and composition boundary. It accepts one prompt, resolves a model ID into the existing `AgentDefinition.model.modelId` field, selects a workspace root, calls `SessionRuntime` once, and prints the final answer. It does not inspect or reproduce model/tool loop state, dispatch tools, or own session orchestration.

The model ID is selected with `--model` or `AGENT_HARNESS_MODEL`; `--provider` or `AGENT_HARNESS_PROVIDER` selects the adapter. Provider credentials configure only the concrete adapter and are never accepted as command-line arguments. Phase 2 adds `--context-window`, `--output-reserve` and `--rules-directory`; see CONTEXT-ENGINE.md. `--workspace` defaults to the current directory and is resolved to the absolute root enforced by `LocalFileSystemCapability`.

The CLI remains one-shot per invocation. Phase 3 adds permission flags and an exact-call TTY approval prompt; without a TTY, approval requests are denied. Phase 4 adds persistent JSON storage and resume/list/show/rewind commands; there is no REPL/TUI or background work. Existing runtime spans provide tool/model activity when the default console tracing exporter is used; the CLI does not create duplicate lifecycle spans.

---

## 5. Dependency Rules

Allowed:

```text
CLI/API
  ↓
Runtime
  ↓
Agent / Context / Session / Sampler / ToolBridge

ToolBridge
  ↓
Tool interface / ToolRegistry
  ├── Native tool → narrow Workspace capability
  └── MCP adapter → MCP client

Context
  ↓
Retrieval / Skills / Rules / Memory

MCP adapter
  ↓
MCP client / transport
```

Disallowed:

```text
Workspace → AgentLoop       ❌
Tool → Sampler              ❌
Tool → provider SDK         ❌
MCP → SessionRuntime        ❌
Memory → Workspace mutation ❌
Context → shell execution   ❌
Runtime → concrete provider ❌
Runtime → concrete workspace ❌
```

Observability subscribers must not change business outcomes. The required persistence subscriber is an intentional exception: SessionStore failures surface rather than pretending the turn was saved. Subscribers do not reverse dependency direction.

---

## 6. Phase 0 Project Structure

Create only the repository foundation:

```text
├── .gitignore
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── eslint.config.mjs
├── prettier.config.mjs
│
src/
├── ids.ts
└── observability/
    ├── logger.ts
    └── tracing.ts

test/
├── ids.test.ts
├── logger.test.ts
└── tracing.test.ts
```

Phase 0 intentionally creates only the already-required Observability boundary. It has no Runtime, Agent, Model, Session, Context, Tools, Workspace, Permissions, Hooks, Events, or integration directories. Those directories are created only when their roadmap phase begins. There is no barrel `index.ts` or public package API until a real consumer requires one.

---

## 7. Target Project Structure

```text
src/
├── runtime/
├── agent/
├── model/
├── session/
├── context/
│   └── retrieval/
├── tools/
│   ├── builtin/
│   └── middleware/
├── workspace/
├── mcp/
├── permissions/
├── project-rules/
├── skills/
├── memory/
├── subagents/
├── hooks/
├── events/
├── observability/
│   ├── tracing/
│   ├── metrics/
│   └── logging/
└── cli/
```

Do not create every directory on day one. Introduce modules according to the roadmap.

---

## 8. First End-to-End Milestone

The first usable harness should support:

```text
User
 ↓
CLI
 ↓
SessionRuntime
 ↓
AgentLoop
 ↓
ContextBuilder
 ↓
Sampler
 ↓
Model requests read_file
 ↓ 
 ↓
Final Answer
```

Once this works and is traced, the project has a real harness core.

Everything after that is capability growth.
