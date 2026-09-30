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

Phase 1 had no active-turn concurrency enforcement. Phase 4 adds explicit session-scoped exclusive operations for separate CLI processes, without introducing an actor or queue.

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

Implemented with an asynchronous ContextBuilder, replaceable token estimation, Workspace-backed scoped rules, projection-only pruning, and bounded Sampler summaries. Phase 2 originally kept checkpoints in memory; Phase 4 now persists them through SessionStore. See [CONTEXT-ENGINE.md](CONTEXT-ENGINE.md).

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

Implemented; see [PHASE-3.md](PHASE-3.md) for rule matching, mode defaults, approval, lifecycle failure contracts, and CLI examples. The native tool registry remains read-only. The older planning document proposed workspace mutation as an extension; that proposal is not part of this phase checklist. File editing and command execution still need their own explicitly requested workspace/tool slices.

## Permissions

- [x] `PermissionEngine`
- [x] replace the Phase 1 inline read-only guard with explicit permission decisions
- [x] `AccessKind`
- [x] allow rules
- [x] ask rules
- [x] deny rules
- [x] `deny > ask > allow`
- [x] modes: ask / auto / always-approve

## Hooks

- [x] hook registry
- [x] `SessionStart`
- [x] `TurnStart`
- [x] `BeforeModel`
- [x] `AfterModel`
- [x] `PreToolUse`
- [x] `PostToolUse`
- [x] `TurnEnd`

## Events

- [x] one canonical runtime event model and event bus
- [x] model lifecycle events
- [x] tool lifecycle events
- [x] persistence subscriber
- [x] tracing subscriber

Session and Runtime must not define duplicate event types for the same lifecycle fact.

Exit criteria:

- dangerous tool calls can be denied independently of the model
- lifecycle behavior can be extended without editing the agent loop

---

# Phase 4 — Persistent Sessions

Goal: resume and inspect agent work.

Implemented with versioned JSON records, atomic filesystem replacement, exclusive session operations, durable progress snapshots and CLI resume/list/show/rewind. See [PHASE-4.md](PHASE-4.md) for recovery, usage and locking limits. `pnpm smoke:persistence` verifies restart/resume in separate processes without a live provider.

- [x] file or SQLite session store
- [x] session metadata
- [x] conversation persistence
- [x] tool-call persistence
- [x] token usage persistence
- [x] resume session
- [x] session list
- [x] basic rewind of conversation state
- [x] trace/session correlation

Exit criteria:

- stop process
- restart process
- resume previous session
- continue conversation correctly

---

# Phase 5 — Skills

Goal: support reusable procedural knowledge.

- [x] `SKILL.md` parser
- [x] project skill discovery
- [x] user skill discovery
- [x] skill precedence
- [x] explicit skill invocation
- [x] skill context injection
- [x] optional automatic skill selection
- [x] trace skill selection/injection

Implemented through a Workspace-backed ContextSource, with project-over-user precedence,
turn-scoped `$name` / `--skill` invocation, opt-in lexical selection, bounded discovery and full
context-budget accounting. See [PHASE-5.md](PHASE-5.md) for format and selection limits.

Exit criteria:

- reusable workflow can be added without changing TypeScript code

---

# Phase 6 — MCP and Dynamic Tool Retrieval

Goal: scale to many external integrations without dumping all schemas into the model context.

Implemented; see [PHASE-6.md](PHASE-6.md) for configuration, target authorization,
stdio/Streamable HTTP, BM25 catalog search, refresh/recovery and bounded output.
[PHASE-6-PLAN.md](PHASE-6-PLAN.md) preserves the original preparation proposal.

## MCP

- [x] MCP manager
- [x] stdio connection
- [x] HTTP/streamable connection
- [x] tool discovery
- [x] reconnect/error handling
- [x] result normalization

## Tool Catalog

- [x] normalized external tool metadata
- [x] qualified names
- [x] collision handling
- [x] BM25 index
- [x] catalog refresh

## Model-facing meta-tools

- [x] `search_tools`
- [x] return relevant schemas
- [x] `invoke_tool`
- [x] route through permissions/hooks/tracing

Exit criteria:

```text
100+ external tools
```

can be available while only a small stable tool surface is always sent to the model.

---

# Phase 7 — Code Retrieval / Token Optimization

Goal: reduce repository exploration cost.

- [x] 7.1: versioned exploration tasks, hashed fixture, scripted benchmark and opt-in live reporting
- [x] 7.2: opt-in bounded lexical retrieval with optional context budgeting
- [x] 7.3a: coverage signals separated from selection limits
- [x] 7.3b: one retrieval scan per turn (in-memory per-turn cache)
- [ ] 7.3c: measured live comparison with human-reviewed correctness and evidence coverage
  (deferred: a 2026-09-29 pilot with qwen3:1.7b made no read_file calls in either mode,
  so it could not test read reduction; rerun with a stronger tool-calling model)

Phase 7.1–7.2 and the 7.3a–b preparation are implemented; see [PHASE-7.md](PHASE-7.md). Scripted runs verify
accounting, not model quality or token savings. No live-model baseline has been
claimed. The remaining sequence is described in [PHASE-7-PLAN.md](PHASE-7-PLAN.md).

Create with the retrieval slice:

```text
src/context/retrieval/code/
```

Potential adapters:

- [x] lexical code search
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

- [x] retrieved token count
- [x] source token contribution
- [x] files considered
- [x] files selected
- [x] retrieval latency
- [x] cache hit/miss

Phase 7.3b reports per-turn cache hits on `context.code_retrieval`; a cross-turn
cache would need an invalidation strategy and is not implemented.

Exit criteria:

- common codebase tasks require materially fewer `read_file` calls and input tokens

---

# Phase 8 — Memory

Goal: preserve useful knowledge across sessions.

Phase 8.1 (read path), 8.2 (write path) and 8.3 (session summaries) are implemented;
see [PHASE-8.md](PHASE-8.md).

Start simple:

- [x] Markdown memory store
- [x] workspace memory
- [x] global (user) memory
- [x] write path: `memory add` CLI command and permission-gated `save_memory` tool (8.2)
- [x] session summaries: explicit `sessions summarize <id>` (8.3)
- [x] BM25 ranking (in-memory; persistent SQLite FTS deferred until corpus size needs it)
- [x] memory context source
- [ ] memory search tool
- [x] first-turn retrieval (memory is selected for every turn from its user message)
- [x] post-compaction retrieval (memory is reloaded from files on every build, independent of the transcript)

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

- [x] `SubagentManager`
- [x] child session creation (persisted, linked by `metadata.parent`)
- [x] max depth = 1
- [x] explore role
- [x] plan role
- [x] review role (test role deferred until command execution exists)
- [x] background execution (`background: true`, `await_subagent`, `cancel_subagent`)
- [x] result handoff (bounded report + sources + usage)
- [x] parent/child trace linking
- [x] capability restrictions (native read tools only, parent rules, token budget)

See [PHASE-9.md](PHASE-9.md).

Exit criteria:

- parent can delegate exploration while preserving its own context window

---

# Phase 10 — Worktrees and Isolation

Goal: let independent agents modify code safely.

- [x] `GitWorktreeWorkspace` (Workspace capabilities bound to a worktree root + `GitWorktreeCapability`)
- [x] create worktree (one branch per implement child)
- [x] bind child session to worktree
- [x] inspect diff (`worktrees diff`)
- [x] apply/merge changes (`worktrees apply`: atomic, refused on conflict)
- [x] cleanup lifecycle (`worktrees remove`: refuses unapplied work unless forced)

See [PHASE-10.md](PHASE-10.md).

Exit criteria:

- two independent sessions can modify the same repository without sharing working-tree state

---

# Phase 11 — Sandbox

Goal: enforce environment boundaries below the model/tool permission layer.

Begin with a replaceable interface:

- [x] `SandboxPolicy`
- [x] path rules (read/private/protected/write)
- [x] command rules (bare allowlisted names, no shell)
- [x] environment filtering (allowlist, private HOME/TMPDIR)

Then choose an implementation:

- [ ] Docker/container sandbox
- [x] OS-level sandbox (macOS Seatbelt, `sandbox-exec`)
- [ ] remote sandbox

See [PHASE-11.md](PHASE-11.md).

Exit criteria:

- restricted sessions cannot bypass policy by executing shell commands directly

---

# Phase 12 — Agent Protocol / External Clients

Goal: separate runtime from UI.

- [x] JSON-RPC or ACP-compatible server (ACP v1 over stdio, `acp` command)
- [x] session creation (`session/new`, `session/load` with replay)
- [x] prompt streaming (per message; token-level streaming deferred)
- [x] tool-call streaming (`tool_call` / `tool_call_update`)
- [x] permission requests (`session/request_permission`)
- [x] IDE/client integration (any ACP client; sessions shared with the CLI)

See [PHASE-12.md](PHASE-12.md).

Exit criteria:

```text
CLI
IDE
web UI
CI
```

can use the same harness runtime.

---

# Phase 13 — Practical Use

Goal: make the harness usable on a real project by composing existing capabilities for
the main session.

- [x] 13.1 direct edit mode (`--edit`): write/edit in the main tree, ask by default,
  diff preview on approval
- [x] 13.2 sandboxed commands in the main tree (`--commands`, macOS Seatbelt)
- [x] 13.3 configurable loop limit (`--max-iterations`, CLI default 25)
- [x] 13.4 interactive `chat` command over one persisted session
- [x] 13.5 concurrent execution of approval-free read-only tool calls
- [x] 13.6 Anthropic prompt caching
- [x] 13.7 quiet terminal output (`AGENT_HARNESS_TRACE`, default off for CLI commands)
- [x] 13.8 provider-aware context/output defaults and `--model-timeout`
- [x] 13.9 tool progress lines on stderr for chat and one-shot runs
- [x] 13.10 credential files hidden from tools and sandboxed commands; command approval warnings
- [x] 13.11 OpenAI-compatible provider fixes from the first live runs (Groq)
- [ ] token-level streaming
- [ ] Linux sandbox backend
- [ ] project configuration file

See [PHASE-13.md](PHASE-13.md).

Exit criteria:

```text
chat → read → edit (approved) → run tests (sandboxed) → fix → final answer
```

works on a real repository without worktree round trips.

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
