import { snapshot } from '../immutable.js';
import type { EventBus } from '../events/event-bus.js';
import { HookError, type HookRegistry } from '../hooks/hook-registry.js';
import { PermissionEngine } from '../permissions/permission-engine.js';
import { SpanStatusCode } from '@opentelemetry/api';

import type { ModelCallId, SessionId, TurnId } from '../ids.js';
import type { TracingHandle } from '../observability/tracing.js';
import type { ToolRegistry } from './tool-registry.js';
import { toolFailure } from './tool-result.js';
import type { ToolCall, ToolExecutionOptions, ToolResult } from './tool-types.js';

export interface ToolBridgeExecutionContext {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly modelCallId: ModelCallId;
  readonly signal?: AbortSignal;
}

function safeToolName(name: string): string {
  return name.slice(0, 128);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'AbortError' ||
    (error as Error & { readonly code?: string }).code === 'ABORT_ERR'
  );
}

export interface ToolBridgeOptions {
  readonly permissions?: PermissionEngine;
  readonly hooks?: HookRegistry;
  readonly events?: EventBus;
}

export class ToolBridge {
  readonly #permissions: PermissionEngine;
  public constructor(
    private readonly registry: ToolRegistry,
    private readonly tracer: TracingHandle['tracer'],
    private readonly options: ToolBridgeOptions = {},
  ) {
    this.#permissions = options.permissions ?? new PermissionEngine();
  }

  public readonly execute = async (
    requestedCall: ToolCall,
    context: ToolBridgeExecutionContext,
  ): Promise<ToolResult> =>
    this.tracer.startActiveSpan('tool.execute', async (span) => {
      const startedAt = performance.now();
      const call = snapshot(requestedCall);
      let finalResult: ToolResult | undefined;
      let dispatched = false;
      const correlation = {
        sessionId: context.sessionId,
        turnId: context.turnId,
        modelCallId: context.modelCallId,
      };
      span.setAttributes({
        'session.id': context.sessionId,
        'turn.id': context.turnId,
        'model_call.id': context.modelCallId,
        'tool_call.id': call.id,
        'tool.name': safeToolName(call.name),
        'tool.kind': 'native',
      });

      const complete = (result: ToolResult, knownErrorType?: string): ToolResult => {
        finalResult = result;
        span.setAttributes({
          success: result.outcome === 'success',
          'tool.result_outcome': result.outcome,
        });
        if (result.outcome === 'error') {
          span.setAttribute('error.type', knownErrorType ?? 'tool_reported_error');
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return result;
      };

      try {
        await this.options.events?.publish({
          type: 'ToolStarted',
          ...correlation,
          toolCallId: call.id,
        });
        if (context.signal?.aborted === true) {
          return complete(
            toolFailure(call.id, 'cancelled', 'Tool execution was cancelled before dispatch.'),
            'cancelled',
          );
        }

        const tool = this.registry.get(call.name);
        if (tool === undefined) {
          return complete(
            toolFailure(call.id, 'unknown_tool', 'No registered tool matches this call.'),
            'unknown_tool',
          );
        }

        span.setAttribute('tool.access_kind', tool.definition.accessKind);

        const validation = tool.validateInput(call.arguments);
        if (!validation.valid) {
          return complete(
            toolFailure(call.id, 'invalid_input', validation.message),
            'invalid_input',
          );
        }

        await this.options.hooks?.run({ name: 'PreToolUse', ...correlation, call }, context.signal);
        const permission = await this.tracer.startActiveSpan(
          'permission.evaluate',
          async (permissionSpan) => {
            const permissionStartedAt = performance.now();
            permissionSpan.setAttributes({
              'session.id': context.sessionId,
              'turn.id': context.turnId,
              'model_call.id': context.modelCallId,
              'tool_call.id': call.id,
              'permission.mode': this.#permissions.mode,
            });
            try {
              const resolution = await this.#permissions.authorize(
                {
                  ...correlation,
                  call,
                  accessKind: tool.definition.accessKind,
                  ...(tool.definition.destructive === undefined
                    ? {}
                    : { destructive: tool.definition.destructive }),
                },
                context.signal,
              );
              const attributes = {
                'permission.mode': this.#permissions.mode,
                'permission.decision': resolution.decision,
                'permission.reason': resolution.reason,
                'permission.allowed': resolution.allowed,
              };
              span.setAttributes(attributes);
              permissionSpan.setAttributes(attributes);
              return resolution;
            } finally {
              permissionSpan.setAttribute('duration_ms', performance.now() - permissionStartedAt);
              permissionSpan.end();
            }
          },
        );
        if (!permission.allowed || isAborted(context.signal)) {
          const code = isAborted(context.signal) ? 'cancelled' : 'access_denied';
          return complete(toolFailure(call.id, code, 'Tool execution was not authorized.'), code);
        }

        const executionOptions: ToolExecutionOptions =
          context.signal === undefined ? {} : { signal: context.signal };
        dispatched = true;
        const result = await tool.execute(call, executionOptions);
        if (result.toolCallId !== call.id) {
          return complete(
            toolFailure(
              call.id,
              'invalid_tool_result',
              'The tool returned a mismatched tool call correlation ID.',
            ),
            'invalid_tool_result',
          );
        }

        return complete(result);
      } catch (error) {
        if (context.signal?.aborted === true || isCancellationError(error)) {
          return complete(
            toolFailure(call.id, 'cancelled', 'Tool execution was cancelled.'),
            'cancelled',
          );
        }

        if (error instanceof HookError) {
          return complete(toolFailure(call.id, 'hook_failed', error.message), 'hook_failed');
        }
        return complete(
          toolFailure(call.id, 'tool_execution_error', 'The tool failed unexpectedly.'),
          'tool_execution_error',
        );
      } finally {
        if (dispatched && finalResult !== undefined) {
          try {
            await this.options.hooks?.run(
              { name: 'PostToolUse', ...correlation, call, result: finalResult },
              context.signal,
            );
          } catch {
            // Preserve the executed result; post-hook failure must not invite a mutation retry.
            span.setAttribute('hook.post_tool_failed', true);
          }
        }
        await this.options.events?.publish({
          type: 'ToolCompleted',
          ...correlation,
          toolCallId: call.id,
          success: finalResult?.outcome === 'success',
        });
        span.setAttribute('duration_ms', performance.now() - startedAt);
        span.end();
      }
    });
}
