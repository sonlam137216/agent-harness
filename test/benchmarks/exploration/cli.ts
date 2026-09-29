import { resolve } from 'node:path';
import { validateBudget } from '../../../src/context/context-budget.js';
import { isModelProvider, type ModelProvider } from '../../../src/model/create-sampler.js';
import { explorationTasks } from './tasks.js';

export const BENCHMARK_HELP = `Exploration benchmark (scripted by default; no credentials needed)
  pnpm benchmark:exploration -- [options]
  node dist/test/benchmarks/exploration/main.js [options]

  --live                 Use an actual model (requires --provider and --model)
  --provider <name>       openai / anthropic / ollama; only with --live
  --model <id>            Explicit live model ID
  --repository <path>     Source repository (default: current directory)
  --task <id>             Run one task; otherwise run all ten
  --repeats <n>           1–10 (default: 1)
  --context-window <n>    Estimate budget (default: 131072)
  --output-reserve <n>    Output limit (default: 4096)
  --timeout-ms <n>        Per-task deadline, 1–600000 (default: 120000)
  --include-answers      Include generated text for human review
  --code-retrieval       Enable lexical retrieval over fixture src and test roots
  --retrieval-tokens <n>  Optional excerpt cap (default: 4096; requires --code-retrieval)
  --output <path>        Write JSON to a NEW file; otherwise stdout
  --help                 Show help

Live mode uses the existing provider environment variables. Expected evidence and
rubrics are not sent to the model. Scripted results do not measure answer quality.`;

export function parseBenchmarkArguments(args: readonly string[], cwd: string) {
  const flags = new Set(['--live', '--include-answers', '--help', '--code-retrieval']);
  const values = new Set([
    '--provider',
    '--model',
    '--repository',
    '--task',
    '--repeats',
    '--context-window',
    '--output-reserve',
    '--timeout-ms',
    '--output',
    '--retrieval-tokens',
  ]);
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (key === '--' && index === 0) continue;
    if (options.has(key)) throw new Error('Duplicate benchmark option.');
    if (flags.has(key)) options.set(key, 'true');
    else if (values.has(key)) {
      const value = args[++index];
      if (value === undefined || value.trim() === '' || value.startsWith('--'))
        throw new Error('Benchmark option requires a value.');
      options.set(key, value);
    } else throw new Error('Unknown benchmark option. Use --help.');
  }
  const integer = (key: string, fallback: number, max = 1_000_000) => {
    const value = options.get(key) ?? String(fallback);
    const number = Number(value);
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max)
      throw new Error('Benchmark numeric option is out of range.');
    return number;
  };
  const live = options.has('--live');
  const provider = options.get('--provider');
  const modelId = options.get('--model');
  if (live && (provider === undefined || !isModelProvider(provider) || modelId === undefined))
    throw new Error('Live mode requires an explicit supported --provider and --model.');
  if (!live && (provider !== undefined || modelId !== undefined))
    throw new Error('Provider/model options require --live.');
  const task = options.get('--task');
  if (task !== undefined && !explorationTasks.some((item) => item.id === task))
    throw new Error('Unknown benchmark task.');
  const contextBudget = {
    windowTokens: integer('--context-window', 131_072),
    outputReserveTokens: integer('--output-reserve', 4_096),
  };
  validateBudget(contextBudget);
  if (options.has('--retrieval-tokens') && !options.has('--code-retrieval'))
    throw new Error('--retrieval-tokens requires --code-retrieval.');
  return {
    ...(options.has('--code-retrieval')
      ? { retrieval: { roots: ['src', 'test'], maxTokens: integer('--retrieval-tokens', 4096) } }
      : {}),
    help: options.has('--help'),
    mode: live ? ('live' as const) : ('scripted' as const),
    provider: provider as ModelProvider | undefined,
    modelId: modelId ?? 'scripted-exploration-v1',
    repositoryRoot: resolve(cwd, options.get('--repository') ?? '.'),
    task,
    repeats: integer('--repeats', 1, 10),
    timeoutMs: integer('--timeout-ms', 120_000, 600_000),
    contextBudget,
    includeAnswers: options.has('--include-answers'),
    output: options.has('--output') ? resolve(cwd, options.get('--output')!) : undefined,
  };
}
