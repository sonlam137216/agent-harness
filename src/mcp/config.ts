import type { FileSystemCapability } from '../workspace/filesystem-capability.js';
import type { ProcessSpecification } from '../workspace/duplex-process.js';

export type McpServerConfig = { readonly alias: string } & (
  | { readonly transport: 'stdio'; readonly process: ProcessSpecification }
  | {
      readonly transport: 'http';
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }
);
export class McpError extends Error {
  override readonly name = 'McpError';
  constructor(
    readonly code: string,
    message = 'The MCP operation failed.',
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export async function loadMcpConfig(
  files: FileSystemCapability,
  path: string,
  environment: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<readonly McpServerConfig[]> {
  try {
    const raw: unknown = JSON.parse((await files.readFile(path, signal ? { signal } : {})).content);
    if (
      !object(raw) ||
      Object.keys(raw).some((k) => k !== 'servers') ||
      !Array.isArray(raw.servers) ||
      raw.servers.length > 16
    )
      throw new Error();
    const aliases = new Set<string>();
    return raw.servers.map((server: unknown): McpServerConfig => {
      if (
        !object(server) ||
        typeof server.alias !== 'string' ||
        !/^[a-z][a-z0-9-]{0,31}$/u.test(server.alias) ||
        aliases.has(server.alias)
      )
        throw new Error();
      aliases.add(server.alias);
      const alias = server.alias;
      const strings = (value: unknown): string[] => {
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || v.includes('\0')))
          throw new Error();
        return value as string[];
      };
      const selectEnv = (names: string[]): Record<string, string> =>
        Object.fromEntries(
          names.map((name) => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || environment[name] === undefined)
              throw new Error();
            return [name, environment[name]];
          }),
        );
      if (server.transport === 'stdio') {
        if (
          Object.keys(server).some(
            (k) => !['alias', 'transport', 'command', 'args', 'cwd', 'env'].includes(k),
          ) ||
          typeof server.command !== 'string' ||
          !server.command ||
          server.command.includes('\0') ||
          (server.cwd !== undefined && typeof server.cwd !== 'string')
        )
          throw new Error();
        return {
          alias,
          transport: 'stdio',
          process: {
            command: server.command,
            args: strings(server.args ?? []),
            cwd: server.cwd ?? '.',
            environment: selectEnv(strings(server.env ?? [])),
          },
        };
      }
      if (server.transport === 'http') {
        if (
          Object.keys(server).some(
            (k) => !['alias', 'transport', 'url', 'headersFromEnv'].includes(k),
          ) ||
          typeof server.url !== 'string'
        )
          throw new Error();
        const url = new URL(server.url);
        if (
          url.username ||
          url.password ||
          url.hash ||
          !(
            url.protocol === 'https:' ||
            (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
          )
        )
          throw new Error();
        const mapping = server.headersFromEnv ?? {};
        if (!object(mapping)) throw new Error();
        const headers: Record<string, string> = {};
        for (const [key, name] of Object.entries(mapping)) {
          if (
            typeof name !== 'string' ||
            !/^[a-zA-Z0-9-]+$/u.test(key) ||
            ['host', 'content-length', 'content-type'].includes(key.toLowerCase()) ||
            key.toLowerCase().startsWith('mcp-')
          )
            throw new Error();
          const value = selectEnv([name])[name]!;
          if (/[\r\n]/u.test(value)) throw new Error();
          headers[key] = value;
        }
        return { alias, transport: 'http', url: url.href, headers };
      }
      throw new Error();
    });
  } catch {
    if (signal?.aborted) throw new DOMException('Cancelled.', 'AbortError');
    throw new McpError(
      'configuration',
      'Invalid MCP configuration or unavailable environment variable.',
    );
  }
}
