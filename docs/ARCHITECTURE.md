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

The Phase 1 `AgentLoop` accepts an immutable `Session` containing the target in-progress turn and returns an updated immutable Session. It does not load or save `SessionStore`; `SessionRuntime` owns loading and persistence around the loop.

Each iteration creates a model call ID, builds provider-neutral context, calls `Sampler`, appends the normalized assistant response, dispatches tool calls sequentially through `ToolBridge`, appends their normalized results, and either repeats or stops. A configurable model-iteration limit terminates runaway loops. The loop performs no provider or tool retries.

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
├── sampler.interface.ts
├── sampling-types.ts
└── providers/
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

Provider adapters must return normalized tool calls and preserve the request's model call correlation ID in the response. Provider wire formats, SDK request objects, raw responses, and provider-specific option types must not cross the Sampler boundary.

Provider-specific formats stay inside sampler implementations.

This makes model swapping possible without changing agent orchestration.

Phase 1 implements one provider only: `OpenAIResponsesSampler`. It maps the provider-neutral transcript to the non-streaming OpenAI Responses wire format and maps output text, function calls, token usage, and completion status back to the shared contract. The adapter uses the platform HTTP transport directly, so no provider SDK types or transport objects cross the `Sampler` boundary. Provider-side response storage is disabled because Session owns the transcript.

`OpenAIResponsesSampler` owns cancellation/deadline enforcement and bounded transient retries. It retries transport unavailability and provider responses classified as transient (`408`, `409`, retryable `429`, and `5xx`), honors a bounded `Retry-After`, and defaults to at most two retries after the initial request. Invalid requests, authentication failures, exhausted quota, invalid provider payloads, and cancellation are not retried. Raw error bodies remain private; failures crossing the boundary are sanitized `SamplingError` values. AgentLoop does not inspect provider status codes or implement provider retry policy, and tool execution is never retried by the sampler.

The current shared contract is sufficient for the Phase 1 portable transcript loop and therefore remains unchanged. One intentionally deferred interoperability boundary is provider-owned opaque continuation data, such as reasoning items that some model modes require to be replayed verbatim. Phase 1 neither leaks those wire items into Session nor adds stateful provider-response chaining. Support for such modes requires a separate provider-neutral continuation design before it is enabled.

Add another adapter only when it is actually needed; do not scaffold placeholder provider files.

---

### 4.4 Session and Chat State

```text
src/session/
├── session.ts
├── turn.ts
├── session-store.ts
└── in-memory-session-store.ts
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

Start with an in-memory `SessionStore`. The stable store port preserves a persistence seam, but durability is not promised until Phase 4. Do not create both `SessionStore` and `SessionRepository` for the same responsibility.

Do not introduce a separate `ChatState` until it has a responsibility distinct from the session's ordered turns. Token accounting and richer model/runtime metadata are added by their owning slices.

When runtime events are introduced in Phase 3, use one canonical event model. Do not duplicate session, runtime, and global event types for the same lifecycle fact. Full event sourcing remains optional.

---

### 4.5 Context Engine

```text
src/context/
└── context-builder.ts
```

Phase 1 includes only a minimal `ContextBuilder` that assembles system instructions, conversation messages, and native tool definitions. Phase 2 turns this seam into the explicit, budget-aware Context Engine shown above.

Its Phase 1 contract accepts an `AgentDefinition`, the current `Session`, a runtime-owned model call ID, and already-selected native `ModelToolDefinition` values. It returns the provider-neutral `ModelRequest` consumed by `Sampler`. It preserves turn and entry order, performs no tool execution or discovery, and does not read project files.

The builder emits one `context.build` span with structural counts. Prompt contents and tool arguments are not recorded as trace attributes. Token budgeting, pluggable context sources, project rules, pruning, and compaction remain Phase 2 additions; do not scaffold them in Phase 1.

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

`ToolBridge` is the single entry point from Runtime to Tools. Its Phase 1 execution context requires session and turn correlation IDs and optionally carries an `AbortSignal`. It resolves tools only through `ToolRegistry`, validates with the selected tool's input validator, and emits one `tool.execute` span.

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

Initial built-in tools:

- `read_file`
- `list_files`
- `grep`
- `write_file` or `apply_patch`
- `run_command`

`ToolBridge` owns this dispatch pipeline; do not add a separate executor until a distinct execution responsibility appears. Before Phase 3, a minimal `PermissionPolicy` must deny mutations by default or explicitly authorize them. Full rules, approval flows, and hooks arrive in Phase 3.

The `Tool` contract accepts a normalized `ToolCall` plus optional cancellation and returns a normalized `ToolResult`. Native tools validate their own input contract and convert capability failures into bounded structured failures. `ToolBridge` rejects invalid calls before dispatch and normalizes registry, access, or unexpected pipeline failures while preserving this canonical result shape.

Phase 1 read-only native tools are `read_file`, `list_files`, and `search_text`. They depend only on `FileSystemCapability`; they never import Node.js filesystem APIs. `search_text` owns literal matching, recursion, and bounded match formatting while composing the capability's read/list operations.

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

Each local operation emits one `workspace.operation` span at the adapter boundary. It records operation kind, success, duration, and safe output counts, but not requested paths or file contents.

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

```text
src/project-rules/
├── rules-loader.ts
└── rules-resolver.ts
```

Support `AGENTS.md`-style project instructions.

Example:

```text
repo/AGENTS.md
repo/src/payments/AGENTS.md
```

When operating under `src/payments`, the Context Engine can combine applicable rules according to defined precedence.

---

### 4.10 Skills

```text
src/skills/
├── skill.ts
├── skill-loader.ts
├── skill-manager.ts
└── skill-selector.ts
```

Skills are reusable prompt/instruction packages.

They belong to context/capability composition, not the core agent loop.

Initial format can follow:

```text
skills/<name>/SKILL.md
```

Skills may later be:

- explicitly invoked
- dynamically selected
- discovered from project/user scopes

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
├── permission-policy.ts             (Phase 1)
├── permission-engine.ts             (Phase 3)
├── permission-rule.ts               (Phase 3)
├── access-kind.ts                   (Phase 3)
└── dangerous-command-detector.ts    (Phase 3)
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

Phase 1 uses the smallest enforceable form of this boundary: a `PermissionPolicy` that must make a decision before a mutating tool runs. Phase 3 adds rule composition, ask flows, modes, and richer policy evaluation.

---

### 4.14 Hooks

```text
src/hooks/
├── hook-manager.ts
├── hook.ts
└── hook-events.ts
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
SessionEnd
```

Hooks extend behavior without modifying the core loop.

Hooks are not required for Phase 0 or Phase 1. Direct calls at explicit boundaries are clearer until more than one lifecycle extension exists.

---

### 4.15 Events

```text
src/events/
├── event-bus.ts
└── runtime-event.ts
```

Example events:

```text
SessionStarted
TurnStarted
ContextBuilt
ModelStarted
ModelCompleted
ToolStarted
ToolCompleted
CompactionStarted
CompactionCompleted
TurnCompleted
SessionCompleted
```

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

Mutating tool calls are not retried automatically unless the operation has an explicit idempotency guarantee. Boundary errors should be normalized for callers while retaining their cause, category, and retryability for diagnostics.

---

### 4.18 Composition Root

The executable entry point owns dependency construction:

```text
CLI composition root
  → creates Sampler, SessionStore, ContextBuilder, ToolBridge, Workspace
  → injects them into SessionRuntime / AgentLoop
```

Do not hide initial wiring behind a dependency-injection framework. Runtime components consume interfaces and must not instantiate provider SDKs, concrete workspaces, or telemetry backends themselves.

The Phase 1 composition root lives in `src/cli/phase-one-cli.ts`. It constructs the in-memory `SessionStore`, `ContextBuilder`, `AgentLoop`, read-only tool registry and bridge, and local filesystem capability around an injected `Sampler` and tracer. Injecting these two existing boundaries keeps the same path runnable with either `OpenAIResponsesSampler` or a deterministic fake without adding a second runtime path.

### 4.19 Phase 1 CLI

```text
src/cli/
├── main.ts
└── phase-one-cli.ts
```

The CLI is a one-shot presentation and composition boundary. It accepts one prompt, resolves a model ID into the existing `AgentDefinition.model.modelId` field, selects a workspace root, calls `SessionRuntime` once, and prints the final answer. It does not inspect or reproduce model/tool loop state, dispatch tools, or own session orchestration.

The model ID is selected with `--model` or `AGENT_HARNESS_MODEL`. `OPENAI_API_KEY` configures the concrete OpenAI adapter and is never accepted as a command-line argument. `--workspace` defaults to the current directory and is resolved to the absolute root enforced by `LocalFileSystemCapability`.

Phase 1 remains intentionally one-shot and in-memory. There is no REPL/TUI, permission prompt, resume command, background work, or persistent session storage. Existing runtime spans provide tool/model activity when the default console tracing exporter is used; the CLI does not create duplicate lifecycle spans.

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

Observability and lifecycle subscribers may observe boundaries but should not reverse dependency direction or change business outcomes.

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
ToolBridge
 ↓
ReadFileTool
 ↓
LocalWorkspace
 ↓
ToolResult
 ↓
Model
 ↓
Final Answer
```

Once this works and is traced, the project has a real harness core.

Everything after that is capability growth.
