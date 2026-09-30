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

### Phase 13 practical-use decision

The main session can act on the user's project when a run opts in, using only
capabilities that already exist. `--edit` registers `write_file`/`edit_file` over a
`LocalFileWriter` rooted at the workspace; `--commands` registers `run_command` over a
`SeatbeltCommandRunner` whose policy root is the workspace (`.git` protected, no network).
Either flag makes `ask` the default permission mode, and the terminal approval prompt
renders a diff or argv preview. ToolDefinition gains an optional `concurrent` flag;
ToolBridge exposes `canRunConcurrently(call)` (visible, `concurrent`, allowed without
approval) and AgentLoop runs a response's calls concurrently only when all of them
qualify, keeping transcript order. The CLI adds `--max-iterations` (default 25) and a
`chat` command that runs each line as a turn through the same `runPhaseOneCli`
composition. The Anthropic adapter adds cache breakpoints. The CLI selects span export with
`AGENT_HARNESS_TRACE` (off by default; tracing still records spans) and derives the
system prompt from the run's capabilities. Later slices add provider-aware budget
defaults, a `withRequestTimeout` Sampler decorator (model layer), a stderr progress
subscriber on the existing EventBus, and a Workspace-level sensitive-path definition
enforced both by `LocalFileSystemCapability` (hidden from listings and reads) and by
`SandboxPolicy.hideSensitiveFiles` (Seatbelt deny rules). Runtime, SessionRuntime,
ContextBuilder, PermissionEngine and the Session schema are unchanged. See
[PHASE-13.md](PHASE-13.md).

### Phase 12 protocol decision

External clients use the Agent Client Protocol (ACP, JSON-RPC 2.0 over stdio), which is
implemented in `src/protocol/` without new dependencies. `JsonRpcConnection` is a
bidirectional, bounded NDJSON transport that handles requests concurrently.
`AcpAgent` implements initialize, session/new, session/load, session/prompt,
session/cancel, streamed session/update notifications and session/request_permission
round trips. The protocol layer sits at the CLI/API level and depends on Runtime types
only. Prompts run through an `AcpPromptRunner` port that the CLI implements with the
same `runPhaseOneCli` composition as a one-shot run, so the CLI, an IDE and CI share one
runtime, store, tool set, permission engine and trace model. Updates are derived from
the existing `SessionUpdated` and `ToolStarted` events. Approvals become protocol
requests through the existing ApprovalHandler seam. In `acp` mode spans go to stderr so
stdout carries only protocol messages. Runtime, AgentLoop, Sampler, ToolBridge and the
Session schema are unchanged. See [PHASE-12.md](PHASE-12.md).

### Phase 11 sandbox decision

Command execution enters the harness only through Workspace's `CommandCapability`, and
its only implementation is sandboxed. `src/workspace/sandbox/` defines a backend-
independent `SandboxPolicy` (root, read paths, private paths, protected paths,
network `deny`, command allowlist, environment allowlist, time and output limits) and a
macOS Seatbelt backend (`SeatbeltCommandRunner`, via a pure profile generator). The OS
enforces the policy for every descendant process, below the permission layer. The
`run_command` tool (`accessKind: 'execute'`) is built per worktree with a policy rooted at
that checkout and offered only to `implement` children. The runner allows `execute`
there, and parent rules still override. Optional linked paths (e.g. `node_modules`) are
symlinked into checkouts read-only and excluded from snapshots. Runtime, AgentLoop,
ToolBridge, ContextBuilder and PermissionEngine are unchanged; no command runs without
the sandbox. See [PHASE-11.md](PHASE-11.md).

### Phase 10 worktree decision

File mutation enters the harness only through disposable Git worktrees. Workspace adds
two narrow capabilities: `GitWorktreeCapability` (a fixed set of worktree, snapshot,
diff, apply and branch operations run as `git` without a shell, with hooks disabled and
an allowlisted environment) and `FileWriteCapability` (contained, atomic whole-file
writes that refuse symlinks and `.git`). A new `src/worktrees/WorktreeManager`
(application level, depends only on those Workspace interfaces and RecordStorage) owns
the lifecycle: create a worktree and branch per child, snapshot-commit the child's work
when it ends, and user-driven apply (atomic `git apply`, refused on conflict) and remove
(refused while changes are unapplied unless forced). The subagent layer sees worktrees
only through an `IsolatedWorkspaceProvider` port that the CLI implements. The
`implement` role gets `write_file`/`edit_file` rooted at its checkout, with writes allowed
by default there and parent rules still overriding. The parent and the user's working
tree are never written by the model; applying is an explicit user command. Runtime,
AgentLoop, ToolBridge, ContextBuilder and PermissionEngine are unchanged. See
[PHASE-10.md](PHASE-10.md).

### Phase 9 subagent decision

Subagents are a new `src/subagents/` module next to Runtime. A child is an isolated
session: `SubagentRunner` composes its own `SessionRuntime`, `AgentLoop`, `ToolRegistry`,
`PermissionEngine` and `EventBus` from injected interfaces (Sampler, a rules-only
ContextBuilder, SessionStore, native read-only tools), runs one turn, and returns a
bounded handoff: the report, the files it read, and usage. `SubagentManager` owns
per-run start and concurrency limits, background handles, cancellation, and cleanup at
run end. The parent-facing `delegate_task`, `await_subagent` and `cancel_subagent` tools
depend only on the manager, so `Tool → Sampler` stays disallowed: the tools never sample
or touch Workspace. Depth is 1 by construction. The runner refuses delegation, write,
execute or external tools, and children never receive a manager. Children inherit the
parent's permission rules in `auto` mode without an approval handler. Child sessions
carry `metadata.parent` for durable correlation. Their `subagent.spawn` span nests under
the parent's `tool.execute`. Runtime, AgentLoop, ToolBridge and ContextBuilder are
unchanged. See [PHASE-9.md](PHASE-9.md).

### Phase 8.3 session summary decision

`SessionSummarizer` (Memory) turns a saved Session into one memory entry. It depends on
the Sampler interface (like compaction) and on `MemoryWriter`; it only reads Session and
never saves it. Input is a projection of completed turns (requests, final answers, tool
names; no tool outputs) plus any checkpoint summary, bounded newest-first. The CLI
`sessions summarize` command composes it with the session's saved model/provider. It is
explicit, not a lifecycle hook, so Runtime, AgentLoop and SessionStore are unchanged.

### Phase 8.2 memory write decision

Writing memory adds one narrow Workspace capability, `NoteStorage`: a locked, atomic
read-modify-write of flat `*.md` files inside one memory directory, refusing symlinked
segments/files so nothing is created outside its root. It is not a general file write.
`MemoryWriter` (Memory) validates that an entry stays exactly one parseable `## ` entry
and adds provenance; the CLI `memory add` command and the `save_memory` tool both use
it. `save_memory` is registered only with `--memory`, has `accessKind: 'write'`, and
therefore passes through the existing PermissionEngine: denied in default auto mode,
approvable in ask mode, or allowed by an explicit rule. The disallowed
`Memory → Workspace mutation` rule below still holds for source and project files:
memory can only append to its own note directory. See [PHASE-8.md](PHASE-8.md).

### Phase 8.1 memory decision

Memory is a new `src/memory/` module that Context depends on (Context → Memory), never
the reverse direction into Runtime. `MarkdownMemoryStore` discovers immediate `*.md`
files in a workspace root (`.agents/memory`) and a separately contained user root through
read-only FileSystemCapability ports, splits them into `## ` entries and ranks them with
in-memory BM25. Context's `memoryContext` owns packing: memory takes only spare input
budget after required context and compaction, is packed before code excerpts, and is a
labeled untrusted user-role message that is never persisted into Session. A shared
`packRanked` helper serves both optional sources. No dependency, database, write path or
Runtime/Sampler/Session change is added. See [PHASE-8.md](PHASE-8.md).

### Phase 7.2 lexical retrieval decision

An opt-in `CodeRetriever` boundary under Context returns bounded, ranked source
excerpts through Workspace's read-only filesystem port. ContextBuilder packs them
only after the existing required-context, pruning and compaction path succeeds;
retrieval cannot trigger compaction or displace required context. CLI composition
supplies explicit roots within the selected project-rule scope and a token cap.
Retrieval is a projection, not persisted transcript or an authorization mechanism.
No Runtime, Sampler or Session schema change is needed. Workspace adds an optional
per-read byte limit so aggregate scanning budgets can bound actual reads.

The initial adapter uses deterministic lexical terms and bounded line windows,
fresh reads, no external dependencies and no cache. It skips symlinks, excluded
paths and subtrees with unloaded nested rules. Scan bounds produce partial-coverage
metadata; candidate/snippet truncation after a complete scan is a separate
selection limit that is not presented to the model as missing coverage. I/O and
containment failures surface as normalized Context errors. Phase 7.3 adds a
Context-owned, in-memory, single-entry per-turn cache so later loop iterations
repack the first successful scan instead of rescanning; it is not persisted and
failures are not cached. See [PHASE-7.md](PHASE-7.md) for the contract and CLI
configuration.

### Phase 7.1 benchmark decision

Exploration measurement is development tooling under `test/benchmarks/exploration`,
not a new production subsystem. It composes the existing read-only CLI, Sampler,
SessionRuntime and in-memory tracing against a hashed, bounded source fixture.
Fixture setup and report output belong to the test driver; harness file access
continues through Workspace. No agent-loop, permission or model contract changes
are required. Scripted workloads verify accounting; explicit live runs measure
model behavior, with answer correctness reserved for rubric-based human review.
No retrieval adapter is introduced in this slice. See [PHASE-7.md](PHASE-7.md).

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

Phase 1 used an inline read-only guard. Phase 3 replaced it with PermissionEngine:
validated immutable calls pass through PreToolUse and explicit authorization before
dispatch. Default auto mode allows reads and denies unmatched non-read calls;
deny rules override ask/allow and destructive calls require approval. Tool operations
are never retried by the bridge.

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

`PreToolUse` hooks must not perform effects before authorization. Current hooks
receive immutable snapshots and cannot transform tool arguments or override permissions.

Phase 1 built-in tools:

- `read_file`
- `list_files`
- `search_text`

`ToolBridge` owns this dispatch pipeline; do not add a separate executor until a distinct execution responsibility appears. Phase 3 rules, approval flows and hooks are implemented. `write_file`/`apply_patch` and `run_command` remain unavailable until their workspace/tool slices are explicitly requested and implemented.

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

Phase 10 adds `FileWriteCapability` (`local-file-writer.ts`) and
`GitWorktreeCapability` (`local-git-worktrees.ts`). Writes are bound only to worktree
roots created by `src/worktrees/WorktreeManager`, never to the main workspace root. Git
runs as a bounded subprocess with repository hooks disabled. Records use the existing
RecordStorage capability.

Phase 11 adds `CommandCapability` (`command-capability.ts`) with one implementation,
`sandbox/SeatbeltCommandRunner`, which enforces a `SandboxPolicy` with macOS Seatbelt:
deny by default, no network, writes only to the worktree and a per-command temporary
directory, a private home directory apart from the detected toolchain, an environment
allowlist, time and output limits, and process-group kill. It is bound only to worktree
roots.

Command `cwd` containment is not an OS sandbox. An authorized child process may still access host resources outside the workspace until Phase 11 introduces an isolation boundary.

---

### 4.8 MCP

Phase 6 implementation decision: the official MCP client SDK is confined to an
adapter in this module. Workspace owns a bounded line-oriented duplex subprocess
capability for stdio; HTTP uses the SDK with a bounded fetch adapter. No model-facing
command tool is added. Explicit CLI configuration owns startup and teardown.

ToolRegistry supports atomic replacement of hidden external registrations.
ToolBridge supports one protocol-neutral delegation hop: validate/hook/authorize the
wrapper, resolve a registered target, validate/hook/authorize that target, check its
pinned registration is current, then execute once. One logical call ID and lifecycle
pair are retained; PostToolUse runs for the executed target only. Wrapper grants
never replace target authorization. External tools remain accessKind=external.

The catalog publishes immutable generations with qualified names and compiled JSON
Schema validators. Search uses BM25 over names/descriptions and returns bounded
complete schemas. See [PHASE-6.md](PHASE-6.md) for the supported schema subset and limits. Only search_tools and invoke_tool enter permanent model definitions.
Refresh invalidates stale targets before discovery and atomically publishes replacements.
Reconnect is demand-driven, bounded, and never replays tools/call. SDK types do not
cross into Runtime, Session or Sampler. See PHASE-6-PLAN.md for preparation history.

```text
src/mcp/
├── config.ts
├── mcp-manager.ts        # composition of search_tools and invoke_tool
├── mcp-client.ts
├── tool-catalog.ts
└── tool-index.ts
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
  "mcp:linear:search_issues",
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

Current implementation (Phase 8.1, read path):

```text
src/memory/
├── memory-parser.ts   # `## ` entries with line provenance
├── memory-index.ts    # deterministic in-memory BM25
├── memory-store.ts    # bounded workspace/user discovery and search
├── memory-writer.ts   # validated, provenance-stamped appends (Phase 8.2)
└── session-summarizer.ts  # explicit session → memory summaries (Phase 8.3)

src/workspace/note-storage.ts, local-note-storage.ts   # narrow note write capability
src/tools/builtin/save-memory.tool.ts                  # permission-gated write tool
src/cli/memory-cli.ts                                  # `memory add`

src/context/retrieval/
├── pack.ts                      # shared greedy packing for optional sources
└── memory/memory-context.ts     # budgeted, labeled injection
```

A persistent index is later work; no `memory-manager` exists until a responsibility
beyond reading, appending and summarizing requires one.

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

Current implementation (Phase 9):

```text
src/subagents/
├── subagent-definition.ts   # explore / plan / review roles, delegation tool names
├── subagent-runner.ts       # one isolated child session, token budget, bounded handoff
├── subagent-manager.ts      # limits, background handles, cancel, close
└── subagent-tools.ts        # delegate_task / await_subagent / cancel_subagent
```

Subagents are child sessions with independent context, model loop, tool scope and
lifecycle. The rule is:

```text
max nesting depth = 1
```

Shared roles are read-only. The `implement` role (Phase 10) edits only inside its own
disposable worktree; see §4.7 and [PHASE-10.md](PHASE-10.md). A test role waits for
command execution.

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

Phase 1 had a narrow inline ToolBridge guard rejecting non-read access kinds.
Phase 3 replaced it with this subsystem: explicit decisions, rule composition,
ask flows and modes are implemented. Native tool registration still remains read-only.

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
CLI/API  (cli/, protocol/ → AcpPromptRunner implemented by cli/)
  ↓
Runtime
  ↓
Agent / Context / Session / Sampler / ToolBridge

ToolBridge
  ↓
Tool interface / ToolRegistry
  ├── Native tool → narrow Workspace capability
  └── MCP adapter → MCP client

Delegation tools
  ↓
SubagentManager → SubagentRunner → child SessionRuntime (Runtime interfaces only)
                                 └→ IsolatedWorkspaceProvider port (implemented by CLI)

WorktreeManager
  ↓
GitWorktreeCapability / RecordStorage (Workspace)

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
Memory → Workspace mutation ❌  (except appending notes via NoteStorage, Phase 8.2)
Context → shell execution   ❌
Runtime → concrete provider ❌
Runtime → concrete workspace ❌
Subagent tool → Sampler      ❌  (tools reach children only through SubagentManager)
Child → delegation tools     ❌  (depth 1)
Child → write tools          ❌  (except implement, rooted in its own worktree)
Child → execute tools        ❌  (except implement: run_command under the OS sandbox)
Unsandboxed command execution ❌
Model → main working tree write ❌  (except with --edit, through PermissionEngine, Phase 13)
Main-tree tool → unconfined Node fs/process ❌  (only FileWriteCapability / sandboxed CommandCapability)
Worktrees → Runtime          ❌
Protocol → CLI / providers / concrete workspace ❌  (prompts go through AcpPromptRunner)
Protocol-mode stdout → anything but protocol messages ❌
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
