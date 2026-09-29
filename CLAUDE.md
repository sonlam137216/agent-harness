# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Read first

`AGENTS.md` is the authoritative rule set (purpose, current phase, architectural rules,
definition of done). Follow it. Before architectural changes also read `docs/ARCHITECTURE.md`,
`docs/DESIGN-PRINCIPLES.md`, `docs/ROADMAP.md` and `docs/OBSERVABILITY.md`. If code and docs
disagree, stop and update the architecture intentionally.

## Project summary

Learning-oriented AI coding-agent harness in TypeScript (strict, ESM, Node >= 22, pnpm).
Phases 0–6 are committed; Phase 7.1–7.3b (benchmark, lexical code retrieval, coverage
signals, per-turn scan cache) and Phase 8.1–8.3 (opt-in Markdown memory read path;
`memory add` and permission-gated `save_memory`; `sessions summarize`) are implemented.
Phase 9 (opt-in `--subagents`: read-only explore/plan/review child sessions, background
delegation, depth 1) and Phase 10 (`--worktrees`: an `implement` child edits only in its
own Git worktree; user runs `worktrees diff/apply/remove`) and Phase 11 (`--sandbox`:
implement children get `run_command` under macOS Seatbelt, no network, writes only in the
worktree) are implemented. Phase 7.3c (live evaluation) is deferred pending a stronger
tool-calling model. The next roadmap phase is 12 (agent protocol). Do not start another capability unless explicitly requested. The main working tree is never written by the model; `save_memory` only appends notes.

Main flow: `cli` (composition root) → `runtime/SessionRuntime` → `runtime/AgentLoop` →
`context/ContextBuilder` + `model/Sampler` + `tools/ToolBridge` → `workspace` / `mcp`.

## Commands

```sh
pnpm install
pnpm build                  # tsc
pnpm test                   # vitest run
pnpm exec vitest run <path> # focused tests
pnpm lint
pnpm typecheck
pnpm format                 # prettier --write
pnpm validate               # format:check + lint + typecheck + test + smoke:persistence
pnpm cli -- --provider ollama --model <model-id> "<prompt>"
pnpm benchmark:exploration -- --repeats 2 --output /tmp/report.json
```

Run `pnpm validate` before declaring a feature done.

## Git profile for this project

This repository is committed and pushed under a personal Git identity, configured
repo-locally (`.git/config`), so the global work profile stays untouched:

```sh
git config user.name "lts137216"
git config user.email "19522133@gm.uit.edu.vn"
```

Before committing, confirm `git config user.email` prints `19522133@gm.uit.edu.vn`; if not
(e.g. fresh clone), run the commands above. Never change the global profile
(`Son Lam Truong` / `sonlt@tech.est-rouge.com`) for this repository.
