import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SpanStatusCode } from '@opentelemetry/api';

import type { TracingHandle } from '../../observability/tracing.js';
import {
  CommandError,
  type CommandCapability,
  type CommandRequest,
  type CommandResult,
} from '../command-capability.js';
import {
  checkCommand,
  sandboxEnvironment,
  validateSandboxPolicy,
  type SandboxPolicy,
} from './sandbox-policy.js';
import { seatbeltProfile } from './seatbelt-profile.js';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_CHARACTERS = 4_096;

export interface SeatbeltCommandRunnerOptions {
  readonly policy: SandboxPolicy;
  readonly tracer: TracingHandle['tracer'];
  /** Host environment the allowlist copies from; defaults to `process.env`. */
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function isInside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

/** Keeps only the last `limit` bytes of a stream. */
class TailBuffer {
  #buffer = Buffer.alloc(0);
  public truncated = false;
  public constructor(private readonly limit: number) {}
  public push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > this.limit) {
      this.#buffer = this.#buffer.subarray(this.#buffer.length - this.limit);
      this.truncated = true;
    }
  }
  public text(): string {
    return this.#buffer.toString('utf8');
  }
}

/** True when `sandbox-exec` exists and accepts a profile on this host. */
export async function seatbeltAvailable(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await access(SANDBOX_EXEC, constants.X_OK);
  } catch {
    return false;
  }
  return new Promise((resolvePromise) => {
    const child = spawn(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '--', '/usr/bin/true'], {
      stdio: 'ignore',
    });
    child.on('error', () => resolvePromise(false));
    child.on('close', (code) => resolvePromise(code === 0));
  });
}

/**
 * Directories a toolchain needs to be readable: every absolute PATH entry, plus the install
 * prefix of each allowed command's real executable (e.g. `…/node-versions/v22/installation`),
 * which may live inside an otherwise private home directory.
 */
export async function detectToolchainPaths(
  commands: readonly string[],
  path: string | undefined,
): Promise<readonly string[]> {
  const entries = (path ?? '').split(delimiter).filter((entry) => isAbsolute(entry));
  const found = new Set<string>();
  for (const entry of entries) {
    found.add(entry);
    found.add(await canonical(entry));
  }
  for (const command of commands) {
    for (const entry of entries) {
      const candidate = join(entry, command);
      try {
        await access(candidate, constants.X_OK);
      } catch {
        continue;
      }
      const executable = await canonical(candidate);
      const directory = dirname(executable);
      found.add(directory.endsWith(`${sep}bin`) ? dirname(directory) : directory);
      break;
    }
  }
  return [...found].filter((entry) => entry !== '/' && !/["\\\n\r\0]/u.test(entry)).sort();
}

/**
 * macOS Seatbelt backend. Each command gets a fresh private temporary directory (also its
 * HOME), runs as its own process group without a shell, and is killed as a group on
 * timeout or cancellation. The OS enforces the policy for every descendant process.
 */
export class SeatbeltCommandRunner implements CommandCapability {
  readonly #policy: SandboxPolicy;
  readonly #tracer: TracingHandle['tracer'];
  readonly #environment: Readonly<Record<string, string | undefined>>;
  #canonicalPolicy: Promise<SandboxPolicy> | undefined;

  public constructor(options: SeatbeltCommandRunnerOptions) {
    this.#policy = validateSandboxPolicy(options.policy);
    this.#tracer = options.tracer;
    this.#environment = options.environment ?? process.env;
  }

  public run(
    request: CommandRequest,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CommandResult> {
    return this.#tracer.startActiveSpan('workspace.operation', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({
        'workspace.type': 'local',
        operation: 'sandbox.command',
        'sandbox.backend': 'seatbelt',
      });
      let temporary: string | undefined;
      try {
        checkCommand(this.#policy, request.command);
        span.setAttribute('command.name', request.command);
        if (
          request.args.length > MAX_ARGUMENTS ||
          request.args.some((arg) => arg.length > MAX_ARGUMENT_CHARACTERS || arg.includes('\0'))
        )
          throw new CommandError('invalid_arguments', 'Too many or invalid command arguments.');
        const timeoutMs = request.timeoutMs ?? this.#policy.defaultTimeoutMs;
        if (
          !Number.isSafeInteger(timeoutMs) ||
          timeoutMs <= 0 ||
          timeoutMs > this.#policy.maxTimeoutMs
        )
          throw new CommandError(
            'invalid_arguments',
            `The timeout must be between 1 and ${this.#policy.maxTimeoutMs} ms.`,
          );
        if (options.signal?.aborted === true)
          throw new CommandError('cancelled', 'The command was cancelled before it started.');

        const policy = await this.#resolvePolicy();
        const cwd = await this.#resolveCwd(policy.root, request.cwd);
        temporary = await realpath(await mkdtemp(join(tmpdir(), 'agent-harness-sandbox-')));
        const result = await this.#spawn(
          request,
          cwd,
          seatbeltProfile(policy, temporary),
          sandboxEnvironment(policy, this.#environment, temporary),
          timeoutMs,
          options.signal,
        );
        span.setAttributes({
          success: true,
          'command.exit_code': result.exitCode ?? -1,
          'command.timed_out': result.timedOut,
          'command.stdout_truncated': result.stdoutTruncated,
          'command.stderr_truncated': result.stderrTruncated,
        });
        return result;
      } catch (error) {
        const normalized =
          error instanceof CommandError
            ? error
            : new CommandError(
                'spawn_failed',
                'The sandboxed command could not be started.',
                error,
              );
        span.setAttributes({ success: false, 'error.type': normalized.code });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw normalized;
      } finally {
        if (temporary !== undefined)
          await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        span.setAttribute('duration_ms', performance.now() - startedAt);
        span.end();
      }
    });
  }

  /** Seatbelt matches canonical paths (e.g. /private/var), so resolve symlinks once. */
  #resolvePolicy(): Promise<SandboxPolicy> {
    this.#canonicalPolicy ??= (async () => {
      const all = async (paths: readonly string[]) => [
        ...new Set([...paths, ...(await Promise.all(paths.map(canonical)))]),
      ];
      return validateSandboxPolicy({
        ...this.#policy,
        root: await canonical(this.#policy.root),
        readPaths: await all(this.#policy.readPaths),
        privatePaths: await all(this.#policy.privatePaths),
        protectedPaths: await all(this.#policy.protectedPaths),
      });
    })();
    return this.#canonicalPolicy;
  }

  async #resolveCwd(root: string, requested: string): Promise<string> {
    const invalid = new CommandError(
      'invalid_cwd',
      'cwd must be a directory inside the workspace.',
    );
    if (isAbsolute(requested) || requested.split('/').includes('..')) throw invalid;
    let cwd: string;
    try {
      cwd = await realpath(resolve(root, requested));
    } catch {
      throw invalid;
    }
    if (!isInside(root, cwd)) throw invalid;
    return cwd;
  }

  #spawn(
    request: CommandRequest,
    cwd: string,
    profile: string,
    environment: Record<string, string>,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<CommandResult> {
    return new Promise((resolvePromise, reject) => {
      const startedAt = performance.now();
      const child = spawn(SANDBOX_EXEC, ['-p', profile, '--', request.command, ...request.args], {
        cwd,
        env: environment,
        shell: false,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = new TailBuffer(this.#policy.maxOutputBytes);
      const stderr = new TailBuffer(this.#policy.maxOutputBytes);
      let timedOut = false;
      let cancelled = false;
      let startFailure: Error | undefined;
      const killGroup = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group already exited.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutMs);
      const abort = (): void => {
        cancelled = true;
        killGroup();
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', (error) => {
        startFailure = error;
      });
      child.on('close', (exitCode, exitSignal) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        // Background descendants never outlive the command.
        killGroup();
        if (startFailure !== undefined)
          return reject(
            new CommandError(
              'sandbox_unavailable',
              'sandbox-exec could not be started.',
              startFailure,
            ),
          );
        if (cancelled) return reject(new CommandError('cancelled', 'The command was cancelled.'));
        resolvePromise({
          exitCode,
          signal: exitSignal,
          timedOut,
          durationMs: Math.round(performance.now() - startedAt),
          stdout: stdout.text(),
          stderr: stderr.text(),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        });
      });
    });
  }
}
