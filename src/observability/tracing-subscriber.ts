import { trace, type Attributes } from '@opentelemetry/api';
import type { EventSubscriber } from '../events/event-bus.js';

/** Enrich existing spans; never create a second span for the same operation. */
export const tracingSubscriber: EventSubscriber = (event) => {
  const attributes: Attributes = { 'session.id': event.sessionId, 'turn.id': event.turnId };
  if ('modelCallId' in event) attributes['model_call.id'] = event.modelCallId;
  if ('toolCallId' in event) attributes['tool_call.id'] = event.toolCallId;
  if ('success' in event) attributes.success = event.success;
  if (event.type === 'TurnCompleted') attributes['turn.outcome'] = event.outcome;
  trace.getActiveSpan()?.addEvent(event.type, attributes);
};
