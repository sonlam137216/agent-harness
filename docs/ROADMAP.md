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

- [ ] `Sampler` interface
- [ ] shared sampling types
- [ ] one provider implementation
- [ ] text response normalization
- [ ] tool-call response normalization
- [ ] token usage extraction
- [ ] stop reason normalization

## Session

- [ ] `Session`
- [ ] `Turn`
- [ ] `ChatState`
- [ ] in-memory session store

## Runtime

- [ ] `SessionActor`
- [ ] `AgentLoop`
- [ ] model/tool loop
- [ ] max-iteration safety limit
- [ ] cancellation path
- [ ] at most one active turn per session

`SessionActor` is an in-process coordinator in this phase; no actor framework or background queue is required.

## Context

- [ ] minimal `ContextBuilder`
- [ ] system instructions
- [ ] conversation messages
- [ ] native tool definitions

Token budgeting, pluggable context sources, project rules, pruning, and compaction remain in Phase 2.

## Tools

- [ ] `Tool` interface
- [ ] `ToolRegistry`
- [ ] `ToolBridge`
- [ ] argument validation
- [ ] result normalization
- [ ] minimal deny-by-default `PermissionPolicy`

## Workspace

- [ ] `Workspace` interface
- [ ] `LocalWorkspace`
- [ ] `read_file`
- [ ] `list_files`
- [ ] `grep`
- [ ] `write_file` or `apply_patch`
- [ ] `run_command`
- [ ] workspace-root and path-containment enforcement
- [ ] cancellation and timeout propagation
- [ ] command output limits
- [ ] environment filtering

Every write or command execution must receive an explicit permission decision. The full rule engine and approval workflow remain in Phase 3.

## Failure behavior

- [ ] normalized errors retain cause, category, and retryability
- [ ] provider transport retries remain inside the provider adapter
- [ ] mutating tools are not retried automatically
- [ ] cancellation reaches active model and workspace operations

## Observability

- [ ] session span
- [ ] turn span
- [ ] model span
- [ ] tool span
- [ ] token usage attributes
- [ ] latency attributes

## Tests

- [ ] agent loop stop/continue and max-iteration behavior
- [ ] provider response normalization
- [ ] tool validation and dispatch
- [ ] minimal permission decisions
- [ ] workspace path boundaries
- [ ] cancellation and retry ownership

Exit criteria:

```text
User prompt
→ model
→ read file
→ model
→ modify file
→ model
→ run command
→ model
→ final answer
```

is possible and fully traceable.

---

# Phase 2 — Context Engine

Goal: make model context explicit and budget-aware.

- [ ] extend the Phase 1 `ContextBuilder`
- [ ] `ContextSource` abstraction
- [ ] context/token budget
- [ ] system instructions source
- [ ] conversation source
- [ ] tool definitions source
- [ ] project rules (`AGENTS.md`)
- [ ] context accounting trace
- [ ] tool-result pruning
- [ ] basic compaction
- [ ] compaction checkpoints

Exit criteria:

- context composition can be inspected
- token contribution per source is measurable
- long sessions can compact and continue

---

# Phase 3 — Permissions, Hooks, and Events

Goal: make execution controllable and extensible.

## Permissions

- [ ] `PermissionEngine`
- [ ] replace/extend the Phase 1 minimal `PermissionPolicy`
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
- actor frameworks or background mailboxes for the initial `SessionActor`
- recursive multi-agent graphs
- vector databases
- elaborate plugin marketplaces
- Kubernetes execution
- OS kernel sandboxing
- multiple persistence backends
- generalized workflow DSLs

The project should grow because a previous phase exposes a concrete need.
