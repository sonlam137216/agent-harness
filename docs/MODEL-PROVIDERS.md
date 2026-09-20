# Model Providers

The runtime depends only on the provider-neutral `Sampler` interface. The CLI composition root
selects one concrete adapter with `--provider` (or `AGENT_HARNESS_PROVIDER`) and passes the model
ID through `AgentDefinition` unchanged.

Supported providers:

| Provider | Adapter | Credential | Default endpoint |
| --- | --- | --- | --- |
| `ollama` | Ollama Chat API | none | `http://localhost:11434/api/chat` |
| `openai` | OpenAI Responses API | `OPENAI_API_KEY` | `https://api.openai.com/v1/responses` |
| `anthropic` | Anthropic Messages API | `ANTHROPIC_API_KEY` | `https://api.anthropic.com/v1/messages` |

## Ollama (local)

Start Ollama and make sure the model is available, then run:

```sh
pnpm cli -- --provider ollama --model qwen3:1.7b \
  "Say hello and tell me your model name."
```

To use a different Ollama server:

```sh
OLLAMA_BASE_URL=http://localhost:11434 \
pnpm cli -- --provider ollama --model qwen3:1.7b "Inspect package.json."
```

The adapter uses non-streaming `/api/chat`, maps native tool definitions and tool results, and
normalizes Ollama token counts and stop reasons into the shared sampler contract.

## OpenAI

```sh
OPENAI_API_KEY=... \
pnpm cli -- --provider openai --model gpt-5.1 "Inspect package.json."
```

`OPENAI_BASE_URL` can override the default API base URL. It should be the API root (normally ending
in `/v1`), not the `/responses` route itself.

## Anthropic / Claude

```sh
ANTHROPIC_API_KEY=... \
pnpm cli -- --provider anthropic --model claude-sonnet-4-5 \
  "Inspect package.json."
```

`ANTHROPIC_BASE_URL` can override the default API base URL. It should be the API root (normally
ending in `/v1`), not the `/messages` route itself.

## Environment-only selection

The flags have environment equivalents, which is useful for a stable local setup:

```sh
AGENT_HARNESS_PROVIDER=ollama \
AGENT_HARNESS_MODEL=qwen3:1.7b \
pnpm cli -- "List the TypeScript source files."
```

Provider selection is deliberately not stored in `AgentDefinition`: the definition requests a
model ID, while the application composition root decides which `Sampler` resolves that ID.
