# Phase 9 — Subagents

Phase 9 lets a parent agent hand a self-contained task to a read-only child session and
receive only a bounded report with its sources. Children can run in the foreground or in
the background, are cancellable, are linked to the parent in traces and in the saved
session, and cannot delegate further. Children that modify files need worktree isolation
(Phase 10), and a test role needs command execution; neither is part of this phase.

## Problem and placement

A parent that explores a large codebase fills its own context window with file bodies it
only needed once. A subagent reads those files in its own context and returns a short
report, so the parent keeps its context for the actual task.

```text
CLI composition
  → SessionRuntime (parent) → AgentLoop → ToolBridge
    → delegate_task / await_subagent / cancel_subagent   (subagent tools)
      → SubagentManager   (limits, background handles, cancellation, cleanup)
        → SubagentRunner  (one child: own SessionRuntime, AgentLoop, ToolRegistry,
                           PermissionEngine, EventBus; token budget)
          → Sampler / ContextBuilder / SessionStore / read-only Tools (injected)
```

`src/subagents/` sits beside Runtime. Delegation tools depend only on the
`SubagentManager`; they never touch a Sampler, provider or Workspace. The runner composes
existing Runtime pieces from injected interfaces; it creates no concrete workspace or
provider. Runtime, AgentLoop, ToolBridge and ContextBuilder are unchanged: a child is
just another session run. `SessionMetadata` gains an optional `parent` link, and
`SessionRuntime` accepts it as configuration.

## Opt in

```sh
pnpm cli -- --provider ollama --model <model-id> --subagents \
  "Where is session locking implemented, and what happens on contention?"
```

| Flag | Meaning |
| --- | --- |
| `--subagents` | Offer `delegate_task`, `await_subagent` and `cancel_subagent` for this run |
| `--subagent-tokens <n>` | Token cap per child (default 120000; requires `--subagents`) |

Like memory, this is a run option and is not saved with the session.

## Roles

| Role | Purpose | Max iterations |
| --- | --- | --- |
| `explore` | Find where and how something is implemented, with supporting paths | 8 |
| `plan` | Propose ordered implementation steps, risks and verification, without changing code | 8 |
| `review` | Report concrete defects with path, line and failure scenario, or "no findings" | 6 |

Every role gets `read_file`, `list_files` and `search_text` and the same shared
instructions. Children are told they are read-only, cannot delegate, must cite workspace
paths and must say what they could not verify. Roles are defined in
`subagent-definition.ts`; the runner accepts replacement definitions.

## Tools

`delegate_task` `{ role, task, background? }`. The child does **not** see the parent
conversation, so the task must be self-contained (at most 8000 characters).

- Foreground (default): the call runs the child to completion and returns its handoff.
- `background: true`: returns `{ subagentId, role, status: "running" }` right away. The
  model can start several children in one response; they run concurrently while the
  parent continues.

`await_subagent` `{ subagentId }` waits for a background child and returns its handoff.
Cancelling the wait (parent cancellation) does not cancel the child. Waiting again returns
the same result.

`cancel_subagent` `{ subagentId }` aborts a background child and returns
`{ subagentId, outcome, sessionId }`.

A completed child returns a success result:

```json
{
  "subagentId": "…", "role": "explore", "sessionId": "<child session>",
  "outcome": "completed",
  "report": "…", "reportTruncated": false,
  "sources": ["src/session/file-session-store.ts"],
  "iterations": 3, "toolCalls": 4,
  "usage": { "inputTokens": 5120, "outputTokens": 380 }
}
```

`report` is the child's final answer, cut to 6000 characters (`reportTruncated`).
`sources` are the paths of files the child successfully read with `read_file`, first-read
order, at most 32. Any other outcome (`failed`, `max_iterations`, `cancelled`,
`deadline_exceeded`, `token_budget_exceeded`) is an error result with code
`subagent_<outcome>` that names the child session for inspection.

All three tools have `accessKind: 'read'`. Children cannot change the workspace, and child
session records are harness-owned storage, so the default permission policy allows them.
Use `--deny-tool delegate_task` to forbid delegation in a run with `--subagents`.

## Isolation and capability restrictions

Each child has its own:

- **session**: a new session in the same SessionStore, with `metadata.parent`
  `{ sessionId, turnId, toolCallId, subagentId, role }`. `sessions list` shows
  `parentSessionId` and `subagentRole`; `sessions show <child>` prints its transcript.
- **context**: a separate ContextBuilder that has project rules and the parent's budget.
  It has no parent history, skills, memory notes or code excerpts.
- **model loop**: its own AgentLoop with the role's iteration limit, using the parent's
  model.
- **tool scope**: a fresh ToolRegistry that holds only the role's tools. The runner refuses
  at construction any tool that is not a native, read-only leaf tool (no `write`,
  `execute` or `external` tools, no MCP delegation) and any delegation tool. That keeps
  the depth at **1**: `root → child`, never `child → child`.
- **permissions**: a PermissionEngine in `auto` mode that carries the parent's rules, so
  `--deny-tool read_file` also applies to children. Children have no approval handler: a
  call that would need approval is denied. A child never prompts the terminal.
- **events**: a private EventBus with the tracing subscriber and the required persistence
  subscriber. Parent hooks do not run inside children. `PreToolUse`/`PostToolUse` still
  wrap the parent's `delegate_task` call.

Child sessions cannot be resumed with `--resume`. Inspect them with `sessions show`.

## Limits

| Limit | Default |
| --- | --- |
| Nesting depth | 1 |
| Children started per run | 8 |
| Concurrent children (foreground + background) | 4 |
| Tokens per child (input + output of response calls) | 120000 |
| Report length | 6000 characters |
| Sources per report | 32 |
| Task length | 8000 characters |

Limits are `SubagentManager` / `SubagentRunner` constructor options, and the per-child
token cap is also a CLI flag. The token budget is checked **before** each child model
call, so the call that crosses it completes and the next one is refused
(`token_budget_exceeded`). Compaction calls inside the child are not counted. Exceeding
the start or concurrency limit returns `subagent_limit` / `subagent_busy`, and nothing
starts.

## Cancellation and cleanup

- A foreground child is cancelled with the parent's tool call (Ctrl-C, parent deadline).
- Background children are cancelled by `cancel_subagent`, by the run's signal, or by
  `SubagentManager.close()`. The CLI calls `close()` after the parent turn ends, so a
  child the parent never awaited is cancelled and its final `cancelled` state is saved
  before the process exits. Nothing keeps running after the CLI returns.
- Cancellation never leaves a child in progress: the child runtime records the terminal
  status through the normal persistence path.

## Observability

`subagent.spawn` is a child of the parent's `tool.execute` span for `delegate_task`. The
child's `session.run` → `turn.run` → `agent.loop.iteration` → `model.sample` /
`tool.execute` tree nests under it in the same trace. A background child's span outlives
the `tool.execute` that started it.

Attributes: `subagent.id`, `subagent.role`, `subagent.background`, parent `session.id`,
`turn.id`, `tool_call.id`, `subagent.session_id`, `subagent.outcome`,
`subagent.max_tokens`, `subagent.max_iterations`, `loop.iterations`,
`subagent.tool_calls`, `subagent.sources`, `subagent.report_chars`,
`subagent.report_truncated`, `input_tokens`, `output_tokens`, `success`, `duration_ms`,
and `error.type` on unexpected failure. Task text, report text and paths are never
recorded. The durable link lives in the child session's `metadata.parent`.

## Verification

```sh
pnpm exec vitest run test/subagents
pnpm validate
```

`test/subagents/subagents.test.ts` covers foreground delegation through the CLI with a
fake model: report, sources, persisted parent link, child tool list, and context isolation
in both directions (the child never sees the parent prompt, the parent never sees the file
body). It also covers trace nesting without task text, opt-in flags, parent deny rules
applying to children, two background children that must overlap to finish, explicit
cancellation and cancellation at run end, foreground cancellation with the parent, the
token budget, start and concurrency limits, refusal of write, external and delegation
tools, codec round-trip of the parent link, and refusal to resume a child.

## Later, when needed

Children that edit files in their own worktree (Phase 10), a test role once command
execution exists, per-role model selection, memory or code-retrieval context for
children, streaming progress from background children, and a `subagent_runs_total`
metric.
