---
name: implement-vertical-slice
description: Implement exactly one roadmap capability end-to-end while preserving architecture boundaries. Use for normal feature implementation.
---

# Implement Vertical Slice

## Read first

- `AGENTS.md`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/OBSERVABILITY.md`

## Rules

Implement only the requested roadmap slice.

Do not:
- implement future phases
- add unrelated abstractions
- refactor neighboring code unless required
- introduce MCP, memory, subagents, sandbox, or retrieval early unless the task explicitly belongs to that phase

## Workflow

1. Restate the requested slice in one sentence.
2. Identify affected architectural boundaries.
3. Inspect existing interfaces before adding new ones.
4. Implement the smallest end-to-end path.
5. Add/update tests.
6. Add required tracing/events.
7. Run relevant checks.
8. Review the diff for architecture drift.

## Final summary

Report:
- what was implemented
- files changed
- architectural boundaries used
- tests/checks run
- tracing added
- intentionally deferred work
