import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CliRunError,
  CliUsageError,
  DEFAULT_CLI_MAX_ITERATIONS,
  parsePhaseOneCliArguments,
  runPhaseOneCli,
} from '../../src/cli/phase-one-cli.js';
import { createToolCallId } from '../../src/ids.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import type { ModelRequest, ModelResponse } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import type { PermissionRequest } from '../../src/permissions/permission-engine.js';
import { DEFAULT_SANDBOX_COMMANDS } from '../../src/workspace/sandbox/sandbox-policy.js';
import { seatbeltAvailable } from '../../src/workspace/sandbox/seatbelt-command-runner.js';

const onMac = process.platform === 'darwin' && (await seatbeltAvailable());

function toolCall(
  request: ModelRequest,
  name: string,
  arguments_: ModelResponse['toolCalls'][number]['arguments'],
): ModelResponse {
  return {
    modelCallId: request.modelCallId,
    text: null,
    toolCalls: [{ id: createToolCallId(), name, arguments: arguments_ }],
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: 'tool_calls',
  };
}

function answer(request: ModelRequest, text: string): ModelResponse {
  return {
    modelCallId: request.modelCallId,
    text,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: 'end_turn',
  };
}

describe('Phase 13 practical CLI', () => {
  const directories: string[] = [];
  const tracings: TracingHandle[] = [];

  afterEach(async () => {
    await Promise.all(tracings.splice(0).map((tracing) => tracing.shutdown()));
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function workspace(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'practical-cli-'));
    directories.push(directory);
    await writeFile(join(directory, 'app.ts'), 'export const answer = 41;\n');
    return directory;
  }

  function tracer(): TracingHandle['tracer'] {
    const tracing = createTracing({ exporter: new InMemorySpanExporter() });
    tracings.push(tracing);
    return tracing.tracer;
  }

  it('parses --edit, --commands and --max-iterations', () => {
    const parsed = parsePhaseOneCliArguments(
      [
        '--model',
        'fake',
        '--edit',
        '--commands',
        '--sandbox-command',
        'cargo',
        '--max-iterations',
        '40',
        'fix it',
      ],
      {},
      '/workspace',
    );
    expect(parsed).toMatchObject({
      config: {
        edit: true,
        commands: { commands: [...DEFAULT_SANDBOX_COMMANDS, 'cargo'] },
        maxIterations: 40,
      },
    });
    for (const value of ['0', '201', '1.5', 'many'])
      expect(() =>
        parsePhaseOneCliArguments(
          ['--model', 'fake', '--max-iterations', value, 'x'],
          {},
          '/workspace',
        ),
      ).toThrow(CliUsageError);
    expect(() =>
      parsePhaseOneCliArguments(
        ['--model', 'fake', '--sandbox-command', 'cargo', 'x'],
        {},
        '/workspace',
      ),
    ).toThrow('--sandbox-command requires --sandbox or --commands.');
  });

  it.each([true, false])(
    'edits the main tree only after approval (approved=%s)',
    async (approved) => {
      const root = await workspace();
      const approve = vi.fn((request: PermissionRequest) => {
        expect(request).toMatchObject({ accessKind: 'write', call: { name: 'edit_file' } });
        return approved;
      });
      const requests: ModelRequest[] = [];
      const sampler: Sampler = {
        sample: (request) => {
          requests.push(request);
          if (requests.length === 1)
            return Promise.resolve(
              toolCall(request, 'edit_file', {
                path: 'app.ts',
                oldText: '41',
                newText: '42',
              }),
            );
          const last = request.messages.at(-1);
          expect(last?.role === 'tool' && last.content).toContain(
            approved ? '"outcome":"success"' : 'access_denied',
          );
          return Promise.resolve(answer(request, 'Done.'));
        },
      };

      await runPhaseOneCli({
        modelId: 'fake',
        prompt: 'Make the answer 42.',
        workspaceRoot: root,
        edit: true,
        approve,
        sampler,
        tracer: tracer(),
        writeOutput: () => undefined,
      });

      expect(approve).toHaveBeenCalledOnce();
      expect(await readFile(join(root, 'app.ts'), 'utf8')).toBe(
        `export const answer = ${approved ? 42 : 41};\n`,
      );
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['write_file', 'edit_file']),
      );
      const system = requests[0]?.messages[0];
      expect(system?.role).toBe('system');
      expect(system?.content).toContain('You can change files');
    },
  );

  it('keeps explicit allow rules and refuses writes into .git', async () => {
    const root = await workspace();
    const approve = vi.fn(() => true);
    let calls = 0;
    const sampler: Sampler = {
      sample: (request) => {
        calls += 1;
        if (calls === 1)
          return Promise.resolve(
            toolCall(request, 'write_file', { path: '.git/hooks/pre-commit', content: 'x' }),
          );
        const last = request.messages.at(-1);
        expect(last?.role === 'tool' && last.content).toContain('protected_path');
        return Promise.resolve(answer(request, 'Refused.'));
      },
    };

    await runPhaseOneCli({
      modelId: 'fake',
      prompt: 'Install a hook.',
      workspaceRoot: root,
      edit: true,
      permissionRules: [{ toolName: 'write_file', decision: 'allow' }],
      approve,
      sampler,
      tracer: tracer(),
      writeOutput: () => undefined,
    });

    expect(approve).not.toHaveBeenCalled();
  });

  it('stays read-only without --edit and uses the larger CLI iteration limit', async () => {
    const root = await workspace();
    let calls = 0;
    const sampler: Sampler = {
      sample: (request) => {
        calls += 1;
        expect(request.tools.map((tool) => tool.name)).not.toContain('edit_file');
        return Promise.resolve(toolCall(request, 'list_files', { path: '.' }));
      },
    };

    await expect(
      runPhaseOneCli({
        modelId: 'fake',
        prompt: 'Loop forever.',
        workspaceRoot: root,
        sampler,
        tracer: tracer(),
        writeOutput: () => undefined,
      }),
    ).rejects.toBeInstanceOf(CliRunError);
    expect(calls).toBe(DEFAULT_CLI_MAX_ITERATIONS);

    calls = 0;
    await expect(
      runPhaseOneCli({
        modelId: 'fake',
        prompt: 'Loop briefly.',
        workspaceRoot: root,
        maxIterations: 3,
        sampler,
        tracer: tracer(),
        writeOutput: () => undefined,
      }),
    ).rejects.toMatchObject({ outcome: 'max_iterations' });
    expect(calls).toBe(3);
  });

  it.skipIf(!onMac)(
    'runs an approved command in the main tree under the sandbox',
    async () => {
      const root = await workspace();
      const approve = vi.fn((request: PermissionRequest) => {
        expect(request).toMatchObject({ accessKind: 'execute', call: { name: 'run_command' } });
        return true;
      });
      const outputs: string[] = [];
      let calls = 0;
      const sampler: Sampler = {
        sample: (request) => {
          calls += 1;
          if (calls === 1)
            return Promise.resolve(
              toolCall(request, 'run_command', {
                command: 'node',
                args: [
                  '-e',
                  "require('fs').writeFileSync('out.txt','ok');" +
                    "try{require('fs').writeFileSync('../escape.txt','x')}catch{}",
                ],
              }),
            );
          const last = request.messages.at(-1);
          if (last?.role === 'tool') outputs.push(last.content);
          return Promise.resolve(answer(request, 'Ran it.'));
        },
      };

      await runPhaseOneCli({
        modelId: 'fake',
        prompt: 'Run node.',
        workspaceRoot: root,
        commands: { commands: ['node'] },
        approve,
        environment: process.env,
        sampler,
        tracer: tracer(),
        writeOutput: () => undefined,
      });

      expect(approve).toHaveBeenCalledOnce();
      expect(outputs[0]).toContain('"exitCode":0');
      expect(await readFile(join(root, 'out.txt'), 'utf8')).toBe('ok');
      await expect(readFile(join(root, '..', 'escape.txt'), 'utf8')).rejects.toThrow();
    },
    30_000,
  );

  it('parses --allow-sensitive-files and --model-timeout', () => {
    expect(
      parsePhaseOneCliArguments(
        ['--model', 'fake', '--allow-sensitive-files', '--model-timeout', '90', 'x'],
        {},
        '/workspace',
      ),
    ).toMatchObject({ config: { allowSensitiveFiles: true, modelTimeoutMs: 90_000 } });
    for (const value of ['0', '3601', 'soon'])
      expect(() =>
        parsePhaseOneCliArguments(
          ['--model', 'fake', '--model-timeout', value, 'x'],
          {},
          '/workspace',
        ),
      ).toThrow(CliUsageError);
  });

  it.each([false, true])(
    'hides .env from the model unless allowed (allowSensitiveFiles=%s)',
    async (allowSensitiveFiles) => {
      const root = await workspace();
      await writeFile(join(root, '.env'), 'API_TOKEN=very-secret\n');
      const results: string[] = [];
      let calls = 0;
      const sampler: Sampler = {
        sample: (request) => {
          calls += 1;
          if (calls === 1) {
            const system = request.messages[0]?.content ?? '';
            expect(system.includes('Credential files')).toBe(!allowSensitiveFiles);
            return Promise.resolve(toolCall(request, 'read_file', { path: '.env' }));
          }
          const last = request.messages.at(-1);
          if (last?.role === 'tool') results.push(last.content);
          return Promise.resolve(answer(request, 'ok'));
        },
      };

      await runPhaseOneCli({
        modelId: 'fake',
        prompt: 'Read the env.',
        workspaceRoot: root,
        ...(allowSensitiveFiles ? { allowSensitiveFiles } : {}),
        sampler,
        tracer: tracer(),
        writeOutput: () => undefined,
      });

      if (allowSensitiveFiles) expect(results[0]).toContain('very-secret');
      else {
        expect(results[0]).toContain('protected_path');
        expect(results[0]).not.toContain('very-secret');
      }
    },
  );
});
