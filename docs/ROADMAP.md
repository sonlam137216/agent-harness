# Agent Harness Roadmap

The roadmap is intentionally incremental.

Do not start the next phase because it is interesting. Start it when the previous phase has a working end-to-end path.

---

# Phase 0 — Repository Foundation

Goal: establish architectural constraints before implementation.

Decisions for the initial repository:

```text
Runtime:       Node.js 22
Language:      TypeScript, strict mode, ESM
Package tool:  pnpm
Tests:         Vitest
Quality:       ESLint + Prettier
Tracing:       OpenTelemetry API/SDK with console export
```

- [x] Create project scaffold
- [x] Add `AGENTS.md`
- [x] Add architecture documentation
- [x] Choose language/runtime
- [x] Configure formatter/linter/tests
- [x] Add minimal structured logger
- [x] Define ID types: session, turn, model call, tool call
- [x] Add basic tracing setup behind one Observability module

Create only:

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

Do not create empty subsystem directories in Phase 0.

Exit criteria:

- Codex can read the repository rules
- project builds
- `pnpm validate` runs format checking, linting, type checking, tests, and build
- a trace can be created and exported to console/logs
- tracing initialization/export failures are contained and can fall back to no-op behavior
- structured logging applies default redaction for known secret fields

---

# Phase 1 — Core Harness

Goal: execute a minimal model → tool → model loop.

## Agent

- [x] `AgentDefinition`
- [x] provider-neutral model configuration
- [x] system prompt

Start with one immutable definition. Add an `Agent` runtime object or builder only when a second construction or behavior path requires it.

## Model

- [x] `Sampler` interface
- [x] shared provider-neutral sampling types
- [x] cancellation/deadline propagation contract
- [x] normalized sampling failure contract
- [x] OpenAI Responses, Anthropic Messages, and Ollama Chat sampler implementations
- [x] text response normalization
- [x] tool-call response normalization
- [x] token usage extraction
- [x] stop reason normalization

## Session

- [x] `Session`
- [x] `Turn`
- [x] `SessionStore` port
- [x] `InMemorySessionStore`

No separate `ChatState` is introduced until it has a responsibility distinct from Session's ordered turns.

## Runtime

- [x] minimal synchronous `SessionRuntime`
- [x] `AgentLoop`
- [x] model/tool loop
- [x] max-iteration safety limit
- [x] cancellation and deadline path through the loop
- [x] normalized stop reasons drive loop completion/failure
- [x] latest transcript is preserved when a later iteration fails

`SessionRuntime` creates or loads session state, creates one user turn, delegates to `AgentLoop`, persists the result, and owns the top-level trace spans. It intentionally has no actor, mailbox, queue, background-processing, or concurrency-management semantics.

At-most-one-active-turn enforcement is deferred until a concurrent API or interactive runtime exists; it must be added as its own capability rather than hidden inside the Phase 1 synchronous coordinator.

## CLI

- [x] one-shot read-only CLI composition root
- [x] explicit provider selection at the CLI composition root
- [x] model selection through `AgentDefinition.model.modelId`
- [x] final answer presentation
- [x] credential-free full-path smoke test with `FakeSampler`

Interactive sessions, a TUI, permission prompts, and persistent session commands are intentionally outside the Phase 1 CLI.

## Context

- [x] minimal `ContextBuilder`
- [x] system instructions
- [x] conversation messages
- [x] native tool definitions

Token budgeting, pluggable context sources, project rules, pruning, and compaction remain in Phase 2.

## Tools

- [x] `Tool` interface
- [x] `ToolRegistry`
- [x] `ToolBridge`
- [x] strict input validation in Phase 1 native tools
- [x] normalized `ToolResult` from Phase 1 native tools
- [x] inline Phase 1 guard denies every non-read tool before dispatch

## Workspace

- [x] narrow read-only `FileSystemCapability`
- [x] local filesystem adapter
- [x] read-only workspace composition in the CLI root
- [x] `read_file`
- [x] `list_files`
- [x] `search_text`
- [x] filesystem-root and path-containment enforcement
- [x] cancellation and timeout propagation across the complete runtime
- [x] bounded filesystem reads and directory listings

`write_file`/`apply_patch`, `run_command`, command output limits, and environment filtering are intentionally unavailable in the read-only Phase 1 harness. Every future write or command execution must receive an explicit permission decision. The full rule engine and approval workflow remain in Phase 3.

## Failure behavior

- [x] normalized provider errors retain a sanitized cause, category, and retryability
- [x] provider transport retries remain inside the provider adapter
- [x] tool operations are not retried automatically
- [x] cancellation reaches active model and workspace operations
- [x] failed later iterations preserve prior model/tool transcript entries

## Observability

- [x] session span
- [x] turn span
- [x] model span
- [x] tool span
- [x] model token usage attributes
- [x] model and loop latency attributes
- [x] session/turn/model/tool correlation across active spans
- [x] normalized error attributes and error span status
- [x] tracing failures do not change harness behavior

## Tests

- [x] agent loop stop/continue and max-iteration behavior
- [x] provider response normalization
- [x] tool validation and dispatch
- [x] Phase 1 non-read denial decision
- [x] workspace path boundaries
- [x] AgentLoop cancellation and no-retry ownership
- [x] normalized stop-reason outcomes
- [x] later-iteration failure persistence

Exit criteria:

```text
User prompt
→ model
→ read-only workspace tool
→ model
→ final answer
```

is possible from the CLI and fully traceable. Mutating files and running commands remain unavailable until their permission and workspace slices are implemented.

---

# Phase 2 — Context Engine

Goal: make model context explicit and budget-aware.

Implemented with an asynchronous ContextBuilder, replaceable token estimation, Workspace-backed scoped rules, projection-only pruning, and bounded Sampler summaries. Checkpoints remain in memory; no Phase 3–12 capabilities are enabled. See [CONTEXT-ENGINE.md](CONTEXT-ENGINE.md).

- [x] extend the Phase 1 `ContextBuilder`
- [x] `ContextSource` abstraction
- [x] context/token budget
- [x] system instructions source
- [x] conversation source
- [x] tool definitions source
- [x] project rules (`AGENTS.md`)
- [x] context accounting trace
- [x] tool-result pruning
- [x] basic compaction
- [x] compaction checkpoints

Exit criteria:

- context composition can be inspected
- token contribution per source is measurable
- long sessions can compact and continue

---

# Phase 3 — Permissions, Hooks, and Events

Goal: make execution controllable and extensible.

## Permissions

- [ ] `PermissionEngine`
- [ ] replace the Phase 1 inline read-only guard with explicit permission decisions
- [ ] `AccessKind`
- [ ] allow rules
- [ ] ask rules
- [ ] deny rules
- [ ] `deny > ask > allow`
- [ ] modes: ask / auto / always-approve

## Hooks

- [ ] hook registry
- [ ] `SessionStart`
- [ ] `TurnStart`
- [ ] `BeforeModel`
- [ ] `AfterModel`
- [ ] `PreToolUse`
- [ ] `PostToolUse`
- [ ] `TurnEnd`

## Events

- [ ] one canonical runtime event model and event bus
- [ ] model lifecycle events
- [ ] tool lifecycle events
- [ ] persistence subscriber
- [ ] tracing subscriber

Session and Runtime must not define duplicate event types for the same lifecycle fact.

Exit criteria:

- dangerous tool calls can be denied independently of the model
- lifecycle behavior can be extended without editing the agent loop

---

# Phase 4 — Persistent Sessions

Goal: resume and inspect agent work.

- [ ] file or SQLite session store
- [ ] session metadata
- [ ] conversation persistence
- [ ] tool-call persistence
- [ ] token usage persistence
- [ ] resume session
- [ ] session list
- [ ] basic rewind of conversation state
- [ ] trace/session correlation

Exit criteria:

- stop process
- restart process
- resume previous session
- continue conversation correctly

---

# Phase 5 — Skills

Goal: support reusable procedural knowledge.

- [ ] `SKILL.md` parser
- [ ] project skill discovery
- [ ] user skill discovery
- [ ] skill precedence
- [ ] explicit skill invocation
- [ ] skill context injection
- [ ] optional automatic skill selection
- [ ] trace skill selection/injection

Exit criteria:

- reusable workflow can be added without changing TypeScript code

---

# Phase 6 — MCP and Dynamic Tool Retrieval

Goal: scale to many external integrations without dumping all schemas into the model context.

## MCP

- [ ] MCP manager
- [ ] stdio connection
- [ ] HTTP/streamable connection
- [ ] tool discovery
- [ ] reconnect/error handling
- [ ] result normalization

## Tool Catalog

- [ ] normalized external tool metadata
- [ ] qualified names
- [ ] collision handling
- [ ] BM25 index
- [ ] catalog refresh

## Model-facing meta-tools

- [ ] `search_tools`
- [ ] return relevant schemas
- [ ] `invoke_tool`
- [ ] route through permissions/hooks/tracing

Exit criteria:

```text
100+ external tools
```

can be available while only a small stable tool surface is always sent to the model.

---

# Phase 7 — Code Retrieval / Token Optimization

Goal: reduce repository exploration cost.

Create:

```text
src/context/retrieval/code/
```

Potential adapters:

- [ ] lexical code search
- [ ] symbol index
- [ ] AST index
- [ ] dependency graph
- [ ] GitNexus adapter
- [ ] semantic code search
- [ ] repository summarizer

Retrieval pipeline:

```text
Task
 ↓
Code Retriever
 ↓
Relevant symbols/files/relationships
 ↓
Context Builder
 ↓
Model
```

Metrics:

- [ ] retrieved token count
- [ ] source token contribution
- [ ] files considered
- [ ] files selected
- [ ] retrieval latency
- [ ] cache hit/miss

Exit criteria:

- common codebase tasks require materially fewer `read_file` calls and input tokens

---

# Phase 8 — Memory

Goal: preserve useful knowledge across sessions.

Start simple:

- [ ] Markdown memory store
- [ ] workspace memory
- [ ] global memory
- [ ] session summaries
- [ ] SQLite FTS/BM25
- [ ] memory search tool/context source
- [ ] first-turn retrieval
- [ ] post-compaction retrieval

Later:

- [ ] embeddings
- [ ] hybrid retrieval
- [ ] temporal decay
- [ ] deduplication/MMR

Exit criteria:

- new sessions can retrieve relevant previous decisions without replaying old conversations

---

# Phase 9 — Subagents

Goal: delegate parallel or specialized work.

- [ ] `SubagentManager`
- [ ] child session creation
- [ ] max depth = 1
- [ ] explore role
- [ ] plan role
- [ ] review/test role
- [ ] background execution
- [ ] result handoff
- [ ] parent/child trace linking
- [ ] capability restrictions

Exit criteria:

- parent can delegate exploration while preserving its own context window

---

# Phase 10 — Worktrees and Isolation

Goal: let independent agents modify code safely.

- [ ] `GitWorktreeWorkspace`
- [ ] create worktree
- [ ] bind child session to worktree
- [ ] inspect diff
- [ ] apply/merge changes
- [ ] cleanup lifecycle

Exit criteria:

- two independent sessions can modify the same repository without sharing working-tree state

---

# Phase 11 — Sandbox

Goal: enforce environment boundaries below the model/tool permission layer.

Begin with a replaceable interface:

- [ ] `SandboxPolicy`
- [ ] path rules
- [ ] command rules
- [ ] environment filtering

Then choose an implementation:

- [ ] Docker/container sandbox
- [ ] OS-level sandbox
- [ ] remote sandbox

Exit criteria:

- restricted sessions cannot bypass policy by executing shell commands directly

---

# Phase 12 — Agent Protocol / External Clients

Goal: separate runtime from UI.

- [ ] JSON-RPC or ACP-compatible server
- [ ] session creation
- [ ] prompt streaming
- [ ] tool-call streaming
- [ ] permission requests
- [ ] IDE/client integration

Exit criteria:

```text
CLI
IDE
web UI
CI
```

can use the same harness runtime.

---

# What Not to Do Early

Avoid implementing these in Phase 1:

- distributed queues
- actor frameworks or background mailboxes around `SessionRuntime`
- recursive multi-agent graphs
- vector databases
- elaborate plugin marketplaces
- Kubernetes execution
- OS kernel sandboxing
- multiple persistence backends
- generalized workflow DSLs

The project should grow because a previous phase exposes a concrete need.
