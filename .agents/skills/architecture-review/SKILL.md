---
name: architecture-review
description: Review proposed or implemented architecture changes against the agent-harness boundaries. Use before introducing a new subsystem, dependency, or top-level abstraction.
---

# Architecture Review

## Read first

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/DESIGN-PRINCIPLES.md`
- relevant section of `docs/ROADMAP.md`

## Goal

Review architecture without implementing code unless explicitly asked.

## Review checklist

1. Identify the responsibility being added or changed.
2. Locate the correct layer:
   - orchestration → Runtime
   - model provider → Sampler
   - context selection → Context/Retrieval
   - action execution → Tools/Workspace
   - external integration → MCP/adapter
   - safety → Permissions/Sandbox
   - lifecycle extension → Hooks/Events
   - diagnostics → Observability
3. Check dependency direction.
4. Detect duplicated responsibilities.
5. Detect premature abstractions.
6. Check whether the change keeps the AgentLoop simple.
7. Check whether model-specific details leak outside Sampler.
8. Check whether filesystem/shell/Git access bypasses Workspace.
9. Check whether safety relies on prompt compliance instead of harness enforcement.
10. Check tracing impact.

## Output

Return:

- architecture decision
- correct layer
- dependency impact
- risks
- simpler alternative if one exists
- docs that must change

Do not invent new layers unless a current boundary cannot cleanly own the responsibility.
