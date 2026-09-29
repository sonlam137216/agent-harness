import { ContextError } from '../context/context-budget.js';
import { EventSubscriberError } from '../events/event-bus.js';
import { McpError } from '../mcp/config.js';
import { MemoryWriteError } from '../memory/memory-writer.js';
import { SessionSummaryError } from '../memory/session-summarizer.js';
import { SamplerConfigurationError } from '../model/create-sampler.js';
import { SamplingError } from '../model/sampling-types.js';
import { SessionFormatError } from '../session/session-codec.js';
import { SessionStateError } from '../session/session-history.js';
import { GitError } from '../workspace/git-worktree-capability.js';
import { RecordStorageError } from '../workspace/record-storage.js';
import { WorktreeError } from '../worktrees/worktree-manager.js';
import { CliRunError, CliUsageError } from './phase-one-cli.js';

/** Messages of known, sanitized error types; anything else gets a generic message. */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof EventSubscriberError) return safeErrorMessage(error.cause);
  if (
    error instanceof McpError ||
    error instanceof SessionFormatError ||
    error instanceof SessionStateError ||
    error instanceof RecordStorageError ||
    error instanceof MemoryWriteError ||
    error instanceof SessionSummaryError ||
    error instanceof WorktreeError ||
    error instanceof GitError ||
    error instanceof ContextError ||
    error instanceof CliUsageError ||
    error instanceof CliRunError ||
    error instanceof SamplerConfigurationError ||
    error instanceof SamplingError
  ) {
    return error.message;
  }
  return 'The CLI failed unexpectedly.';
}
