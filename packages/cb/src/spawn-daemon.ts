// Auto-spawn the bridged daemon as a detached process if the pipe is absent.
// Best-effort: if daemon never becomes reachable, cb continues in headless mode.
//
// Concurrency (audit M9): multiple cb processes started at the same moment
// would all see no pipe + all spawn a daemon. The losers fail to bind the
// pipe and just log noise, but it's wasteful. We coordinate via a transient
// file-lock under BRIDGE_DIR/spawn.lock. Stale locks (>5s old) are forcibly
// removed; foreign locks are left alone.

import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  constants as fsConstants,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PIPE_NAME, BRIDGE_DIR } from '@bridge-clis/shared';
import { log } from './log.js';

const SPAWN_POLL_INTERVAL_MS = 100;
const SPAWN_POLL_TIMEOUT_MS = 3000;
const CONNECT_PROBE_TIMEOUT_MS = 500;
const SPAWN_LOCK_PATH = path.join(BRIDGE_DIR, 'spawn.lock');
const SPAWN_LOCK_STALE_MS = 5_000;

/** Probe the pipe with a short-lived connection. Resolves true if accept succeeds. */
function probePipe(): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    const sock = net.createConnection({ path: PIPE_NAME });
    const t = setTimeout(() => finish(false), CONNECT_PROBE_TIMEOUT_MS);
    sock.once('connect', () => {
      clearTimeout(t);
      finish(true);
    });
    sock.once('error', () => {
      clearTimeout(t);
      finish(false);
    });
  });
}

/**
 * Resolve the daemon entry script. Tries layouts in order:
 *   - Bundled (T14):       <here>/bridged.cjs        (cb.cjs and bridged.cjs siblings)
 *   - Dev (pnpm/tsc):      <here>/../../bridged/dist/index.js
 *   - Alt monorepo layout: <here>/../bridged/dist/index.js
 * Returns the first existing path, or the dev path as a last-resort guess.
 */
function resolveDaemonEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, 'bridged.cjs'),
    path.resolve(here, '..', '..', 'bridged', 'dist', 'index.js'),
    path.resolve(here, '..', 'bridged', 'dist', 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to the dev path so the error message is informative.
  return candidates[1]!;
}

function spawnDetached(entry: string): void {
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', err => {
    log.error('daemon spawn error', { err: err.message, entry });
  });
  child.unref();
  log.info('daemon spawn requested', { entry, pid: child.pid });
}

function ensureBridgeDir(): void {
  try {
    if (!existsSync(BRIDGE_DIR)) {
      mkdirSync(BRIDGE_DIR, { recursive: true });
    }
  } catch {
    // logging path may also be broken; carry on — daemon will recreate if it can.
  }
}

/**
 * Try to acquire the spawn lock. Returns:
 *   - 'acquired' if we own the lock (caller MUST release in finally),
 *   - 'foreign'  if someone else holds a fresh lock (caller should wait + re-probe pipe).
 *   - 'forced'   if a stale lock was removed and a fresh one acquired (we own it).
 */
function acquireSpawnLock(): 'acquired' | 'foreign' | 'forced' {
  ensureBridgeDir();
  const tryOnce = (): boolean => {
    try {
      const fd = openSync(
        SPAWN_LOCK_PATH,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      closeSync(fd);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      // Unexpected error — log and treat as foreign so we fall back to polling.
      log.warn('spawn lock open failed', { err: (e as Error).message });
      return false;
    }
  };

  if (tryOnce()) return 'acquired';

  // EEXIST: inspect age. If stale, force-remove and retry once.
  try {
    const st = statSync(SPAWN_LOCK_PATH);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs > SPAWN_LOCK_STALE_MS) {
      log.warn('removing stale spawn lock', { ageMs, path: SPAWN_LOCK_PATH });
      try {
        unlinkSync(SPAWN_LOCK_PATH);
      } catch (e) {
        log.warn('stale spawn lock unlink failed', { err: (e as Error).message });
        return 'foreign';
      }
      if (tryOnce()) return 'forced';
    }
  } catch {
    // stat failed — file probably already removed by another contender.
  }
  return 'foreign';
}

function releaseSpawnLock(): void {
  try {
    unlinkSync(SPAWN_LOCK_PATH);
  } catch {
    // Best effort: caller may have already released, or never owned it.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Ensure the daemon is reachable. If the pipe is already accepting, returns immediately.
 * Otherwise spawns the daemon detached and polls for up to SPAWN_POLL_TIMEOUT_MS.
 * Returns true if connectable by deadline; false otherwise.
 */
export async function ensureDaemonRunning(): Promise<boolean> {
  if (await probePipe()) {
    log.debug('pipe already up — no spawn needed');
    return true;
  }

  const lockState = acquireSpawnLock();
  const owned = lockState === 'acquired' || lockState === 'forced';

  if (!owned) {
    // Someone else is spawning. Wait briefly then re-probe — they probably
    // already got the daemon up.
    log.debug('spawn lock held by another cb — waiting');
    await sleep(500);
    if (await probePipe()) {
      log.info('daemon reachable after foreign-spawn wait');
      return true;
    }
    // Fall through to polling without re-spawn.
    const deadline = Date.now() + SPAWN_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(SPAWN_POLL_INTERVAL_MS);
      if (await probePipe()) {
        log.info('daemon became reachable (after foreign spawn)');
        return true;
      }
    }
    log.warn('foreign-spawn wait timed out — continuing headless');
    return false;
  }

  try {
    const entry = resolveDaemonEntry();
    log.info('spawning daemon (lock acquired)', { entry, lockState });
    try {
      spawnDetached(entry);
    } catch (e) {
      log.error('daemon spawn failed', { err: (e as Error).message, entry });
      return false;
    }

    const deadline = Date.now() + SPAWN_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(SPAWN_POLL_INTERVAL_MS);
      if (await probePipe()) {
        log.info('daemon became reachable');
        return true;
      }
    }
    log.warn('daemon did not become reachable in time — continuing headless', {
      timeoutMs: SPAWN_POLL_TIMEOUT_MS,
    });
    return false;
  } finally {
    if (owned) releaseSpawnLock();
  }
}
