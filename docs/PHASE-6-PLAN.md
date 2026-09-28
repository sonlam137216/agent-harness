# Phase 6 preparation — MCP and dynamic tool retrieval

Assessment date: 2026-09-22. Baseline: `cd3f247`, initially clean working tree.
Status: historical preparation proposal. Phase 6 was subsequently implemented;
see [PHASE-6.md](PHASE-6.md) for the shipped contract and differences from these proposals.

## Current phase verified

Phase 0–5 are complete against the current roadmap. Phase 5 supplies parsing,
bounded project/user discovery, precedence, explicit invocation, opt-in automatic
selection, budgeted injection and tracing. Its CLI integration tests verify that
skills cannot bypass permissions, persist invocation intent and reload current
skill files on resume. Native tools remain `read_file`, `list_files`, `search_text`.

`pnpm validate` passed: formatting, lint, type checking, 35 test files / 215 tests,
build and the separate-process persistence smoke (restart, transcript/usage and
interrupted-call recovery). No live model or external MCP server was exercised.
This is readiness evidence, not a security audit or a live-provider certification.

The next roadmap phase is **Phase 6 — MCP and Dynamic Tool Retrieval**. Native
file mutation and general command execution are separate deferred capabilities.
The historical `PROJECT-STATUS-AND-PLAN.md` is not the current implementation status.

## Architecture decision

Add the planned `src/mcp/` integration boundary to solve external tool discovery
and invocation without expanding every model request by the entire catalog.

| Responsibility | Owner and dependency |
| --- | --- |
| Connect, discover, call, disconnect | MCP manager/client adapter; protocol SDK confined here |
| Qualified identity and atomic catalog snapshots | MCP tool catalog, independent of Runtime |
| Rank tool metadata and return selected schemas | Catalog search index and `search_tools`; Context still owns token budgets |
| Resolve an invocation and execute its target | Generic ToolBridge delegation contract, then a normal Tool adapter |
| Authorize actual target and immutable arguments | Existing PermissionEngine and hooks inside ToolBridge |
| Launch and terminate a local MCP server | Narrow Workspace process capability used by the stdio adapter |
| Compose configuration, connections and cleanup | CLI composition root |

Keep AgentLoop, Sampler and Session free of MCP imports. Do not introduce a second
executor, event model, persistence backend or background supervisor. A small map
of configured connections suffices for the manager. Catalog search can stay local
to MCP; a general retrieval framework is unnecessary for this phase.

## Existing seams and required changes

- `ToolRegistry.getModelDefinitions()` currently exposes every registered tool.
  Add explicit visibility metadata/options: external adapters are registered for
  dispatch but hidden from model-definition projection. Native defaults stay visible.
- `ToolBridge` currently resolves only a top-level name and hardcodes
  `tool.kind=native`. Add protocol-neutral delegation and origin metadata; keep the
  existing validation → hooks → authorization → execution pipeline authoritative.
- `Tool.execute` receives only cancellation, not runtime correlation. Resolve
  delegation in ToolBridge, which already owns the correlation context, rather
  than injecting a second bridge into `invoke_tool` or reaching into Runtime.
- `AccessKind` already includes `external`; default auto mode denies it. Use that
  classification for every MCP target initially. Server read-only annotations
  cannot promote it to an automatically authorized read.
- Workspace has filesystem and record storage, but no process capability. Add only
  the bounded duplex process lifecycle needed for stdio, not a model-facing shell tool.
- Session already persists JSON arguments/results. Keep the original `invoke_tool`
  call and its result ID intact; target identity/version must remain visible in the
  result envelope. No automatic replay on reconnect or resume.

## Invocation contract to implement first

Proposed stable surface:

```text
search_tools({ query, limit? })
  → { tools: [{ name, description, inputSchema, version }], truncated }
invoke_tool({ name, version, arguments })
  → bounded normalized target result
```

`search_tools` reads the in-memory catalog; it does not launch arbitrary servers.
`invoke_tool` resolution is side-effect-free and may resolve only a registered,
hidden external target, never another meta-tool or a native tool. Use a generic
optional delegation resolver on the internal Tool contract; allow one hop only.

The bridge validates the wrapper, enforces wrapper policy, resolves and pins the
target, validates target arguments against its schema, runs target PreToolUse,
authorizes the qualified target name/access/destructive classification and calls
the target once. Target PostToolUse sees the actual result. Wrapper allowance is
never target allowance; denial of either blocks dispatch. Classify the wrapper as
local routing (`read`) so the default external denial is evaluated on the target.
Explicit wrapper ask/deny rules still apply. Hooks remain immutable and cannot
override either permission decision. Document and test wrapper and target hook order.

Use one logical tool call ID, one ToolStarted/ToolCompleted pair and one
`tool.execute` span for the model call; record requested and effective names on
that span and distinguish the two authorization checks. Return the original call
ID to Session. This avoids nested transcript entries and duplicate lifecycle facts.

Qualified names must be deterministic and collision-safe. Use a configured server
alias plus reversible encoding of the raw tool name; do not concatenate ambiguous
delimiters or silently overwrite duplicates. Enforce bounded names and fail explicit
collisions. Bind `version` to the current catalog generation, target schema and
policy metadata; stale requests fail before dispatch and require another search.
Do not switch targets during approval. If the pinned generation is invalidated,
return a stale-target error without calling the server.

## Transport, configuration and safety

MCP is opt-in through explicit run configuration, proposed as `--mcp-config <path>`.
Do not auto-run commands discovered in the repository or in server instructions.
Read configuration through Workspace. Configured command/argument arrays, contained
cwd and an explicit environment allowlist are trusted application inputs; never use
a shell string or pass the full host environment. Configuration selects servers
for startup; per-call permission does not authorize server installation or startup.
Local server processes are not sandboxed, even when cwd is contained.

Workspace owns spawn, stdin/stdout lifecycle, bounded framing/output, cancellation,
timeout and termination. MCP owns JSON-RPC framing and protocol behavior. Verify
the SDK's custom transport interface before wiring its stdio convenience transport:
that convenience API owns spawning, so using it directly would bypass Workspace.
No provider sampling or elicitation callbacks are enabled in the initial client.

Prefer the official TypeScript SDK over hand-writing the protocol. Official docs
currently identify v2 as stable and show separate client imports; confirm the exact
published version, Node 22/TypeScript compatibility, schema validator dependencies,
license and transitive dependencies when implementing, then lock the selected version.
There is no dependency installation in this preparation change.

HTTP later uses explicitly configured endpoints and fresh run-time credentials.
Do not persist credentials or transport session IDs in harness Session. Authentication
failures surface intentionally; interactive OAuth and legacy SSE fallback are out
of the initial scope. Resume rediscovers tools and requires fresh configuration and
permissions. Reconnect restores availability, never automatically replays a call.

## Bounded catalog and results

Initial proposed application limits: 1,000 catalog tools, 64 KiB per schema,
8 MiB aggregate discovery metadata, 5 search results, 16 KiB search response,
64 KiB normalized call result and a 30-second operation timeout. All are configurable
within validated bounds; transport message limits must also bound memory before parsing.
Reject schemas that cannot fit; never return an incomplete schema as executable.
Use a JSON Schema validator compatible with the negotiated protocol, disable remote
reference fetching and reject unsupported schemas explicitly.

Start with deterministic lexical matching, then implement BM25 over names and
descriptions (not arbitrary schema bodies), with stable name tie-breaking. Replace
catalog and index together only after a complete bounded discovery succeeds.
Handle pagination, repeated cursors, malformed entries and disconnects explicitly.
Retain old metadata for diagnostics on refresh failure, but mark invalidated targets
unavailable until rediscovery succeeds. Do not invoke removed tools through stale handles.

Normalize MCP tool errors separately from transport/protocol failures. Preserve text
and structured JSON within limits; represent images/audio/blob resources as explicit
omitted-content metadata, since current provider-neutral messages are text/JSON only.
Preserve bounded resource-link metadata without fetching links. Label truncation and
unsupported content; do not imply that the model saw omitted media. Oversized results
may follow a completed side effect: report that distinction and never retry them.

Search results enter ordinary tool-result history and count toward conversation
tokens; only the two meta-tool definitions contribute permanent external-tool schema
tokens. Context remains the final budget authority. Current-turn results are not
pruned, so bounded output can still produce an explicit `budget_exceeded` failure.

## Incremental delivery and acceptance

| Slice | Scope | Required evidence |
| --- | --- | --- |
| 6.1 — One stdio vertical slice | Workspace process lifecycle, SDK adapter, one configured server, bounded discovery, hidden registrations, lexical search and target-authorized invocation | FakeSampler → search → invoke → real fixture stdio server → final response; denied target has zero call side effects; cancellation/cleanup pass |
| 6.2 — Catalog at scale | Multiple servers, BM25, pagination, atomic refresh and stale-version rejection | 100+ fixture tools; same permanent model schemas at 1 and 100+ tools; collisions/refresh races deterministic; bounded search payload |
| 6.3 — HTTP and recovery | Streamable HTTP, authentication error mapping, disconnect/reconnect and rediscovery | Local HTTP fixture tests; timeouts/cancellation/disconnect; no replay after ambiguous execution; cleanup on every exit |

Each slice requires relevant tests, tracing and documentation before the next starts.
Phase 6 is complete only when all roadmap items and the 100+ tools criterion pass.

Tests must also cover: target deny overriding wrapper allow and always-approve;
missing approval; destructive approval floor; invalid target input; hook veto;
catalog replacement during approval; result ID preservation; interrupted resume;
server errors and malformed/oversized results; secret-free traces; and unchanged
native-tool behavior with MCP disabled. Use fixture servers without hosted credentials.

Trace `mcp.search` beneath search execution and `mcp.call` beneath target execution,
using existing session/turn/model/tool correlation. Record catalog size, result count,
duration, safe configured server identity, normalized failure and result byte count.
Do not record queries, raw schemas, arguments/results, URLs with credentials, stderr
or environments. Test observer/export failures do not change execution outcomes.

## Implementation handoff

Next implementation request should target **6.1 only**. Before production code:
confirm SDK/custom-transport and schema-validation choices with a small fixture
spike, then finalize the generic delegation contract in architecture docs. Update
ARCHITECTURE, OBSERVABILITY, ROADMAP and a new PHASE-6 usage document with each shipped
slice; update AGENTS.md current phase only when the full phase exits. No Phase 7
retriever, memory, plugins, subagents, worktrees or sandbox is part of this plan.

Primary references checked on 2026-09-22:

- [Official TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)
- [Client connections and transport ownership](https://ts.sdk.modelcontextprotocol.io/v2/clients/connect)
- [Tool annotations and host enforcement](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)

The boundaries, limits and delivery sequence above are harness design proposals,
not protocol requirements.
