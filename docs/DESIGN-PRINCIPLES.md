# Design Principles

These principles are the architectural guardrails for the project.

## 1. Keep the Agent Loop Simple

The core loop should remain understandable without reading the entire repository.

It should visibly express:

```text
build context
→ call model
→ execute tools if requested
→ feed results back
→ repeat or finish
```

Complexity belongs behind subsystem boundaries.

---

## 2. Model Is Not the Harness

The model reasons and selects actions.

The harness provides:

- context
- tools
- environment
- persistence
- safety
- retries
- observability
- lifecycle

Do not push runtime responsibilities into prompts when they can be enforced by code.

---

## 3. Model Providers Are Replaceable

The runtime depends on a `Sampler`, not OpenAI, Anthropic, Grok, or Ollama directly.

Provider-specific behavior stays in adapters.

---

## 4. MCP Is an Adapter, Not Core Architecture

MCP is one way external capabilities enter the harness.

The internal architecture should still work if MCP is removed or replaced.

```text
Runtime → ToolBridge → Tool contract ← MCP adapter → MCP client
```

not:

```text
Runtime → MCP-specific logic
```

---

## 5. Retrieve External Tools on Demand

Large external tool catalogs should not automatically become large model prompts.

Prefer:

```text
Tool Catalog
→ search
→ relevant schema
→ invoke
```

over:

```text
all external tool schemas
→ every model request
```

---

## 6. Context Selection and Action Execution Are Different Problems

Use this rule:

```text
SELECT information → Context / Retrieval
DO something        → Tools / Workspace
```

Examples:

- GitNexus → Retrieval
- AST symbol graph → Retrieval
- semantic code search → Retrieval
- file write → Tool/Workspace
- shell command → Tool/Workspace
- Git commit → Tool/Workspace

---

## 7. Workspace Owns the Execution Environment

Tools do not own the filesystem, shell, or Git implementation.

Workspace provides those capabilities.

This allows local, worktree, container, sandbox, and remote execution to share the same agent/tool logic.

---

## 8. Safety Is Enforced Outside the Model

The model may request an action.

The harness decides whether that action is allowed.

Permissions, deny rules, sandbox restrictions, and approval flows must not depend solely on prompt compliance.

A roadmap phase must not expose a mutating capability before an enforceable permission decision exists. A minimal deny-by-default policy is sufficient before the full permission engine is implemented.

---

## 9. Observability Is Part of the Runtime Contract

Every important boundary should be observable:

- context build
- model call
- tool call
- workspace command
- MCP search/call
- retries
- compaction
- subagent execution

A complex agent without tracing is difficult to debug, optimize, or trust.

---

## 10. Session State Must Be Durable

Long-running agent tasks should not depend only on in-memory state.

Design stable session identity and a `SessionStore` boundary from the beginning. Phase 1 may use an in-memory implementation; durability begins in Phase 4. Do not claim restart/resume behavior before then.

---

## 11. Compaction Is Context Management, Not Memory

Compaction answers:

> What can be compressed or removed from the active context?

Memory answers:

> What knowledge should survive across sessions?

Keep them separate.

---

## 12. Skills, Rules, and Memory Have Different Roles

```text
Project Rules
= how this repository must be handled

Skills
= how to perform a reusable workflow

Memory
= what was learned before
```

Do not merge them into one generic prompt store.

---

## 13. Prefer Stable Model-Facing Interfaces

Changing tool schemas or system structure on every loop can increase context churn and reduce caching effectiveness.

Prefer stable primitives and retrieve dynamic capabilities behind them.

---

## 14. Concurrency Is a Harness Decision

The model may emit multiple tool calls.

The harness decides whether they are safe to run in parallel.

Examples:

```text
read A + read B      → parallel possible
grep + read          → parallel possible
edit A + edit A      → serialize
git mutation + edit  → evaluate conflict
```

Do not assume all tool calls are safely parallel.

---

## 15. Subagents Are Isolated Sessions

A subagent should have its own:

- context
- model loop
- tool scope
- lifecycle

Start with a flat hierarchy:

```text
root → child
child → child ❌
```

This avoids uncontrolled recursive agent trees.

---

## 16. Add Abstractions at Boundaries, Not Everywhere

Useful interfaces:

- Sampler
- Workspace
- Tool
- SessionStore
- Retriever
- PermissionPolicy

Avoid creating factories, managers, providers, strategies, and registries for code that has only one simple responsibility and no architectural boundary.

Likewise, do not create both a store and a repository for the same persistence responsibility, or separate event models for the same lifecycle fact.

---

## 17. Build Vertical Slices

Prefer:

```text
prompt
→ model
→ read tool
→ result
→ final answer
```

before separately implementing ten incomplete subsystems.

A harness is learned best by following real end-to-end execution.

---

## 18. Optimize Only What You Can Observe

Before optimizing:

- tool count
- token use
- retrieval
- compaction
- retries
- caching
- parallelism

make them measurable with tracing and metrics.

---

## 19. Documentation Is Architectural State

When a top-level boundary changes, update architecture docs in the same change.

Documentation drift is architecture drift.

---

## 20. Start Small, Preserve the Seams

The first implementation can be simple:

```text
one model
one local workspace
five tools
in-memory session storage
basic tracing
```

Durable JSON or SQLite session storage arrives in the persistence phase. The important part is preserving seams that allow later replacement without rewriting the agent loop.

---

## 21. Make Failure Ownership Explicit

Every boundary should document which failures it normalizes and which retries it owns.

```text
provider transport retry      → Sampler adapter
agent iteration and stopping  → Runtime
tool validation and dispatch  → ToolBridge
environment operation failure → Workspace
```

Do not automatically retry a mutating operation without an explicit idempotency guarantee. Cancellation and deadlines should propagate through all active boundaries.

---

## 22. Separate Current Shape from Target Shape

Future seams are useful architectural constraints, but they are not a request to create empty modules today.

Each roadmap phase should add only the directories, interfaces, and implementations required by its vertical slice. Architecture diagrams must label later-phase capabilities clearly.
