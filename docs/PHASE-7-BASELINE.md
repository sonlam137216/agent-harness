# Phase 7.1 scripted baseline

Recorded: 2026-09-28T08:02:06.804Z. This is an accounting workload, not an autonomous
model evaluation or evidence of token savings.

- Source revision: `8b0aa1bd6b8bf05700b6a6c7e3745a9e9d47c8e4`; working tree dirty with Phase 7.1 development.
- Task set version: 1.
- Task set SHA-256: `4d165a7f6abe24504cf41cafa6d5b7a5b35796e0e64346dffd6c3de1a9fc1fe5`.
- Fixture SHA-256: `416e8a7abc49e2d80daac5135796108ab0160b1bf36e4f799f7e1b7bc399b915`.
- Runtime: v22.11.0, darwin.
- Model: scripted-exploration-v1; no provider calls.
- Budget: 131072 estimated window units, 4096 output reserve.
- Two repeats per task: 20 completed, zero failures/skips, all with telemetry.
- Median all-request estimate: **62,738 units**; median read_file calls: **2**.
- Provider usage, answer correctness and savings: **not measured**.

The estimate counts serialized UTF-8 bytes plus framing allowances; it is not a
provider tokenizer count. Costs below are per run, summed across all its model
requests. Both repeats produced identical request estimates and operation counts.
Filesystem successes include Context-owned rules reads and search scanning.

| Task | Estimated request units | read_file calls | Filesystem read successes |
| --- | ---: | ---: | ---: |
| target-permissions | 74,487 | 2 | 8 |
| deny-precedence | 54,804 | 2 | 7 |
| checkpoint-reuse | 81,545 | 2 | 8 |
| required-context | 92,378 | 2 | 8 |
| interrupted-call | 58,409 | 2 | 7 |
| rewind-checkpoint | 56,288 | 2 | 7 |
| skill-selection | 90,974 | 3 | 10 |
| workspace-containment | 66,309 | 2 | 7 |
| search-bounds | 59,167 | 2 | 8 |
| absent-vector-index | 43,935 | 1 | 14 |

Across one repeat of the suite, conversation contributes 48.1%
and project rules 45.8% of estimated input. Conversation includes
repeated tool results; the current report does not break those out separately.
The negative lookup uses only one read_file call but scans enough files to produce
14 filesystem read successes, illustrating why tool counts alone are insufficient.

This baseline suggests measuring narrower evidence selection and repeated input
in Phase 7.2. It does not justify dropping required rules or promise a savings
percentage. The fixed scripted sequence cannot predict a live model's tool choices.
The initial suite does not trigger compaction; a separate integration test verifies
that actual ContextBuilder summary calls enter all-request accounting.

Reproduce from the same source/runtime and task/corpus hashes:

```sh
pnpm benchmark:exploration -- --repeats 2 --output /tmp/exploration-baseline.json
```

JSON reports include per-file hashes, configuration, correlation IDs, source totals,
outcomes and rubrics. Timing and IDs vary on rerun. After runtime or fixture edits,
generate a new baseline and compare only compatible inputs. See [PHASE-7.md](PHASE-7.md).

## Phase 7.2 paired scripted overhead check

Recorded 2026-09-29 after the lexical retriever implementation. These two runs
used identical task and corpus hashes, the same working-tree runtime, and two
repeats per task. They supersede the earlier snapshot only for this paired
comparison; do not compare different fixture versions as a savings result.

- Fixture SHA-256: `ddce5d904dc06df6fe8763ab13440596589c6419c8467d752a79aba9597ba5cc`.
- Task SHA-256: `4d165a7f6abe24504cf41cafa6d5b7a5b35796e0e64346dffd6c3de1a9fc1fe5`.
- Budget: 131072 estimated units, output reserve 4096; retrieval cap 4096.
- Model: scripted-exploration-v1. Source revision remains `8b0aa1b` with
  uncommitted Phase 7.1–7.2 changes. No hosted model was called.

| Measurement | Retrieval off | Retrieval on |
| --- | ---: | ---: |
| Completed runs | 20/20 | 20/20 |
| Median all-request estimated units | 63,289 | 79,591 |
| Median read_file calls | 2 | 2 |
| Median elapsed time (ms) | 6.93 | 60.84 |
| Total successful filesystem bytes read | 1,291,072 | 12,160,192 |
| Retrieval scans | 0 | 80 |
| Scans reporting partial coverage | 0 | 74 |

The scripted sampler deliberately executes the same tool sequence in both modes.
Retrieval therefore adds excerpts and rescans without replacing those tool calls:
this is measured overhead, not token savings or a quality assessment. Partial
coverage is explicitly reported and must not be treated as exhaustive evidence.
Timing is local and includes instrumentation overhead.

## Phase 7.3a–b paired scripted check

Recorded 2026-09-29 after separating selection limits from coverage gaps and adding
the per-turn scan cache. Same method as above: two repeats per task, identical task
and corpus hashes within the pair, source revision `82f8f54` plus uncommitted 7.3a–b
changes. The fixture hash (`2addd257…c8a0`) differs from the 7.2 pair because the
fixture copies changed source files, so compare the 7.2 row only as indicative.

| Measurement | 7.2 retrieval on | 7.3a–b retrieval off | 7.3a–b retrieval on |
| --- | ---: | ---: | ---: |
| Completed runs | 20/20 | 20/20 | 20/20 |
| Median all-request estimated units | 79,591 | 63,289 | 79,563 |
| Median read_file calls | 2 | 2 | 2 |
| Median elapsed time (ms) | 60.84 | 8.39 | 26.93 |
| Total successful filesystem bytes read | 12,160,192 | 1,292,512 | 4,012,192 |
| Retrieval scans | 80 | 0 | 20 |
| Per-turn cache hits | — | 0 | 60 |
| Scans reporting partial coverage | 74 | 0 | 0 |
| Scans with selection limits (`candidates`) | — | 0 | 18 |

Every former partial report was candidate-list truncation after a complete scan;
no scan in this suite hit a real coverage bound. The model now receives no false
partial-coverage notice. Rescanning dropped from four to one scan per run, cutting
retrieval I/O by 75%. Estimated request size is unchanged: the same excerpts are
still sent on every model request, which is inherent to stateless requests. Whether
a live model offsets that by reading fewer files remains the Phase 7.3c question.

Phase 7.3c must evaluate whether a live model can use these excerpts to reduce its
own exploration while preserving correctness. Keep retrieval opt-in until that
comparison supports a broader default. The proposed savings target is unproven.
