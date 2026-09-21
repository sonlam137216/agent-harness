import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { ApprovalHandler } from '../permissions/permission-engine.js';

export function createTerminalApproval(
  input: Readable & { readonly isTTY?: boolean },
  output: Writable & { readonly isTTY?: boolean },
  onInterrupt: () => void,
): ApprovalHandler {
  return async (request, signal) => {
    if (!input.isTTY || !output.isTTY || signal?.aborted) return false;
    const closed = new AbortController();
    const approvalSignal =
      signal === undefined ? closed.signal : AbortSignal.any([signal, closed.signal]);
    const prompt = createInterface({ input, output });
    const stop = (): void => closed.abort();
    // Readline emits SIGINT itself while the terminal is in raw mode.
    const interrupt = (): void => {
      stop();
      onInterrupt();
    };
    prompt.once('SIGINT', interrupt);
    prompt.once('close', stop);
    try {
      const answer = await prompt.question(
        `Allow ${JSON.stringify(request.call.name)} (${request.accessKind}) with ${JSON.stringify(request.call.arguments)}? [y/N] `,
        { signal: approvalSignal },
      );
      return answer.trim().toLowerCase() === 'y' && !approvalSignal.aborted;
    } catch {
      return false;
    } finally {
      prompt.close();
      prompt.removeListener('SIGINT', interrupt);
      prompt.removeListener('close', stop);
      input.pause();
    }
  };
}
