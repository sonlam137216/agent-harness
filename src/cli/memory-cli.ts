import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { memoryInputProblem, type MemoryWriter } from '../memory/memory-writer.js';
import type { MemoryScope } from '../memory/memory-store.js';
import { SessionSummarizer } from '../memory/session-summarizer.js';
import { isModelProvider, MODEL_PROVIDERS, type ModelProvider } from '../model/create-sampler.js';
import type { Sampler } from '../model/sampler.interface.js';
import type { TracingHandle } from '../observability/tracing.js';
import { SessionStateError } from '../session/session-history.js';
import type { SessionStore } from '../session/session-store.js';
import { CliUsageError, createMemoryWriter } from './phase-one-cli.js';
import type { SessionSummarizeCommand } from './session-cli.js';

export interface MemoryAddCommand {
  readonly kind: 'memory-add';
  readonly workspaceRoot: string;
  readonly userMemoryDirectory: string;
  readonly scope: MemoryScope;
  readonly file?: string;
  readonly title: string;
  readonly body: string;
}

const USAGE = 'Use memory add --title <title> [--scope workspace|user] [--file <name>] "<note>".';

/** Returns undefined when the arguments are not a memory command. */
export function parseMemoryCommand(
  arguments_: readonly string[],
  cwd: string,
): MemoryAddCommand | undefined {
  const args = arguments_.filter((argument) => argument !== '--');
  if (args[0] !== 'memory') return undefined;
  if (args[1] !== 'add') throw new CliUsageError(USAGE);
  let workspace = cwd;
  let userMemoryDirectory = join(homedir(), '.agents', 'memory');
  let scope: MemoryScope = 'workspace';
  let file: string | undefined;
  let title: string | undefined;
  const bodyParts: string[] = [];
  for (let index = 2; index < args.length; index += 1) {
    const argument = args[index]!;
    const value = (): string => {
      const next = args[index + 1];
      if (next === undefined || next.startsWith('--'))
        throw new CliUsageError(`${argument} requires a value.`);
      index += 1;
      return next;
    };
    if (argument === '--title') title = value();
    else if (argument === '--file') file = value();
    else if (argument === '--workspace') workspace = value();
    else if (argument === '--user-memory-directory') userMemoryDirectory = resolve(cwd, value());
    else if (argument === '--scope') {
      const next = value();
      if (next !== 'workspace' && next !== 'user')
        throw new CliUsageError('--scope must be workspace or user.');
      scope = next;
    } else if (argument.startsWith('--')) throw new CliUsageError(`Unknown option: ${argument}`);
    else bodyParts.push(argument);
  }
  if (title === undefined) throw new CliUsageError(USAGE);
  const body = bodyParts.join(' ');
  const problem = memoryInputProblem({ title, body, ...(file === undefined ? {} : { file }) });
  if (problem !== undefined) throw new CliUsageError(problem);
  return {
    kind: 'memory-add',
    workspaceRoot: resolve(cwd, workspace),
    userMemoryDirectory,
    scope,
    ...(file === undefined ? {} : { file }),
    title,
    body,
  };
}

/**
 * Summarizes a saved session into memory. Model and provider default to those saved
 * with the session; the workspace defaults to the session's saved root.
 */
export async function runSessionSummaryCommand(
  command: SessionSummarizeCommand,
  store: SessionStore,
  cwd: string,
  dependencies: {
    readonly createSampler: (provider: ModelProvider) => Sampler;
    readonly tracer: TracingHandle['tracer'];
    readonly writeOutput: (text: string) => void;
    readonly signal?: AbortSignal;
  },
): Promise<void> {
  const session = await store.get(command.sessionId);
  if (session === undefined) throw new SessionStateError('The requested session does not exist.');
  const modelId = command.model ?? session.metadata?.agent.model.modelId;
  if (modelId === undefined || modelId.trim() === '')
    throw new CliUsageError('Provide --model; the session has no saved model.');
  const provider = command.provider ?? session.metadata?.provider ?? 'openai';
  if (!isModelProvider(provider))
    throw new CliUsageError(
      `Unknown provider "${provider}". Choose one of: ${MODEL_PROVIDERS.join(', ')}.`,
    );
  const writer = createMemoryWriter(
    command.workspace ?? session.metadata?.workspaceRoot ?? cwd,
    command.userMemoryDirectory ?? join(homedir(), '.agents', 'memory'),
    dependencies.tracer,
  );
  const result = await new SessionSummarizer(
    dependencies.createSampler(provider),
    writer,
    dependencies.tracer,
  ).summarize({
    session,
    modelId,
    scope: command.scope,
    ...(command.file === undefined ? {} : { file: command.file }),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
  });
  dependencies.writeOutput(
    result.outcome === 'recorded'
      ? `Recorded ${result.memory.scope} memory "${result.memory.title}" at ${result.memory.path}:${result.memory.startLine}-${result.memory.endLine}`
      : `Nothing durable to record from session ${session.id}.`,
  );
}

export async function runMemoryCommand(
  command: MemoryAddCommand,
  writer: MemoryWriter,
  writeOutput: (text: string) => void,
): Promise<void> {
  const recorded = await writer.record({
    scope: command.scope,
    title: command.title,
    body: command.body,
    ...(command.file === undefined ? {} : { file: command.file }),
    source: { kind: 'cli' },
  });
  writeOutput(
    `Recorded ${recorded.scope} memory "${recorded.title}" at ${recorded.path}:${recorded.startLine}-${recorded.endLine}`,
  );
}
