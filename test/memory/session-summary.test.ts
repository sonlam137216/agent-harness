import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSessionSummaryCommand } from '../../src/cli/memory-cli.js';
import { createMemoryWriter } from '../../src/cli/phase-one-cli.js';
import { parseSessionCommand } from '../../src/cli/session-cli.js';
import {
  createModelCallId,
  createSessionId,
  createToolCallId,
  createTurnId,
} from '../../src/ids.js';
import { normalizeSummary, SessionSummarizer } from '../../src/memory/session-summarizer.js';
import type { Sampler } from '../../src/model/sampler.interface.js';
import type { ModelRequest } from '../../src/model/sampling-types.js';
import { createTracing, type TracingHandle } from '../../src/observability/tracing.js';
import { InMemorySessionStore } from '../../src/session/in-memory-session-store.js';
import type { Session } from '../../src/session/session.js';
import type { Turn } from '../../src/session/turn.js';

const turn = (
  prompt: string,
  answer: string,
  status: Turn['status'] = 'completed',
  toolOutput?: string,
): Turn => {
  const callId = createToolCallId();
  return {
    id: createTurnId(),
    status,
    entries: [
      { kind: 'user_message', content: prompt },
      ...(toolOutput === undefined
        ? []
        : [
            {
              kind: 'assistant_message' as const,
              modelCallId: createModelCallId(),
              content: null,
              toolCalls: [{ id: callId, name: 'read_file', arguments: { path: 'a.ts' } }],
            },
            {
              kind: 'tool_result' as const,
              toolCallId: callId,
              outcome: 'success' as const,
              output: toolOutput,
            },
          ]),
      {
        kind: 'assistant_message',
        modelCallId: createModelCallId(),
        content: answer,
        toolCalls: [],
      },
    ],
  };
};

describe('session summaries', () => {
  let root: string;
  let tracing: TracingHandle;
  let exporter: InMemorySpanExporter;
  let requests: ModelRequest[];
  let reply: string | null;
  const sampler: Sampler = {
    sample: (request) => {
      requests.push(request);
      return Promise.resolve({
        modelCallId: request.modelCallId,
        text: reply,
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 10, outputTokens: 5 },
      });
    },
  };
  const session = (turns: Turn[]): Session => ({
    id: createSessionId(),
    turns,
    metadata: {
      createdAt: '2026-09-29T00:00:00.000Z',
      updatedAt: '2026-09-29T00:00:00.000Z',
      agent: { name: 'cli', systemPrompt: 'x', model: { modelId: 'saved-model' } },
      provider: 'ollama',
      workspaceRoot: root,
    },
  });
  const summarizer = () =>
    new SessionSummarizer(
      sampler,
      createMemoryWriter(root, join(root, 'user-memory'), tracing.tracer),
      tracing.tracer,
    );
  const sessionsFile = () => readFile(join(root, '.agents/memory/sessions.md'), 'utf8');

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'session-summary-'));
    exporter = new InMemorySpanExporter();
    tracing = createTracing({ exporter });
    requests = [];
    reply = '- Chose versioned JSON session files over SQLite.\n- Follow-up: add FTS later.';
  });
  afterEach(async () => {
    await tracing.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  it('normalizes headings and recognizes an explicit NONE', () => {
    expect(normalizeSummary('none')).toBeNull();
    expect(normalizeSummary(' NONE. ')).toBeNull();
    expect(normalizeSummary('# Top\n## Decisions\n### Kept\n- a')).toBe(
      '### Top\n### Decisions\n### Kept\n- a',
    );
  });

  it('summarizes completed turns without tool outputs and records provenance', async () => {
    const saved = session([
      turn('How should sessions be stored?', 'Use JSON files.', 'completed', 'SECRET tool output'),
      turn('Half-finished request', 'partial', 'failed'),
      turn('Confirm the storage decision.', 'Confirmed: JSON.'),
    ]);
    const result = await summarizer().summarize({
      session: saved,
      modelId: 'saved-model',
      scope: 'workspace',
    });
    expect(result).toMatchObject({
      outcome: 'recorded',
      memory: {
        scope: 'workspace',
        path: '.agents/memory/sessions.md',
        title: 'Session summary: How should sessions be stored?',
        startLine: 1,
      },
    });
    const request = requests[0]!;
    expect(request.tools).toEqual([]);
    expect(request.modelId).toBe('saved-model');
    const payload = request.messages[1]!.content!;
    expect(payload).toContain('Confirm the storage decision.');
    expect(payload).toContain('read_file');
    expect(payload).not.toContain('SECRET tool output');
    expect(payload).not.toContain('Half-finished request');
    const text = await sessionsFile();
    expect(text).toContain(`from session ${saved.id} (2 turns) by model saved-model`);
    expect(text).toContain('- Chose versioned JSON session files over SQLite.');

    await expect(
      summarizer().summarize({ session: saved, modelId: 'saved-model', scope: 'workspace' }),
    ).rejects.toMatchObject({ code: 'duplicate' });
    expect(await sessionsFile()).toBe(text);
  });

  it('keeps the most recent whole turns within the input limit', async () => {
    const saved = session([
      turn('old request '.repeat(50), 'old answer'),
      turn('recent request', 'recent answer'),
    ]);
    await summarizer().summarize({
      session: saved,
      modelId: 'm',
      scope: 'workspace',
      maxInputCharacters: 300,
    });
    const payload = JSON.parse(requests[0]!.messages[1]!.content!) as {
      omittedOlderTurns: number;
      turns: { user: string[] }[];
    };
    expect(payload.omittedOlderTurns).toBe(1);
    expect(payload.turns.map((t) => t.user[0])).toEqual(['recent request']);
    await tracing.forceFlush();
    const span = exporter.getFinishedSpans().find((s) => s.name === 'memory.summarize')!;
    expect(span.attributes).toMatchObject({ turns_included: 1, turns_omitted: 1, success: true });
  });

  it('writes nothing for NONE, empty sessions or unusable responses', async () => {
    reply = 'NONE';
    const saved = session([turn('Say hi', 'Hi.')]);
    expect(
      await summarizer().summarize({ session: saved, modelId: 'm', scope: 'workspace' }),
    ).toMatchObject({ outcome: 'nothing_durable' });
    await expect(
      summarizer().summarize({
        session: session([turn('x', 'y', 'failed')]),
        modelId: 'm',
        scope: 'workspace',
      }),
    ).rejects.toMatchObject({ code: 'nothing_to_summarize' });
    for (const bad of [null, '   ', 'x'.repeat(4_001), '```\nunclosed fence']) {
      reply = bad;
      await expect(
        summarizer().summarize({ session: saved, modelId: 'm', scope: 'workspace' }),
      ).rejects.toMatchObject({ code: 'invalid_response' });
    }
    await expect(sessionsFile()).rejects.toMatchObject({ code: 'ENOENT' });
    await tracing.forceFlush();
    expect(JSON.stringify(exporter.getFinishedSpans().map((s) => s.attributes))).not.toContain(
      'Say hi',
    );
  });

  it('runs from the CLI with the saved model and provider and parses options', async () => {
    const store = new InMemorySessionStore();
    const saved = session([turn('Why JSON storage?', 'Single writer.')]);
    await store.save(saved);
    const command = parseSessionCommand(
      ['sessions', 'summarize', saved.id, '--scope', 'user', '--file', 'history'],
      root,
    );
    if (command.kind !== 'summarize') throw new Error('Expected summarize');
    const providers: string[] = [];
    const output: string[] = [];
    await runSessionSummaryCommand(
      { ...command, userMemoryDirectory: join(root, 'user-memory') },
      store,
      root,
      {
        createSampler: (provider) => {
          providers.push(provider);
          return sampler;
        },
        tracer: tracing.tracer,
        writeOutput: (text) => output.push(text),
      },
    );
    expect(providers).toEqual(['ollama']);
    expect(requests[0]!.modelId).toBe('saved-model');
    expect(output[0]).toMatch(
      /^Recorded user memory "Session summary: Why JSON storage\?" at history\.md:1-/u,
    );
    expect(await readFile(join(root, 'user-memory/history.md'), 'utf8')).toContain(saved.id);

    await expect(
      runSessionSummaryCommand({ ...command, sessionId: createSessionId() }, store, root, {
        createSampler: () => sampler,
        tracer: tracing.tracer,
        writeOutput: () => undefined,
      }),
    ).rejects.toThrow('does not exist');
    for (const args of [
      ['sessions', 'summarize', 'not-a-uuid'],
      ['sessions', 'summarize', saved.id, '--scope', 'global'],
      ['sessions', 'summarize', saved.id, '--file', 'Bad.md'],
      ['sessions', 'summarize', saved.id, '--bogus', 'x'],
      ['sessions', 'summarize', saved.id, '--model'],
    ])
      expect(() => parseSessionCommand(args, root)).toThrow();
  });
});
