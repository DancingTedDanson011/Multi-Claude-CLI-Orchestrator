// Per-daemon-startup shared secret for pipe authentication.
// Single-user threat model: file lives under USERPROFILE\.bridge-clis\ which
// is owner-only on a default Windows install. cb and bridge-mcp both read it;
// daemon writes it once at startup if absent. Audit C4.

import { Buffer } from 'node:buffer';
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BRIDGE_DIR,
  DAEMON_SECRET_BYTES,
  DAEMON_SECRET_PATH,
} from './constants.js';

/** Generates a fresh hex-encoded secret. */
export function generateDaemonSecret(): string {
  return randomBytes(DAEMON_SECRET_BYTES).toString('hex');
}

function ensureDir(): void {
  if (!existsSync(BRIDGE_DIR)) {
    mkdirSync(BRIDGE_DIR, { recursive: true });
  }
}

/**
 * Write the secret if and only if the file does not exist yet (O_EXCL atomic).
 * On Windows the file inherits the parent directory's ACL (user profile is
 * owner-only by default). On POSIX we additionally chmod to 0600.
 *
 * Returns true if THIS call created the file, false if it already existed.
 */
export function writeDaemonSecretIfAbsent(secret: string, secretPath = DAEMON_SECRET_PATH): boolean {
  ensureDir();
  try {
    const fd = openSync(secretPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    try {
      writeFileSync(fd, secret + '\n', { encoding: 'utf8' });
    } finally {
      closeSync(fd);
    }
    if (process.platform !== 'win32') {
      try {
        chmodSync(secretPath, 0o600);
      } catch {
        /* best effort */
      }
    }
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') return false;
    throw e;
  }
}

/**
 * Read the secret. Throws if absent or empty. Callers (cb, bridge-mcp) should
 * call this AFTER they know the daemon is reachable (i.e. after ensureDaemonRunning).
 */
export function readDaemonSecret(secretPath = DAEMON_SECRET_PATH): string {
  const raw = readFileSync(secretPath, { encoding: 'utf8' });
  const s = raw.trim();
  if (!s) throw new Error(`Daemon secret file is empty: ${secretPath}`);
  return s;
}

/** Tries readDaemonSecret with a short retry window; returns null on failure. */
export async function readDaemonSecretWithRetry(
  secretPath = DAEMON_SECRET_PATH,
  attempts = 30,
  intervalMs = 100,
): Promise<string | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return readDaemonSecret(secretPath);
    } catch {
      await new Promise(r => setTimeout(r, intervalMs));
    }
  }
  return null;
}

/**
 * Initialize the daemon's secret at startup:
 * - If the file exists, read and return it (a prior daemon process wrote it).
 * - Otherwise generate, write atomically (O_EXCL), and return.
 *
 * Two daemons racing this will both call writeDaemonSecretIfAbsent — exactly
 * one wins; the loser reads the winner's value. So the secret is stable across
 * spawn races.
 */
export function initDaemonSecret(secretPath = DAEMON_SECRET_PATH): string {
  if (existsSync(secretPath)) {
    return readDaemonSecret(secretPath);
  }
  const candidate = generateDaemonSecret();
  const created = writeDaemonSecretIfAbsent(candidate, secretPath);
  if (created) return candidate;
  return readDaemonSecret(secretPath);
}

/**
 * Constant-time comparison. Both sides are hex strings of the same length;
 * a short-circuit length check is safe (length differs → wrong secret anyway).
 */
export function verifyDaemonSecret(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  try {
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export const SECRET_PATH_FOR_LOG = DAEMON_SECRET_PATH;

// Re-export path util for callers that want to test/override location.
export { path as _path };
