export interface CommandRequest {
  /** Bare executable name resolved on the policy's PATH; never a path or shell text. */
  readonly command: string;
  readonly args: readonly string[];
  /** Directory relative to the capability root; `.` addresses the root. */
  readonly cwd: string;
  readonly timeoutMs?: number;
}

/** A type alias (not an interface) so results stay assignable to JSON values. */
export type CommandResult = {
  /** Null when the process was killed by a signal. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** The last bytes of each stream when it exceeds the output limit. */
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
};

/**
 * Runs one program without a shell. Every implementation must enforce its policy below
 * the permission layer (paths, network, environment, time and output limits); a
 * non-zero exit is a result, not an error. Failures to start are `CommandError`s.
 */
export interface CommandCapability {
  run(request: CommandRequest, options?: { readonly signal?: AbortSignal }): Promise<CommandResult>;
}

export type CommandErrorCode =
  | 'command_not_allowed'
  | 'invalid_arguments'
  | 'invalid_cwd'
  | 'sandbox_unavailable'
  | 'cancelled'
  | 'spawn_failed';

export class CommandError extends Error {
  public override readonly name = 'CommandError';
  public readonly retryable = false;
  public constructor(
    public readonly code: CommandErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}
