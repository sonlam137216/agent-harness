# Phase 5 — Skills

Skills add reusable procedural instructions without changing TypeScript or the agent loop.
They are context, not executable plugins. Native tools remain read-only.

## Add a workflow

Create `.agents/skills/review/SKILL.md` in the workspace:

```markdown
---
name: review
description: Review code changes for correctness and missing tests
---
Read the relevant files before drawing conclusions.
Describe each actionable finding with its location and practical impact.
If there are no findings, say so and report what was checked.
```

Invoke it with either form:

```sh
pnpm cli -- --provider ollama --model <model-id> --skill review "Review src/context"
pnpm cli -- --provider ollama --model <model-id> '$review Review src/context'
```

Use single quotes around a prompt containing `$name` so the shell does not expand it.
`--skill` is repeatable. CLI flags become `$name` lines in the persisted user message;
the rest of the prompt remains intact. A prompt is still required.

## Discovery and precedence

- Project: `<workspace>/.agents/skills/<folder>/SKILL.md`.
- User: `~/.agents/skills/<folder>/SKILL.md`, or the directory supplied with
  `--user-skills-directory <path>`.
- Only immediate child directories are scanned, in deterministic name order.
  Symlink child directories are skipped. A skill file or root path that resolves outside
  its configured filesystem root fails through Workspace containment checks.
- The declared `name` is the identity; it need not match the folder name. Duplicate names
  within one scope fail. Project skills override user skills with the same name regardless
  of root order. All discovered files, including shadowed files, are validated.
- Missing roots and missing `SKILL.md` files are optional. Invalid files, unreadable roots,
  containment violations and limit violations fail the context build explicitly.

The user skill root has its own read-only FileSystemCapability, used only by the context source.
It does not expand the root available to `read_file`, `list_files` or `search_text`.
Relative resource references are not loaded automatically. In this phase, keep user skills
self-contained; their auxiliary resources are not exposed through workspace tools.

Discovery runs on every context build, so file changes are reflected on the next iteration.
There is no watcher, cache, install command or skill registry service.

## Supported format

The parser intentionally supports a small frontmatter subset, not arbitrary YAML:

- Opening and closing `---` lines, required `name` and `description`, and a nonempty Markdown body.
- Names start with a lowercase ASCII letter, use lowercase letters, digits and single hyphens
  between segments, and contain at most 64 characters.
- Values may be plain strings, JSON-style double-quoted strings, or single-quoted strings
  with doubled apostrophes. Quote descriptions containing `: ` or ` #`.
- `description: >`, `>-`, `|`, and `|-` accept lines indented by two spaces. Folded blocks join
  lines with spaces; literal blocks retain newlines. Outer whitespace is trimmed.
- UTF-8 BOM, CRLF, empty frontmatter lines and full-line `#` comments are accepted.
- Unknown fields, duplicate fields, nested structures, tags, anchors, aliases and unsupported
  YAML syntax are rejected. Metadata such as `allowed-tools` cannot grant permissions.

The body is preserved as Markdown apart from outer whitespace and newline normalization.
Parser errors identify the supported format without copying file content into diagnostics.

## Selection and budget

Explicit invocation reads only the active turn's original user message. A token must be
whitespace-delimited `$name`, optionally followed by `. , ; : ! ?`. Duplicate invocations load
once, in invocation order. Currency amounts and uppercase environment variables are not skill
invocations. An unknown explicit name fails before model sampling.

Historical messages, assistant output, tool results and references inside skill bodies do not
select skills. A new turn requires a new invocation. Skill bodies are not persisted as transcript
entries or copied into checkpoints. Resuming a session loads current skill files; it does not
reconstruct an earlier skill version. `--auto-skills` and a custom user root are run options and
must be supplied again on resume when wanted.

Automatic selection is disabled by default. `--auto-skills` enables a simple lexical heuristic:
lowercase ASCII words of at least three characters from the name and description, excluding a small
stop-word set, must share at least two distinct words with the current prompt. At most three additional
skills are selected, ranked by overlap then name. Explicit skills come first and are deduplicated
from automatic results. This is not semantic relevance detection; use explicit invocation when
selection matters. Bodies never contribute to automatic matching.

Selected bodies are labeled system context after project rules. The label states that workflows
must respect user instructions, rules and harness policy and cannot grant permissions. Permission
enforcement remains in ToolBridge, independently of the model following that label.

Default discovery limits are 100 files across both scopes, 64 KiB per file, and 1 MiB total file
content; filesystem reads/listings also retain their own bounds. `SkillsSource` accepts application
limits through `SkillsOptions`. Only selected skills enter the model request. All injected labels
and bodies count toward `context.skills_tokens`. Selected skills are mandatory for that build:
pruning/compaction may reduce old history but never silently remove or truncate a selected workflow.
Irreducible overflow is `ContextError('budget_exceeded')`.

## Errors, tracing and verification

SkillsSource normalizes parser/discovery failures to `ContextError('source_failed')`, retaining a
sanitized cause category for filesystem/format failures. Cancellation and deadlines propagate as
the existing SamplingError categories. No filesystem or provider retry is added.

`context.skills` is a child of `context.build`, with session, turn and model-call correlation.
It emits `skills.selected` and `skills.injected` events and records discovered/effective/selected
counts, automatic-selection status, bytes, duration and normalized failure category. It does not
record names, paths, descriptions, bodies or prompts. `context.build` provides token accounting.
An injection event describes the source contribution; only a successful enclosing context build
produces a request that can be sampled.

Verification uses parser/selector tests, real temporary filesystem discovery tests, and a fake-model
CLI integration covering permissions, token budgets, persistence/resume and current-file reloads:

```sh
pnpm exec vitest run test/skills test/cli/skills-cli.test.ts
pnpm validate
```

Deferred: full YAML interoperability, automatic resource loading, script execution, executable
plugins, semantic/model-based selection, skill-version snapshots, MCP and all later roadmap phases.
