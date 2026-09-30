/**
 * Files that commonly hold credentials. They are hidden from model-facing reads, listings
 * and searches, and unreadable by sandboxed commands, because anything the model reads is
 * sent to the model provider. Patterns are anchored path-segment regexes written in the
 * common subset of JavaScript and POSIX ERE, so the Seatbelt backend can reuse them.
 */
const SENSITIVE_FILE_NAMES = [
  '\\.env',
  '\\.env\\..+',
  '.+\\.(pem|key|p12|pfx|jks|keystore)',
  'id_(rsa|dsa|ecdsa|ed25519)',
  '\\.(npmrc|pypirc|netrc|pgpass|git-credentials)',
] as const;

/** Committed templates that look like secrets but are meant to be read. */
const ALLOWED_FILE_NAMES = ['\\.env\\.(example|sample|template|defaults|dist)'] as const;

/** Directories whose whole content is sensitive. */
const SENSITIVE_DIRECTORY_NAMES = ['\\.(ssh|aws|gnupg)'] as const;

function anchored(patterns: readonly string[]): RegExp {
  return new RegExp(`^(?:${patterns.join('|')})$`, 'u');
}

const SENSITIVE_FILE = anchored(SENSITIVE_FILE_NAMES);
const ALLOWED_FILE = anchored(ALLOWED_FILE_NAMES);
const SENSITIVE_DIRECTORY = anchored(SENSITIVE_DIRECTORY_NAMES);

/** True for a workspace-relative, `/`-separated path that must stay hidden. */
export function isSensitivePath(path: string): boolean {
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  const name = segments.at(-1);
  if (name === undefined) return false;
  if (segments.some((segment) => SENSITIVE_DIRECTORY.test(segment))) return true;
  return SENSITIVE_FILE.test(name) && !ALLOWED_FILE.test(name);
}

function escapeRegex(text: string): string {
  return text.replace(/[.[\]()*+?{}|^$\\]/gu, '\\$&');
}

/**
 * Seatbelt rules for an absolute root: deny reading sensitive files anywhere below it,
 * then re-allow the templates. Place them after the rule that makes the root readable.
 */
export function sensitiveSeatbeltRules(root: string): readonly string[] {
  const base = `^${escapeRegex(root.replace(/\/+$/u, ''))}/(.*/)?`;
  const regex = (pattern: string): string => `(regex #"${pattern}")`;
  return [
    `(deny file-read-data ${regex(`${base}(${SENSITIVE_FILE_NAMES.join('|')})$`)} ${regex(
      `${base}(${SENSITIVE_DIRECTORY_NAMES.join('|')})(/.*)?$`,
    )})`,
    `(allow file-read-data ${regex(`${base}(${ALLOWED_FILE_NAMES.join('|')})$`)})`,
  ];
}
