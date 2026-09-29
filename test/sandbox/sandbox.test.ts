import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parsePhaseOneCliArguments, runPhaseOneCli } from '../../src/cli/phase-one-cli.js';
import { createWorktreeManager } from '../../src/cli/worktree-cli.js';
import { createToolCallId } from '../../src/ids.js';
import type { JsonObject } from '../../src/json.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import type { ModelRequest, ModelResponse } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import type { ToolResult } from '../../src/session/turn.js';
import { RunCommandTool } from '../../src/tools/builtin/run-command.tool.js';
import type { CommandResult } from '../../src/workspace/command-capability.js';
import {
  checkCommand,
  DEFAULT_SANDBOX_COMMANDS,
  sandboxEnvironment,
  validateSandboxPolicy,
  type SandboxPolicy,
} from '../../src/workspace/sandbox/sandbox-policy.js';
import {
  detectToolchainPaths,
  SeatbeltCommandRunner,
  seatbeltAvailable,
} from '../../src/workspace/sandbox/seatbelt-command-runner.js';
import { seatbeltProfile } from '../../src/workspace/sandbox/seatbelt-profile.js';

const onMac = process.platform === 'darwin' && (await seatbeltAvailable());

function basePolicy(root: string, extra: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    root,
    readPaths: [],
    privatePaths: [],
    protectedPaths: [],
    network: 'deny',
    commands: ['node'],
    environment: { allow: ['PATH'], set: { CI: '1' } },
    defaultTimeoutMs: 20_000,
    maxTimeoutMs: 60_000,
    maxOutputBytes: 4_096,
    ...extra,
  };
}

describe('sandbox policy', () => {
  it('validates paths, commands and limits', () => {
    expect(() => validateSandboxPolicy(basePolicy('/work'))).not.toThrow();
    for (const bad of [
      basePolicy('relative'),
      basePolicy('/'),
      basePolicy('/work', { readPaths: ['/a"b'] }),
      basePolicy('/work', { privatePaths: ['/x/../y'] }),
      basePolicy('/work', { commands: [] }),
      basePolicy('/work', { commands: ['/bin/sh'] }),
      basePolicy('/work', { environment: { allow: ['bad-name'], set: {} } }),
      basePolicy('/work', { defaultTimeoutMs: 10, maxTimeoutMs: 5 }),
      { ...basePolicy('/work'), network: 'allow' } as unknown as SandboxPolicy,
    ])
      expect(() => validateSandboxPolicy(bad)).toThrow();
  });

  it('allows only bare allowlisted command names', () => {
    const policy = basePolicy('/work', { commands: [...DEFAULT_SANDBOX_COMMANDS] });
    expect(() => checkCommand(policy, 'pnpm')).not.toThrow();
    for (const command of ['sh', 'bash', '/usr/bin/node', './node', 'node; rm -rf /', '../node'])
      expect(() => checkCommand(policy, command)).toThrow(/allowed command|bare executable/u);
  });

  it('passes only allowlisted environment variables', () => {
    const environment = sandboxEnvironment(
      basePolicy('/work'),
      { PATH: '/bin', OPENAI_API_KEY: 'sk-secret', AWS_SECRET_ACCESS_KEY: 'x' },
      '/tmp/t',
    );
    expect(environment).toEqual({ PATH: '/bin', CI: '1', HOME: '/tmp/t', TMPDIR: '/tmp/t/' });
  });

  it('renders a deny-by-default profile without network rules', () => {
    const profile = seatbeltProfile(
      basePolicy('/work', { privatePaths: ['/Users/me'], protectedPaths: ['/work/.git'] }),
      '/tmp/t',
    );
    expect(profile).toContain('(deny default)');
    expect(profile).toContain('(deny file-read* (subpath "/Users/me"))');
    expect(profile).toContain('(deny file-write* (subpath "/work/.git"))');
    expect(profile).not.toMatch(/network/u);
    // Private paths are denied before the root and read paths are allowed again.
    expect(profile.indexOf('(deny file-read*')).toBeLessThan(profile.indexOf('(subpath "/work")'));
  });
});

describe.skipIf(!onMac)('Seatbelt command runner', () => {
  let base: string;
  let root: string;
  let outside: string;
  let privateDirectory: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let runner: SeatbeltCommandRunner;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'sandbox-')));
    root = join(base, 'root');
    outside = join(base, 'outside');
    privateDirectory = join(base, 'private');
    await mkdir(join(root, 'sub'), { recursive: true });
    await mkdir(join(root, '.git'));
    await mkdir(outside);
    await mkdir(join(privateDirectory, 'allowed'), { recursive: true });
    await writeFile(join(privateDirectory, 'secret.txt'), 'SECRET');
    await writeFile(join(privateDirectory, 'allowed', 'ok.txt'), 'OK');
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    runner = new SeatbeltCommandRunner({
      tracer: tracing.tracer,
      environment: { PATH: process.env.PATH, OPENAI_API_KEY: 'sk-secret' },
      policy: basePolicy(root, {
        commands: ['node', 'sh'],
        // The real home directory is private too; the detected toolchain is re-allowed.
        privatePaths: [privateDirectory, homedir()],
        readPaths: [
          join(privateDirectory, 'allowed'),
          ...(await detectToolchainPaths(['node', 'sh'], process.env.PATH)),
        ],
        protectedPaths: [join(root, '.git')],
      }),
    });
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(base, { recursive: true, force: true });
  });

  const node = (script: string, extra: Partial<Parameters<typeof runner.run>[0]> = {}) =>
    runner.run({ command: 'node', args: ['-e', script], cwd: '.', ...extra });

  it('runs allowed programs that write inside the root', async () => {
    const result = await node(
      "require('fs').writeFileSync('out.txt','built'); console.log('ok', process.cwd())",
      { cwd: 'sub' },
    );
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.stdout).toContain(`ok ${join(root, 'sub')}`);
    expect(await readFile(join(root, 'sub/out.txt'), 'utf8')).toBe('built');
  });

  it('denies writes outside the root and into protected paths', async () => {
    for (const target of [join(outside, 'x.txt'), join(root, '.git', 'config')]) {
      const result = await node(`require('fs').writeFileSync(${JSON.stringify(target)}, 'x')`);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toMatch(/EPERM|not permitted/u);
      await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('keeps private paths unreadable except explicit read paths', async () => {
    const read = (path: string) =>
      node(`process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)}, 'utf8'))`);
    expect((await read(join(privateDirectory, 'secret.txt'))).exitCode).not.toBe(0);
    expect((await read(join(privateDirectory, 'allowed', 'ok.txt'))).stdout).toBe('OK');
  });

  it('blocks network access and host secrets', async () => {
    const result = await node(
      "const s=require('net').connect(443,'1.1.1.1');s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',e=>console.log('blocked',e.code)); console.log('key', process.env.OPENAI_API_KEY ?? 'absent')",
    );
    expect(result.stdout).toContain('blocked EPERM');
    expect(result.stdout).toContain('key absent');
    expect(result.stdout).not.toContain('CONNECTED');
  });

  it('confines an allowed shell too: shell commands cannot bypass the policy', async () => {
    const target = join(outside, 'shell.txt');
    const result = await runner.run({
      command: 'sh',
      args: [
        '-c',
        `echo x > ${target}; cat ${join(privateDirectory, 'secret.txt')}; echo in-root > inside.txt`,
      ],
      cwd: '.',
    });
    expect(result.stdout).not.toContain('SECRET');
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'inside.txt'), 'utf8')).toBe('in-root\n');
  });

  it('enforces command, cwd, timeout, cancellation and output limits', async () => {
    await expect(runner.run({ command: 'python3', args: [], cwd: '.' })).rejects.toMatchObject({
      code: 'command_not_allowed',
    });
    for (const cwd of ['..', '/tmp', 'missing'])
      await expect(node('1', { cwd })).rejects.toMatchObject({ code: 'invalid_cwd' });
    await expect(node('1', { timeoutMs: 120_000 })).rejects.toMatchObject({
      code: 'invalid_arguments',
    });

    const slow = await node('setTimeout(() => {}, 30_000)', { timeoutMs: 500 });
    expect(slow).toMatchObject({ timedOut: true, exitCode: null, signal: 'SIGKILL' });

    const controller = new AbortController();
    const cancelled = node('setTimeout(() => {}, 30_000)', {});
    setTimeout(() => controller.abort(), 200);
    await expect(
      runner.run(
        { command: 'node', args: ['-e', 'setTimeout(() => {}, 30_000)'], cwd: '.' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    // The unobserved slow run above is still bounded by the default timeout; stop waiting.
    void cancelled.catch(() => undefined);

    const noisy = await node("process.stdout.write('a'.repeat(10000) + 'END')");
    expect(noisy.stdoutTruncated).toBe(true);
    expect(noisy.stdout).toHaveLength(4_096);
    expect(noisy.stdout.endsWith('END')).toBe(true);

    await tracing.forceFlush();
    const spans = exporter
      .getFinishedSpans()
      .filter((span) => span.attributes.operation === 'sandbox.command');
    expect(spans.some((span) => span.attributes['command.timed_out'] === true)).toBe(true);
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain('setTimeout');
  });

  it('exposes results through run_command without treating non-zero exits as failures', async () => {
    const tool = new RunCommandTool(runner);
    const result = await tool.execute({
      id: createToolCallId(),
      name: 'run_command',
      arguments: { command: 'node', args: ['-e', 'process.exit(3)'] },
    });
    expect(result).toMatchObject({ outcome: 'success', output: { exitCode: 3 } });
    const denied = await tool.execute({
      id: createToolCallId(),
      name: 'run_command',
      arguments: { command: 'bash', args: ['-c', 'id'] },
    });
    expect(denied).toMatchObject({
      outcome: 'error',
      output: { error: { code: 'command_not_allowed' } },
    });
  });
});

describe.skipIf(!onMac)('sandboxed implement subagents', () => {
  let base: string;
  let repo: string;
  let worktreeDirectory: string;
  let tracing: TracingHandle;

  beforeEach(async () => {
    base = await realpath(await mkdtemp(join(tmpdir(), 'sandbox-agent-')));
    repo = join(base, 'repo');
    worktreeDirectory = join(base, 'worktrees');
    await mkdir(join(repo, 'node_modules', 'greeting'), { recursive: true });
    await writeFile(join(repo, 'README.md'), 'readme\n');
    await writeFile(
      join(repo, 'node_modules', 'greeting', 'index.js'),
      "module.exports = 'hello from linked dependency';\n",
    );
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', ...args], { cwd: repo });
    git('init', '--quiet');
    git('add', 'README.md');
    git('commit', '--quiet', '-m', 'init');
    tracing = createTracing({ exporter: new InMemorySpanExporter() });
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(base, { recursive: true, force: true });
  });

  function scripted(childCalls: ReturnType<typeof commandCall>[]) {
    const requests = { parent: [] as ModelRequest[], child: [] as ModelRequest[] };
    const sampler: Sampler = {
      sample: (request): Promise<ModelResponse> => {
        const system = request.messages.find((m) => m.role === 'system');
        const isChild = system?.role === 'system' && system.content.includes('Git worktree');
        const list = isChild ? requests.child : requests.parent;
        list.push(request);
        const index = list.length - 1;
        const toolCalls = isChild
          ? index < childCalls.length
            ? [childCalls[index]!]
            : []
          : index === 0
            ? [commandCall('delegate_task', { role: 'implement', task: 'build it' })]
            : [];
        return Promise.resolve({
          modelCallId: request.modelCallId,
          text: toolCalls.length > 0 ? null : 'done',
          toolCalls,
          stopReason: toolCalls.length > 0 ? 'tool_calls' : 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    };
    return { sampler, requests };
  }
  function commandCall(name: string, args: JsonObject) {
    return { id: createToolCallId(), name, arguments: args };
  }
  const node = (script: string) =>
    commandCall('run_command', { command: 'node', args: ['-e', script] });
  function commandOutputs(request: ModelRequest): CommandResult[] {
    return request.messages.flatMap((m) =>
      m.role === 'tool' ? [(JSON.parse(m.content) as { output: CommandResult }).output] : [],
    );
  }

  it('runs commands in the worktree only, with linked dependencies read-only', async () => {
    const { sampler, requests } = scripted([
      node("require('fs').writeFileSync('built.txt', require('greeting'))"),
      node(`require('fs').writeFileSync(${JSON.stringify(join(repo, 'PWNED'))}, 'x')`),
      node("require('fs').writeFileSync('node_modules/greeting/index.js', 'tampered')"),
    ]);
    const result = await runPhaseOneCli({
      modelId: 'fake',
      prompt: 'Build it in a worktree.',
      workspaceRoot: repo,
      userSkillsDirectory: join(base, 'no-skills'),
      sessionStore: new InMemorySessionStore(),
      subagents: {
        worktreeDirectory,
        worktreeLinks: ['node_modules'],
        sandbox: { commands: ['node'] },
      },
      sampler,
      tracer: tracing.tracer,
      writeOutput: () => undefined,
    });

    const [built, escaped, tampered] = commandOutputs(requests.child.at(-1)!);
    expect(built).toMatchObject({ exitCode: 0 });
    expect(escaped!.exitCode).not.toBe(0);
    expect(tampered!.exitCode).not.toBe(0);
    await expect(stat(join(repo, 'PWNED'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(repo, 'node_modules/greeting/index.js'), 'utf8')).toContain(
      'hello from linked dependency',
    );

    // Only the built file is snapshotted; the linked directory is never committed.
    const handoff = (
      result.session.turns[0]!.entries.find((e) => e.kind === 'tool_result') as ToolResult
    ).output as JsonObject;
    expect(handoff).toMatchObject({ worktree: { changes: { files: 1 } } });
    const manager = createWorktreeManager(repo, worktreeDirectory, tracing.tracer);
    const [record] = await manager.list();
    const { patch } = await manager.diff(record!.id);
    expect(patch).toContain('built.txt');
    expect(patch).toContain('+hello from linked dependency');
    expect(patch).not.toContain('node_modules');

    expect(requests.child[0]!.tools.map((tool) => tool.name)).toContain('run_command');
    expect(requests.parent[0]!.tools.map((tool) => tool.name)).not.toContain('run_command');
  });

  it('is not offered without --sandbox and parses its flags', async () => {
    const { sampler, requests } = scripted([]);
    await runPhaseOneCli({
      modelId: 'fake',
      prompt: 'x',
      workspaceRoot: repo,
      userSkillsDirectory: join(base, 'no-skills'),
      subagents: { worktreeDirectory },
      sampler,
      tracer: tracing.tracer,
      writeOutput: () => undefined,
    });
    expect(requests.child[0]!.tools.map((tool) => tool.name)).not.toContain('run_command');

    expect(
      parsePhaseOneCliArguments(
        [
          '--model',
          'm',
          '--subagents',
          '--worktrees',
          '--sandbox',
          '--sandbox-command',
          'cargo',
          '--worktree-link',
          'node_modules',
          'hi',
        ],
        {},
        base,
      ),
    ).toMatchObject({
      config: {
        subagents: {
          worktreeLinks: ['node_modules'],
          sandbox: { commands: [...DEFAULT_SANDBOX_COMMANDS, 'cargo'] },
        },
      },
    });
    for (const args of [
      ['--subagents', '--sandbox'],
      ['--subagents', '--worktrees', '--sandbox-command', 'x'],
      ['--subagents', '--worktrees', '--sandbox', '--sandbox-command', '/bin/sh'],
      ['--subagents', '--worktrees', '--worktree-link', '../x'],
      ['--subagents', '--worktrees', '--worktree-link', '.git'],
    ])
      expect(() => parsePhaseOneCliArguments(['--model', 'm', ...args, 'hi'], {}, base)).toThrow();
  });
});
