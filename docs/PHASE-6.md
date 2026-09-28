# Phase 6 — MCP and dynamic tool retrieval

Phase 6 adds explicitly configured MCP servers behind two stable model-facing tools:
`search_tools` and `invoke_tool`. The three native filesystem tools remain read-only.
The agent loop, provider adapters and persisted session schema have no MCP dependency.

## Configure and run

Create a workspace-relative `mcp.json`. Configuration is loaded only when explicitly
supplied; repository discovery and server instructions cannot start processes.

```json
{
  "servers": [
    {
      "alias": "local",
      "transport": "stdio",
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/server.js"],
      "cwd": ".",
      "env": ["PATH"]
    },
    {
      "alias": "service",
      "transport": "http",
      "url": "https://example.com/mcp",
      "headersFromEnv": { "Authorization": "MCP_AUTHORIZATION" }
    }
  ]
}
```

Use an actual installed server and endpoint; these values are examples. An HTTP
Authorization environment value includes its scheme, for example `Bearer …`.
Environment variable names are selected explicitly; missing values fail configuration.
No secrets are copied into session configuration or traces. As with other tools,
arguments and returned content are persisted in the transcript and should not contain
credentials unnecessarily.

```sh
pnpm cli -- --provider ollama --model <model-id> --mcp-config mcp.json \
  --permission-mode ask "Find the configured tools and use one to answer my question"
```

Servers connect lazily on the first search. Explicit configuration authorizes starting
those application-owned integrations; per-tool permissions are separate. StdIO uses
argument arrays without a shell, an explicit environment and Workspace-contained cwd,
including canonical symlink checks. This is not an OS sandbox: the configured executable
can access host resources. There is no native `run_command` tool.

HTTP supports Streamable HTTP JSON and SSE responses. Use HTTPS except for loopback
HTTP fixtures/services. URLs with embedded credentials, fragments and redirects are
rejected. Authentication headers come from fresh run-time environment variables;
interactive OAuth and legacy HTTP+SSE fallback are not implemented.

## Search, identity and authorization

```text
search_tools({ query: "find project issue", limit: 3 })
  → { tools: [{ name, description, inputSchema, version }], truncated }
invoke_tool({ name, version, arguments: { ... } })
  → normalized result
```

Search uses deterministic BM25 over names/descriptions, with qualified-name tie breaks.
Schemas do not affect ranking. Qualified names have the form
`mcp:<configured-alias>:<percent-encoded-raw-tool-name>`. Duplicate aliases and raw tool
names within one server fail; the same raw name on different servers stays distinct.
Only matching complete schemas are returned. The catalog supports up to 1,000 tools;
125-tool tests verify the permanent model tool definitions remain unchanged.

External registrations are hidden from the model-definition list and cannot be called
directly by a top-level model call. `invoke_tool` delegates exactly once through
ToolBridge. The pipeline validates and runs PreToolUse/permissions for the wrapper,
then validates and runs PreToolUse/permissions for the actual target. Target hooks
receive the qualified name and actual immutable arguments. PostToolUse runs for the
executed target only; hook failure cannot replace a completed result.

All targets have `accessKind=external`, so default auto mode denies them. A wrapper
allow never grants target access. Exact target deny rules win, including in
always-approve mode. Server read-only hints do not make an external tool an automatic
read. Missing/true destructive hints impose the existing approval floor; even an
allow rule or always-approve then requires affirmative approval. Server metadata is
not a substitute for reviewing the configured server and selecting a permission policy.

For a reviewed non-destructive target, an exact rule can allow it:

```sh
pnpm cli -- --model <model-id> --mcp-config mcp.json \
  --allow-tool 'mcp:local:lookup' "Look up the requested information"
```

The bridge pins the target registration during authorization. Catalog changes during
approval fail before dispatch. The original model call ID, `invoke_tool` arguments
and one corresponding result remain the durable transcript; no synthetic nested model
call is introduced. Successful/remote-error result envelopes include target and version.

## Refresh and recovery

Tool-list notifications invalidate the server's registrations immediately. The next
search rediscovers the dirty server and publishes a complete new catalog/index snapshot.
Unchanged healthy connections are reused. Pagination is bounded; repeated cursors and
malformed or excessive catalogs fail explicitly. Failed refresh leaves that server's
targets unavailable; another search can retry discovery. Other server registrations
remain separate. There is no background reconnect loop or persistent catalog cache.

Versions combine a random per-manager identity with a generation, so a prior run’s
handle cannot match a new catalog after restart. They are not durable handles. Resume requires
`--mcp-config` again and fresh permissions, then a new search; old versions must not
be used as authorization. Interrupted calls remain governed by Phase 4's execution-
unknown recovery and are never replayed automatically.

Transport failure closes/invalidate the connection. The next search can reconnect and
rediscover; invocation itself is never retried. The SDK receives the exact discovered
definition on each call, disabling its automatic changed-header definition retry.
No sampling, elicitation, task or resource-reading capability is exposed to servers.

## Bounds and supported schemas

Current fixed application limits:

| Boundary | Limit |
| --- | --- |
| Configured servers | 16 |
| Discovery pages per server | 32 |
| Catalog entries across servers | 1,000 |
| Discovery metadata | 8 MiB per server and across published entries |
| StdIO line / HTTP response stream | 1 MiB |
| Search query / results | 512 characters / at most 5 tools |
| Individual searchable entry | 15,000 bytes |
| Search response | 16 KiB |
| Normalized invocation result | 64 KiB |
| SDK operation timeout | 30 seconds (adapter constructor can override) |

StdIO stderr is drained and discarded. Teardown closes stdin, sends SIGTERM and
escalates to SIGKILL after 500 ms, then closes owned streams. It manages the configured
child, not an OS-isolated process tree. HTTP redirects and automatic stream reconnect
are disabled. These are resource bounds for trusted configured integrations, not a
sandbox for hostile programs.

Input schemas use Ajv with JSON Schema 2020-12 by default; an explicit draft-07 URI
selects draft-07. Root inputs must be objects. Remote references, regex constraints,
asynchronous validators and `x-mcp-header` schema extensions are currently rejected.
Unknown schema keywords fail; `format` remains annotation-only. Schema traversal is
limited to depth 32. Unsupported or unsearchably large schemas fail that server's
catalog publication rather than being silently weakened or truncated.

Text and structured JSON are preserved within the result bound. Resource links are
metadata only and are never fetched. Text embedded resources are preserved; binary,
image and audio content becomes explicit omitted-content metadata. Current Sampler
messages remain text/JSON only. Oversized or invalid post-call output returns an error
without implying that a completed side effect was undone or should be retried.

Context counts retrieved schemas as conversation tool-result tokens, not permanent
tool definitions. Current-turn results are not pruned; cumulative output can still
exceed the context budget and fail explicitly. Original transcript data is preserved.

## Errors, tracing and verification

Configuration, schema, catalog, authentication, timeout, cancellation and transport
failures use sanitized errors. Raw SDK bodies/exception messages, stderr, environments,
queries and returned content are excluded from traces. There is one logical
ToolStarted/ToolCompleted pair and `tool.execute` span per model call, with requested
and effective names. `permission.evaluate` identifies which tool is being authorized.
`mcp.search` and `mcp.call` nest under that span and include session/turn/model correlation;
call tracing also records the original tool-call ID. Counts, byte sizes, duration and
normalized outcome support debugging without dumping payloads.

```sh
pnpm exec vitest run test/mcp
pnpm validate
```

Tests use real temporary stdio processes and localhost HTTP fixtures with a fake model;
no hosted credentials are needed. The suite covers stable schemas at 125 tools,
permissions, hooks, version invalidation, schema rejection, result bounds, JSON/SSE,
auth failures, cancellation, cwd containment, pagination and no invocation replay.
Local tests require permission to open loopback sockets. Full validation also retains
all prior phase checks and the separate-process persistence recovery smoke.

Verified on 2026-09-23: `pnpm validate` passed formatting, lint, type checking,
37 test files / 237 tests, build and the persistence restart/recovery smoke.
External transport evidence uses fixture servers; no hosted service or live model
credentials were exercised.

Deferred: OAuth flows, legacy SSE fallback, multimodal model messages, arbitrary JSON
Schema extensions, native workspace mutation, sandboxing and Phase 7+ capabilities.
