import pino from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Readonly<Record<string, unknown>>;

export interface StructuredLogger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

interface LogDestination {
  write(message: string): void;
}

export interface LoggerOptions {
  level?: LogLevel;
  destination?: LogDestination;
}

const REDACTED = '[REDACTED]';

const sensitiveKeys = new Set([
  'authorization',
  'cookie',
  'cookies',
  'credentials',
  'databaseurl',
  'password',
  'passwd',
  'secret',
  'setcookie',
  'token',
]);

function normalizeKey(key: string): string {
  return key.replaceAll(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);

  return (
    sensitiveKeys.has(normalized) ||
    normalized.endsWith('accesskey') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('accesstoken') ||
    normalized.endsWith('authorization') ||
    normalized.endsWith('clientsecret') ||
    normalized.endsWith('connectionstring') ||
    normalized.endsWith('credentials') ||
    normalized.endsWith('databaseurl') ||
    normalized.endsWith('password') ||
    normalized.endsWith('privatekey') ||
    normalized.endsWith('refreshtoken') ||
    normalized.endsWith('secret') ||
    normalized.endsWith('token')
  );
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, seen));
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }

  if (Object.getPrototypeOf(value) !== Object.prototype) {
    return value;
  }

  seen.add(value);

  const sanitized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? REDACTED : sanitize(item, seen),
    ]),
  );

  seen.delete(value);
  return sanitized;
}

function sanitizeFields(fields: LogFields): LogFields {
  return sanitize(fields, new WeakSet()) as LogFields;
}

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  const config = {
    level: options.level ?? 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
  };
  const baseLogger =
    options.destination === undefined ? pino(config) : pino(config, options.destination);

  function write(level: LogLevel, event: string, fields: LogFields = {}): void {
    baseLogger[level]({ ...sanitizeFields(fields), event });
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}
