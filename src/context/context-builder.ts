import { SpanStatusCode } from '@opentelemetry/api';

import type { ModelCallId } from '../ids.js';
import type { Sampler } from '../model/sampler.interface.js';
import { SamplingError, type ModelMessage, type ModelRequest } from '../model/sampling-types.js';
import type { TracingHandle } from '../observability/tracing.js';
import type { Session } from '../session/session.js';
import { compactTurns } from './compaction.js';
import {
  checkContextCancellation,
  ContextError,
  contributionTokens,
  DEFAULT_CONTEXT_BUDGET,
  positiveInteger,
  REQUEST_FRAMING_TOKENS,
  utf8TokenEstimate,
  validateBudget,
  type ContextBudget,
  type TokenCounter,
} from './context-budget.js';
import {
  checkpointMessages,
  checkpointOffset,
  ConversationSource,
  pruneTurnMessages,
  SystemInstructionsSource,
  ToolDefinitionsSource,
  toModelMessage,
  type ContextContribution,
  type ContextSource,
  type ContextSourceInput,
} from './context-source.js';

export interface ContextBuildInput extends ContextSourceInput {
  readonly modelCallId: ModelCallId;
}

export interface ContextBuilderOptions {
  readonly budget?: ContextBudget;
  readonly tokenCounter?: TokenCounter;
  readonly additionalSources?: readonly ContextSource[];
  /** Enables model-assisted compaction. Without a sampler, irreducible overflow is an error. */
  readonly sampler?: Sampler;
  readonly toolResultMaxChars?: number;
  readonly summaryMaxTokens?: number;
  readonly keepRecentTurns?: number;
}

export interface ContextAccounting {
  readonly counter: string;
  readonly estimated: true;
  readonly inputLimit: number;
  readonly baselineTokens: number;
  readonly totalTokens: number;
  readonly framingTokens: number;
  readonly sources: Readonly<Record<string, number>>;
  readonly prunedResults: number;
  readonly compactedTurns: number;
}

export interface ContextBuildResult {
  readonly request: ModelRequest;
  readonly session: Session;
  readonly accounting: ContextAccounting;
}

export class ContextBuilder {
  readonly #budget: ContextBudget;
  readonly #counter: TokenCounter;
  readonly #sources: readonly ContextSource[];
  readonly #sampler: Sampler | undefined;
  readonly #toolResultMaxChars: number;
  readonly #summaryMaxTokens: number;
  readonly #keepRecentTurns: number;
  readonly #conversation = new ConversationSource();

  public constructor(
    private readonly tracer: TracingHandle['tracer'],
    options: ContextBuilderOptions = {},
  ) {
    this.#budget = { ...(options.budget ?? DEFAULT_CONTEXT_BUDGET) };
    validateBudget(this.#budget);
    this.#counter = options.tokenCounter ?? utf8TokenEstimate;
    this.#sources = [
      new SystemInstructionsSource(),
      ...(options.additionalSources ?? []),
      new ToolDefinitionsSource(),
    ];
    const names = new Set(['conversation']);
    for (const source of this.#sources) {
      if (!/^[a-z][a-z0-9_]{0,63}$/u.test(source.name) || names.has(source.name))
        throw new RangeError('Context source names must be unique stable identifiers.');
      names.add(source.name);
    }
    this.#sampler = options.sampler;
    this.#toolResultMaxChars = options.toolResultMaxChars ?? 1_024;
    this.#summaryMaxTokens =
      options.summaryMaxTokens ?? Math.min(1_024, this.#budget.outputReserveTokens);
    this.#keepRecentTurns = options.keepRecentTurns ?? 1;
    positiveInteger('toolResultMaxChars', this.#toolResultMaxChars);
    positiveInteger('summaryMaxTokens', this.#summaryMaxTokens);
    if (this.#summaryMaxTokens >= this.#budget.windowTokens)
      throw new RangeError('Summary budget must fit the context window.');
    if (!Number.isSafeInteger(this.#keepRecentTurns) || this.#keepRecentTurns < 0)
      throw new RangeError('keepRecentTurns must be a non-negative safe integer.');
  }

  public async build(input: ContextBuildInput): Promise<ContextBuildResult> {
    return this.tracer.startActiveSpan('context.build', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({
        'session.id': input.session.id,
        'turn.id': input.turnId,
        'model_call.id': input.modelCallId,
      });
      try {
        checkContextCancellation(input);
        if (
          input.session.turns.at(-1)?.id !== input.turnId ||
          input.session.turns.at(-1)?.status !== 'in_progress' ||
          input.session.turns.slice(0, -1).some((turn) => turn.status === 'in_progress')
        ) {
          throw new ContextError(
            'invalid_state',
            'Context requires one active turn at the end of the session.',
          );
        }
        const fixed: { name: string; contribution: ContextContribution }[] = [];
        for (const source of this.#sources) {
          try {
            fixed.push({ name: source.name, contribution: await source.load(input) });
          } catch (error) {
            checkContextCancellation(input);
            if (error instanceof ContextError || error instanceof SamplingError) throw error;
            throw new ContextError('source_failed', 'A context source failed.', {
              cause: new Error('source_load_failed'),
            });
          }
          checkContextCancellation(input);
        }
        const fixedMessages = fixed.flatMap(({ contribution }) => contribution.messages);
        const tools = fixed.flatMap(({ contribution }) => contribution.tools);
        const sourceTokens = Object.fromEntries(
          fixed.map(({ name, contribution }) => [
            name,
            contributionTokens(this.#counter, contribution.messages, contribution.tools),
          ]),
        );
        const fixedTokens = Object.values(sourceTokens).reduce(
          (sum, value) => sum + value,
          REQUEST_FRAMING_TOKENS,
        );
        const inputLimit = this.#budget.windowTokens - this.#budget.outputReserveTokens;
        let session = input.session;
        let messages = this.#conversation.load(input).messages;
        const total = (conversation: readonly ModelMessage[]): number =>
          fixedTokens + contributionTokens(this.#counter, conversation, []);
        const baselineTokens = total(messages);
        span.setAttributes({
          'context.window_limit': this.#budget.windowTokens,
          'context.input_limit': inputLimit,
          'context.output_reserve': this.#budget.outputReserveTokens,
          'context.baseline_tokens': baselineTokens,
          'context.total_tokens': baselineTokens,
          'context.conversation_tokens': contributionTokens(this.#counter, messages, []),
          'context.token_counter': this.#counter.name,
          'context.tokens_estimated': true,
        });
        for (const [name, tokens] of Object.entries(sourceTokens))
          span.setAttribute(`context.${name === 'tools' ? 'tool' : name}_tokens`, tokens);
        let prunedResults = 0;
        let compactedTurns = 0;

        // The active turn, rules, instructions and schemas are mandatory, even on overflow.
        const activeMessages = input.session.turns.at(-1)!.entries.map(toModelMessage);
        if (total(activeMessages) > inputLimit)
          throw new ContextError(
            'budget_exceeded',
            'Required context exceeds the input budget; reduce the current turn, rules or tool schemas.',
          );

        const projected = new Map(
          input.session.turns
            .slice(checkpointOffset(session))
            .map((turn) => [turn.id, turn.entries.map(toModelMessage) as readonly ModelMessage[]]),
        );
        const compose = (): readonly ModelMessage[] => [
          ...checkpointMessages(session),
          ...session.turns
            .slice(checkpointOffset(session))
            .flatMap((turn) => projected.get(turn.id)!),
        ];

        if (baselineTokens > inputLimit) {
          for (const turn of input.session.turns.slice(checkpointOffset(session), -1)) {
            const before = projected.get(turn.id)!;
            const after = pruneTurnMessages(turn, this.#toolResultMaxChars);
            if (
              contributionTokens(this.#counter, after, []) <
              contributionTokens(this.#counter, before, [])
            ) {
              prunedResults += after.filter(
                (message, index) =>
                  message.role === 'tool' && message.content !== before[index]?.content,
              ).length;
              projected.set(turn.id, after);
            }
          }
          messages = compose();
        }

        if (total(messages) > inputLimit && this.#sampler !== undefined) {
          const sampler = this.#sampler;
          await this.tracer.startActiveSpan('compaction', async (compactionSpan) => {
            const compactionStarted = performance.now();
            compactionSpan.setAttributes({
              'session.id': session.id,
              'turn.id': input.turnId,
              reason: 'context_budget',
              tokens_before: total(messages),
              messages_before: messages.length,
            });
            try {
              const end = Math.max(0, session.turns.length - 1 - this.#keepRecentTurns);
              while (total(messages) > inputLimit && checkpointOffset(session) < end) {
                checkContextCancellation(input);
                const offset = checkpointOffset(session);
                const candidates = session.turns
                  .slice(offset, end)
                  .map((turn) => ({ turn, messages: projected.get(turn.id)! }));
                const previousTokens = total(messages);
                const checkpoint = await compactTurns(
                  {
                    ...input,
                    candidates,
                    ...(session.contextCheckpoint === undefined
                      ? {}
                      : { previous: session.contextCheckpoint }),
                    budget: this.#budget,
                    summaryMaxTokens: this.#summaryMaxTokens,
                    counter: this.#counter,
                  },
                  sampler,
                  this.tracer,
                );
                session = { ...session, contextCheckpoint: checkpoint };
                messages = compose();
                if (total(messages) >= previousTokens)
                  throw new ContextError(
                    'compaction_failed',
                    'Compaction did not reduce context size.',
                  );
                compactedTurns += checkpoint.coveredTurnIds.length - offset;
              }
              if (total(messages) > inputLimit)
                throw new ContextError(
                  'budget_exceeded',
                  'Context still exceeds the budget after preserving recent turns.',
                );
              compactionSpan.setAttributes({
                success: true,
                tokens_after: total(messages),
                messages_after: messages.length,
                'compaction.turn_count': compactedTurns,
              });
            } catch (error) {
              compactionSpan.setAttributes({
                success: false,
                'error.type':
                  error instanceof ContextError || error instanceof SamplingError
                    ? error.code
                    : 'compaction_failed',
              });
              compactionSpan.setStatus({ code: SpanStatusCode.ERROR });
              throw error;
            } finally {
              compactionSpan.setAttribute('duration_ms', performance.now() - compactionStarted);
              compactionSpan.end();
            }
          });
        }
        checkContextCancellation(input);
        if (total(messages) > inputLimit)
          throw new ContextError(
            'budget_exceeded',
            'Context exceeds the input budget and cannot be reduced safely.',
          );
        const sources = {
          ...sourceTokens,
          conversation: contributionTokens(this.#counter, messages, []),
        };
        const accounting: ContextAccounting = {
          counter: this.#counter.name,
          estimated: true,
          inputLimit,
          baselineTokens,
          totalTokens: total(messages),
          framingTokens: REQUEST_FRAMING_TOKENS,
          sources,
          prunedResults,
          compactedTurns,
        };
        const request: ModelRequest = {
          modelCallId: input.modelCallId,
          modelId: input.agent.model.modelId,
          messages: [...fixedMessages, ...messages],
          tools,
          maxOutputTokens: this.#budget.outputReserveTokens,
        };
        span.setAttributes({
          'context.message_count': request.messages.length,
          'context.system_message_count': request.messages.filter(
            (message) => message.role === 'system',
          ).length,
          'context.conversation_message_count': messages.length,
          'context.tool_count': tools.length,
          'context.window_limit': this.#budget.windowTokens,
          'context.output_reserve': this.#budget.outputReserveTokens,
          'context.input_limit': inputLimit,
          'context.baseline_tokens': baselineTokens,
          'context.total_tokens': accounting.totalTokens,
          'context.framing_tokens': REQUEST_FRAMING_TOKENS,
          'context.token_counter': this.#counter.name,
          'context.tokens_estimated': true,
          'context.pruned_results': prunedResults,
          'context.compaction_applied': compactedTurns > 0,
          'context.checkpoint_reused': input.session.contextCheckpoint !== undefined,
          success: true,
        });
        for (const [name, tokens] of Object.entries(sources))
          span.setAttribute(`context.${name === 'tools' ? 'tool' : name}_tokens`, tokens);
        return { request, session, accounting };
      } catch (error) {
        span.setAttributes({
          success: false,
          'error.type':
            error instanceof ContextError || error instanceof SamplingError
              ? error.code
              : 'context_failed',
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.setAttribute('duration_ms', performance.now() - startedAt);
        span.end();
      }
    });
  }
}
