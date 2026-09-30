import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createToolCallId } from '../../src/ids.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { SearchTextTool } from '../../src/tools/builtin/search-text.tool.js';
import { LocalFileSystemCapability } from '../../src/workspace/local-file-system.js';
import {
  detectToolchainPaths,
  SeatbeltCommandRunner,
  seatbeltAvailable,
} from '../../src/workspace/sandbox/seatbelt-command-runner.js';
import { isSensitivePath, sensitiveSeatbeltRules } from '../../src/workspace/sensitive-paths.js';

const onMac = process.platform === 'darwin' && (await seatbeltAvailable());

describe('sensitive paths', () => {
  it.each([
    '.env',
    'apps/api/.env.local',
    '.env.production',
    'certs/server.pem',
    'deploy/tls.key',
    'id_ed25519',
    '.npmrc',
    'home/.ssh/config',
    '.aws/credentials',
  ])('hides %s', (path) => expect(isSensitivePath(path)).toBe(true));

  it.each([
    '.env.example',
    'config/.env.sample',
    'src/env.ts',
    'id_rsa.pub',
    'keys.ts',
    'docs/pem.md',
    'environment/.envrc.md',
    '.',
  ])('keeps %s visible', (path) => expect(isSensitivePath(path)).toBe(false));

  it('builds Seatbelt rules with an escaped root', () => {
    const rules = sensitiveSeatbeltRules('/tmp/a.b (1)/');
    expect(rules[0]).toContain('^/tmp/a\\.b \\(1\\)/(.*/)?(\\.env|');
    expect(rules[1]).toMatch(/^\(allow file-read-data \(regex #"/u);
  });
});

describe('hidden credential files', () => {
  let root: string;
  let tracing: TracingHandle;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'sensitive-')));
    await mkdir(join(root, 'app'));
    await writeFile(join(root, '.env'), 'TOKEN=secret-value\n');
    await writeFile(join(root, '.env.example'), 'TOKEN=\n');
    await writeFile(join(root, 'app', 'main.ts'), 'const token = process.env.TOKEN;\n');
    await symlink(join(root, '.env'), join(root, 'app', 'settings.txt'));
    tracing = createTracing({ exporter: new InMemorySpanExporter() });
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  function files(hideSensitiveFiles: boolean): LocalFileSystemCapability {
    return new LocalFileSystemCapability({
      workspaceRoot: root,
      tracer: tracing.tracer,
      hideSensitiveFiles,
    });
  }

  it('omits them from listings and refuses direct or symlinked reads', async () => {
    const hidden = files(true);
    expect((await hidden.listDirectory('.')).map((entry) => entry.name)).toEqual([
      '.env.example',
      'app',
    ]);
    await expect(hidden.readFile('.env')).rejects.toMatchObject({ code: 'protected_path' });
    await expect(hidden.readFile('app/settings.txt')).rejects.toMatchObject({
      code: 'protected_path',
    });
    await expect(hidden.readFile('.env.example')).resolves.toMatchObject({ content: 'TOKEN=\n' });
    await expect(files(false).readFile('.env')).resolves.toMatchObject({
      content: 'TOKEN=secret-value\n',
    });
  });

  it('keeps search working while never returning their content', async () => {
    const result = await new SearchTextTool(files(true)).execute({
      id: createToolCallId(),
      name: 'search_text',
      arguments: { query: 'TOKEN' },
    });
    expect(result.outcome).toBe('success');
    expect(JSON.stringify(result.output)).not.toContain('secret-value');
    expect(JSON.stringify(result.output)).toContain('app/main.ts');
  });

  it.skipIf(!onMac)(
    'makes them unreadable to sandboxed commands',
    async () => {
      const runner = new SeatbeltCommandRunner({
        tracer: tracing.tracer,
        environment: { PATH: process.env.PATH },
        policy: {
          root,
          readPaths: await detectToolchainPaths(['node'], process.env.PATH),
          privatePaths: [homedir()],
          protectedPaths: [],
          hideSensitiveFiles: true,
          network: 'deny',
          commands: ['node'],
          environment: { allow: ['PATH'], set: {} },
          defaultTimeoutMs: 20_000,
          maxTimeoutMs: 60_000,
          maxOutputBytes: 4_096,
        },
      });
      const read = async (path: string): Promise<string> =>
        (
          await runner.run({
            command: 'node',
            args: [
              '-e',
              `try{process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)},'utf8'))}catch(e){process.stdout.write(e.code)}`,
            ],
            cwd: '.',
          })
        ).stdout;

      expect(await read('.env')).toBe('EPERM');
      expect(await read('app/settings.txt')).toBe('EPERM');
      expect(await read('.env.example')).toBe('TOKEN=\n');
      expect(await read('app/main.ts')).toContain('process.env.TOKEN');
    },
    30_000,
  );
});
