import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { TracingHandle } from '../observability/tracing.js';

export interface ProcessSpecification {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}
export interface LineProcess {
  send(line: string): Promise<void>;
  close(): Promise<void>;
}
export interface ProcessObserver {
  line(line: string): void;
  error(error: Error): void;
  closed(): void;
}
export interface DuplexProcessCapability {
  open(spec: ProcessSpecification, observer: ProcessObserver): Promise<LineProcess>;
}

/** Process access is application-owned, not a model-facing command executor. */
export class LocalDuplexProcess implements DuplexProcessCapability {
  constructor(
    private readonly root: string,
    private readonly tracer: TracingHandle['tracer'],
    private readonly maxLineBytes = 1_048_576,
  ) {}
  async open(spec: ProcessSpecification, observer: ProcessObserver): Promise<LineProcess> {
    return this.tracer.startActiveSpan('workspace.operation', async (span) => {
      span.setAttributes({ operation: 'process.open', 'workspace.type': 'local' });
      try {
        const root = await realpath(this.root);
        if (isAbsolute(spec.cwd) || spec.cwd.split(/[\\/]/u).includes('..'))
          throw new Error('Invalid process cwd.');
        const cwd = await realpath(resolve(root, spec.cwd));
        const rel = relative(root, cwd);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
          throw new Error('Invalid process cwd.');
        const child = spawn(spec.command, [...spec.args], {
          cwd,
          env: { ...spec.environment },
          shell: false,
          stdio: 'pipe',
        });
        let buffer = Buffer.alloc(0);
        let closed = false;
        let closing: Promise<void> | undefined;
        let resolveExit: () => void = () => undefined;
        const exited = new Promise<void>((resolve) => {
          resolveExit = resolve;
        });
        const finish = () => {
          if (closed) return;
          closed = true;
          resolveExit();
          observer.closed();
        };
        child.once('close', finish);
        const close = (): Promise<void> => {
          closing ??= (async () => {
            if (closed) return;
            child.stdin.destroy();
            child.kill('SIGTERM');
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              child.stdout.destroy();
              child.stderr.destroy();
              finish();
            }, 500);
            try {
              await exited;
            } finally {
              clearTimeout(timer);
            }
          })();
          return closing;
        };
        const fail = () => {
          observer.error(new Error('Workspace process failed.'));
          void close();
        };
        child.on('error', fail);
        child.stdin.on('error', fail);
        child.stdout.on('error', fail);
        child.stderr.on('error', fail);
        // Drain and discard diagnostics: never retain or trace arbitrary server stderr.
        child.stderr.resume();
        child.stdout.on('data', (chunk: Buffer) => {
          buffer = Buffer.concat([buffer, chunk]);
          let newline: number;
          while ((newline = buffer.indexOf(10)) >= 0) {
            if (newline > this.maxLineBytes) {
              fail();
              return;
            }
            const line = buffer.subarray(0, newline).toString('utf8');
            buffer = buffer.subarray(newline + 1);
            try {
              observer.line(line);
            } catch {
              fail();
              return;
            }
          }
          if (buffer.length > this.maxLineBytes) fail();
        });
        await new Promise<void>((resolve, reject) => {
          child.once('spawn', resolve);
          child.once('error', () => reject(new Error('Workspace process could not start.')));
        });
        span.setAttribute('success', true);
        return {
          send: async (line: string) => {
            if (closed || Buffer.byteLength(line) > this.maxLineBytes || line.includes('\n'))
              throw new Error('Invalid process message.');
            await new Promise<void>((resolve, reject) =>
              child.stdin.write(`${line}\n`, (error) =>
                error ? reject(new Error('Workspace process write failed.')) : resolve(),
              ),
            );
          },
          close,
        };
      } catch {
        span.setAttributes({ success: false, 'error.type': 'process_error' });
        throw new Error('Workspace process could not start.');
      } finally {
        span.end();
      }
    });
  }
}
