import type { Readable, Writable } from 'node:stream';

/** JSON-RPC 2.0 error codes used by the protocol layer. */
export const JSON_RPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

export type JsonRpcId = string | number;

export class JsonRpcError extends Error {
  public override readonly name = 'JsonRpcError';
  public constructor(
    public readonly code: number,
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface JsonRpcHandlers {
  /** Resolve with the result or throw a JsonRpcError; other errors become internal errors. */
  request(method: string, params: unknown): Promise<unknown>;
  notification(method: string, params: unknown): void;
}

export interface JsonRpcConnectionOptions {
  /** Longest accepted message line; longer lines are rejected and skipped. */
  readonly maxLineBytes?: number;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

/**
 * Newline-delimited JSON-RPC 2.0 over a pair of streams, in both directions: incoming
 * requests run concurrently (so a cancel notification can arrive during a long request),
 * and outgoing requests are matched to responses by ID. Batches are not supported.
 */
export class JsonRpcConnection {
  readonly #pending = new Map<JsonRpcId, Pending>();
  readonly #inFlight = new Set<Promise<void>>();
  readonly #maxLineBytes: number;
  #nextId = 1;
  #closed = false;

  public constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handlers: JsonRpcHandlers,
    options: JsonRpcConnectionOptions = {},
  ) {
    this.#maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
  }

  /** Reads until the input ends; outstanding outgoing requests are then rejected. */
  public start(): Promise<void> {
    return new Promise((resolve) => {
      let buffer = Buffer.alloc(0);
      let discarding = false;
      const finish = (): void => {
        this.close();
        resolve();
      };
      this.input.on('data', (chunk: Buffer | string) => {
        buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
        let newline = buffer.indexOf(0x0a);
        while (newline !== -1) {
          const line = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          if (!discarding) this.#receive(line.toString('utf8'));
          discarding = false;
          newline = buffer.indexOf(0x0a);
        }
        if (buffer.length > this.#maxLineBytes) {
          if (!discarding) this.#error(null, JSON_RPC_ERRORS.invalidRequest, 'Message too large.');
          discarding = true;
          buffer = Buffer.alloc(0);
        }
      });
      this.input.once('end', finish);
      this.input.once('close', finish);
      this.input.once('error', finish);
    });
  }

  public notify(method: string, params: unknown): void {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  public request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error('The connection is closed.'));
    if (signal?.aborted === true) return Promise.reject(new Error('The request was cancelled.'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.#pending.delete(id);
        reject(new Error('The request was cancelled.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.#pending.set(id, {
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
      this.#write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Waits for incoming requests that are still being handled (e.g. after cancelling them). */
  public async drain(): Promise<void> {
    while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      pending.cleanup();
      pending.reject(new Error('The connection closed.'));
    }
    this.#pending.clear();
  }

  #receive(line: string): void {
    if (line.trim() === '') return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#error(null, JSON_RPC_ERRORS.parseError, 'Parse error.');
      return;
    }
    if (!isObject(message) || message.jsonrpc !== '2.0') {
      this.#error(null, JSON_RPC_ERRORS.invalidRequest, 'Invalid request.');
      return;
    }
    const { id, method } = message;
    if (typeof method === 'string') {
      if (id === undefined) {
        try {
          this.handlers.notification(method, message.params);
        } catch {
          // Notifications have no response channel.
        }
        return;
      }
      if (!isId(id)) {
        this.#error(null, JSON_RPC_ERRORS.invalidRequest, 'Invalid request ID.');
        return;
      }
      const handling = this.#handle(id, method, message.params);
      this.#inFlight.add(handling);
      void handling.finally(() => this.#inFlight.delete(handling));
      return;
    }
    if (isId(id) && ('result' in message || 'error' in message)) {
      const pending = this.#pending.get(id);
      if (pending === undefined) return;
      this.#pending.delete(id);
      pending.cleanup();
      if (isObject(message.error))
        pending.reject(
          new JsonRpcError(
            typeof message.error.code === 'number'
              ? message.error.code
              : JSON_RPC_ERRORS.internalError,
            typeof message.error.message === 'string' ? message.error.message : 'Request failed.',
          ),
        );
      else pending.resolve(message.result);
      return;
    }
    this.#error(isId(id) ? id : null, JSON_RPC_ERRORS.invalidRequest, 'Invalid request.');
  }

  async #handle(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.request(method, params);
      this.#write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      if (error instanceof JsonRpcError) this.#error(id, error.code, error.message, error.data);
      else this.#error(id, JSON_RPC_ERRORS.internalError, 'Internal error.');
    }
  }

  #error(id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
    this.#write({
      jsonrpc: '2.0',
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }

  #write(message: unknown): void {
    if (this.#closed && !('id' in (message as object))) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }
}
