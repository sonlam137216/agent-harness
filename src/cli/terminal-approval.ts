import { createInterface } from 'node:readline/promises';
import type { Readable, Writable } from 'node:stream';
import type { ApprovalHandler, PermissionRequest } from '../permissions/permission-engine.js';

const MAX_PREVIEW_LINES = 40;
/** Interpreter flags that execute an argument as a program. */
const INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

/** Model-controlled text must not drive the terminal: escape control characters. */
export function visible(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, (character) =>
    JSON.stringify(character).slice(1, -1),
  );
}

function prefixed(text: string, prefix: string): string[] {
  const lines = text.split('\n');
  const shown = lines.slice(0, MAX_PREVIEW_LINES).map((line) => `${prefix}${visible(line)}`);
  if (lines.length > MAX_PREVIEW_LINES)
    shown.push(`${prefix}… ${lines.length - MAX_PREVIEW_LINES} more lines`);
  return shown;
}

function shellWord(word: string): string {
  return /^[\w./=:@%+,-]+$/u.test(word) ? word : JSON.stringify(word);
}

/** A readable, bounded preview of what approving the request will do. */
export function describeApprovalRequest(request: PermissionRequest): string {
  const { name, arguments: input } = request.call;
  const header = `${visible(name)} (${request.accessKind})`;
  if (
    name === 'edit_file' &&
    typeof input.path === 'string' &&
    typeof input.oldText === 'string' &&
    typeof input.newText === 'string'
  )
    return [
      `${header} ${visible(input.path)}`,
      ...prefixed(input.oldText, '- '),
      ...prefixed(input.newText, '+ '),
    ].join('\n');
  if (name === 'write_file' && typeof input.path === 'string' && typeof input.content === 'string')
    return [
      `${header} ${visible(input.path)} (${input.content.split('\n').length} lines, replaces the whole file)`,
      ...prefixed(input.content, '+ '),
    ].join('\n');
  if (name === 'run_command' && typeof input.command === 'string') {
    const args = Array.isArray(input.args)
      ? input.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    const cwd = typeof input.cwd === 'string' ? input.cwd : '.';
    return [
      `${header} in ${visible(cwd)}: ${visible([input.command, ...args].map(shellWord).join(' '))}`,
      ...(args.some((arg) => INLINE_CODE_FLAGS.has(arg))
        ? ['  ! runs inline code chosen by the model']
        : []),
      '  ! may create or change any workspace file except .git, without per-file approval;',
      '    review the changes before running project scripts outside the sandbox',
    ].join('\n');
  }
  return `${header} with ${visible(JSON.stringify(input))}`;
}

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
      const answer = await prompt.question(`\n${describeApprovalRequest(request)}\nAllow? [y/N] `, {
        signal: approvalSignal,
      });
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
