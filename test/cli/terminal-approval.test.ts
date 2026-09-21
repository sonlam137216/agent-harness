import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalApproval } from '../../src/cli/terminal-approval.js';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import type { PermissionRequest } from '../../src/permissions/permission-engine.js';

const request: PermissionRequest = {
  sessionId: createSessionId(),
  turnId: createTurnId(),
  modelCallId: createModelCallId(),
  call: { id: createToolCallId(), name: 'read_file', arguments: { path: 'fixture.txt' } },
  accessKind: 'read',
};

function terminal() {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  const onInterrupt = vi.fn();
  return {
    input,
    output,
    onInterrupt,
    approve: createTerminalApproval(input, output, onInterrupt),
  };
}

describe('terminal approval', () => {
  it.each([
    ['y\n', true],
    ['\n', false],
    ['yes\n', false],
  ])('handles answer %j', async (answer, expected) => {
    const f = terminal();
    const pending = f.approve(request);
    f.input.write(answer);
    expect(await pending).toBe(expected);
    f.input.destroy();
    f.output.destroy();
  });
  it('denies EOF without leaving the question pending', async () => {
    const f = terminal();
    const pending = f.approve(request);
    f.input.end();
    expect(await pending).toBe(false);
    f.output.destroy();
  });
  it('cancels the owning turn on readline Ctrl-C', async () => {
    const f = terminal();
    const pending = f.approve(request);
    f.input.write('\u0003');
    expect(await pending).toBe(false);
    expect(f.onInterrupt).toHaveBeenCalledTimes(1);
    f.input.destroy();
    f.output.destroy();
  });
  it('denies parent cancellation and headless input', async () => {
    const f = terminal();
    const controller = new AbortController();
    const pending = f.approve(request, controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    f.input.isTTY = false;
    expect(await f.approve(request)).toBe(false);
    f.input.destroy();
    f.output.destroy();
  });
});
