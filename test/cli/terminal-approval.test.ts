import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createTerminalApproval,
  describeApprovalRequest,
} from '../../src/cli/terminal-approval.js';
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

  describe('previews', () => {
    const call = (name: string, arguments_: PermissionRequest['call']['arguments']) => ({
      ...request,
      accessKind: name === 'run_command' ? ('execute' as const) : ('write' as const),
      call: { id: createToolCallId(), name, arguments: arguments_ },
    });

    it('shows edit_file as a diff', () => {
      expect(
        describeApprovalRequest(
          call('edit_file', { path: 'src/a.ts', oldText: 'a = 1;\nb;', newText: 'a = 2;' }),
        ),
      ).toBe('edit_file (write) src/a.ts\n- a = 1;\n- b;\n+ a = 2;');
    });

    it('shows write_file with a bounded content preview', () => {
      const content = Array.from({ length: 45 }, (_, index) => `line ${index}`).join('\n');
      const preview = describeApprovalRequest(call('write_file', { path: 'new.txt', content }));
      expect(preview.split('\n')[0]).toBe(
        'write_file (write) new.txt (45 lines, replaces the whole file)',
      );
      expect(preview).toContain('+ line 39');
      expect(preview).not.toContain('+ line 40');
      expect(preview).toContain('+ … 5 more lines');
    });

    it('shows run_command as a quoted argv', () => {
      expect(
        describeApprovalRequest(
          call('run_command', { command: 'pnpm', args: ['test', '--filter', 'a b'], cwd: 'pkg' }),
        ),
      ).toBe(
        [
          'run_command (execute) in pkg: pnpm test --filter "a b"',
          '  ! may create or change any workspace file except .git, without per-file approval;',
          '    review the changes before running project scripts outside the sandbox',
        ].join('\n'),
      );
      expect(
        describeApprovalRequest(call('run_command', { command: 'node', args: ['-e', 'x()'] })),
      ).toContain('! runs inline code chosen by the model');
    });

    it('escapes terminal control sequences from model output', () => {
      const preview = describeApprovalRequest(
        call('edit_file', { path: 'x\u001b[2J', oldText: 'a', newText: '\u001b]0;pwned\u0007' }),
      );
      expect(preview).not.toContain('\u001b');
      expect(preview).toContain('\\u001b[2J');
    });
  });
});
