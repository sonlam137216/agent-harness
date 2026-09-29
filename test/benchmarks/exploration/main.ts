import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createSampler } from '../../../src/model/create-sampler.js';
import { runBenchmarkTask, scriptedSampler, median } from './benchmark.js';
import { BENCHMARK_HELP, parseBenchmarkArguments } from './cli.js';
import { createFixture } from './fixture.js';
import { explorationTasks, TASK_SET_VERSION } from './tasks.js';

async function main(): Promise<void> {
  const options = parseBenchmarkArguments(process.argv.slice(2), process.cwd());
  if (options.help) {
    process.stdout.write(`${BENCHMARK_HELP}\n`);
    return;
  }
  // Fail configuration before spending any work or making a live request.
  const liveSampler =
    options.mode === 'live'
      ? createSampler({ provider: options.provider!, environment: process.env })
      : undefined;
  const fixture = await createFixture(options.repositoryRoot);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    let revision: string | null = null;
    let dirty: boolean | null = null;
    try {
      const git = (args: string[]) =>
        execFileSync('git', args, {
          cwd: options.repositoryRoot,
          encoding: 'utf8',
          timeout: 5_000,
          maxBuffer: 1_048_576,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      revision = git(['rev-parse', 'HEAD']);
      dirty = git(['status', '--porcelain']).length > 0;
    } catch {
      /* Source digests remain authoritative outside a Git checkout. */
    }
    const runs: Awaited<ReturnType<typeof runBenchmarkTask>>[] = [];
    const tasks = explorationTasks.filter(
      (task) => options.task === undefined || task.id === options.task,
    );
    for (const task of tasks) {
      for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
        if (controller.signal.aborted) break;
        runs.push(
          await runBenchmarkTask({
            ...options,
            ...fixture,
            task,
            repeat,
            sampler: liveSampler ?? scriptedSampler(task),
            signal: controller.signal,
          }),
        );
      }
    }
    const complete = runs.filter((run) => run.outcome === 'completed');
    const measured = complete.filter((run) => run.metrics !== null);
    const report = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      mode: options.mode,
      provenance: {
        revision,
        dirty,
        node: process.version,
        platform: process.platform,
        taskSetVersion: TASK_SET_VERSION,
        taskSetSha256: createHash('sha256').update(JSON.stringify(explorationTasks)).digest('hex'),
        fixtureSha256: fixture.digest,
        fixtureFiles: fixture.files,
      },
      configuration: {
        provider: options.provider ?? null,
        modelId: options.modelId,
        contextBudget: options.contextBudget,
        repeats: options.repeats,
        timeoutMs: options.timeoutMs,
        taskIds: tasks.map((task) => task.id),
        retrieval: options.retrieval !== undefined,
        retrievalOptions: options.retrieval ?? null,
        skills: 'none in fixture',
        mcp: false,
        permissionMode: 'auto',
        customEndpoint:
          options.mode === 'live' &&
          process.env[`${options.provider!.toUpperCase()}_BASE_URL`] !== undefined,
      },
      summary: {
        plannedRuns: tasks.length * options.repeats,
        completedRuns: complete.length,
        failedRuns: runs.length - complete.length,
        skippedRuns: tasks.length * options.repeats - runs.length,
        measuredCompletedRuns: measured.length,
        // Never mix failed runs into apparent cost improvements.
        mediansForCompletedRuns: {
          estimatedRequestTokens: median(
            complete.map((run) => run.sampling.estimatedRequestTokens),
          ),
          readFileCalls: median(measured.map((run) => run.metrics!.toolCalls.read_file!)),
          elapsedMs: median(complete.map((run) => run.elapsedMs)),
          reportedInputTokens:
            options.mode === 'live'
              ? median(
                  complete
                    .filter((run) => run.sampling.providerUsage?.complete)
                    .map((run) => run.sampling.providerUsage!.inputTokens),
                )
              : null,
        },
        quality: options.mode === 'scripted' ? 'not_evaluated_scripted' : 'pending_human_review',
        savings: null,
      },
      runs,
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output === undefined) process.stdout.write(json);
    else await writeFile(options.output, json, { flag: 'wx' });
    if (
      report.summary.failedRuns > 0 ||
      report.summary.skippedRuns > 0 ||
      measured.length !== complete.length
    )
      process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    await fixture.dispose();
  }
}

await main().catch(() => {
  // Do not print raw provider/configuration exceptions or environment values.
  process.stderr.write(
    'Exploration benchmark failed. Check options, provider configuration, fixture files and output destination. Use --help.\n',
  );
  process.exitCode = 1;
});
