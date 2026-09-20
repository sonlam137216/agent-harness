# Agent Harness Development Rules

## Purpose

This repository is a learning-oriented AI agent harness inspired by the architectural lessons of Waku Agent, DeepSeek Harness, and Grok Build.

The goal is not to copy any one implementation. The goal is to build a small, understandable harness first, while preserving boundaries that can scale toward a production coding agent.

## Source of Truth

Before making architectural changes, read:

1. `docs/ARCHITECTURE.md`
2. `docs/DESIGN-PRINCIPLES.md`
3. `docs/ROADMAP.md`
4. `docs/OBSERVABILITY.md`

If code and documentation disagree, stop and update the architecture intentionally rather than silently drifting.

## Current Phase

The repository has completed **Phase 2 — Context Engine**.

Phase 1 core and its read-only CLI are complete, including OpenAI Responses, Anthropic Messages, and Ollama Chat adapters. Phase 2 adds budget-aware context sources, scoped project rules, historical tool-result pruning, and model-assisted compaction with in-memory checkpoints. See `docs/CONTEXT-ENGINE.md` for the current contract and limits.

Implement one roadmap capability at a time. Do not start Phase 3 or another capability until explicitly requested. File mutation, command execution, durable sessions, hooks, and events remain unavailable.

Do not implement advanced capabilities before the core end-to-end loop works.

Unless explicitly requested, do not implement:

- MCP
- memory
- subagents
- worktrees
- sandboxing
- plugins
- remote workspaces
- vector search

## Architectural Rules

### Runtime

- `SessionRuntime` owns session-level orchestration around one synchronous `AgentLoop` run.
- `SessionRuntime` creates or loads session state, creates one turn, and persists the turn before and after loop execution.
- Concurrency control, queues, background work, actor semantics, and mailboxes are not part of the Phase 1 `SessionRuntime`.
- `AgentLoop` owns the model → tool → model iteration.
- `Turn` is session state; Runtime coordinates it but does not define a second turn model.
- Runtime code must not directly access the filesystem, shell, Git, or model-provider SDKs.

### Model

- All model providers are behind the `Sampler` abstraction.
- Provider-specific request/response mapping stays inside the model layer.
- Tools must never call model providers directly.

### Context

- Context selection is separate from action execution.
- Anything whose job is to decide **what information should be sent to the model** belongs in Context/Retrieval.
- Anything whose job is to **perform an action** belongs in Tools/Workspace.
- Token-budget decisions belong to the Context layer.

### Tools

- `ToolBridge` is the single runtime entry point for tool execution.
- Tools are registered through a registry.
- A permission decision must occur before any mutating tool executes. Hooks are added later according to the roadmap.
- Tracing and result normalization wrap tool execution.
- Tools should depend on Workspace interfaces rather than Node.js filesystem/process APIs directly.

### Workspace

- Workspace owns filesystem, terminal, and Git access.
- Workspace enforces root/path containment for filesystem operations and command working directories, and carries cancellation, timeout, output-limit, and environment constraints to concrete operations.
- Working-directory containment is not an OS sandbox: an authorized command may still access resources outside the workspace until a sandbox implementation exists.
- Prefer narrow filesystem, command, and Git capabilities over one unbounded `workspace.git(...)` or `workspace.execute(...)` API.
- Local execution is only one implementation of Workspace.
- The design must allow future worktree, container, sandbox, or remote workspace implementations.

### MCP

- MCP is an integration capability, not part of the core agent loop.
- MCP tools integrate through the internal tool abstraction.
- External MCP tool schemas should eventually be retrieved on demand rather than all being injected into every model request.

### Safety

- Permission enforcement must happen in the harness, not rely on the model behaving correctly.
- Deny rules always override allow rules.
- Destructive actions must be representable as explicit permission decisions.
- Until the full permission engine exists, mutating tools must be unavailable or protected by a minimal deny-by-default policy.

### Observability

- Every session, turn, model call, and tool call must have correlation IDs.
- Tracing must not change business behavior.
- Never log raw secrets, API keys, auth headers, or sensitive environment variables.

### Retries and Errors

- Provider adapters own retries for transient provider transport failures.
- Runtime owns loop continuation, iteration limits, and turn cancellation.
- Mutating tools are not retried automatically without an explicit idempotency guarantee.
- Errors crossing a boundary must be normalized without losing their cause or retryability.

## Development Style

- Prefer clear interfaces at architectural boundaries.
- Prefer simple implementations behind those interfaces.
- Avoid abstraction before there are at least two meaningful implementations or a clear architectural boundary.
- Keep the main agent loop readable.
- Implement one roadmap capability at a time.
- Prefer vertical slices that can be run end-to-end.
- Add tests around behavior and boundaries, not implementation details.

## Change Discipline

When introducing a new top-level subsystem:

1. Explain which existing problem it solves.
2. Explain where it sits in the dependency graph.
3. Confirm it does not violate existing dependency rules.
4. Update the architecture docs.
5. Only then implement it.

## Testing Priorities

Prioritize tests for:

- agent loop stop/continue behavior
- model response normalization
- tool dispatch
- permission decisions
- workspace path boundaries
- retry behavior
- context-budget behavior
- session persistence

## Definition of Done for a Feature

A feature is not complete until:

- its responsibility is clear
- its dependencies follow the architecture
- errors are surfaced intentionally
- relevant tracing is emitted
- tests cover the core behavior
- documentation is updated when architecture changes
