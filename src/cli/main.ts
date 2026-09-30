#!/usr/bin/env node
import { FileSessionStore } from '../session/file-session-store.js';
import { LocalRecordStorage } from '../workspace/local-record-storage.js';
import { parseSessionCommand, prepareSessionRun, runSessionCommand } from './session-cli.js';
import { createTerminalApproval } from './terminal-approval.js';

import { createSampler } from '../model/create-sampler.js';
import { createTracing, type TracingHandle } from '../observability/tracing.js';
import { StderrSpanExporter } from '../observability/stderr-span-exporter.js';
import { CLI_HELP, CliUsageError, createMemoryWriter, runPhaseOneCli } from './phase-one-cli.js';
import { parseMemoryCommand, runMemoryCommand, runSessionSummaryCommand } from './memory-cli.js';
import { createWorktreeManager, parseWorktreeCommand, runWorktreeCommand } from './worktree-cli.js';
import { runAcpServer } from './acp-cli.js';
import { createPromptReader, runChat } from './chat-cli.js';
import { safeErrorMessage } from './errors.js';
import { EventBus } from '../events/event-bus.js';
import { createProgressReporter } from './progress-reporter.js';

const TRACE_ENVIRONMENT_VARIABLE = 'AGENT_HARNESS_TRACE';

/**
 * Span export for CLI commands: `off` (default; spans still carry trace IDs into sessions),
 * `stderr` (one JSON line per span) or `console` (verbose). Protocol mode never uses stdout.
 */
function createCliTracing(defaultMode: 'off' | 'stderr', protocol = false): TracingHandle {
  const mode = process.env[TRACE_ENVIRONMENT_VARIABLE]?.trim() || defaultMode;
  if (!['off', 'stderr', 'console'].includes(mode))
    throw new CliUsageError(`${TRACE_ENVIRONMENT_VARIABLE} must be off, stderr or console.`);
  if (mode === 'off') return createTracing({ exporter: null });
  if (mode === 'stderr' || protocol) return createTracing({ exporter: new StderrSpanExporter() });
  return createTracing();
}

/** A per-run event bus that shows tool progress on stderr; stdout keeps only answers. */
function progressEvents(): EventBus {
  const events = new EventBus();
  events.subscribe(createProgressReporter((line) => process.stderr.write(`${line}\n`)));
  return events;
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
    const memoryCommand = parseMemoryCommand(arguments_, process.cwd());
    if (memoryCommand !== undefined) {
      tracing = createCliTracing('off');
      await runMemoryCommand(
        memoryCommand,
        createMemoryWriter(
          memoryCommand.workspaceRoot,
          memoryCommand.userMemoryDirectory,
          tracing.tracer,
        ),
        (text) => process.stdout.write(`${text}\n`),
      );
      return;
    }
    const worktreeCommand = parseWorktreeCommand(arguments_, process.cwd());
    if (worktreeCommand !== undefined) {
      tracing = createCliTracing('off');
      process.once('SIGINT', cancel);
      await runWorktreeCommand(
        worktreeCommand,
        createWorktreeManager(
          worktreeCommand.workspaceRoot,
          worktreeCommand.worktreeDirectory,
          tracing.tracer,
          process.env,
        ),
        (text) => process.stdout.write(`${text}\n`),
        cancellation.signal,
      );
      return;
    }
    const command = parseSessionCommand(arguments_, process.cwd());
    if (command.kind === 'run' && command.arguments[0] === 'acp') {
      if (command.resumeId !== undefined)
        throw new CliUsageError('Use session/load instead of --resume with acp.');
      // stdout carries the protocol: spans and diagnostics go to stderr only.
      tracing = createCliTracing('stderr', true);
      await runAcpServer({
        arguments: command.arguments.slice(1),
        environment: process.env,
        cwd: process.cwd(),
        sessionStore: new FileSessionStore(
          new LocalRecordStorage(command.directory),
          tracing.tracer,
        ),
        createSampler: (provider) => createSampler({ provider, environment: process.env }),
        tracer: tracing.tracer,
        input: process.stdin,
        output: process.stdout,
        diagnostics: (message) => process.stderr.write(`${message}\n`),
      });
      return;
    }
    tracing = createCliTracing('off');
    const store = new FileSessionStore(new LocalRecordStorage(command.directory), tracing.tracer);
    if (command.kind === 'summarize') {
      process.once('SIGINT', cancel);
      await runSessionSummaryCommand(command, store, process.cwd(), {
        createSampler: (provider) => createSampler({ provider, environment: process.env }),
        tracer: tracing.tracer,
        writeOutput: (text) => process.stdout.write(`${text}\n`),
        signal: cancellation.signal,
      });
      return;
    }
    if (command.kind !== 'run') {
      await runSessionCommand(command, store, tracing.tracer, (text) =>
        process.stdout.write(`${text}\n`),
      );
      return;
    }
    if (command.arguments[0] === 'chat') {
      const prepared = await prepareSessionRun(
        { ...command, arguments: command.arguments.slice(1) },
        process.env,
        process.cwd(),
        store,
        { requirePrompt: false },
      );
      if (prepared.parsed.help) {
        process.stdout.write(`${CLI_HELP}\n`);
        return;
      }
      if (prepared.parsed.config.prompt !== '')
        throw new CliUsageError('chat reads prompts interactively; omit the prompt argument.');
      const { config, provider } = prepared.parsed;
      const sampler = createSampler({ provider, environment: process.env });
      const tracer = tracing.tracer;
      let interrupt: (() => void) | undefined;
      const onSigint = (): void => interrupt?.();
      process.on('SIGINT', onSigint);
      process.stderr.write('Chat started. Ctrl+C cancels a running turn; /exit leaves.\n');
      try {
        const sessionId = await runChat({
          ...(command.resumeId === undefined ? {} : { sessionId: command.resumeId }),
          readPrompt: createPromptReader(process.stdin, process.stderr),
          setInterrupt: (cancel) => {
            interrupt = cancel;
          },
          writeError: (text) => process.stderr.write(`${text}\n`),
          runTurn: async ({ prompt, sessionId: current, onSessionId, signal }) => {
            await runPhaseOneCli({
              ...config,
              prompt,
              environment: process.env,
              sessionStore: store,
              provider,
              ...(current === undefined ? {} : { sessionId: current }),
              ...(prepared.savedAgent === undefined ? {} : { savedAgent: prepared.savedAgent }),
              onSessionId: (id) => {
                if (current === undefined) process.stderr.write(`Session: ${id}\n`);
                onSessionId(id);
              },
              sampler,
              tracer,
              signal,
              events: progressEvents(),
              approve: createTerminalApproval(process.stdin, process.stderr, () => interrupt?.()),
              writeOutput: (text) => process.stdout.write(`${text}\n`),
            });
          },
        });
        if (sessionId !== undefined) process.stderr.write(`Resume with: --resume ${sessionId}\n`);
      } finally {
        process.removeListener('SIGINT', onSigint);
      }
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
      environment: process.env,
      sessionStore: store,
      provider: parsed.provider,
      ...(command.resumeId === undefined ? {} : { sessionId: command.resumeId }),
      ...(prepared.savedAgent === undefined ? {} : { savedAgent: prepared.savedAgent }),
      onSessionId: (id) => process.stderr.write(`Session: ${id}\n`),
      sampler: createSampler({ provider: parsed.provider, environment: process.env }),
      tracer: tracing.tracer,
      signal: cancellation.signal,
      events: progressEvents(),
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
