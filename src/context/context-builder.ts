import type { AgentDefinition } from '../agent/agent-definition.js';
import type { ModelCallId } from '../ids.js';
import type { ModelMessage, ModelRequest, ModelToolDefinition } from '../model/sampling-types.js';
import type { TracingHandle } from '../observability/tracing.js';
import type { Session } from '../session/session.js';
import type { ToolResult, TurnEntry } from '../session/turn.js';

export interface ContextBuildInput {
  readonly agent: AgentDefinition;
  readonly session: Session;
  readonly modelCallId: ModelCallId;
  readonly tools: readonly ModelToolDefinition[];
}

function serializeToolResult(result: ToolResult): string {
  return JSON.stringify({
    outcome: result.outcome,
    output: result.output,
  });
}

function toModelMessage(entry: TurnEntry): ModelMessage {
  switch (entry.kind) {
    case 'user_message':
      return { role: 'user', content: entry.content };
    case 'assistant_message':
      return {
        role: 'assistant',
        content: entry.content,
        toolCalls: entry.toolCalls,
      };
    case 'tool_result':
      return {
        role: 'tool',
        toolCallId: entry.toolCallId,
        content: serializeToolResult(entry),
      };
  }
}

export class ContextBuilder {
  public constructor(private readonly tracer: TracingHandle['tracer']) {}

  public build(input: ContextBuildInput): ModelRequest {
    return this.tracer.startActiveSpan('context.build', (span) => {
      try {
        const conversationMessages = input.session.turns.flatMap((turn) =>
          turn.entries.map(toModelMessage),
        );
        const messages: readonly ModelMessage[] = [
          { role: 'system', content: input.agent.systemPrompt },
          ...conversationMessages,
        ];

        span.setAttributes({
          'session.id': input.session.id,
          'model_call.id': input.modelCallId,
          'context.message_count': messages.length,
          'context.system_message_count': 1,
          'context.conversation_message_count': conversationMessages.length,
          'context.tool_count': input.tools.length,
        });

        return {
          modelCallId: input.modelCallId,
          modelId: input.agent.model.modelId,
          messages,
          tools: input.tools,
        };
      } finally {
        span.end();
      }
    });
  }
}
