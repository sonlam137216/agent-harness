import { isAbsolute } from 'node:path';

import { CommandError } from '../command-capability.js';

/**
 * Backend-independent description of what a sandboxed command may do. Backends (Seatbelt
 * today; containers or remote runners later) must enforce every rule at the OS level.
 */
export interface SandboxPolicy {
  /** Absolute root: readable, writable, and the only allowed working-directory tree. */
  readonly root: string;
  /** Extra readable absolute paths, e.g. the toolchain or linked dependencies. */
  readonly readPaths: readonly string[];
  /** Absolute paths that must not be readable (default: the user's home directory). */
  readonly privatePaths: readonly string[];
  /** Absolute paths inside `root` that stay read-only, e.g. the worktree's `.git` link. */
  readonly protectedPaths: readonly string[];
  /** Only `deny` exists; network access is never granted. */
  readonly network: 'deny';
  /** Bare executable names that may be started directly. */
  readonly commands: readonly string[];
  readonly environment: {
    /** Variable names copied from the host environment. */
    readonly allow: readonly string[];
    /** Fixed values applied after copying; `HOME` and `TMPDIR` are set per command. */
    readonly set: Readonly<Record<string, string>>;
  };
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  /** Retained bytes per output stream (the tail is kept). */
  readonly maxOutputBytes: number;
}

export const DEFAULT_SANDBOX_COMMANDS = [
  'node',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'python3',
  'make',
] as const;

const COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;

export function isCommandName(value: string): boolean {
  return COMMAND.test(value);
}

/** Paths are embedded in backend profiles, so only plain absolute paths are accepted. */
function validPath(path: string): boolean {
  return isAbsolute(path) && !/["\\\n\r\0]/u.test(path) && !path.split('/').includes('..');
}

export function validateSandboxPolicy(policy: SandboxPolicy): SandboxPolicy {
  const paths = [
    policy.root,
    ...policy.readPaths,
    ...policy.privatePaths,
    ...policy.protectedPaths,
  ];
  if (!paths.every(validPath)) throw new TypeError('Sandbox paths must be plain absolute paths.');
  if (policy.root === '/') throw new TypeError('The sandbox root cannot be the filesystem root.');
  if (policy.network !== 'deny') throw new TypeError('Sandboxed network access is not supported.');
  if (policy.commands.length === 0 || !policy.commands.every(isCommandName))
    throw new TypeError('Sandbox commands must be bare executable names.');
  const names = [...policy.environment.allow, ...Object.keys(policy.environment.set)];
  if (!names.every((name) => ENVIRONMENT_NAME.test(name)))
    throw new TypeError('Invalid sandbox environment variable name.');
  for (const [name, value] of [
    ['defaultTimeoutMs', policy.defaultTimeoutMs],
    ['maxTimeoutMs', policy.maxTimeoutMs],
    ['maxOutputBytes', policy.maxOutputBytes],
  ] as const)
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new RangeError(`${name} must be a positive safe integer.`);
  if (policy.defaultTimeoutMs > policy.maxTimeoutMs)
    throw new RangeError('defaultTimeoutMs cannot exceed maxTimeoutMs.');
  return policy;
}

/** Command rule: a bare, allowlisted name. Paths and shell syntax never reach a backend. */
export function checkCommand(policy: SandboxPolicy, command: string): void {
  if (!isCommandName(command))
    throw new CommandError('command_not_allowed', 'Commands must be bare executable names.');
  if (!policy.commands.includes(command))
    throw new CommandError(
      'command_not_allowed',
      `"${command}" is not an allowed command. Allowed: ${policy.commands.join(', ')}.`,
    );
}

/** Environment rule: only allowlisted host variables plus fixed values reach the process. */
export function sandboxEnvironment(
  policy: SandboxPolicy,
  host: Readonly<Record<string, string | undefined>>,
  temporaryDirectory: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of policy.environment.allow) {
    const value = host[name];
    if (value !== undefined) environment[name] = value;
  }
  return {
    ...environment,
    ...policy.environment.set,
    HOME: temporaryDirectory,
    TMPDIR: `${temporaryDirectory}/`,
  };
}
