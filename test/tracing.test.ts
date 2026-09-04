import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';

import { createSessionId } from '../src/ids.js';
import { createTracing } from '../src/observability/tracing.js';

describe('tracing foundation', () => {
  it('creates and exports a span with an application correlation ID', async () => {
    const exporter = new InMemorySpanExporter();
    const tracing = createTracing({ exporter });
    const sessionId = createSessionId();

    const span = tracing.tracer.startSpan('phase0.smoke');
    span.setAttribute('session.id', sessionId);
    span.end();
    await tracing.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('phase0.smoke');
    expect(spans[0]?.attributes['session.id']).toBe(sessionId);
    expect(spans[0]?.resource.attributes['service.name']).toBe('agent-harness');

    await tracing.shutdown();
  });

  it('contains synchronous exporter failures', async () => {
    const failures: unknown[] = [];
    const exporter: SpanExporter = {
      export: () => {
        throw new Error('export failed');
      },
      shutdown: () => Promise.resolve(),
    };
    const tracing = createTracing({
      exporter,
      onError: (error) => failures.push(error),
    });

    expect(() => {
      const span = tracing.tracer.startSpan('phase0.failure');
      span.end();
    }).not.toThrow();

    await tracing.forceFlush();
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures.some((failure) => String(failure).includes('export failed'))).toBe(true);
    await tracing.shutdown();
  });
});
