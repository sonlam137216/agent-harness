# Phase 12 — Agent Protocol / External Clients

Phase 12 separates the runtime from the UI. `acp` runs the harness as an **Agent Client
Protocol** (ACP) agent: JSON-RPC 2.0 over stdio, the protocol editors such as Zed use for
external agents. Every prompt is an ordinary `SessionRuntime` turn composed exactly like
a one-shot CLI run, so the CLI, an IDE and CI share one runtime, one session store and
one set of tools, permissions and traces.

## Problem and placement

Until now the only client was the one-shot CLI. It printed the final answer and asked for
approvals on the terminal. External clients need to create and resume sessions, see
messages and tool calls as they happen, answer permission requests and cancel. They must
not re-implement the agent loop.

```text
editor / other ACP client
   │  stdin/stdout, newline-delimited JSON-RPC 2.0
   ▼
src/protocol/json-rpc.ts      JsonRpcConnection (bidirectional, bounded, concurrent)
src/protocol/acp-agent.ts     AcpAgent: ACP methods, per-session prompt state
src/protocol/acp-updates.ts   transcript entries → session/update payloads
   │  AcpPromptRunner port
   ▼
src/cli/acp-cli.ts            runAcpServer: runner = runPhaseOneCli(...) per prompt
   → SessionRuntime → AgentLoop → ContextBuilder / Sampler / ToolBridge (unchanged)
```

The protocol module depends on Runtime-level types (EventBus, SessionStore,
PermissionRequest), not on the CLI. The CLI composition root implements the
`AcpPromptRunner` port. Streaming uses the existing canonical events: `SessionUpdated`
carries new transcript entries and `ToolStarted` marks execution. No Runtime, AgentLoop,
Sampler, ToolBridge or Session schema change was needed.

## Running it

```sh
pnpm build
node dist/src/cli/main.js acp --provider ollama --model <model-id> [run options]
```

Start the built entry point directly: `pnpm cli` prints build output to stdout, which
would corrupt the protocol stream. All one-shot run options apply: `--memory`,
`--subagents`, `--worktrees`, `--sandbox`, `--mcp-config`, `--permission-mode`,
`--allow-tool`/`--deny-tool`, `--session-dir`, budget and retrieval flags. `--skill` is
per prompt, so write `$skill-name` in the prompt. The workspace comes from each
session's `cwd`. The permission mode defaults to **ask**, so every write or execute call
becomes a client permission request unless a rule decides it.

In an editor, register it as a custom agent server that runs this command. For example,
Zed's external-agent settings take a command and arguments (check your editor's
documentation for the exact key):

```json
{
  "command": "node",
  "args": ["/abs/path/agent-harness/dist/src/cli/main.js", "acp",
           "--provider", "ollama", "--model", "qwen3"]
}
```

## Protocol surface (ACP version 1)

| Method | Direction | Behaviour |
| --- | --- | --- |
| `initialize` | client → agent | Returns `protocolVersion: 1`, `loadSession: true`, text-only prompts, no auth methods, `agentInfo`. Other methods fail until it is called |
| `authenticate` | client → agent | Accepted (no methods are advertised) |
| `session/new` | client → agent | `{ cwd, mcpServers }` → `{ sessionId }`. Creates and saves an empty session whose workspace is `cwd` (must be absolute) |
| `session/load` | client → agent | `{ sessionId, cwd, mcpServers }`. Replays every saved turn as updates, then returns `null`. Refuses subagent sessions and a different `cwd` |
| `session/prompt` | client → agent | `{ sessionId, prompt }` runs one turn and returns `{ stopReason }` after all its updates |
| `session/cancel` | notification | Aborts the session's running prompt |
| `session/update` | agent → client | Streamed progress (below) |
| `session/request_permission` | agent → client | Asks to allow one tool call |

**Prompt content.** `text` blocks, plus `resource_link` blocks rendered as
`[Resource: name uri]`. Images, audio and embedded resources are not advertised and are
rejected.

**Stop reasons.** `completed` → `end_turn`, `max_iterations` → `max_turn_requests`,
cancelled or deadline → `cancelled`. A failed turn or harness error is a JSON-RPC error
(`-32603`) with the same sanitized message the CLI prints. Malformed traffic gets standard
JSON-RPC errors: `-32700` parse, `-32600` invalid request (including a second prompt on a
busy session), `-32601` unknown method, `-32602` invalid params.

**Updates.** These are per message and per tool event; text arrives one model response
at a time, not token by token.

| Transcript event | `session/update` |
| --- | --- |
| Assistant text | `agent_message_chunk` |
| Assistant tool call | `tool_call` with `title` (e.g. `read_file README.md`), `kind` (read/search/edit/execute/think/other), `status: pending`, `rawInput`, absolute `locations` for path arguments |
| ToolBridge starts it | `tool_call_update` `in_progress` |
| Tool result | `tool_call_update` `completed`/`failed` with the output as text (≤ 8000 characters) |
| Replay only | `user_message_chunk` for earlier prompts |

Subagent children stream nothing themselves. Only the parent's `delegate_task` call and
its result appear.

**Permissions.** When the engine decides `ask`, the approval handler sends
`session/request_permission` with the tool call and two options: `allow` (`allow_once`)
and `reject` (`reject_once`). Only `{ outcome: { outcome: "selected", optionId: "allow" } }`
grants the call. Rejection, `cancelled`, a malformed answer, a disconnect or cancelling the
prompt denies it, and the tool reports `access_denied`. Grants never outlive the call.
Deny rules still win and are never sent to the client.

**MCP servers.** Client-provided `mcpServers` are ignored with a stderr diagnostic;
configure servers with `--mcp-config` on the agent (`mcpCapabilities` advertises neither
HTTP nor SSE).

## Sessions and lifecycle

- ACP sessions live in the same store as CLI sessions (`--session-dir`, default
  `~/.agent-harness/sessions`). `sessions list/show/rewind/summarize` work on them, the CLI
  can `--resume` an ACP session, and `session/load` replays turns created by the CLI.
- A session created with `session/new` starts empty. Its first prompt stores the runtime's
  agent definition, and later prompts reuse the saved one, as CLI resume does.
- One prompt runs per session at a time; different sessions run concurrently. The store's
  session lock still protects against other processes.
- Requests are handled concurrently, so `session/cancel` and permission answers arrive
  during a prompt. When the client closes stdin, running prompts are cancelled and the
  server waits for them to save their final (`cancelled`) state before exiting.
- Lines are limited to 16 MiB. Batches are not supported.

## Observability

stdout carries only protocol messages. In `acp` mode spans go to stderr as one JSON line
each (`StderrSpanExporter`). `protocol.prompt` (`protocol.name=acp`, `session.id`,
`protocol.outcome`) wraps each prompt, and the usual `session.run` → `turn.run` → … tree
nests under it. Prompt text, tool arguments and outputs are never span attributes.

## Verification

```sh
pnpm exec vitest run test/protocol
pnpm validate
```

`test/protocol/acp.test.ts` drives the server with an in-process ACP client over paired
streams, the real runtime and a scripted model. It covers:

- **JSON-RPC errors:** `initialize`-first, parse, unknown method and invalid params.
- **Streaming:** the exact update sequence for a read-then-answer turn. Every update
  precedes the response, and every stdout line is JSON-RPC.
- **Permissions:** rejected (nothing written) and allowed (note written) round trips for a
  gated tool.
- **Cancellation:** cancel, a refused concurrent prompt, and cancellation plus a saved
  state when the client disconnects.
- **Shared runtime:** a session created over ACP, continued by the one-shot CLI and
  replayed by `session/load`. Ignored MCP servers are reported, and a mismatched `cwd`
  is refused.
- **Tracing:** spans are written to stderr only.

A manual check pipes `initialize` and `session/new` into the built binary and verifies
that stdout contains only JSON-RPC while spans appear on stderr.

## Later, when needed

Token-level streaming (a streaming Sampler contract for all adapters), `allow_always`
grants remembered per session, client file-system and terminal capabilities
(`fs/read_text_file`, `terminal/*`), connecting client-provided MCP servers, session modes,
image prompts, a WebSocket transport for web UIs, and a bundled reference client.
