import { SpanStatusCode } from '@opentelemetry/api';
import type { TracingHandle } from '../observability/tracing.js';
import { waitForCallback } from '../cancellation.js';
import { snapshot } from '../immutable.js';
import type { ModelCallId, SessionId, TurnId } from '../ids.js';
import type { ModelRequest, ModelResponse } from '../model/sampling-types.js';
import type { ToolCall, ToolResult } from '../tools/tool-types.js';

interface Correlation {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}
export type HookContext = Correlation &
  (
    | { readonly name: 'SessionStart' | 'TurnStart' }
    | {
        readonly name: 'BeforeModel';
        readonly request: ModelRequest;
        readonly modelCallId: ModelCallId;
      }
    | {
        readonly name: 'AfterModel';
        readonly response: ModelResponse;
        readonly modelCallId: ModelCallId;
      }
    | { readonly name: 'PreToolUse'; readonly call: ToolCall; readonly modelCallId: ModelCallId }
    | {
        readonly name: 'PostToolUse';
        readonly call: ToolCall;
        readonly result: ToolResult;
        readonly modelCallId: ModelCallId;
      }
    | { readonly name: 'TurnEnd'; readonly outcome: string }
  );
export type HookName = HookContext['name'];
export type Hook = (
  context: HookContext,
  signal?: AbortSignal,
) => void | { readonly deny: true } | Promise<void | { readonly deny: true }>;

export class HookError extends Error {
  public override readonly name = 'HookError';
  public constructor(
    public readonly hookName: HookName,
    cause: unknown,
  ) {
    super(`The ${hookName} hook failed.`, { cause });
  }
}

export class HookRegistry {
  readonly #hooks = new Map<HookName, Set<Hook>>();
  public constructor(private readonly tracer?: TracingHandle['tracer']) {}
  public register(name: HookName, hook: Hook): () => void {
    const hooks = this.#hooks.get(name) ?? new Set<Hook>();
    hooks.add(hook);
    this.#hooks.set(name, hooks);
    return () => {
      hooks.delete(hook);
    };
  }
  public async run(context: HookContext, signal?: AbortSignal): Promise<void> {
    const selected = [...(this.#hooks.get(context.name) ?? [])];
    if (selected.length === 0) return;
    const immutable = snapshot(context);
    const run = async (): Promise<void> => {
      for (const hook of selected) {
        try {
          const result = await waitForCallback(() => hook(immutable, signal), signal);
          if (result?.deny === true) throw new Error('Lifecycle action vetoed.');
        } catch (error) {
          throw new HookError(context.name, error);
        }
      }
    };
    if (this.tracer === undefined) return run();
    return this.tracer.startActiveSpan('hook.run', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({
        'session.id': context.sessionId,
        'turn.id': context.turnId,
        'hook.name': context.name,
        'hook.count': selected.length,
      });
      if ('modelCallId' in context) span.setAttribute('model_call.id', context.modelCallId);
      if ('call' in context) span.setAttribute('tool_call.id', context.call.id);
      try {
        await run();
        span.setAttribute('success', true);
      } catch (error) {
        span.setAttributes({
          success: false,
          'error.type': signal?.aborted ? 'cancelled' : 'hook_failed',
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
