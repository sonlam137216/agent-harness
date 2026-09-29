# Phase 7 — Code retrieval and measurement

Phase 7.1 (exploration benchmark) and 7.2 (bounded lexical retrieval) are implemented.
Phase 7.3 (live quality and cost comparison), symbol/AST indexes and caching remain
deferred. No live-model token savings are claimed.

## Opt in to code retrieval

```sh
pnpm cli -- --provider ollama --model <installed-model-id> \
  --retrieval-root src --retrieval-root test --retrieval-tokens 4096 \
  "Explain checkpoint validation and identify the relevant tests."
```

Each `--retrieval-root` is an explicit workspace-relative directory; one to eight
are accepted. Parent traversal, absolute paths, excluded directory roots and roots
outside `--rules-directory` are rejected. Duplicate/overlapping roots are collapsed.
`--retrieval-tokens` requires a root. No flag means the original behavior. Retrieval
is not saved in session configuration: provide roots again when resuming.

The adapter normalizes case and splits identifiers into lexical terms, ranks
matching five-line windows by unique query-term matches plus path matches, and
uses path/line order for deterministic ties. Windows do not overlap; lines are
kept intact. Context packs the ranked excerpts as untrusted data with source paths
and one-based line ranges, using only remaining input space. A large excerpt may
be skipped so a smaller lower-ranked excerpt fits. Existing manual tools remain
available, and the model-facing tool definitions do not change.

Fresh Workspace reads run on every context build. There is no cache, index file,
model-based query planner, shell command or external dependency. This can add I/O
and repeated prompt content; use the benchmark before drawing efficiency conclusions.

Default scan limits (constructor options allow tuning the scan limits):

| Limit | Default |
| --- | --- |
| Eligible file read attempts | 128 |
| Visited directory entries | 2000 |
| Successfully read source bytes | 1 MiB |
| File content per read | 64 KiB or remaining byte allowance, whichever is smaller |
| Retained candidates | 128 |
| Scan deadline | 500 ms |
| Query text / unique terms | 4096 characters / 32 terms |
| Excerpt | At most 5 lines / 1800 characters, without cutting lines |
| Selected context | 4096 estimated units or remaining input allowance |

Workspace may read one extra byte to detect a concurrently growing oversized
file; failed-read probes are not successful-source-byte accounting. Workspace's
own per-directory and per-file bounds also apply. The scan deadline stops waiting
and signals cancellation; an already-started filesystem operation may finish later.
No new OS sandbox or atomic repository snapshot is provided.

Policy excludes dot directories/files, node_modules, vendor, dist, build, coverage,
target, sessions, session-data, secrets and credentials directories, and filenames
with a secret/secrets/credentials segment. Only common source extensions are read
(JS/TS, Python, Go, Rust, Java/Kotlin, Swift, Ruby, C/C++, C#, PHP, shell, SQL,
Vue and Svelte); NUL-containing content is skipped. This is an explicit bounded
code-selection policy, not gitignore support or a guarantee that code has no secrets.

Symlinks are skipped; explicit roots through symlinks fail. Ancestor directory
segments are walked through Workspace before reaching a root. Deeper directories
containing `AGENTS.md` are skipped with `nested_rules` unless the configured rule
scope already includes them. To include such a subtree, choose for example
`--rules-directory src/feature --retrieval-root src/feature`; project-rule loading
then supplies the applicable ancestor instructions. Retrieval does not infer rule
scope from the query or treat source text as new instructions.

Bounds, oversized files/directories and skipped nested-rule subtrees produce
partial-coverage metadata. If it fits, a model-facing notice accompanies excerpts
or stands alone. A complete scan with no matches injects nothing; zero budget skips
the scan. No result establishes absence outside the selected policy/scope. Missing
roots and I/O/containment failures surface as sanitized Context errors; parent
cancellation/deadlines propagate. An internal scan timeout returns partial coverage.

## Run the benchmark

From the repository root:

```sh
pnpm benchmark:exploration -- --repeats 2 --output /tmp/exploration-scripted.json
```

This builds the project and runs ten fixed search/read workloads through the
existing read-only CLI, SessionRuntime, ToolBridge, Workspace and ContextBuilder.
It requires no credentials or network. Output paths must be new files in existing
directories; the runner refuses to overwrite a report. Without `--output`, the
Node entry point writes JSON to stdout (pnpm also prints its build progress).

After building, a live run is explicitly opt-in:

```sh
node dist/test/benchmarks/exploration/main.js --live \
  --provider ollama --model <installed-model-id> \
  --repeats 3 --include-answers --output /tmp/exploration-live.json
```

OpenAI and Anthropic are supported through the existing Sampler factory and its
environment configuration. No new provider API or dependency is added. A live run
sends fixture evidence to the selected model; it can consume provider usage.
`--provider` and `--model` are rejected without `--live`. No live provider was
invoked to implement this slice.

Use `--task <id>` for a single workload and `--help` for all options. Defaults:
one repeat, 131072 estimated window units, 4096 output reserve, 120 seconds per
task. Repeats are bounded to 10; timeout to 600 seconds. SIGINT cancels the active
turn and preserves a partial report. Task failures remain in the report and cause
a nonzero exit. Setup/output errors also exit nonzero with a sanitized message.

## Corpus and tasks

The versioned task set is in `test/benchmarks/exploration/tasks.ts`. It covers
target authorization, deny precedence, checkpoint reuse, required-context overflow,
interrupted calls, rewind, skill selection, path containment, search bounds and
absent vector-index evidence. Each question has expected evidence paths and a
human-readable correctness rubric, specified before retrieval evaluation.

The test driver reads only the fixed allowlist of AGENTS.md and task evidence
files through a bounded Workspace adapter, then copies them to a temporary
fixture. This is a curated subset, not the whole repository. File and corpus
SHA-256 digests identify exactly the copied contents. Git revision and dirty-state
metadata identify the source checkout when available. The fixture is removed
after the run. A separate empty user-skill directory excludes personal settings;
no MCP configuration, automatic skills or external mutation tools are enabled.

Live models receive the question, normal harness instructions and fixture rules.
Expected paths and rubrics are evaluator metadata and are not injected. A model
may find the fixture's files through normal tools. Scripted mode instead follows
one fixed literal search and sequential reads of the expected evidence, validating
successful results and complete searches. It does not answer the question or
approximate autonomous model exploration quality.

The corpus is generated from the current source rather than a permanently frozen
copy. Compare runs only with identical corpus/task hashes, matching runtime code
and compatible settings. For defensible live comparisons use recorded clean code
revisions; a dirty-tree flag alone cannot reconstruct unpublished runtime edits.
The manifest does not claim to verify answer rubrics automatically after edits.

## Report interpretation

Each run records:

- Outcome, sanitized failure category, elapsed time and session/turn/trace IDs.
- All Sampler request estimates, including failed attempts and compaction requests.
- Normalized usage from returned model responses, including compaction; null for
  scripted runs. Partial response usage is flagged and is not a billing ledger.
- Successful normal context-build contributions by source, framing and total size.
- Model tool calls, tool errors, filesystem read attempts/successes/bytes,
  directory-list attempts, iterations and compaction calls.
- Expected files actually read successfully with read_file and their fraction.
- A pending human-review rubric in live mode, or an explicit unevaluated scripted
  status. Optional generated answers support manual assessment.

The default estimator counts UTF-8 serialized bytes conservatively. Its values
are **not tokenizer counts or provider-billed tokens**. Source contributions count
repeated input on each successful normal context build; all-request totals also
include summary requests. This initial single-turn task suite does not normally
trigger compaction. Failed builds and missing telemetry remain explicit.

Filesystem totals include scans and Context-owned rules/skills reads, not fixture
setup. Fewer read_file calls alone can hide increased search I/O. File-read
coverage is a diagnostic: correct answers might use search snippets, and reading
every expected file does not establish correctness or complete evidence coverage.

Medians use completed runs only and report the contributing count. Failures and
skipped runs are separately visible; do not accept an efficiency result with a
lower completion rate. Timing includes tracing overhead and varies by machine.
No savings are calculated before a comparable retrieval-enabled run exists.

## Evaluation and next capability

For live baselines, run repeated trials with fixed corpus, questions, model,
endpoint, runtime configuration and budget. Save answers only when requested,
then review every rubric item, cited evidence and bounded absence claim. Record
the review alongside the report; automated model-as-judge scoring is not included.

The next capability is Phase 7.3: evaluate live retrieval-enabled runs against
matching baselines, preserving correctness and completion rates. The proposed 20%
median input reduction remains a target, not a demonstrated improvement.

The benchmark accepts `--code-retrieval` (explicit fixture roots `src` and `test`)
and optional `--retrieval-tokens`. Run both variants from the same checkout:

```sh
pnpm benchmark:exploration -- --repeats 2 --output /tmp/exploration-off.json
pnpm benchmark:exploration -- --repeats 2 --code-retrieval --output /tmp/exploration-on.json
```

Scripted tool sequences stay fixed in both variants. They measure retrieval's
accounting and overhead, not an adaptive model's potential reduction in reads.
Their input/I/O costs can increase; this must not be presented as a quality or
savings result. Reports include scan counts, considered files, source bytes,
partial scans, selected items/files/tokens and scan duration.

Verification:

The recorded [scripted baseline and overhead comparison](PHASE-7-BASELINE.md)
completed 20/20 runs per variant (ten tasks, two repeats). Phase 7.2 full validation
passed 40 test files / 266 tests, formatting, lint, type checking, build and
persistence restart/recovery. A final leading-blank-line citation correction also
passed the focused retrieval suite, formatting, lint, type checking and build.

```sh
pnpm exec vitest run test/benchmarks/exploration
pnpm validate
```

The benchmark lives in development/test tooling. Phase 7.2 changes Context and CLI
wiring plus Workspace's per-read size option; Runtime, Session schema, provider
adapters, tool definitions and permission decisions retain their existing behavior.
