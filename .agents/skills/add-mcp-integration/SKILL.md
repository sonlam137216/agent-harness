---
name: add-mcp-integration
description: Add or change MCP connectivity while keeping MCP outside the core agent loop and routing discovered tools through the internal tool runtime.
---

# Add MCP Integration

## Boundary

```text
MCP Server
→ MCP Client/Manager
→ Tool Catalog
→ search_tools / invoke_tool
→ ToolBridge
→ permissions/hooks/tracing
```

AgentLoop must not contain MCP-specific branching.

## Workflow

1. Add transport/client logic in MCP layer.
2. Normalize server and tool metadata into ToolCatalog.
3. Handle qualified naming and collisions.
4. Refresh the search index.
5. Keep model-facing external-tool access behind stable meta-tools.
6. Route invocation through normal permission/hooks/tracing.
7. Normalize MCP text/image/resource results.
8. Add reconnect/error tests where relevant.
9. Add tracing for search and call latency.

Do not inject every discovered MCP schema into every model request.
