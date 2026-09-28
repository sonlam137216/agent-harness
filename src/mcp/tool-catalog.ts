import { randomBytes } from 'node:crypto';
import type { ToolExecutionOptions } from '../tools/tool-types.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv } from 'ajv';
import { snapshot } from '../immutable.js';
import type { JsonObject, JsonValue } from '../json.js';
import type { Tool } from '../tools/tool.interface.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { toolFailure } from '../tools/tool-result.js';
import { McpError, object } from './config.js';
import type { ExternalToolMetadata, McpConnection } from './mcp-client.js';
import { ToolIndex } from './tool-index.js';
import type { TracingHandle } from '../observability/tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';

export interface CatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly version: string;
}
export function qualifiedName(alias: string, name: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(alias) || name.length === 0 || Buffer.byteLength(name) > 128)
    throw new McpError('invalid_name');
  return `mcp:${alias}:${encodeURIComponent(name)}`;
}
function validateSchema(schema: JsonObject): (value: unknown) => boolean {
  const text = JSON.stringify(schema);
  if (Buffer.byteLength(text) > 65_536 || schema.type !== 'object')
    throw new McpError('invalid_schema');
  // No network references, regex execution or asynchronous validators from server data.
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 32) throw new McpError('invalid_schema');
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (
        ['pattern', 'patternProperties', '$async', 'x-mcp-header'].includes(key) ||
        (['$ref', '$dynamicRef'].includes(key) &&
          (typeof child !== 'string' || !child.startsWith('#')))
      )
        throw new McpError('unsupported_schema');
      if (
        ['properties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'].includes(key) &&
        object(child)
      )
        for (const nested of Object.values(child)) visit(nested, depth + 1);
      else if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(child))
        for (const nested of child) visit(nested, depth + 1);
      else if (
        [
          'items',
          'additionalProperties',
          'additionalItems',
          'unevaluatedProperties',
          'unevaluatedItems',
          'contains',
          'propertyNames',
          'not',
          'if',
          'then',
          'else',
        ].includes(key)
      ) {
        if (Array.isArray(child)) for (const nested of child) visit(nested, depth + 1);
        else visit(child, depth + 1);
      }
    }
  };
  visit(schema);
  const options = {
    strict: false,
    strictSchema: true,
    allErrors: false,
    validateFormats: false,
    ownProperties: true,
    addUsedSchema: false,
  };
  const ajv =
    schema.$schema === 'http://json-schema.org/draft-07/schema#'
      ? new Ajv(options)
      : new Ajv2020(options);
  try {
    const validate = ajv.compile(schema);
    return (value) => validate(value) === true;
  } catch {
    throw new McpError('invalid_schema');
  }
}
function normalizedResult(raw: JsonValue): { output: JsonValue; error: boolean } {
  if (!object(raw) || !Array.isArray(raw.content)) throw new McpError('invalid_result');
  const content = raw.content.map((block: unknown): JsonValue => {
    if (!object(block) || typeof block.type !== 'string') throw new McpError('invalid_result');
    if (block.type === 'text' && typeof block.text === 'string')
      return { type: 'text', text: block.text };
    if (block.type === 'resource_link')
      return {
        type: 'resource_link',
        name: typeof block.name === 'string' ? block.name : '',
        uri: typeof block.uri === 'string' ? block.uri : '',
      };
    if (
      block.type === 'resource' &&
      object(block.resource) &&
      typeof block.resource.text === 'string'
    )
      return {
        type: 'resource',
        uri: typeof block.resource.uri === 'string' ? block.resource.uri : '',
        text: block.resource.text,
      };
    return {
      type: block.type,
      omitted: true,
      reason: 'Media is unavailable in the text-only harness.',
    };
  });
  return {
    output: {
      content,
      ...(raw.structuredContent === undefined ? {} : { structuredContent: raw.structuredContent }),
    },
    error: raw.isError === true,
  };
}

export class ToolCatalog {
  private readonly servers = new Map<
    string,
    { entries: readonly CatalogEntry[]; tools: readonly Tool[] }
  >();
  private entries = new Map<string, CatalogEntry>();
  private index = new ToolIndex([]);
  private generation = 0;
  private readonly epoch = randomBytes(8).toString('hex');
  constructor(
    private readonly registry: ToolRegistry,
    private readonly tracer: TracingHandle['tracer'],
  ) {}
  invalidate(alias: string): void {
    const previous = this.servers.get(alias);
    if (!previous) return;
    this.registry.replaceHidden(
      previous.tools.map((tool) => tool.definition.name),
      [],
    );
    this.servers.delete(alias);
    this.reindex();
  }
  private reindex(): void {
    this.entries = new Map(
      [...this.servers.values()]
        .flatMap((server) => server.entries)
        .map((entry) => [entry.name, entry]),
    );
    this.index = new ToolIndex([...this.entries.values()]);
  }
  publish(
    alias: string,
    metadata: readonly ExternalToolMetadata[],
    connection: McpConnection,
  ): void {
    const previous = this.servers.get(alias);
    const existingCount = this.entries.size - (previous?.entries.length ?? 0);
    if (
      existingCount + metadata.length > 1000 ||
      Buffer.byteLength(JSON.stringify(metadata)) > 8_388_608
    )
      throw new McpError('catalog_limit');
    const retained = [...this.servers.entries()]
      .filter(([key]) => key !== alias)
      .flatMap(([, server]) => server.entries);
    if (
      Buffer.byteLength(JSON.stringify(retained)) + Buffer.byteLength(JSON.stringify(metadata)) >
      8_388_608
    )
      throw new McpError('catalog_limit');
    const version = `${this.epoch}-${++this.generation}`;
    const entries: CatalogEntry[] = [];
    const tools = metadata.map((item): Tool => {
      const entry = snapshot({
        name: qualifiedName(alias, item.name),
        description: item.description,
        inputSchema: item.inputSchema,
        version,
      });
      if (Buffer.byteLength(JSON.stringify(entry)) > 15_000)
        throw new McpError(
          'schema_too_large',
          'A tool schema cannot fit the bounded search response.',
        );
      const validate = validateSchema(entry.inputSchema);
      entries.push(entry);
      return {
        definition: {
          ...entry,
          accessKind: 'external',
          origin: 'external',
          destructive: item.destructive,
        },
        validateInput: (input) =>
          validate(input)
            ? { valid: true }
            : { valid: false, message: 'Arguments do not match the external tool schema.' },
        execute: async (call, options) =>
          this.tracer.startActiveSpan('mcp.call', async (span) => {
            const start = performance.now();
            span.setAttributes({
              server: alias,
              tool: entry.name,
              'tool_call.id': call.id,
              ...correlationAttributes(options),
            });
            try {
              const normalized = normalizedResult(
                await connection.call(item.name, call.arguments, options?.signal),
              );
              const output = { target: entry.name, version, result: normalized.output };
              const bytes = Buffer.byteLength(JSON.stringify(output));
              span.setAttribute('result_size_bytes', bytes);
              if (bytes > 65_536)
                throw new McpError(
                  'result_limit',
                  'The tool returned oversized output after execution. Do not automatically retry.',
                );
              span.setAttribute('success', !normalized.error);
              if (normalized.error) span.setStatus({ code: SpanStatusCode.ERROR });
              return {
                toolCallId: call.id,
                outcome: normalized.error ? ('error' as const) : ('success' as const),
                output,
              };
            } catch (error) {
              const code = error instanceof McpError ? error.code : 'external_error';
              span.setAttributes({ success: false, 'error.type': code });
              span.setStatus({ code: SpanStatusCode.ERROR });
              return toolFailure(
                call.id,
                code,
                error instanceof McpError
                  ? error.message
                  : 'External execution failed; it may have completed. No call was retried.',
              );
            } finally {
              span.setAttribute('duration_ms', performance.now() - start);
              span.end();
            }
          }),
      };
    });
    this.registry.replaceHidden(previous?.tools.map((tool) => tool.definition.name) ?? [], tools);
    this.servers.set(alias, { entries, tools });
    this.reindex();
  }
  resolve(name: string, version: string): CatalogEntry | undefined {
    const entry = this.entries.get(name);
    return entry?.version === version ? entry : undefined;
  }
  search(query: string, limit = 5, options?: ToolExecutionOptions): JsonObject {
    return this.tracer.startActiveSpan('mcp.search', (span) => {
      const start = performance.now();
      span.setAttributes(correlationAttributes(options));
      try {
        const names = this.index.search(query);
        const tools: JsonValue[] = [];
        for (const name of names.slice(0, limit)) {
          const entry = this.entries.get(name)!;
          const value = { ...entry };
          if (
            Buffer.byteLength(JSON.stringify({ tools: [...tools, value], truncated: true })) >
            16_384
          )
            break;
          tools.push(value);
        }
        span.setAttributes({
          query_length: query.length,
          catalog_size: this.entries.size,
          result_count: tools.length,
          success: true,
        });
        return { tools, truncated: tools.length < names.length };
      } finally {
        span.setAttribute('duration_ms', performance.now() - start);
        span.end();
      }
    });
  }
}

function correlationAttributes(options?: ToolExecutionOptions): Record<string, string> {
  return options?.correlation === undefined
    ? {}
    : {
        'session.id': options.correlation.sessionId,
        'turn.id': options.correlation.turnId,
        'model_call.id': options.correlation.modelCallId,
      };
}
