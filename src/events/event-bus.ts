import { createCancellationScope, waitForCallback } from '../cancellation.js';
import { freezeData } from '../immutable.js';
import type { RuntimeEvent } from './runtime-event.js';

export type EventSubscriber = (event: RuntimeEvent, signal?: AbortSignal) => void | Promise<void>;
export class EventSubscriberError extends Error {
  public override readonly name = 'EventSubscriberError';
  public constructor(cause: unknown) {
    super('A required lifecycle subscriber failed.', { cause });
  }
}

export class EventBus {
  readonly #subscribers = new Set<{ subscriber: EventSubscriber; required: boolean }>();

  public constructor(private readonly observerTimeoutMs = 1000) {
    if (!Number.isSafeInteger(observerTimeoutMs) || observerTimeoutMs <= 0) {
      throw new RangeError('observerTimeoutMs must be a positive safe integer.');
    }
  }

  public subscribe(
    subscriber: EventSubscriber,
    options: { readonly required?: boolean } = {},
  ): () => void {
    const entry = { subscriber, required: options.required ?? false };
    this.#subscribers.add(entry);
    return () => {
      this.#subscribers.delete(entry);
    };
  }

  public async publish(event: RuntimeEvent): Promise<void> {
    const immutable = freezeData(event);
    let failure: EventSubscriberError | undefined;
    for (const { subscriber, required } of [...this.#subscribers]) {
      const critical = required && event.type === 'SessionUpdated';
      const cancellation = createCancellationScope(
        undefined,
        critical ? undefined : Date.now() + this.observerTimeoutMs,
      );
      try {
        await waitForCallback(
          () => subscriber(immutable, cancellation.signal),
          cancellation.signal,
        );
      } catch (error) {
        if (required && event.type === 'SessionUpdated' && failure === undefined)
          failure = new EventSubscriberError(error);
      } finally {
        cancellation.dispose();
      }
    }
    if (failure !== undefined) throw failure;
  }
}
