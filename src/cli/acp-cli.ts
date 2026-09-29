import type { Readable, Writable } from 'node:stream';

import type { ModelProvider } from '../model/create-sampler.js';
import type { Sampler } from '../model/sampler.interface.js';
import type { TracingHandle } from '../observability/tracing.js';
import { AcpAgent, type AcpPromptRunner } from '../protocol/acp-agent.js';
import { JsonRpcConnection } from '../protocol/json-rpc.js';
import type { SessionStore } from '../session/session-store.js';
import { DEFAULT_CONTEXT_BUDGET } from '../context/context-budget.js';
import { safeErrorMessage } from './errors.js';
import {
  CliRunError,
  CliUsageError,
  parsePhaseOneCliArguments,
  runPhaseOneCli,
  type PhaseOneCliConfig,
} from './phase-one-cli.js';

export interface AcpServerOptions {
  /** Run options after `acp` (provider, model, memory, subagents, permissions, …). */
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly sessionStore: SessionStore;
  readonly createSampler: (provider: ModelProvider) => Sampler;
  readonly tracer: TracingHandle['tracer'];
  readonly input: Readable;
  readonly output: Writable;
  /** Diagnostics; never the protocol stream. */
  readonly diagnostics: (message: string) => void;
  readonly version?: string;
}

/**
 * Each ACP prompt runs through the same composition as the one-shot CLI (`runPhaseOneCli`),
 * so tools, context, permissions, persistence and tracing are identical. Only approval
 * (a protocol round trip) and output (streamed updates) differ.
 */
export function createAcpPromptRunner(
  config: PhaseOneCliConfig,
  provider: ModelProvider,
  sampler: Sampler,
  sessionStore: SessionStore,
  tracer: TracingHandle['tracer'],
  environment: Readonly<Record<string, string | undefined>>,
): AcpPromptRunner {
  return {
    run: async (input) => {
      try {
        const result = await runPhaseOneCli({
          ...config,
          // Interactive clients approve each call unless the server was started otherwise.
          permissionMode: config.permissionMode ?? 'ask',
          prompt: input.prompt,
          workspaceRoot: input.workspaceRoot,
          environment,
          sessionStore,
          sessionId: input.sessionId,
          ...(input.savedAgent === undefined ? {} : { savedAgent: input.savedAgent }),
          provider,
          events: input.events,
          approve: input.approve,
          sampler,
          tracer,
          signal: input.signal,
          writeOutput: () => undefined,
        });
        return { outcome: result.outcome };
      } catch (error) {
        if (error instanceof CliRunError) return { outcome: error.outcome };
        throw error;
      }
    },
  };
}

/** Serves ACP on the given streams until the client closes its end. */
export async function runAcpServer(options: AcpServerOptions): Promise<void> {
  const parsed = parsePhaseOneCliArguments(options.arguments, options.environment, options.cwd, {
    requirePrompt: false,
  });
  if (parsed.help) throw new CliUsageError('Use --help without acp for the option list.');
  const { config, provider } = parsed;
  if (config.skillNames !== undefined)
    throw new CliUsageError('--skill is per prompt; write $skill-name in the prompt instead.');
  const agent = new AcpAgent({
    sessionStore: options.sessionStore,
    runner: createAcpPromptRunner(
      config,
      provider,
      options.createSampler(provider),
      options.sessionStore,
      options.tracer,
      options.environment,
    ),
    tracer: options.tracer,
    defaults: {
      modelId: config.modelId,
      provider,
      contextBudget: config.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
      rulesDirectory: config.rulesDirectory ?? '.',
    },
    agentInfo: { name: 'agent-harness', version: options.version ?? '0.0.0' },
    describeError: safeErrorMessage,
    warn: options.diagnostics,
  });
  const connection = new JsonRpcConnection(options.input, options.output, agent);
  agent.attach(connection);
  await connection.start();
  // The client is gone: cancel running prompts, then let them persist their final state.
  agent.cancelAll();
  await connection.drain();
}
