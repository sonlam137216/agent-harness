---
name: add-sampler
description: Add a new model/provider adapter behind the Sampler abstraction without leaking provider-specific types into Runtime, Tools, or Session.
---

# Add Sampler

## Boundary rule

```text
Runtime
→ Sampler interface
→ Provider adapter
→ Model API
```

## Responsibilities of a provider adapter

Map internal requests to provider format and normalize responses back to:

- text
- tool calls
- reasoning metadata when supported
- token usage
- stop reason
- errors/retries metadata

## Workflow

1. Read the shared sampling types first.
2. Do not modify AgentLoop to accommodate provider quirks unless the internal abstraction is genuinely insufficient.
3. Implement request mapping.
4. Implement streaming/non-streaming normalization as required.
5. Normalize tool calls into the common format.
6. Normalize usage and stop reasons.
7. Handle provider errors in the adapter boundary.
8. Add model-call tracing attributes.
9. Add contract tests against shared Sampler behavior.

Avoid exposing provider SDK objects outside the adapter.
