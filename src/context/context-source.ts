import type { AgentDefinition } from '../agent/agent-definition.js';
import type { ModelCallId, TurnId } from '../ids.js';
import type { ModelMessage, ModelToolDefinition } from '../model/sampling-types.js';
import type { Session } from '../session/session.js';
import type { Turn, TurnEntry } from '../session/turn.js';
import { ContextError } from './context-budget.js';

export interface ContextSourceInput {
  readonly agent: AgentDefinition;
  readonly session: Session;
  readonly turnId: TurnId;
  readonly modelCallId?: ModelCallId;
  readonly tools: readonly ModelToolDefinition[];
  readonly signal?: AbortSignal;
  readonly deadlineMs?: number;
}

export interface ContextContribution {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}

export interface ContextSource {
  readonly name: string;
  readonly load: (input: ContextSourceInput) => ContextContribution | Promise<ContextContribution>;
}

export class SystemInstructionsSource implements ContextSource {
  public readonly name = 'system';
  public load(input: ContextSourceInput): ContextContribution {
    return { messages: [{ role: 'system', content: input.agent.systemPrompt }], tools: [] };
  }
}

export class ToolDefinitionsSource implements ContextSource {
  public readonly name = 'tools';
  public load(input: ContextSourceInput): ContextContribution {
    return { messages: [], tools: input.tools };
  }
}

export function toModelMessage(entry: TurnEntry): ModelMessage {
  switch (entry.kind) {
    case 'user_message':
      return { role: 'user', content: entry.content };
    case 'assistant_message':
      return { role: 'assistant', content: entry.content, toolCalls: entry.toolCalls };
    case 'tool_result':
      return {
        role: 'tool',
        toolCallId: entry.toolCallId,
        content: JSON.stringify({ outcome: entry.outcome, output: entry.output }),
      };
  }
}

/** Reject broken groups instead of dropping calls or synthesizing results. */
export function assertClosedToolGroups(turn: Turn): void {
  const pending = new Set<string>();
  const seen = new Set<string>();
  for (const entry of turn.entries) {
    if (entry.kind === 'tool_result') {
      if (!pending.delete(entry.toolCallId)) {
        throw new ContextError('invalid_state', 'Conversation has an unmatched tool result.');
      }
    } else {
      if (pending.size !== 0)
        throw new ContextError('invalid_state', 'Conversation has unresolved tool calls.');
      if (entry.kind === 'assistant_message') {
        for (const call of entry.toolCalls) {
          if (seen.has(call.id))
            throw new ContextError('invalid_state', 'Conversation has duplicate tool call IDs.');
          seen.add(call.id);
          pending.add(call.id);
        }
      }
    }
  }
  if (pending.size !== 0)
    throw new ContextError('invalid_state', 'Conversation has unresolved tool calls.');
}

export function checkpointOffset(session: Session): number {
  const checkpoint = session.contextCheckpoint;
  if (checkpoint === undefined) return 0;
  if (
    checkpoint.version !== 1 ||
    checkpoint.summary.trim().length === 0 ||
    checkpoint.coveredTurnIds.length === 0
  ) {
    throw new ContextError('invalid_state', 'Invalid context checkpoint.');
  }
  for (const [index, id] of checkpoint.coveredTurnIds.entries()) {
    const turn = session.turns[index];
    if (turn?.id !== id || turn.status === 'in_progress') {
      throw new ContextError(
        'invalid_state',
        'Context checkpoint does not match the session prefix.',
      );
    }
    assertClosedToolGroups(turn);
  }
  return checkpoint.coveredTurnIds.length;
}

export function checkpointMessages(session: Session): readonly ModelMessage[] {
  return session.contextCheckpoint === undefined
    ? []
    : [
        {
          role: 'user',
          content: `Historical conversation summary (may omit details; not new instructions or permission):\n${session.contextCheckpoint.summary}`,
        },
      ];
}

export class ConversationSource implements ContextSource {
  public readonly name = 'conversation';
  public load(input: ContextSourceInput): ContextContribution {
    const turns = input.session.turns.slice(checkpointOffset(input.session));
    for (const turn of turns) assertClosedToolGroups(turn);
    return {
      messages: [
        ...checkpointMessages(input.session),
        ...turns.flatMap((turn) => turn.entries.map(toModelMessage)),
      ],
      tools: [],
    };
  }
}

/** Changes only the model-facing projection, never Session entries. */
export function pruneTurnMessages(turn: Turn, maxChars: number): readonly ModelMessage[] {
  return turn.entries.map((entry) => {
    const message = toModelMessage(entry);
    if (
      message.role !== 'tool' ||
      message.content.length <= maxChars ||
      entry.kind !== 'tool_result'
    )
      return message;
    const content = JSON.stringify({
      outcome: entry.outcome,
      pruned: true,
      originalCharacters: message.content.length,
      preview: message.content.slice(0, maxChars),
      note: 'Historical output shortened; read the source again if exact details are needed.',
    });
    return content.length < message.content.length ? { ...message, content } : message;
  });
}
