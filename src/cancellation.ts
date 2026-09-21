export interface CancellationScope {
  readonly signal?: AbortSignal;
  readonly deadlineReached: () => boolean;
  readonly dispose: () => void;
}

export function createCancellationScope(
  parentSignal: AbortSignal | undefined,
  deadlineMs: number | undefined,
): CancellationScope {
  if (deadlineMs !== undefined && !Number.isFinite(deadlineMs)) {
    throw new RangeError('deadlineMs must be a finite absolute timestamp.');
  }
  if (parentSignal === undefined && deadlineMs === undefined) {
    return { deadlineReached: () => false, dispose: () => undefined };
  }

  const controller = new AbortController();
  let deadlineReached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelFromParent = (): void => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted === true) {
    cancelFromParent();
  } else {
    parentSignal?.addEventListener('abort', cancelFromParent, { once: true });
    if (deadlineMs !== undefined) {
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        deadlineReached = true;
        controller.abort();
      } else {
        timer = setTimeout(() => {
          deadlineReached = true;
          controller.abort();
        }, remainingMs);
      }
    }
  }

  return {
    signal: controller.signal,
    deadlineReached: () => deadlineReached,
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', cancelFromParent);
    },
  };
}

/** Stops waiting on trusted callbacks even if they ignore their cancellation signal. */
export async function waitForCallback<T>(
  run: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (signal === undefined) return run();
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new DOMException('Operation cancelled.', 'AbortError'));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return run();
      }),
      cancelled,
    ]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
