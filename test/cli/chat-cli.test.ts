import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { createPromptReader, runChat, type ChatOptions } from '../../src/cli/chat-cli.js';
import { CliRunError, CliUsageError } from '../../src/cli/phase-one-cli.js';
import { createSessionId, type SessionId } from '../../src/ids.js';

function prompts(...lines: (string | null)[]): ChatOptions['readPrompt'] {
  return () => Promise.resolve(lines.length === 0 ? null : lines.shift()!);
}

describe('chat', () => {
  it('runs each prompt as a turn of one session and stops on /exit', async () => {
    const created = createSessionId();
    const seen: { prompt: string; sessionId: SessionId | undefined }[] = [];
    const errors: string[] = [];

    const sessionId = await runChat({
      readPrompt: prompts('first', '   ', 'second', '/exit', 'never'),
      runTurn: ({ prompt, sessionId: current, onSessionId }) => {
        seen.push({ prompt, sessionId: current });
        onSessionId(created);
        return Promise.resolve();
      },
      setInterrupt: () => undefined,
      writeError: (text) => errors.push(text),
    });

    expect(seen).toEqual([
      { prompt: 'first', sessionId: undefined },
      { prompt: 'second', sessionId: created },
    ]);
    expect(sessionId).toBe(created);
    expect(errors).toEqual([]);
  });

  it('continues a resumed session and ends at end of input', async () => {
    const resumed = createSessionId();
    const runTurn = vi.fn<ChatOptions['runTurn']>(() => Promise.resolve());

    await expect(
      runChat({
        sessionId: resumed,
        readPrompt: prompts('hello'),
        runTurn,
        setInterrupt: () => undefined,
        writeError: () => undefined,
      }),
    ).resolves.toBe(resumed);
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: resumed }));
  });

  it('cancels only the running turn on interrupt and keeps chatting', async () => {
    let interrupt: (() => void) | undefined;
    const errors: string[] = [];
    const outcomes: boolean[] = [];

    await runChat({
      readPrompt: prompts('long task', 'next'),
      setInterrupt: (cancel) => {
        interrupt = cancel;
      },
      runTurn: ({ prompt, signal }) => {
        if (prompt === 'long task') {
          interrupt?.();
          outcomes.push(signal.aborted);
          return Promise.reject(new CliRunError('cancelled'));
        }
        outcomes.push(signal.aborted);
        return Promise.resolve();
      },
      writeError: (text) => errors.push(text),
    });

    expect(outcomes).toEqual([true, false]);
    expect(errors).toEqual(['Turn ended without an answer (cancelled).']);
    expect(interrupt).toBeUndefined();
  });

  it('keeps the session of a failed turn, reports it, but stops on configuration errors', async () => {
    const errors: string[] = [];
    const created = createSessionId();
    const sessions: (SessionId | undefined)[] = [];
    let turns = 0;

    await expect(
      runChat({
        readPrompt: prompts('a', 'b', 'c'),
        runTurn: ({ sessionId, onSessionId }) => {
          turns += 1;
          sessions.push(sessionId);
          if (turns === 1) {
            onSessionId(created);
            return Promise.reject(new Error('provider down'));
          }
          return Promise.reject(new CliUsageError('sandbox unavailable'));
        },
        setInterrupt: () => undefined,
        writeError: (text) => errors.push(text),
      }),
    ).rejects.toThrow('sandbox unavailable');
    expect(turns).toBe(2);
    expect(sessions).toEqual([undefined, created]);
    expect(errors).toEqual(['Error: The CLI failed unexpectedly.']);
  });

  it('reads every piped line without losing buffered input', async () => {
    const input = new PassThrough();
    const read = createPromptReader(input, new PassThrough());
    input.end('one\ntwo\n');

    expect(await read()).toBe('one');
    expect(await read()).toBe('two');
    expect(await read()).toBeNull();
  });
});
