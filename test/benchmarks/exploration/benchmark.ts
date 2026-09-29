import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { CliRunError, runPhaseOneCli } from '../../../src/cli/phase-one-cli.js';
import {
  contributionTokens,
  REQUEST_FRAMING_TOKENS,
  utf8TokenEstimate,
  type ContextBudget,
} from '../../../src/context/context-budget.js';
import { createToolCallId, type SessionId } from '../../../src/ids.js';
import type { JsonValue } from '../../../src/json.js';
import type { Sampler } from '../../../src/model/sampler.interface.js';
import type { TokenUsage } from '../../../src/model/sampling-types.js';
import { createTracing } from '../../../src/observability/tracing.js';
import { InMemorySessionStore } from '../../../src/session/in-memory-session-store.js';
import type { Session } from '../../../src/session/session.js';
import type { ExplorationTask } from './tasks.js';

export function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

/** A fixed workload, not a simulated quality score or autonomous exploration baseline. */
export function scriptedSampler(task: ExplorationTask): Sampler {
  const steps = [
    { name: 'search_text', arguments: { ...task.search } },
    ...task.evidence.map((path) => ({ name: 'read_file', arguments: { path } })),
  ];
  let index = 0;
  return {
    sample: (request) => {
      if (index > 0) {
        const last = request.messages.at(-1);
        if (last?.role !== 'tool') throw new Error('Scripted workload expected a tool result.');
        const result = object(JSON.parse(last.content) as JsonValue);
        if (result?.outcome !== 'success') throw new Error('Scripted tool operation failed.');
        if (index === 1) {
          const output = object(result.output);
          if (!Array.isArray(output?.matches) || output.truncated !== false)
            throw new Error('Scripted search was incomplete.');
          if ((output.matches.length === 0) !== (task.expectNoMatches === true))
            throw new Error('Scripted search expectation no longer matches the fixture.');
        }
      }
      const step = steps[index++];
      return Promise.resolve({
        modelCallId: request.modelCallId,
        text:
          step === undefined
            ? 'Scripted evidence workload completed; answer quality is not evaluated.'
            : null,
        toolCalls: step === undefined ? [] : [{ id: createToolCallId(), ...step }],
        // These synthetic zeros are never reported as provider usage.
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: step === undefined ? 'end_turn' : 'tool_calls',
      });
    },
  };
}

export class SamplingMeasurements implements Sampler {
  public attempts = 0;
  public estimatedRequestTokens = 0;
  public readonly returnedUsage: TokenUsage[] = [];

  public constructor(private readonly delegate: Sampler) {}

  public readonly sample: Sampler['sample'] = async (request, options) => {
    this.attempts += 1;
    this.estimatedRequestTokens +=
      REQUEST_FRAMING_TOKENS +
      contributionTokens(utf8TokenEstimate, request.messages, request.tools);
    const response = await this.delegate.sample(request, options);
    this.returnedUsage.push(response.usage);
    return response;
  };

  public usage(mode: 'scripted' | 'live') {
    if (mode === 'scripted') return null;
    const sum = (key: keyof TokenUsage) =>
      this.returnedUsage.reduce((total, usage) => total + (usage[key] ?? 0), 0);
    return {
      inputTokens: sum('inputTokens'),
      outputTokens: sum('outputTokens'),
      cachedInputTokens: this.returnedUsage.every((usage) => usage.cachedInputTokens !== undefined)
        ? sum('cachedInputTokens')
        : null,
      responseCount: this.returnedUsage.length,
      complete: this.attempts === this.returnedUsage.length,
      note: 'Normalized usage from returned responses, including compaction. Failed transport attempts and provider-internal retries may have unreported usage; this is not a billing ledger.',
    };
  }
}

/** Counts how many spans carry each value of a string-array attribute. */
function countValues(items: readonly ReadableSpan[], key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const span of items) {
    const values = span.attributes[key];
    if (!Array.isArray(values)) continue;
    for (const value of values)
      if (typeof value === 'string') counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

export function summarizeSpans(spans: readonly ReadableSpan[]) {
  const named = (name: string) => spans.filter((span) => span.name === name);
  const sum = (items: readonly ReadableSpan[], key: string) =>
    items.reduce(
      (total, span) =>
        total + (typeof span.attributes[key] === 'number' ? span.attributes[key] : 0),
      0,
    );
  const contexts = named('context.build').filter((span) => span.attributes.success === true);
  const reads = named('workspace.operation').filter(
    (span) => span.attributes.operation === 'filesystem.read_file',
  );
  const tools = named('tool.execute');
  const sources = ['system', 'conversation', 'tool', 'rules', 'skills', 'memory', 'retrieval'];
  return {
    available: named('session.run').length === 1 && named('turn.run').length === 1,
    contextBuilds: contexts.length,
    failedContextBuilds: named('context.build').length - contexts.length,
    retrieval: {
      scans: named('retrieval.code').length,
      consideredFiles: sum(named('retrieval.code'), 'files_considered'),
      bytesRead: sum(named('retrieval.code'), 'bytes_read'),
      partialScans: named('retrieval.code').filter((span) => span.attributes.partial === true)
        .length,
      partialReasons: countValues(named('retrieval.code'), 'partial_reasons'),
      selectionLimits: countValues(named('retrieval.code'), 'selection_limits'),
      cacheHits: named('context.code_retrieval').filter(
        (span) => span.attributes['cache.hit'] === true,
      ).length,
      selectedItems: sum(named('context.code_retrieval'), 'selected_items'),
      selectedFiles: sum(named('context.code_retrieval'), 'selected_files'),
      selectedTokens: sum(named('context.code_retrieval'), 'selected_tokens'),
      scanDurationMs: sum(named('retrieval.code'), 'duration_ms'),
    },
    // These contributions cover successful normal context builds; summary requests
    // are included separately by SamplingMeasurements for the total request estimate.
    estimatedSourceTokens: Object.fromEntries(
      sources.map((source) => [source, sum(contexts, `context.${source}_tokens`)]),
    ),
    estimatedFramingTokens: sum(contexts, 'context.framing_tokens'),
    estimatedBuiltContextTokens: sum(contexts, 'context.total_tokens'),
    toolCalls: Object.fromEntries(
      ['read_file', 'search_text', 'list_files'].map((name) => [
        name,
        tools.filter((span) => span.attributes['tool.name'] === name).length,
      ]),
    ),
    toolFailures: tools.filter((span) => span.attributes.success === false).length,
    filesystemReadAttempts: reads.length,
    filesystemReadSuccesses: reads.filter((span) => span.attributes.success === true).length,
    filesystemBytesRead: sum(reads, 'filesystem.bytes_read'),
    directoryListAttempts: named('workspace.operation').filter(
      (span) => span.attributes.operation === 'filesystem.list_directory',
    ).length,
    iterations: named('agent.loop.iteration').length,
    compactionModelCalls: named('model.sample').filter(
      (span) => span.attributes['model.purpose'] === 'compaction',
    ).length,
  };
}

export function evidenceRead(session: Session | undefined, expected: readonly string[]) {
  const readCalls = new Set(
    session?.turns.flatMap((turn) =>
      turn.entries.flatMap((entry) =>
        entry.kind === 'assistant_message'
          ? entry.toolCalls.filter((call) => call.name === 'read_file').map((call) => call.id)
          : [],
      ),
    ) ?? [],
  );
  const paths = new Set(
    session?.turns.flatMap((turn) =>
      turn.entries.flatMap((entry) => {
        if (
          entry.kind !== 'tool_result' ||
          entry.outcome !== 'success' ||
          !readCalls.has(entry.toolCallId)
        )
          return [];
        const path = object(entry.output)?.path;
        return typeof path === 'string' ? [path] : [];
      }),
    ) ?? [],
  );
  const found = expected.filter((path) => paths.has(path));
  return {
    expected: [...expected],
    read: found,
    fraction: expected.length === 0 ? null : found.length / expected.length,
  };
}

export interface BenchmarkRunOptions {
  readonly retrieval?: { readonly roots: readonly string[]; readonly maxTokens?: number };
  readonly task: ExplorationTask;
  readonly repeat: number;
  readonly mode: 'scripted' | 'live';
  readonly modelId: string;
  readonly sampler: Sampler;
  readonly workspaceRoot: string;
  readonly userSkillsDirectory: string;
  readonly contextBudget: ContextBudget;
  readonly timeoutMs: number;
  readonly includeAnswers?: boolean;
  readonly signal?: AbortSignal;
}

export async function runBenchmarkTask(options: BenchmarkRunOptions) {
  const exporter = new InMemorySpanExporter();
  let traceFailed = false;
  const tracing = createTracing({
    exporter,
    onError: () => {
      traceFailed = true;
    },
  });
  const store = new InMemorySessionStore();
  const sampler = new SamplingMeasurements(options.sampler);
  let sessionId: SessionId | undefined;
  let outcome = 'failed';
  let failure: string | null = null;
  let answer: string | null = null;
  const started = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  const signal =
    options.signal === undefined
      ? controller.signal
      : AbortSignal.any([controller.signal, options.signal]);
  try {
    try {
      const result = await runPhaseOneCli({
        modelId: options.modelId,
        prompt: `Answer using only the supplied, curated repository fixture. Cite workspace-relative source paths and line numbers. Limit absence claims to inspected evidence.\n\n${options.task.question}`,
        workspaceRoot: options.workspaceRoot,
        userSkillsDirectory: options.userSkillsDirectory,
        autoSkills: false,
        permissionMode: 'auto',
        contextBudget: options.contextBudget,
        ...(options.retrieval === undefined ? {} : { retrieval: options.retrieval }),
        sampler,
        sessionStore: store,
        onSessionId: (id) => {
          sessionId = id;
        },
        tracer: tracing.tracer,
        signal,
        writeOutput: () => undefined,
      });
      outcome = result.outcome;
      answer = result.finalText;
    } catch (error) {
      outcome = signal.aborted ? 'cancelled' : 'failed';
      failure = controller.signal.aborted
        ? 'timeout'
        : error instanceof CliRunError
          ? error.outcome
          : 'run_failed';
    }
    const elapsedMs = performance.now() - started;
    await tracing.forceFlush();
    const session = sessionId === undefined ? undefined : await store.get(sessionId);
    const spanMetrics = summarizeSpans(exporter.getFinishedSpans());
    return {
      taskId: options.task.id,
      repeat: options.repeat,
      outcome,
      failure,
      elapsedMs,
      correlation: {
        sessionId: sessionId ?? null,
        turnId: session?.turns.at(-1)?.id ?? null,
        traceId: session?.turns.at(-1)?.traceId ?? null,
      },
      sampling: {
        attempts: sampler.attempts,
        estimatedRequestTokens: sampler.estimatedRequestTokens,
        counter: utf8TokenEstimate.name,
        providerUsage: sampler.usage(options.mode),
      },
      metrics: traceFailed || !spanMetrics.available ? null : spanMetrics,
      evidenceFileReads: evidenceRead(session, options.task.evidence),
      quality: {
        status: options.mode === 'scripted' ? 'not_evaluated_scripted' : 'pending_human_review',
        rubric: options.task.rubric,
        note: 'File-read coverage does not establish answer correctness or complete evidence coverage.',
      },
      ...(options.includeAnswers === true ? { answer } : {}),
    };
  } finally {
    clearTimeout(timeout);
    await tracing.shutdown();
  }
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}
