import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';
import {
  Client,
  StreamableHTTPClientTransport,
  SdkHttpError,
  UnauthorizedError,
  type Transport,
  type JSONRPCMessage,
  type Tool as SdkTool,
} from '@modelcontextprotocol/client';
import type { JsonObject, JsonValue } from '../json.js';
import { createCancellationScope, waitForCallback } from '../cancellation.js';
import type { DuplexProcessCapability, LineProcess } from '../workspace/duplex-process.js';
import { McpError, type McpServerConfig } from './config.js';

export interface ExternalToolMetadata {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly destructive: boolean;
}
export interface McpConnection {
  readonly discover: (signal?: AbortSignal) => Promise<readonly ExternalToolMetadata[]>;
  readonly call: (name: string, args: JsonObject, signal?: AbortSignal) => Promise<JsonValue>;
  readonly close: () => Promise<void>;
  onInvalidated?: () => void;
}
class WorkspaceTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;
  private process: LineProcess | undefined;
  private closed = false;
  constructor(
    private readonly workspace: DuplexProcessCapability,
    private readonly config: Extract<McpServerConfig, { transport: 'stdio' }>,
  ) {}
  async start(): Promise<void> {
    this.process = await this.workspace.open(this.config.process, {
      line: (line) => this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line))),
      error: (error) => this.onerror?.(error),
      closed: () => this.onclose?.(),
    });
    if (this.closed) {
      await this.process.close();
      throw new McpError('cancelled');
    }
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.process) throw new McpError('disconnected');
    await this.process.send(JSON.stringify(message));
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.process?.close();
  }
}

/** Bounds streamed HTTP response bytes before SDK parsing; never follows redirects. */
const boundedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'error' });
  if (!response.body) return response;
  let bytes = 0;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          controller.close();
          return;
        }
        bytes += part.value.byteLength;
        if (bytes > 1_048_576) {
          await reader.cancel();
          throw new McpError('output_limit');
        }
        controller.enqueue(part.value);
      } catch {
        controller.error(new McpError('transport'));
      }
    },
    cancel: () => reader.cancel(),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export class SdkMcpConnection implements McpConnection {
  onInvalidated?: () => void;
  private client: Client | undefined;
  private definitions = new Map<string, SdkTool>();
  constructor(
    private readonly config: McpServerConfig,
    private readonly workspace: DuplexProcessCapability,
    private readonly timeoutMs = 30_000,
  ) {}
  private async operation<T>(
    run: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const scope = createCancellationScope(signal, Date.now() + this.timeoutMs);
    try {
      return await waitForCallback(() => run(scope.signal!), scope.signal);
    } catch (cause) {
      await this.close();
      throw new McpError(
        signal?.aborted
          ? 'cancelled'
          : scope.deadlineReached()
            ? 'timeout'
            : cause instanceof UnauthorizedError ||
                (cause instanceof SdkHttpError && [401, 403].includes(cause.status))
              ? 'authentication'
              : cause instanceof McpError
                ? cause.code
                : 'transport',
        'MCP connection failed; an interrupted call may have executed. No call was retried.',
        { cause: new Error(cause instanceof McpError ? cause.code : 'Transport failure') },
      );
    } finally {
      scope.dispose();
    }
  }
  async discover(signal?: AbortSignal): Promise<readonly ExternalToolMetadata[]> {
    return this.operation(async (active) => {
      if (!this.client) {
        const client = new Client(
          { name: 'agent-harness', version: '0.0.0' },
          { capabilities: {}, listMaxPages: 32 },
        );
        this.client = client;
        client.onclose = () => {
          if (this.client === client) {
            this.client = undefined;
            this.onInvalidated?.();
          }
        };
        client.onerror = () => this.onInvalidated?.();
        client.setNotificationHandler('notifications/tools/list_changed', () =>
          this.onInvalidated?.(),
        );
        const transport =
          this.config.transport === 'stdio'
            ? new WorkspaceTransport(this.workspace, this.config)
            : new StreamableHTTPClientTransport(new URL(this.config.url), {
                fetch: boundedFetch,
                requestInit: { headers: this.config.headers },
                reconnectionOptions: {
                  maxRetries: 0,
                  initialReconnectionDelay: 1000,
                  maxReconnectionDelay: 1000,
                  reconnectionDelayGrowFactor: 1,
                },
              });
        await client.connect(transport, { signal: active, timeout: this.timeoutMs });
      }
      const tools: SdkTool[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let bytes = 0;
      for (let page = 0; ; page += 1) {
        if (page >= 32) throw new McpError('catalog_limit');
        const result = await this.client.request(
          { method: 'tools/list', params: cursor === undefined ? {} : { cursor } },
          { signal: active, timeout: this.timeoutMs },
        );
        bytes += Buffer.byteLength(JSON.stringify(result));
        tools.push(...result.tools);
        if (tools.length > 1000 || bytes > 8_388_608) throw new McpError('catalog_limit');
        cursor = result.nextCursor;
        if (cursor === undefined) break;
        if (seen.has(cursor)) throw new McpError('pagination');
        seen.add(cursor);
      }
      active.throwIfAborted();
      this.definitions = new Map(tools.map((tool) => [tool.name, tool]));
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as JsonObject,
        destructive: tool.annotations?.destructiveHint !== false,
      }));
    }, signal);
  }
  async call(name: string, args: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    return this.operation(async (active) => {
      if (!this.client) throw new McpError('disconnected');
      const definition = this.definitions.get(name);
      if (!definition) throw new McpError('stale_target');
      return (await this.client.callTool(
        { name, arguments: args },
        { signal: active, timeout: this.timeoutMs, toolDefinition: definition },
      )) as JsonValue;
    }, signal);
  }
  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      this.onInvalidated?.();
      await client.close().catch(() => undefined);
    }
  }
}
