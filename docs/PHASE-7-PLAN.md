# Current status and Phase 7 proposal

Assessment date: 2026-09-28. This is a planning document, not an implementation
of Phase 7 or authorization to begin it.

## Verified baseline

The working tree implements Phase 0–6. HEAD is `cd3f247`
(`feat: Permissions, Hooks, Events, Sessions, Skills`); Phase 6 changes are
uncommitted, including the new MCP implementation and tests. Conclusions here
refer to the working tree, not just HEAD.

`pnpm validate` passed formatting, lint, type checking, all 37 test files / 237
tests, build, and the separate-process persistence smoke. The first sandboxed
run failed four HTTP fixture tests because loopback binding returned EPERM;
the approved rerun outside the sandbox passed. No live model or hosted MCP
service was exercised. This is a status and architecture review, not a full
security audit or coverage analysis.

| Area | Implemented | Remaining boundary |
| --- | --- | --- |
| Core and providers | Synchronous session/agent loop; OpenAI, Anthropic and Ollama adapters; cancellation and normalized failures | No background orchestration or interactive agent UI |
| Context | Source accounting, scoped rules, pruning, compaction and checkpoints | No ranked code retrieval; additional sources currently count as mandatory context |
| Control | Permissions, seven hooks, canonical events and tracing | Native tools remain read-only |
| Sessions | Durable transcript, usage, checkpoints, resume/list/show/rewind and exclusive operations | Rewind does not undo external effects; unknown interrupted calls are not replayed |
| Skills | Bounded project/user discovery, explicit selection and opt-in automatic selection | No skill script execution |
| MCP | Stdio and Streamable HTTP, bounded BM25 catalog, search/invoke meta-tools, target authorization, refresh and recovery | No OAuth, legacy SSE fallback or multimodal model messages |

MCP tests demonstrate a 125-tool catalog without growing the permanent tool
surface: three native read tools plus two meta-tools. SDK details stay behind
the MCP adapter, and Workspace owns the application-side stdio process access.

## Findings that shape the next phase

1. **The next roadmap phase is code retrieval/token optimization.** Memory,
   subagents, worktrees and sandboxing remain later phases. Native file editing
   and command execution still lack an explicit delivery milestone; resolving
   that product priority would be a separate roadmap decision.
2. **Existing search is a useful baseline, not ranked retrieval.**
   `SearchTextTool` scans files through Workspace for case-sensitive literal
   matches. It bounds traversal and returned snippets but does not rank code
   candidates or select them for ContextBuilder.
3. **Optional context needs a deliberate budget contract.** ContextBuilder loads
   all additional sources into its fixed contribution before pruning or
   compaction. Adding code as an ordinary source can cause overflow or displace
   conversation through compaction. Retrieval should receive only spare capacity.
4. **Savings are not measured yet.** Source accounting and provider usage exist,
   but this assessment has no representative exploration benchmark. The default
   counter uses serialized UTF-8 bytes as a conservative token estimate; it must
   not be presented as provider-billed tokens. No dominant source or savings
   percentage can be established from the test count.
5. **Historical status documentation is easy to misread.**
   `PROJECT-STATUS-AND-PLAN.md` contains an explicitly historical Phase 1 review
   under later update notes. This document supplies the current assessment;
   historical proposals are not current implementation requirements.

## Architecture decision

Start with one opt-in, bounded lexical retriever under
`src/context/retrieval/code/`. Its question is: which small source excerpts best
support the active user's codebase question?

The dependency direction is:

```text
CLI composition
  → ContextBuilder
    → code retrieval boundary
      → FileSystemCapability
        → local Workspace adapter
  → provider-neutral model request
```

Retrieval selects candidates; ContextBuilder owns final selection and budgets;
Workspace performs reads. AgentLoop, Sampler and SessionStore need no retrieval
logic. A narrow Retriever contract is justified by this boundary, but no new
top-level manager, background indexer, database or general plugin framework is
needed. Do not import MCP's catalog into Context just to reuse its ranker.

Candidate results should contain a workspace-relative source path, line range,
relevance score, excerpt/reference, and estimated size. Use a stable path/line
tie-break. Keep adapter types private. Present excerpts as labeled repository
data, never as system instructions or permission grants.

## Ordered delivery plan

### 7.1 — Establish an exploration benchmark

Create a small versioned task set, initially 8–12 questions covering symbol
lookup, responsibility tracing, cross-file behavior, tests and absent evidence.
Examples for this repository: target permission enforcement, checkpoint reuse,
interrupted-call recovery, and skill precedence. Record expected evidence paths
and answer criteria before evaluating retrieval.

Measure the existing tool-driven path: total model input usage across the full
turn (including compaction), estimated contributions per source, read_file and
search_text calls, underlying filesystem reads/bytes, iterations, latency and
answer correctness. Record fixture revision, model/configuration and repeats.
Keep real-provider comparisons opt-in; fake-model tests establish plumbing and
invariants, not model quality or real-world token savings.

Exit: a reproducible baseline report with provenance and explicit unavailable
measurements. This is the recommended first implementation capability.

### 7.2 — Bounded lexical retrieval, end to end

Implement one retriever and CLI opt-in wiring through ContextBuilder. Use the
active user request and explicitly configured roots to derive deterministic
lexical queries; do not add a model-based query planner initially. Rank bounded
line windows using identifier/path terms, merge overlapping excerpts, and cap
files, bytes, candidates, snippet size and elapsed work.

Start with explicit source roots such as `src` and `test`. Exclude dependency,
build, VCS, session-storage, credential and binary files by documented policy;
do not imply complete gitignore semantics without implementing them. Retain
Workspace containment and symlink checks. Context-owned reads follow an explicit
retrieval scope; a tool-name permission rule is not a filesystem access policy.
Existing scoped project-rule selection must remain authoritative: first limit
retrieval to the configured rules directory and document that nested-rule
inference is not introduced by retrieval.

Build required context with the existing behavior first. Then spend at most
the lesser of the retrieval cap and the remaining request budget, counting
labels and framing. Drop lower-ranked excerpts before exceeding that budget;
retrieval alone must not force compaction or fail an otherwise valid request.
Do not weaken mandatory rules, skills, active-turn content or tool-call groups.

Use fresh bounded reads initially, with no persistent cache or freshness claim.
Mark exhausted scan bounds as partial coverage. No matches or zero budget is
a normal empty contribution; preserve manual tools as the fallback. Surface
containment/I/O failures intentionally and propagate cancellation/deadlines;
never report incomplete or failed scanning as exhaustive absence of evidence.

Exit: prompt → bounded relevant code → budgeted model request → evidence-based
answer, verified through SessionRuntime/CLI fixtures. Tests cover ranking,
scope, overlap, no matches, bounds, cancellation, file changes, budget exhaustion,
unaltered required context/transcripts and interaction with compaction/resume.

### 7.3 — Evaluate and tune

Repeat the baseline with retrieval enabled, holding task/model/configuration
constant. Compare correctness and evidence coverage before claiming efficiency.
Count all model input, including repeatedly injected excerpts; count filesystem
work so hidden scanning does not masquerade as lower exploration cost.

Proposed acceptance target, to fix before the comparison: at least 20% lower
median total model input and fewer median read_file calls on exploration tasks,
without lower answer correctness or evidence coverage. Report per-task
regressions and latency alongside the median. This is a target, not a result.
Keep retrieval opt-in if evidence does not support enabling it by default.

### Later Phase 7 capabilities — only if measurements justify them

Choose one next improvement from observed failures: a symbol index for identifier
ambiguity, an AST/dependency adapter for relationship questions, or a cache for
measured repeated scanning. GitNexus is a potential adapter, not a prerequisite.
Any cache needs a tested invalidation strategy for edits, deletion and resume;
the current filesystem port has no revision API. Defer semantic retrieval,
embeddings and repository summarization until simpler retrieval is insufficient.

## Observability and completion

Use `context.code_retrieval` beneath `context.build` with `retrieval.code` for
retriever work, defining distinct responsibilities to avoid duplicate spans.
Record correlation IDs, candidates/files considered and selected, selected
estimated tokens, bytes read, latency, outcome and partial-coverage reason.
Account for injected content as `context.retrieval_tokens`. Report caching as
disabled initially; add hit/miss only when a cache exists. Exclude queries,
paths, source text and raw exceptions from default telemetry.

Before implementation, update ARCHITECTURE and CONTEXT-ENGINE with the optional
retrieval contract, ROADMAP with the selected slice, and OBSERVABILITY with its
actual attributes. Add PHASE-7 documentation and CLI examples with the first
working slice; update AGENTS and the current-status pointer to match delivery.

Review and establish the existing Phase 6 baseline before mixing in Phase 7
implementation. Each capability needs boundary tests, intentional error behavior,
tracing and full validation. A retriever interface alone does not complete Phase
7; the roadmap exit is measured exploration savings with preserved correctness.
