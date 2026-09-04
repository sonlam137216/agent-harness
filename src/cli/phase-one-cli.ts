import { resolve } from 'node:path';

import type { AgentDefinition } from '../agent/agent-definition.js';
import { ContextBuilder } from '../context/context-builder.js';
import type { Sampler } from '../model/sampler.interface.js';
import type { TracingHandle } from '../observability/tracing.js';
import { AgentLoop } from '../runtime/agent-loop.js';
import { SessionRuntime, type SessionRuntimeResult } from '../runtime/session-runtime.js';
import { InMemorySessionStore } from '../session/in-memory-session-store.js';
import { ListFilesTool } from '../tools/builtin/list-files.tool.js';
import { ReadFileTool } from '../tools/builtin/read-file.tool.js';
import { SearchTextTool } from '../tools/builtin/search-text.tool.js';
import { ToolBridge } from '../tools/tool-bridge.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { LocalFileSystemCapability } from '../workspace/local-file-system.js';

const MODEL_ENVIRONMENT_VARIABLE = 'AGENT_HARNESS_MODEL';

export const CLI_HELP = `Usage:
  pnpm cli -- --model <model-id> [--workspace <path>] "<prompt>"

Options:
  --model <model-id>    Model ID stored in AgentDefinition (or AGENT_HARNESS_MODEL)
  --workspace <path>    Read-only workspace root (default: current directory)
  --help                Show this help

Environment:
  OPENAI_API_KEY        Required by the OpenAI sampler
  AGENT_HARNESS_MODEL   Model ID fallback when --model is omitted`;

export interface PhaseOneCliConfig {
  readonly modelId: string;
  readonly prompt: string;
  readonly workspaceRoot: string;
}

export type ParsedPhaseOneCliArguments =
  { readonly help: true } | { readonly help: false; readonly config: PhaseOneCliConfig };

export interface RunPhaseOneCliOptions extends PhaseOneCliConfig {
  readonly sampler: Sampler;
  readonly tracer: TracingHandle['tracer'];
  readonly writeOutput: (text: string) => void;
  readonly signal?: AbortSignal;
}

export class CliUsageError extends Error {
  public override readonly name = 'CliUsageError';
}

export class CliRunError extends Error {
  public override readonly name = 'CliRunError';

  public constructor(public readonly outcome: SessionRuntimeResult['outcome']) {
    super(`The turn ended with outcome "${outcome}" and no final answer.`);
  }
}

function optionValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError(`${option} requires a value.`);
  }
  return value;
}

export function parsePhaseOneCliArguments(
  arguments_: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  currentDirectory: string,
): ParsedPhaseOneCliArguments {
  if (arguments_.includes('--help')) return { help: true };

  let modelId = environment[MODEL_ENVIRONMENT_VARIABLE]?.trim();
  let workspace = currentDirectory;
  const promptParts: string[] = [];

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') {
      // pnpm forwards its argument separator to this script.
      continue;
    }
    if (argument === '--model') {
      modelId = optionValue(arguments_, index, '--model').trim();
      index += 1;
      continue;
    }
    if (argument === '--workspace') {
      workspace = optionValue(arguments_, index, '--workspace');
      index += 1;
      continue;
    }
    if (argument?.startsWith('-') === true) {
      throw new CliUsageError(`Unknown option: ${argument}`);
    }
    if (argument !== undefined) promptParts.push(argument);
  }

  if (modelId === undefined || modelId.length === 0) {
    throw new CliUsageError(`Provide --model or ${MODEL_ENVIRONMENT_VARIABLE}.`);
  }

  const prompt = promptParts.join(' ').trim();
  if (prompt.length === 0) throw new CliUsageError('Provide a non-empty user prompt.');

  return {
    help: false,
    config: {
      modelId,
      prompt,
      workspaceRoot: resolve(currentDirectory, workspace),
    },
  };
}

export async function runPhaseOneCli(
  options: RunPhaseOneCliOptions,
): Promise<SessionRuntimeResult> {
  const fileSystem = new LocalFileSystemCapability({
    workspaceRoot: options.workspaceRoot,
    tracer: options.tracer,
  });
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool(fileSystem));
  registry.register(new ListFilesTool(fileSystem));
  registry.register(new SearchTextTool(fileSystem));

  const toolBridge = new ToolBridge(registry, options.tracer);
  const agentLoop = new AgentLoop({
    sampler: options.sampler,
    contextBuilder: new ContextBuilder(options.tracer),
    toolBridge,
    tracer: options.tracer,
  });
  const runtime = new SessionRuntime({
    sessionStore: new InMemorySessionStore(),
    agentLoop,
    tracer: options.tracer,
  });
  const agent: AgentDefinition = {
    name: 'phase-one-read-only-cli',
    systemPrompt:
      'You are a read-only coding assistant. Use the available tools when workspace evidence is needed. Tool paths are relative to the workspace root. Do not claim to modify files.',
    model: { modelId: options.modelId },
  };

  const result = await runtime.run({
    agent,
    prompt: options.prompt,
    tools: registry.getModelDefinitions(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.finalText === null) throw new CliRunError(result.outcome);

  options.writeOutput(result.finalText);
  return result;
}
