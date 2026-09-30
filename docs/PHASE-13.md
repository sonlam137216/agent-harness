# Phase 13 — Practical Use

Phases 0–12 built every boundary a coding agent needs, but daily use on a real project
was awkward: the main agent could not edit files or run tests, a turn stopped after eight
model calls, there was no interactive session, independent reads ran one by one and
Anthropic requests re-sent the whole prompt uncached. Phase 13 closes those gaps by
**composing existing capabilities** for the main session. It adds no new subsystem and
does not change the Session schema.

## Decisions

### 13.1 Direct edit mode (`--edit`)

The main session may edit the user's working tree, but only when the run opts in:

```text
--edit  →  write_file + edit_file rooted at --workspace (LocalFileWriter)
```

- Writes use the same `FileWriteCapability` as worktree children: workspace-relative
  paths only, no `..`, no symlinked segments, no `.git`, atomic replacement, 1 MiB cap.
- Both tools have `accessKind: 'write'`. When `--edit` or `--commands` is given without
  `--permission-mode`, the mode defaults to `ask`: reads run freely and every write or
  command needs approval. `--allow-tool edit_file` (etc.) or
  `--permission-mode always-approve` remove the prompt deliberately; `--deny-tool` still
  wins over everything.
- The terminal approval prompt renders a readable preview: a `-`/`+` diff for
  `edit_file`, path and first lines for `write_file`, the argv for `run_command`.
- Undo is the user's version control. The harness does not snapshot the main tree;
  worktrees (`--subagents --worktrees`) remain the isolated alternative.

### 13.2 Commands in the main tree (`--commands`)

`--commands` offers `run_command` to the main session, executed by the existing
`SeatbeltCommandRunner` with a policy rooted at the workspace: allowlisted bare command
names (`--sandbox-command` extends the list), no shell, no network, writes only inside
the workspace, `.git` read-only, private HOME/TMPDIR and an environment allowlist. It
requires macOS with a working `sandbox-exec`; there is still no unsandboxed command
path. `accessKind: 'execute'`, so it asks by default like writes.

### 13.3 Loop limit (`--max-iterations`)

The CLI default for the main session rises from 8 to 25 model calls per turn and is
configurable with `--max-iterations <1-200>`. `AgentLoop`'s own default is unchanged.

### 13.4 Interactive chat (`chat`)

`pnpm cli -- chat [run options]` reads prompts from the terminal and runs each as a new
turn of one persisted session (`--resume <id>` continues an existing one). `Ctrl+C`
cancels the running turn; at the prompt it, `/exit` or end of input leaves. Each turn is
composed exactly like a one-shot run (`runPhaseOneCli`), as ACP already does, so tools,
permissions, persistence and tracing are identical.

### 13.5 Concurrent read-only tool calls

When one model response requests several tool calls and **every** one is marked
`concurrent` in its definition (native `read_file`, `list_files`, `search_text`) and is
allowed without approval, AgentLoop runs them concurrently through `ToolBridge` and
appends results in the original call order. Any write, command, external, delegation or
approval-requiring call makes the whole batch sequential (design principle 14).

### 13.6 Anthropic prompt caching

The Anthropic adapter marks cache breakpoints (`cache_control: ephemeral`) on the last
tool definition, the system prompt and the last message block, so each loop iteration
reuses the previous prefix. Reported `inputTokens` now include cache reads and writes so
usage stays comparable with other providers; `cachedInputTokens` reports the cache reads.

### 13.7 Quiet terminal output

The CLI used to print every span to stdout with the console exporter, burying the answer.
Span export is now selected with `AGENT_HARNESS_TRACE`: `off` (default for CLI commands),
`stderr` (one JSON line per span) or `console`. `acp` keeps its stderr default and never
writes spans to stdout. With `off`, spans are still recorded, so sessions keep real trace
IDs; `createTracing({ exporter: null })` provides that mode.

### 13.8 Provider-aware defaults and model timeouts

Without `--context-window`/`--output-reserve`, the budget now follows the provider
(`PROVIDER_CONTEXT_DEFAULTS`): anthropic 200 000 / 16 384, openai 128 000 / 16 384,
ollama 32 768 / 4 096. The old 32 768 / 4 096 default pruned and compacted hosted-model
sessions early and truncated whole-file `write_file` calls. Setting one value keeps the
provider default for the other. Resumed sessions keep their saved budget.

`withRequestTimeout` (model layer) bounds every `sample` call of a run (turns,
compaction, subagents), transport retries included: `--model-timeout <seconds>`, default
600. A timeout is a retryable `unavailable` SamplingError, so the turn fails with
"The model request timed out after N seconds." instead of hanging; user cancellation
and deadlines keep their own outcomes.

### 13.9 Tool progress on the terminal

`createProgressReporter` subscribes to the run's EventBus and prints, on stderr, one line
per tool call (`→ read_file src/x.ts`, `→ run_command pnpm test`), the first line of any
text the model wrote alongside tool calls, failed results (`✗ access_denied: …`) and
command exit codes. It follows only the running turn, escapes control characters and
never repeats the final answer, which stays alone on stdout. Chat and one-shot runs use it.

### 13.10 Credential files stay hidden

Anything the model reads is sent to the provider, so credential files are hidden by
default (`src/workspace/sensitive-paths.ts`): `.env`, `.env.*` (except `.example`,
`.sample`, `.template`, `.defaults`, `.dist`), `*.pem|key|p12|pfx|jks|keystore`,
`id_rsa|dsa|ecdsa|ed25519`, `.npmrc`, `.pypirc`, `.netrc`, `.pgpass`, `.git-credentials`
and anything under `.ssh/`, `.aws/` or `.gnupg/`.

- `LocalFileSystemCapability({ hideSensitiveFiles: true })` omits them from listings (so
  `search_text` and code retrieval never see them) and refuses reads with
  `protected_path`, including through a symlink with an innocent name.
- `SandboxPolicy.hideSensitiveFiles` adds Seatbelt `file-read-data` deny rules for the same
  patterns below the root, so `run_command` (main tree and worktree children) cannot read
  them either, including files created later.
- The system prompt says they are hidden. `--allow-sensitive-files` opts out.

The `run_command` approval preview also warns that an approved command can change any
workspace file except `.git` without per-file approval, and flags inline code
(`node -e`, `python3 -c`, …), because files it writes (e.g. `package.json` scripts) may
later run outside the sandbox.

### 13.11 OpenAI-compatible providers (verified with Groq)

The first live runs used Groq's free tier through the OpenAI adapter
(`OPENAI_BASE_URL=https://api.groq.com/openai/v1`, `openai/gpt-oss-120b`) and exposed four
issues, now fixed:

- Groq validates sampled tool calls against the declared schema and answers HTTP 400
  `tool_use_failed`, so the harness never saw the call and could not tell the model what
  was wrong. The adapter now sends tool schemas **without value limits** (min/max,
  lengths, item counts, patterns); structure, `required`, enums and
  `additionalProperties` stay. ToolBridge validation remains authoritative and returns an
  `invalid_input` message the model corrects on its next call. A remaining
  `tool_use_failed` is treated as retryable.
- `list_files`/`search_text` accept `path: ""` as the workspace root.
- `search_text` skips generated trees (`.git`, `node_modules`, `dist`, `build`,
  `coverage`, `target`, `vendor`, `.next`, `.venv`, `__pycache__`) while walking and skips
  unreadable files (too large, protected, vanished) with a `filesSkipped` count instead of
  failing the whole search.
- OpenAI and Anthropic adapters honor `Retry-After` up to 60 s (was 10 s), which free-tier
  rate limits need.

Live results (2026-09-30, Groq free tier, `openai/gpt-oss-120b`, `--context-window 32000`):
a read-only question about this repository answered correctly with a citation (≈2 min,
mostly rate-limit waits); a fix-the-failing-test task on a small project completed in
12 s: run test → read → edit → rerun test passing.

### System prompt follows the run

The main session's system prompt is derived from the current run's capabilities (MCP,
edit, commands, subagents) instead of the prompt saved when the session was created, so
`--resume … --edit` or `chat --resume … --commands` tells the model what it can do. The
saved agent name and model are still reused.

## Not in Phase 13

- Token-level streaming of model output (message-level updates exist via ACP).
- A Linux sandbox backend (bubblewrap/landlock); `--commands` is macOS-only.
- A project configuration file replacing command-line flags.
- Reporting which files an approved command changed.
- Automatic checkpoints or undo for main-tree edits.

These remain candidates for later slices.

## Example

```sh
# Ask before every edit and command; run tests in the sandbox.
pnpm cli -- chat --provider anthropic --model <model-id> --edit --commands \
  --max-iterations 40

# One-shot, trusting edits but still approving commands.
pnpm cli -- --provider openai --model <model-id> --edit --commands \
  --allow-tool edit_file --allow-tool write_file "Fix the failing date parser test"
```

## Safety summary

```text
Model → main working tree write   only with --edit; ask by default; .git/symlinks refused
Model → command                   only with --commands (main) or --sandbox (worktree child);
                                  always under the OS sandbox, no network
Model → push / network            ❌
```
