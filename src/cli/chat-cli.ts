import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import type { SessionId } from '../ids.js';
import { safeErrorMessage } from './errors.js';
import { CliRunError, CliUsageError } from './phase-one-cli.js';

const EXIT_COMMANDS = new Set(['/exit', '/quit']);

export interface ChatOptions {
  /** Resolves the next prompt, or null when the user leaves (EOF, Ctrl+C at the prompt). */
  readonly readPrompt: () => Promise<string | null>;
  /** Runs one turn; reports the session as soon as it exists, even if the turn fails. */
  readonly runTurn: (input: {
    readonly prompt: string;
    readonly sessionId: SessionId | undefined;
    readonly onSessionId: (id: SessionId) => void;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  /** Receives the canceller of the running turn, and undefined when it ends. */
  readonly setInterrupt: (cancel: (() => void) | undefined) => void;
  readonly writeError: (text: string) => void;
  readonly sessionId?: SessionId;
}

/**
 * Runs each prompt as a new turn of one session. A failed or cancelled turn is reported
 * and the chat continues; configuration errors end it because every turn would repeat them.
 */
export async function runChat(options: ChatOptions): Promise<SessionId | undefined> {
  let sessionId = options.sessionId;
  for (;;) {
    const line = await options.readPrompt();
    if (line === null) return sessionId;
    const prompt = line.trim();
    if (prompt === '') continue;
    if (EXIT_COMMANDS.has(prompt)) return sessionId;

    const turn = new AbortController();
    options.setInterrupt(() => turn.abort());
    try {
      await options.runTurn({
        prompt,
        sessionId,
        onSessionId: (id) => {
          sessionId = id;
        },
        signal: turn.signal,
      });
    } catch (error) {
      if (error instanceof CliUsageError) throw error;
      options.writeError(
        error instanceof CliRunError
          ? `Turn ended without an answer (${error.outcome}).`
          : `Error: ${safeErrorMessage(error)}`,
      );
    } finally {
      options.setInterrupt(undefined);
    }
  }
}

/**
 * Terminal input: a fresh readline per prompt, so approval prompts can own the terminal
 * while a turn runs. Piped input uses one reader for the whole chat so buffered lines
 * are not lost; approvals are unavailable there anyway.
 */
export function createPromptReader(
  input: Readable & { readonly isTTY?: boolean },
  output: Writable,
): () => Promise<string | null> {
  if (input.isTTY !== true) {
    const lines = createInterface({ input, terminal: false })[Symbol.asyncIterator]();
    return async () => {
      const next = await lines.next();
      return next.done === true ? null : next.value;
    };
  }
  return () =>
    new Promise((resolve) => {
      const reader = createInterface({ input, output, terminal: true });
      let settled = false;
      const finish = (value: string | null): void => {
        if (settled) return;
        settled = true;
        reader.close();
        input.pause();
        resolve(value);
      };
      reader.once('SIGINT', () => finish(null));
      reader.once('close', () => finish(null));
      reader.question('\n› ', (answer) => finish(answer));
    });
}
