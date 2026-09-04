---
name: context-optimization
description: Analyze and reduce model input-token usage by improving context selection, tool schema exposure, retrieval, pruning, or compaction without degrading correctness.
---

# Context Optimization

## Principle

Measure before optimizing.

## Inspect

For a representative turn, break input tokens down by:

- system instructions
- conversation
- project rules
- skills
- native tools
- MCP/external tools
- memory
- retrieval
- tool results

## Optimization order

Prefer:

1. remove duplicate context
2. avoid sending irrelevant tool schemas
3. prune oversized old tool results
4. retrieve code on demand
5. summarize stable repository context
6. compact old conversation
7. use caching/stable model-facing surfaces

## MCP rule

Prefer:

```text
search_tools
→ relevant schemas
→ invoke_tool
```

instead of exposing all external schemas every turn.

## Codebase rule

Prefer:

```text
task
→ GitNexus/AST/semantic retrieval
→ relevant symbols/files
→ ContextBuilder
```

instead of broad file reads.

## Report

Include:
- baseline tokens
- dominant contributors
- proposed change
- expected savings
- correctness risk
- measurements needed after change
