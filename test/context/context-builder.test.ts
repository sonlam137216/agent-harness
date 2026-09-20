import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';

import type { AgentDefinition } from '../../src/agent/agent-definition.js';
import { ContextBuilder } from '../../src/context/context-builder.js';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import type { ModelToolDefinition } from '../../src/model/sampling-types.js';
import { createTracing } from '../../src/observability/tracing.js';
import type { Session } from '../../src/session/session.js';

const agent: AgentDefinition = {
  name: 'test-agent',
  systemPrompt: 'Follow the test instructions.',
  model: { modelId: 'test-model' },
};

const tool: ModelToolDefinition = {
  name: 'read_file',
  description: 'Read a UTF-8 text file.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
};

describe('ContextBuilder', () => {
  it('composes the system prompt, ordered session conversation, and tool definitions', async () => {
    const tracing = createTracing({ exporter: new InMemorySpanExporter() });
    const builder = new ContextBuilder(tracing.tracer);
    const toolCallId = createToolCallId();
    const modelCallId = createModelCallId();
    const turnId = createTurnId();
    const session: Session = {
      id: createSessionId(),
      turns: [
        {
          id: createTurnId(),
          status: 'completed',
          entries: [
            { kind: 'user_message', content: 'Read package.json.' },
            {
              kind: 'assistant_message',
              modelCallId: createModelCallId(),
              content: null,
              toolCalls: [
                { id: toolCallId, name: 'read_file', arguments: { path: 'package.json' } },
              ],
            },
            {
              kind: 'tool_result',
              toolCallId,
              outcome: 'success',
              output: { name: 'agent-harness' },
            },
          ],
        },
        {
          id: turnId,
          status: 'in_progress',
          entries: [{ kind: 'user_message', content: 'What is its name?' }],
        },
      ],
    };

    const { request } = await builder.build({ agent, session, turnId, modelCallId, tools: [tool] });

    expect(request).toEqual({
      modelCallId,
      modelId: 'test-model',
      maxOutputTokens: 4096,
      messages: [
        { role: 'system', content: 'Follow the test instructions.' },
        { role: 'user', content: 'Read package.json.' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: toolCallId, name: 'read_file', arguments: { path: 'package.json' } }],
        },
        {
          role: 'tool',
          toolCallId,
          content: '{"outcome":"success","output":{"name":"agent-harness"}}',
        },
        { role: 'user', content: 'What is its name?' },
      ],
      tools: [tool],
    });

    await tracing.shutdown();
  });

  it('emits safe structural context.build attributes without prompt content', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({ exporter });
    const builder = new ContextBuilder(tracing.tracer);
    const session: Session = {
      id: createSessionId(),
      turns: [
        {
          id: createTurnId(),
          status: 'in_progress',
          entries: [{ kind: 'user_message', content: 'sensitive prompt content' }],
        },
      ],
    };
    const turnId = session.turns[0]!.id;
    const modelCallId = createModelCallId();

    await builder.build({ agent, session, turnId, modelCallId, tools: [tool] });
    await tracing.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('context.build');
    expect(spans[0]?.attributes).toMatchObject({
      'session.id': session.id,
      'turn.id': turnId,
      'model_call.id': modelCallId,
      'context.message_count': 2,
      'context.system_message_count': 1,
      'context.conversation_message_count': 1,
      'context.tool_count': 1,
    });
    expect(JSON.stringify(spans[0]?.attributes)).not.toContain('sensitive prompt content');

    await tracing.shutdown();
  });
});
