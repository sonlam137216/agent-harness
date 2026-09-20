#!/usr/bin/env node

import { createSampler, SamplerConfigurationError } from '../model/create-sampler.js';
import { ContextError } from '../context/context-budget.js';
import { SamplingError } from '../model/sampling-types.js';
import { createTracing, type TracingHandle } from '../observability/tracing.js';
import {
  CLI_HELP,
  CliRunError,
  CliUsageError,
  parsePhaseOneCliArguments,
  runPhaseOneCli,
} from './phase-one-cli.js';

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof ContextError ||
    error instanceof CliUsageError ||
    error instanceof CliRunError ||
    error instanceof SamplerConfigurationError ||
    error instanceof SamplingError
  ) {
    return error.message;
  }
  return 'The CLI failed unexpectedly.';
}

async function main(): Promise<void> {
  let tracing: TracingHandle | undefined;
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort();

  try {
    const parsed = parsePhaseOneCliArguments(process.argv.slice(2), process.env, process.cwd());
    if (parsed.help) {
      process.stdout.write(`${CLI_HELP}\n`);
      return;
    }

    tracing = createTracing();
    process.once('SIGINT', cancel);
    await runPhaseOneCli({
      ...parsed.config,
      sampler: createSampler({ provider: parsed.provider, environment: process.env }),
      tracer: tracing.tracer,
      signal: cancellation.signal,
      writeOutput: (text) => process.stdout.write(`${text}\n`),
    });
  } catch (error) {
    process.stderr.write(`Error: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    await tracing?.forceFlush();
    await tracing?.shutdown();
  }
}

void main();
