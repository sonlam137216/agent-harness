# Phase 3 — Permissions, Hooks, and Events

This document describes the Phase 3 baseline. Phase 4 extends persistence to disk and adds model/tool progress save points; see [PHASE-4.md](PHASE-4.md) for current durability and recovery behavior.

Phase 3 implements the checklist in ROADMAP.md. Runtime still coordinates a synchronous turn;
Tools own execution, Workspace owns filesystem access, and Context owns model input selection.
No new dependencies, provider formats, native write/command tools, or durable storage are introduced.

## Permissions

`AccessKind` has one source in `src/permissions/access-kind.ts`; the existing `ToolAccessKind`
name is a compatibility alias. Access classification and the optional `destructive` flag are trusted
tool metadata and are excluded from model-facing schemas.

ToolBridge snapshots the call, resolves the registered tool, validates input, runs PreToolUse,
authorizes the immutable call, checks cancellation again, and dispatches at most once. Invalid or
unknown calls never reach approval. A permission or hook denial becomes a normal structured tool
error so the next model iteration can respond to it. No mutation is retried automatically.

Rules use exact `toolName` and/or `accessKind` selectors. Both must match when both are present;
omitting both makes a global rule. Wildcards, path patterns, arbitrary predicates, project-file
policies, and command parsing are not supported. Across all matching rules: **deny > ask > allow**,
independent of rule order. A matched rule takes precedence over mode defaults.

| Mode | Unmatched read | Unmatched write / execute / external |
| --- | --- | --- |
| `auto` (default) | allow | deny |
| `ask` | allow | ask |
| `always-approve` | allow | allow |

Explicit deny and ask rules retain their meaning in every mode. Destructive metadata sets an ask
floor, including when an allow rule matches or always-approve is selected; deny still wins. The
approval callback receives the immutable call, access metadata, all correlation IDs, and a signal.
Only literal `true` approves. Rejection, absence, exceptions, cancellation, or deadline expiration
deny execution. Approval is never cached or reused for another call. Rules are copied at engine
construction so caller mutation cannot change a running policy.

The default is compatible with the old read-only guard, while explicit application policy can
authorize other registered tools. Native CLI tools remain `read_file`, `list_files`, `search_text`.
This is a permission boundary, not an OS sandbox or a mechanism for running untrusted callbacks.

## CLI

The existing CLI entry point supports repeatable `--allow-tool`, `--ask-tool`, `--deny-tool`, plus
`--permission-mode`. For example:

```sh
pnpm cli -- --provider ollama --model YOUR_MODEL --ask-tool read_file "Read package.json"
pnpm cli -- --provider ollama --model YOUR_MODEL --deny-tool search_text "Inspect this project"
```

The terminal approval prompt displays the exact tool name and JSON arguments. Only `y` approves;
other answers deny. Approval requires interactive stdin and stderr; piped/headless invocations
deny ask requests. Ctrl-C cancels a pending prompt. Applications/tests can inject an ApprovalHandler
without importing terminal APIs into Runtime or Permissions. Provider keys remain in the existing
sampler configuration and are never copied into policy or tracing.

## Hooks

Register ordered callbacks through `HookRegistry.register(name, callback)`, which returns an
unsubscribe function. Construct it with a tracer to record callback execution. The CLI does so.

| Hook | Boundary and failure behavior |
| --- | --- |
| SessionStart | New session only, after the initial turn is saved; failure stops the turn |
| TurnStart | Each turn, before context/model work; failure stops the turn |
| BeforeModel | After context build, before normal loop sampling; failure prevents sampling |
| AfterModel | After normalized response is appended; failure preserves transcript and stops the turn |
| PreToolUse | Validated tool call, before permission; veto/failure prevents dispatch |
| PostToolUse | Once for dispatched tools, with their normalized result, including thrown tool errors; failure is traced and preserves that result |
| TurnEnd | After the persistence attempt on success/failure/cancellation; failure is traced without changing the turn result |

Callbacks receive deeply frozen copies and optional cancellation signals. They cannot return
transformed calls; a `{ deny: true }` result vetoes the lifecycle boundary like a hook failure.
PostToolUse and TurnEnd are notification boundaries, so they cannot undo completed work. On an
already aborted signal, callbacks are skipped and cancellation is recorded by the owning boundary.
Waiting stops when the signal aborts even if a callback ignores it. Callbacks are trusted in-process
code: they must cooperate with cancellation and must not perform pre-authorization effects.
Stopping a wait does not forcibly stop callback code or undo its external effects.

Model hooks apply to AgentLoop sampling. Compaction remains owned and traced by Context; it does
not recursively run these hooks. SessionEnd is deferred because this one-shot runtime does not own
a persistent session lifetime.

## Events and persistence

`RuntimeEvent` is the sole lifecycle fact model. SessionStarted, TurnStarted, ModelStarted,
ModelCompleted, ToolStarted, ToolCompleted and TurnCompleted carry applicable correlation IDs;
completed model/tool facts include success, including failed/cancelled calls. TurnCompleted includes
the terminal outcome (or `error` if persistence fails). ToolStarted means the bridge received the
request; ToolCompleted also covers validation, hook and permission denial without dispatch.

SessionUpdated carries the immutable session snapshot ready for persistence before and after a
turn. It does not assert that storage has succeeded. SessionRuntime installs a required subscriber
that saves it through SessionStore and awaits completion. Loading still uses SessionStore directly.
Failed hooks/models preserve the latest available transcript before errors surface. Initial storage
failure prevents model/tool work; final storage failure surfaces instead of reporting success.
There is no automatic save retry or durable event log. InMemorySessionStore still loses state on
process exit; crash-safe recovery is Phase 4.

Use one EventBus per SessionRuntime and pass that same instance to its AgentLoop and ToolBridge.
Do not share it across runtimes/stores. `runtime.dispose()` removes the persistence subscription
after work completes and prevents subsequent runs. CLI composition performs this cleanup.

Subscribers run in registration order. Ordinary observer exceptions are contained and observers
have a configurable timeout (one second each by default); timeout signals are supplied to callbacks.
The required flag propagates errors only for SessionUpdated, whose storage failure must surface.
Observers cannot modify the frozen event/session data. Async callbacks should not publish and await
the same lifecycle event recursively. This bus is synchronous orchestration with bounded observers,
not a background queue, delivery-retry system, or replay log.

The tracing subscriber adds a whitelist of IDs/status to existing active spans. It never serializes
the full event or SessionUpdated payload, which may contain sensitive transcript data. Existing
model/tool spans remain unique. See OBSERVABILITY.md for permission/hook spans and safe attributes.

## Review findings and validation

- Reused one AccessKind definition instead of introducing a second access taxonomy.
- Replaced the fixed read-only bridge guard with enforceable explicit policy; prompts and AGENTS.md
  cannot grant permission.
- Approval uses immutable arguments and cancellation checks, preventing a stale/changed-call grant.
- Kept executed tool results intact when post-hooks fail; no hidden mutation retry.
- Preserved assistant/tool transcript entries when later hooks or model iterations fail.
- Contained ordinary observer failures/timeouts while surfacing required persistence failures.
- Added permission/hook correlation and metadata-only event tracing without duplicate model spans.
- Clarified that the older PROJECT-STATUS-AND-PLAN.md proposed workspace mutation as an extension;
  it was never added to the authoritative Phase 3 checklist. File editing, command execution and
  their path/environment/process safeguards still need their own requested slices.

Run `pnpm validate` for formatting, lint, type checking, tests, and build. Tests include rule/mode
precedence, destructive requests, missing/failed approvals, cancellation and hanging callbacks,
immutable snapshots, hook ordering/veto/failure, event isolation/persistence, transcript preservation,
and CLI approval/denial through FakeSampler with a real temporary workspace. These checks do not
call a paid model or claim live-provider verification.
