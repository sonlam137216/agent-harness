import { SpanStatusCode } from '@opentelemetry/api';
import type { SessionId } from '../ids.js';
import type { TracingHandle } from '../observability/tracing.js';
import { RecordStorageError, type RecordStorage } from '../workspace/record-storage.js';
import { decodeSession, encodeSession, SessionFormatError } from './session-codec.js';
import { summarizeSession, type SessionSummary } from './session-history.js';
import type { SessionStore } from './session-store.js';
import type { Session } from './session.js';

export class FileSessionStore implements SessionStore {
  public constructor(
    private readonly storage: RecordStorage,
    private readonly tracer: TracingHandle['tracer'],
  ) {}
  public get(sessionId: SessionId): Promise<Session | undefined> {
    return this.#operation('get', sessionId, async () => {
      const content = await this.storage.read(sessionId);
      return content === undefined ? undefined : decodeSession(content, sessionId);
    });
  }
  public save(session: Session): Promise<void> {
    return this.#operation('save', session.id, async () => {
      const serialized = encodeSession(session);
      // Never overwrite a corrupted or future-version document with a partial replacement.
      const existing = await this.storage.read(session.id);
      if (existing !== undefined) decodeSession(existing, session.id);
      await this.storage.writeAtomic(session.id, serialized);
    });
  }
  public list(): Promise<readonly SessionSummary[]> {
    return this.#operation('list', undefined, async () => {
      const summaries: SessionSummary[] = [];
      for (const id of await this.storage.listKeys()) {
        const session = await this.get(id as SessionId);
        if (session !== undefined) summaries.push(summarizeSession(session));
      }
      return summaries.sort(
        (a, b) =>
          (b.metadata?.updatedAt ?? '').localeCompare(a.metadata?.updatedAt ?? '') ||
          a.id.localeCompare(b.id),
      );
    });
  }
  public withSessionLock<T>(id: SessionId, run: () => Promise<T>): Promise<T> {
    return this.storage.withLock(id, run);
  }
  #operation<T>(operation: string, id: SessionId | undefined, run: () => Promise<T>): Promise<T> {
    return this.tracer.startActiveSpan('session.store', async (span) => {
      const start = performance.now();
      span.setAttribute('session.store.operation', operation);
      if (id !== undefined) span.setAttribute('session.id', id);
      try {
        const result = await run();
        span.setAttribute('success', true);
        return result;
      } catch (error) {
        span.setAttributes({
          success: false,
          'error.type':
            error instanceof SessionFormatError || error instanceof RecordStorageError
              ? error.code
              : 'session_storage_error',
        });
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.setAttribute('duration_ms', performance.now() - start);
        span.end();
      }
    });
  }
}
