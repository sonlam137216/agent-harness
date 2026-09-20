# Ollama / Qwen3 Phase 2 live verification

Date: 2026-09-20. These are observations from a small local fixture suite, not a model reliability benchmark.

## Environment

- Ollama endpoint: `http://localhost:11434`, version `0.32.14`.
- Installed model: `qwen3:1.7b`, digest `8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7`.
- `/api/tags` advertised completion, tools and thinking capabilities. `/api/ps` reported a loaded context length of 4096.
- Built the current working tree using `pnpm build`.
- Invoked the actual OllamaChatSampler, ContextBuilder, AgentLoop and SessionRuntime; no model responses were mocked. The file-reading cases used the actual CLI composition function and local filesystem tools.
- Read cases used a 4096 context window and 1024 output reserve. Compaction/pruning used a 4096 window, 2048 output reserve and 1024 summary cap.
- Provider retry count was configured to zero in the probe. The model's default sampling/thinking settings were otherwise unchanged.

## Results

| Case | Result | Evidence |
| --- | --- | --- |
| File read, initial prompt | Failed factual check | Model returned final text without any tool call, inventing a verification code description and InnoDB; the fixture contained a random code and SQLite |
| File read, more explicit prompt | Passed | Actual `read_file` execution succeeded; two model iterations; final answer contained the exact random code `LIVE-24ee9f04` and SQLite |
| Root project rules | Passed in successful read case | AGENTS.md loaded through Workspace; answer began with required `VERIFIED:` prefix |
| Compaction | Passed | Six seeded historical turns triggered two actual summary calls covering five turns; estimated input reduced from 4605 to 1524, below the 2048 input allowance |
| Facts after compaction | Passed | Model correctly recalled `LIVE-1737a99b`, SQLite and teal, which were supplied only in the oldest historical turn |
| Checkpoint continuation | Passed | Next turn reused the checkpoint without further compaction and returned exactly `LIVE-1737a99b` |
| Historical result pruning | Passed | One seeded historical tool result was shortened; estimated input reduced from 8909 to 1917, with no summary call; model retained the code `LIVE-80ac2259`, SQLite and teal |
| Transcript preservation | Passed | Original historical entries compared equal before/after both compaction and pruning |

The context-size numbers above are **the harness's UTF-8-based estimates**, not provider token usage.
Actual provider input/output usage was also returned and recorded separately in the reports.

The compaction and pruning cases deliberately seeded fixture histories to trigger budget pressure;
the historical assistant/tool entries were not generated in prior live model runs. Summarization,
final answers and checkpoint continuation were real Ollama calls.

The successful read prompt explicitly required `read_file`, explained that the code was random and
must not be guessed, and appended `/no_think`. The response still contained thinking metadata, so
this run does not establish that thinking was disabled or that `/no_think` caused the improvement.
Only one attempt per prompt variant was measured.

## Interpretation

The Phase 2 mechanisms exercised here work with this local model: scoped context assembly at the
root, budgeting, historical result pruning, model-assisted compaction, checkpoint reuse and raw
transcript preservation. An actual model → read_file → model path also succeeded.

Tool selection is not consistently reliable in this small model: the first run skipped the tool and
invented an answer. Runtime's `completed` status means a valid final response, not verified factual
correctness. These results do not justify claiming every repository task or summary is reliable.
No production source code was changed to force these outcomes.

Nested rule precedence, cancellation and invalid-summary handling remain covered by deterministic
tests; this live suite did not retest every Phase 2 edge case. Checkpoints remain in memory only.

## Local evidence

The temporary probe and complete sanitized reports were retained on this machine:

- Probe: `/private/tmp/phase2-ollama-live.mjs` (modes `read`, `read-no-think`, `compaction`, `pruning`).
- Initial read: `/private/tmp/harness-ollama-live-IY200w/report.json`.
- Successful read: `/private/tmp/harness-ollama-live-2gR1N6/report.json`.
- Compaction and continuation: `/private/tmp/harness-ollama-live-Dg3kh5/report.json`.
- Pruning: `/private/tmp/harness-ollama-live-tjHe4l/report.json`.

These temporary paths may be removed by the OS. This document preserves the measured results.
