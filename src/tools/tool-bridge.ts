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

function isCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'AbortError' ||
    (error as Error & { readonly code?: string }).code === 'ABORT_ERR'
  );
}

export class ToolBridge {
  public constructor(
    private readonly registry: ToolRegistry,
    private readonly tracer: TracingHandle['tracer'],
  ) {}

  public readonly execute = async (
    call: ToolCall,
    context: ToolBridgeExecutionContext,
  ): Promise<ToolResult> =>
    this.tracer.startActiveSpan('tool.execute', async (span) => {
      const startedAt = performance.now();
      span.setAttributes({
        'session.id': context.sessionId,
        'turn.id': context.turnId,
        'model_call.id': context.modelCallId,
        'tool_call.id': call.id,
        'tool.name': safeToolName(call.name),
        'tool.kind': 'native',
      });

      const complete = (result: ToolResult, knownErrorType?: string): ToolResult => {
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
        if (tool.definition.accessKind !== 'read') {
          return complete(
            toolFailure(
              call.id,
              'access_denied',
              'Phase 1 ToolBridge executes read-only tools only.',
            ),
            'access_denied',
          );
        }

        const validation = tool.validateInput(call.arguments);
        if (!validation.valid) {
          return complete(
            toolFailure(call.id, 'invalid_input', validation.message),
            'invalid_input',
          );
        }

        const executionOptions: ToolExecutionOptions =
          context.signal === undefined ? {} : { signal: context.signal };
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

        return complete(
          toolFailure(call.id, 'tool_execution_error', 'The tool failed unexpectedly.'),
          'tool_execution_error',
        );
      } finally {
        span.setAttribute('duration_ms', performance.now() - startedAt);
        span.end();
      }
    });
}
