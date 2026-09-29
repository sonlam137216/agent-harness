import type { ModelCallId, SessionId, TurnId } from '../../../ids.js';
import type { TokenCounter } from '../../context-budget.js';

export interface CodeCandidate {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
  readonly score: number;
  /** Estimate of excerpt text only; Context counts the complete message. */
  readonly estimatedTokens: number;
}

export interface CodeRetrievalInput {
  readonly query: string;
  readonly counter: TokenCounter;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly modelCallId: ModelCallId;
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

/** Scan coverage gaps: some in-scope source or query terms were not examined. */
export type PartialReason =
  | 'entries'
  | 'files'
  | 'bytes'
  | 'file_size'
  | 'directory_size'
  | 'time'
  | 'nested_rules'
  | 'query';

/** Output shaping after a scan: every file was examined, but not every match was kept. */
export type SelectionLimit = 'candidates' | 'snippet';

export interface CodeRetrievalResult {
  readonly candidates: readonly CodeCandidate[];
  readonly partialReasons: readonly PartialReason[];
  readonly selectionLimits: readonly SelectionLimit[];
  readonly filesConsidered: number;
  readonly bytesRead: number;
}

/** Select information only. Implementations access source data through Workspace. */
export interface CodeRetriever {
  readonly retrieve: (input: CodeRetrievalInput) => Promise<CodeRetrievalResult>;
}

const excludedDirectories = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'coverage',
  'target',
  'sessions',
  'session-data',
  'secrets',
  'credentials',
]);
export const excludedDirectory = (name: string): boolean =>
  name.startsWith('.') || excludedDirectories.has(name);

export function normalizedDirectory(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith('/') ||
    /[\\:\x00-\x1f]/u.test(value) ||
    value.split('/').includes('..')
  )
    throw new RangeError('Retrieval directories must be workspace-relative without traversal.');
  return (
    value
      .split('/')
      .filter((part) => part !== '' && part !== '.')
      .join('/') || '.'
  );
}

export const within = (path: string, root: string): boolean =>
  root === '.' || path === root || path.startsWith(`${root}/`);

export function retrievalRoots(roots: readonly string[], rulesDirectory = '.'): readonly string[] {
  if (roots.length === 0 || roots.length > 8)
    throw new RangeError('Provide one to eight retrieval roots.');
  const scope = normalizedDirectory(rulesDirectory);
  const normalized = [...new Set(roots.map(normalizedDirectory))].sort();
  if (
    normalized.some(
      (root) => !within(root, scope) || (root !== '.' && root.split('/').some(excludedDirectory)),
    )
  )
    throw new RangeError(
      'Retrieval roots must be inside the rule scope and outside excluded directories.',
    );
  return normalized.filter(
    (root) => !normalized.some((other) => other !== root && within(root, other)),
  );
}
