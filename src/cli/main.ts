#!/usr/bin/env node
import { FileSessionStore } from '../session/file-session-store.js';
import { SessionFormatError } from '../session/session-codec.js';
import { SessionStateError } from '../session/session-history.js';
import { RecordStorageError } from '../workspace/record-storage.js';
import { LocalRecordStorage } from '../workspace/local-record-storage.js';
import { EventSubscriberError } from '../events/event-bus.js';
import { parseSessionCommand, prepareSessionRun, runSessionCommand } from './session-cli.js';
import { createTerminalApproval } from './terminal-approval.js';

import { createSampler, SamplerConfigurationError } from '../model/create-sampler.js';
import { ContextError } from '../context/context-budget.js';
import { SamplingError } from '../model/sampling-types.js';
import { createTracing, type TracingHandle } from '../observability/tracing.js';
import { CLI_HELP, CliRunError, CliUsageError, runPhaseOneCli } from './phase-one-cli.js';

function safeErrorMessage(error: unknown): string {
  if (error instanceof EventSubscriberError) return safeErrorMessage(error.cause);
  if (
    error instanceof SessionFormatError ||
    error instanceof SessionStateError ||
    error instanceof RecordStorageError ||
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
    const arguments_ = process.argv.slice(2);
    if (arguments_.includes('--help')) {
      process.stdout.write(`${CLI_HELP}\n`);
      return;
    }
    const command = parseSessionCommand(arguments_, process.cwd());
    tracing = createTracing();
    const store = new FileSessionStore(new LocalRecordStorage(command.directory), tracing.tracer);
    if (command.kind !== 'run') {
      await runSessionCommand(command, store, tracing.tracer, (text) =>
        process.stdout.write(`${text}\n`),
      );
      return;
    }
    const prepared = await prepareSessionRun(command, process.env, process.cwd(), store);
    const parsed = prepared.parsed;
    if (parsed.help) {
      process.stdout.write(`${CLI_HELP}\n`);
      return;
    }
    process.once('SIGINT', cancel);
    await runPhaseOneCli({
      ...parsed.config,
      sessionStore: store,
      provider: parsed.provider,
      ...(command.resumeId === undefined ? {} : { sessionId: command.resumeId }),
      ...(prepared.savedAgent === undefined ? {} : { savedAgent: prepared.savedAgent }),
      onSessionId: (id) => process.stderr.write(`Session: ${id}\n`),
      sampler: createSampler({ provider: parsed.provider, environment: process.env }),
      tracer: tracing.tracer,
      signal: cancellation.signal,
      approve: createTerminalApproval(process.stdin, process.stderr, cancel),
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
