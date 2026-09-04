import { describe, expect, it } from 'vitest';

import { createLogger } from '../src/observability/logger.js';

interface CapturedLog {
  event: string;
  authorization: string;
  nested: {
    apiKey: string;
    databaseUrl: string;
    refresh_token: string;
    visible: string;
  };
  OPENAI_API_KEY: string;
}

describe('structured logger', () => {
  it('writes JSON and recursively redacts known secret fields', () => {
    const messages: string[] = [];
    const logger = createLogger({
      destination: {
        write: (message) => messages.push(message),
      },
    });

    logger.info('credentials.checked', {
      authorization: 'Bearer secret',
      nested: {
        apiKey: 'secret-key',
        databaseUrl: 'postgres://user:password@localhost/database',
        refresh_token: 'refresh-secret',
        visible: 'safe',
      },
      OPENAI_API_KEY: 'provider-secret',
    });

    expect(messages).toHaveLength(1);
    const record = JSON.parse(messages[0] ?? '{}') as CapturedLog;
    expect(record.event).toBe('credentials.checked');
    expect(record.authorization).toBe('[REDACTED]');
    expect(record.nested.apiKey).toBe('[REDACTED]');
    expect(record.nested.databaseUrl).toBe('[REDACTED]');
    expect(record.nested.refresh_token).toBe('[REDACTED]');
    expect(record.nested.visible).toBe('safe');
    expect(record.OPENAI_API_KEY).toBe('[REDACTED]');
  });
});
