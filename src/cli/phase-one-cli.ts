import { resolve } from 'node:path';

import type { AgentDefinition } from '../agent/agent-definition.js';
import { ContextBuilder } from '../context/context-builder.js';
import {
  DEFAULT_CONTEXT_BUDGET,
  validateBudget,
  type ContextBudget,
} from '../context/context-budget.js';
import type { Sampler } from '../model/sampler.interface.js';
import { isModelProvider, MODEL_PROVIDERS, type ModelProvider } from '../model/create-sampler.js';
import type { TracingHandle } from '../observability/tracing.js';
import { ProjectRulesSource } from '../project-rules/project-rules-source.js';
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
const PROVIDER_ENVIRONMENT_VARIABLE = 'AGENT_HARNESS_PROVIDER';

export const CLI_HELP = `Usage:
  pnpm cli -- --provider <provider> --model <model-id> [--workspace <path>] "<prompt>"

Options:
  --provider <provider> Provider adapter: ${MODEL_PROVIDERS.join(', ')} (default: openai)
  --model <model-id>    Model ID stored in AgentDefinition (or AGENT_HARNESS_MODEL)
  --workspace <path>    Read-only workspace root (default: current directory)
  --context-window <n>  Context window estimate (default: 32768; configure for your model)
  --output-reserve <n>  Maximum output tokens reserved (default: 4096)
  --rules-directory <p> Workspace-relative directory for AGENTS.md scope (default: .)
  --help                Show this help

Environment:
  AGENT_HARNESS_PROVIDER Provider fallback when --provider is omitted
  AGENT_HARNESS_MODEL    Model ID fallback when --model is omitted
  OPENAI_API_KEY         Required by the OpenAI sampler
  OPENAI_BASE_URL        Optional OpenAI API base URL
  ANTHROPIC_API_KEY      Required by the Anthropic sampler
  ANTHROPIC_BASE_URL     Optional Anthropic API base URL
  OLLAMA_BASE_URL        Ollama base URL (default: http://localhost:11434)`;

export interface PhaseOneCliConfig {
  readonly modelId: string;
  readonly prompt: string;
  readonly workspaceRoot: string;
  readonly contextBudget?: ContextBudget;
  readonly rulesDirectory?: string;
}

export type ParsedPhaseOneCliArguments =
  | { readonly help: true }
  | {
      readonly help: false;
      readonly provider: ModelProvider;
      readonly config: PhaseOneCliConfig;
    };

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

  let provider = environment[PROVIDER_ENVIRONMENT_VARIABLE]?.trim() ?? 'openai';
  let modelId = environment[MODEL_ENVIRONMENT_VARIABLE]?.trim();

  let windowTokens = DEFAULT_CONTEXT_BUDGET.windowTokens;
  let outputReserveTokens = DEFAULT_CONTEXT_BUDGET.outputReserveTokens;
  let budgetProvided = false;
  let rulesDirectory: string | undefined;
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
    if (argument === '--provider') {
      provider = optionValue(arguments_, index, '--provider').trim();
      index += 1;
      continue;
    }
    if (argument === '--workspace') {
      workspace = optionValue(arguments_, index, '--workspace');
      index += 1;
      continue;
    }
    if (argument === '--context-window' || argument === '--output-reserve') {
      const value = optionValue(arguments_, index, argument);
      if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value)))
        throw new CliUsageError(`${argument} requires a positive integer.`);
      if (argument === '--context-window') windowTokens = Number(value);
      else outputReserveTokens = Number(value);
      budgetProvided = true;
      index += 1;
      continue;
    }
    if (argument === '--rules-directory') {
      rulesDirectory = optionValue(arguments_, index, argument);
      if (
        rulesDirectory === '' ||
        rulesDirectory.startsWith('/') ||
        /[\\:\0]/u.test(rulesDirectory) ||
        rulesDirectory.split('/').includes('..')
      )
        throw new CliUsageError('--rules-directory must stay within the workspace.');
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
  if (!isModelProvider(provider)) {
    throw new CliUsageError(
      `Unknown provider "${provider}". Choose one of: ${MODEL_PROVIDERS.join(', ')}.`,
    );
  }

  const prompt = promptParts.join(' ').trim();
  if (prompt.length === 0) throw new CliUsageError('Provide a non-empty user prompt.');
  try {
    validateBudget({ windowTokens, outputReserveTokens });
  } catch {
    throw new CliUsageError('The context window must exceed the positive output reserve.');
  }

  return {
    help: false,
    provider,
    config: {
      modelId,
      prompt,
      workspaceRoot: resolve(currentDirectory, workspace),
      ...(budgetProvided ? { contextBudget: { windowTokens, outputReserveTokens } } : {}),
      ...(rulesDirectory === undefined ? {} : { rulesDirectory }),
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
    contextBuilder: new ContextBuilder(options.tracer, {
      ...(options.contextBudget === undefined ? {} : { budget: options.contextBudget }),
      sampler: options.sampler,
      additionalSources: [
        new ProjectRulesSource(fileSystem, options.tracer, {
          ...(options.rulesDirectory === undefined ? {} : { directory: options.rulesDirectory }),
        }),
      ],
    }),
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
