---
name: harness-debug
description: Debug agent-loop, context, tool, model, retry, session, or workspace failures using execution flow and tracing before changing code.
---

# Harness Debug

## Principle

Do not guess from the final error alone.

Trace the execution path:

```text
Session
→ Turn
→ Context Build
→ Model Call
→ Tool Call
→ Permission
→ Workspace/MCP
→ Tool Result
→ Next Model Call
```

## Workflow

1. Reproduce the issue if possible.
2. Identify:
   - session_id
   - turn_id
   - loop iteration
   - model_call_id
   - tool_call_id
3. Inspect trace/log events in chronological order.
4. Determine the failing boundary:
   - Context
   - Sampler
   - AgentLoop
   - ToolBridge
   - Permission
   - Workspace
   - MCP
   - Session persistence
5. Check for:
   - repeated identical tool calls
   - missing/incorrect tool results
   - provider normalization bugs
   - token/context overflow
   - permission rejection
   - cancellation deadlocks
   - retry loops
6. Fix the smallest responsible layer.
7. Add a regression test.
8. Improve observability if the bug was difficult to diagnose.

Do not work around runtime bugs by adding prompt instructions unless the issue is genuinely model behavior.
