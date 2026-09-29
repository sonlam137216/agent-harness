import type { ModelMessage } from '../../model/sampling-types.js';
import {
  checkContextCancellation,
  contributionTokens,
  type TokenCounter,
} from '../context-budget.js';

export interface PackResult<T> {
  readonly selected: readonly T[];
  readonly messages: readonly ModelMessage[];
  readonly tokens: number;
}

/**
 * Greedily keeps ranked items whose complete rendered message still fits the
 * allowance; a large item may be skipped so a smaller lower-ranked one fits.
 * Renders even with no items when `renderEmpty` is set (e.g. a coverage notice),
 * and returns nothing if that notice itself does not fit.
 */
export function packRanked<T>(
  items: readonly T[],
  render: (selected: readonly T[]) => readonly ModelMessage[],
  allowance: number,
  counter: TokenCounter,
  input: { readonly signal?: AbortSignal; readonly deadlineMs?: number },
  renderEmpty = false,
): PackResult<T> {
  const selected: T[] = [];
  for (const item of items) {
    checkContextCancellation(input);
    if (contributionTokens(counter, render([...selected, item]), []) <= allowance)
      selected.push(item);
  }
  const messages = selected.length > 0 || renderEmpty ? render(selected) : [];
  const tokens = contributionTokens(counter, messages, []);
  return tokens <= allowance
    ? { selected, messages, tokens }
    : { selected: [], messages: [], tokens: 0 };
}
