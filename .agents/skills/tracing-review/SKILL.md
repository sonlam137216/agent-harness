---
name: tracing-review
description: Review whether a feature or bug has sufficient logs, metrics, trace spans, and correlation IDs for debugging and token/performance analysis.
---

# Tracing Review

## Read first

- `docs/OBSERVABILITY.md`

## Required correlation

Check presence and propagation of:

- session_id
- turn_id
- model_call_id
- tool_call_id
- subagent_id when applicable

## Review important spans

Depending on the feature:

- `session.run`
- `turn.run`
- `context.build`
- `model.sample`
- `tool.execute`
- `permission.evaluate`
- `workspace.operation`
- `mcp.search`
- `mcp.call`
- `retrieval.code`
- `compaction`

## Check useful attributes

Prefer counts, timings, sizes, and classifications over raw payloads.

Examples:

- input/output token count
- context source token counts
- latency
- retry count
- tool result bytes
- permission decision
- retrieval candidate/selection counts
- cache hit/miss

## Sensitive-data check

Do not log:
- API keys
- auth headers
- tokens
- raw secrets
- arbitrary environment values
- full prompts/tool outputs by default

## Output

Return:
- missing spans
- missing correlation
- missing metrics
- excessive/noisy telemetry
- sensitive-data risks
- recommended minimal additions
