import type { JsonObject } from '../json.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { TracingHandle } from '../observability/tracing.js';
import type { Tool } from '../tools/tool.interface.js';
import { toolFailure, toolSuccess } from '../tools/tool-result.js';
import { ToolCatalog } from './tool-catalog.js';
import { object, McpError } from './config.js';
import type { McpConnection } from './mcp-client.js';

/** One run's connections; refresh is demand-driven and never retries invocation. */
export class McpManager {
  readonly catalog: ToolCatalog;
  private readonly dirty = new Set<string>();
  private readonly revisions = new Map<string, number>();
  private closed = false;
  private refreshing: Promise<void> | undefined;
  constructor(
    private readonly connections: ReadonlyMap<string, McpConnection>,
    registry: ToolRegistry,
    tracer: TracingHandle['tracer'],
  ) {
    this.catalog = new ToolCatalog(registry, tracer);
    for (const [alias, connection] of connections) {
      this.dirty.add(alias);
      connection.onInvalidated = () => {
        this.revisions.set(alias, (this.revisions.get(alias) ?? 0) + 1);
        this.catalog.invalidate(alias);
        this.dirty.add(alias);
      };
    }
    registry.register(this.searchTool());
    registry.register(this.invokeTool());
  }
  async refresh(signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new McpError('closed');
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      for (const alias of [...this.dirty]) {
        signal?.throwIfAborted();
        const connection = this.connections.get(alias)!;
        const revision = this.revisions.get(alias) ?? 0;
        const metadata = await connection.discover(signal);
        if (this.closed || revision !== (this.revisions.get(alias) ?? 0))
          throw new McpError('catalog_changed', 'Catalog changed during discovery; search again.');
        this.catalog.publish(alias, metadata, connection);
        this.dirty.delete(alias);
      }
    })();
    try {
      await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.connections.values()].map((connection) => connection.close()),
    );
    for (const alias of this.connections.keys()) this.catalog.invalidate(alias);
  }
  private searchTool(): Tool {
    return {
      definition: {
        name: 'search_tools',
        description:
          'Search configured external tools and retrieve complete input schemas and current versions.',
        accessKind: 'read',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 512 },
            limit: { type: 'integer', minimum: 1, maximum: 5 },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      validateInput: (input) =>
        typeof input.query === 'string' &&
        input.query.trim().length > 0 &&
        input.query.length <= 512 &&
        Object.keys(input).every((key) => ['query', 'limit'].includes(key)) &&
        (input.limit === undefined ||
          (typeof input.limit === 'number' &&
            Number.isInteger(input.limit) &&
            input.limit >= 1 &&
            input.limit <= 5))
          ? { valid: true }
          : { valid: false, message: 'Provide query and optional limit (1–5).' },
      execute: async (call, options) => {
        try {
          await this.refresh(options?.signal);
          return toolSuccess(
            call.id,
            this.catalog.search(
              call.arguments.query as string,
              call.arguments.limit as number | undefined,
              options,
            ),
          );
        } catch (error) {
          return toolFailure(
            call.id,
            error instanceof McpError ? error.code : 'discovery_failed',
            'External tool discovery failed; search again after fixing the connection.',
          );
        }
      },
    };
  }
  private invokeTool(): Tool {
    return {
      definition: {
        name: 'invoke_tool',
        description:
          'Invoke a tool returned by search_tools using its exact name, version and schema. External target permissions apply.',
        accessKind: 'read',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            arguments: { type: 'object' },
          },
          required: ['name', 'version', 'arguments'],
          additionalProperties: false,
        },
      },
      validateInput: (input) =>
        typeof input.name === 'string' &&
        input.name.length <= 512 &&
        typeof input.version === 'string' &&
        input.version.length <= 32 &&
        object(input.arguments) &&
        Object.keys(input).every((key) => ['name', 'version', 'arguments'].includes(key))
          ? { valid: true }
          : { valid: false, message: 'Provide target name, version and arguments object.' },
      resolveInvocation: (call) => {
        const entry = this.catalog.resolve(
          call.arguments.name as string,
          call.arguments.version as string,
        );
        return {
          id: call.id,
          name: entry?.name ?? '',
          arguments: call.arguments.arguments as JsonObject,
        };
      },
      execute: (call) =>
        Promise.resolve(
          toolFailure(call.id, 'invalid_delegation', 'Invocation requires target resolution.'),
        ),
    };
  }
}
