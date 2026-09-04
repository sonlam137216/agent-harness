---
name: add-tool
description: Add a native harness tool through ToolRegistry, ToolBridge, permissions, Workspace, tracing, and tests. Use whenever adding a new executable capability.
---

# Add Native Tool

## Boundary rule

```text
AgentLoop
→ ToolBridge
→ Tool
→ Workspace
```

Never:

```text
Tool
→ fs / child_process / git library directly
```

when the operation belongs to Workspace.

## Workflow

1. Define the tool's responsibility.
2. Decide its access kind:
   - read
   - write
   - execute
   - external
3. Define strict input schema.
4. Implement through Workspace capability where applicable.
5. Register through ToolRegistry.
6. Ensure ToolBridge execution path is used.
7. Add permission classification.
8. Add tracing:
   - tool name
   - duration
   - result size
   - success/failure
9. Normalize model-facing output.
10. Add tests for:
    - valid input
    - invalid input
    - permission rejection
    - workspace error
    - success path

Do not add provider-specific logic to a tool.
