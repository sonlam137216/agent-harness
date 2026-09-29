import type { SandboxPolicy } from './sandbox-policy.js';

/** Paths were validated as plain absolute paths, so JSON quoting is a valid SBPL string. */
function quote(path: string): string {
  return JSON.stringify(path);
}

function subpaths(paths: readonly string[]): string {
  return paths.map((path) => `(subpath ${quote(path)})`).join(' ');
}

/**
 * Deny-by-default Seatbelt profile. Later, more specific rules override earlier ones:
 * the system is readable, private paths are not, and the root, temporary directory and
 * explicit read paths are readable again. Writes are limited to the root (minus protected
 * paths), the per-command temporary directory and a few devices. Network, Apple events and
 * most Mach services remain denied.
 */
export function seatbeltProfile(policy: SandboxPolicy, temporaryDirectory: string): string {
  const readable = [policy.root, temporaryDirectory, ...policy.readPaths];
  const rules = [
    '(version 1)',
    '(deny default)',
    '(allow process-fork)',
    '(allow process-exec)',
    '(allow signal (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow ipc-posix-shm)',
    '(allow file-read-metadata)',
    '(allow file-read* (subpath "/"))',
    ...(policy.privatePaths.length === 0
      ? []
      : [`(deny file-read* ${subpaths(policy.privatePaths)})`]),
    `(allow file-read* ${subpaths(readable)})`,
    `(allow file-write* ${subpaths([policy.root, temporaryDirectory])} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))`,
    ...(policy.protectedPaths.length === 0
      ? []
      : [`(deny file-write* ${subpaths(policy.protectedPaths)})`]),
    // User lookup and logging only; no network resolver, launch services or Apple events.
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo") (global-name "com.apple.system.notification_center") (global-name "com.apple.logd"))',
  ];
  return rules.join('\n');
}
