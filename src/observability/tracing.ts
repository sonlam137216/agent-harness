import { context, trace, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const DEFAULT_TRACER_NAME = 'agent-harness';
let contextManagerInstallationAttempted = false;

export interface TracingOptions {
  exporter?: SpanExporter;
  onError?: (error: unknown) => void;
  serviceName?: string;
  tracerName?: string;
}

export interface TracingHandle {
  readonly tracer: Tracer;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

function reportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    onError?.(error);
  } catch {
    // Observability error reporting must not become an application failure.
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

class GuardedSpanExporter implements SpanExporter {
  public constructor(
    private readonly delegate: SpanExporter,
    private readonly onError: ((error: unknown) => void) | undefined,
  ) {}

  public export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    let completed = false;
    const complete = (result: ExportResult): void => {
      if (completed) {
        return;
      }

      completed = true;
      if (result.code === ExportResultCode.FAILED) {
        reportError(this.onError, result.error);
      }
      resultCallback(result);
    };

    try {
      this.delegate.export(spans, complete);
    } catch (error) {
      complete({ code: ExportResultCode.FAILED, error: toError(error) });
    }
  }

  public async shutdown(): Promise<void> {
    try {
      await this.delegate.shutdown();
    } catch (error) {
      reportError(this.onError, error);
    }
  }
}

function createNoopTracing(tracerName: string): TracingHandle {
  return {
    tracer: trace.getTracer(tracerName),
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

function ensureAsyncContextPropagation(): void {
  if (contextManagerInstallationAttempted) return;
  contextManagerInstallationAttempted = true;

  const contextManager = new AsyncLocalStorageContextManager().enable();
  if (!context.setGlobalContextManager(contextManager)) {
    contextManager.disable();
  }
}

export function createTracing(options: TracingOptions = {}): TracingHandle {
  const tracerName = options.tracerName ?? DEFAULT_TRACER_NAME;

  try {
    ensureAsyncContextPropagation();
    const exporter = new GuardedSpanExporter(
      options.exporter ?? new ConsoleSpanExporter(),
      options.onError,
    );
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': options.serviceName ?? DEFAULT_TRACER_NAME,
      }),
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });

    return {
      tracer: provider.getTracer(tracerName),
      forceFlush: async () => {
        try {
          await provider.forceFlush();
        } catch (error) {
          reportError(options.onError, error);
        }
      },
      shutdown: async () => {
        try {
          await provider.shutdown();
        } catch (error) {
          reportError(options.onError, error);
        }
      },
    };
  } catch (error) {
    reportError(options.onError, error);
    return createNoopTracing(tracerName);
  }
}
