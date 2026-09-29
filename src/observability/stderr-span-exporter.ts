import { ExportResultCode, hrTimeToMilliseconds, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

/**
 * Writes one JSON line per finished span to a diagnostic stream (normally stderr). Used when
 * stdout carries a protocol, where the default console exporter would corrupt the stream.
 */
export class StderrSpanExporter implements SpanExporter {
  public constructor(private readonly output: { write(text: string): unknown } = process.stderr) {}

  public export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans)
      this.output.write(
        `${JSON.stringify({
          span: span.name,
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: span.parentSpanContext?.spanId,
          durationMs: hrTimeToMilliseconds(span.duration),
          status: span.status.code,
          attributes: span.attributes,
        })}\n`,
      );
    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  public shutdown(): Promise<void> {
    return Promise.resolve();
  }
}
