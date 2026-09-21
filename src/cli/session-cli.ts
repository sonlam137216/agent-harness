import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';
import type { SessionId } from '../ids.js';
import type { TracingHandle } from '../observability/tracing.js';
import { rewindSession, SessionStateError } from '../session/session-history.js';
import type { SessionStore } from '../session/session-store.js';
import { validRecordKey } from '../workspace/record-storage.js';
import { CliUsageError, parsePhaseOneCliArguments } from './phase-one-cli.js';

interface StorageOptions {
  readonly directory: string;
}
export type SessionCliCommand = StorageOptions &
  (
    | { readonly kind: 'run'; readonly arguments: readonly string[]; readonly resumeId?: SessionId }
    | { readonly kind: 'list' }
    | { readonly kind: 'show'; readonly sessionId: SessionId }
    | { readonly kind: 'rewind'; readonly sessionId: SessionId; readonly keepTurns: number }
  );
function sessionId(value: string | undefined): SessionId {
  if (value === undefined || !validRecordKey(value))
    throw new CliUsageError('Provide a UUID session ID.');
  return value as SessionId;
}

export function parseSessionCommand(arguments_: readonly string[], cwd: string): SessionCliCommand {
  let directory = join(homedir(), '.agent-harness', 'sessions');
  let directoryProvided = false;
  let resumeId: SessionId | undefined;
  const remaining: string[] = [];
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === '--session-dir' || argument === '--resume') {
      const value = arguments_[++index];
      if (!value || value.startsWith('--'))
        throw new CliUsageError(`${argument} requires a value.`);
      if (argument === '--resume') {
        if (resumeId !== undefined) throw new CliUsageError('Provide --resume only once.');
        resumeId = sessionId(value);
      } else {
        if (directoryProvided) throw new CliUsageError('Provide --session-dir only once.');
        directoryProvided = true;
        directory = resolve(cwd, value);
      }
    } else if (argument !== '--') remaining.push(argument);
  }
  if (remaining[0] !== 'sessions')
    return {
      kind: 'run',
      directory,
      arguments: remaining,
      ...(resumeId === undefined ? {} : { resumeId }),
    };
  if (resumeId !== undefined)
    throw new CliUsageError('--resume cannot be combined with a session command.');
  if (remaining[1] === 'list' && remaining.length === 2) return { kind: 'list', directory };
  if (remaining[1] === 'show' && remaining.length === 3)
    return { kind: 'show', directory, sessionId: sessionId(remaining[2]) };
  if (remaining[1] === 'rewind' && remaining.length === 5 && remaining[3] === '--keep-turns') {
    const count = remaining[4]!;
    if (!/^(0|[1-9][0-9]*)$/u.test(count) || !Number.isSafeInteger(Number(count)))
      throw new CliUsageError('--keep-turns requires a non-negative integer.');
    return {
      kind: 'rewind',
      directory,
      sessionId: sessionId(remaining[2]),
      keepTurns: Number(count),
    };
  }
  throw new CliUsageError(
    'Use sessions list, sessions show <id>, or sessions rewind <id> --keep-turns <n>.',
  );
}

export async function prepareSessionRun(
  command: Extract<SessionCliCommand, { kind: 'run' }>,
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string,
  store: SessionStore,
) {
  const saved = command.resumeId === undefined ? undefined : await store.get(command.resumeId);
  if (command.resumeId !== undefined && saved === undefined)
    throw new SessionStateError('The requested session does not exist.');
  const defaults: string[] = [];
  const metadata = saved?.metadata;
  if (metadata !== undefined) {
    defaults.push('--model', metadata.agent.model.modelId);
    if (metadata.provider !== undefined) defaults.push('--provider', metadata.provider);
    if (metadata.workspaceRoot !== undefined) defaults.push('--workspace', metadata.workspaceRoot);
    if (metadata.rulesDirectory !== undefined)
      defaults.push('--rules-directory', metadata.rulesDirectory);
    if (metadata.contextBudget !== undefined)
      defaults.push(
        '--context-window',
        String(metadata.contextBudget.windowTokens),
        '--output-reserve',
        String(metadata.contextBudget.outputReserveTokens),
      );
  }
  return {
    parsed: parsePhaseOneCliArguments([...defaults, ...command.arguments], environment, cwd),
    ...(metadata === undefined ? {} : { savedAgent: metadata.agent }),
  };
}

export async function runSessionCommand(
  command: Exclude<SessionCliCommand, { kind: 'run' }>,
  store: SessionStore,
  tracer: TracingHandle['tracer'],
  writeOutput: (text: string) => void,
): Promise<void> {
  if (command.kind === 'list') {
    const summaries = (await store.list()).map(({ id, metadata, turnCount, status, usage }) => ({
      id,
      createdAt: metadata?.createdAt,
      updatedAt: metadata?.updatedAt,
      modelId: metadata?.agent.model.modelId,
      workspaceRoot: metadata?.workspaceRoot,
      turnCount,
      status,
      usage,
    }));
    writeOutput(JSON.stringify(summaries, null, 2));
    return;
  }
  if (command.kind === 'show') {
    const session = await store.get(command.sessionId);
    if (session === undefined) throw new SessionStateError('The requested session does not exist.');
    writeOutput(JSON.stringify(session, null, 2));
    return;
  }
  await store.withSessionLock(command.sessionId, () =>
    tracer.startActiveSpan('session.rewind', async (span) => {
      span.setAttributes({
        'session.id': command.sessionId,
        'session.retained_turns': command.keepTurns,
      });
      try {
        const session = await store.get(command.sessionId);
        if (session === undefined)
          throw new SessionStateError('The requested session does not exist.');
        const rewound = rewindSession(session, command.keepTurns);
        await store.save(rewound);
        span.setAttribute('success', true);
        writeOutput(JSON.stringify({ sessionId: rewound.id, retainedTurns: rewound.turns.length }));
      } catch (error) {
        span.setAttribute('success', false);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}
