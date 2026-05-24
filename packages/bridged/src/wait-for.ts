// wait_for_pattern and wait_for_idle.
// Both are pull-based polling rather than push-from-stdout because the
// xterm/headless `term.write()` happens synchronously inside `onStdout`,
// and any pattern/idle test needs the FULLY RENDERED state — easier to
// re-check on a tick than to instrument every write.

import {
  WAIT_FOR_IDLE_DEFAULT_STABLE_TICKS,
  WAIT_FOR_IDLE_DEFAULT_TIMEOUT_MS,
  WAIT_FOR_IDLE_MIN_SILENT_MS,
  WAIT_FOR_IDLE_TICK_MS,
  type WaitForIdleResult,
  type WaitForResult,
} from '@bridge-clis/shared';
import type { Session } from './session.js';
import { log } from './log.js';

// ---------- waitForPattern ----------

export type WaitForPatternOpts = {
  pattern: string;
  mode: 'regex' | 'substring';
  timeoutMs: number;
  /** Tail length to scan on each tick. 100 lines covers a reasonable Claude Code answer. */
  scanLines?: number;
  tickMs?: number;
};

/**
 * Resolves when `pattern` appears in the last N rendered lines, or on timeout.
 * `mode === 'regex'` compiles `new RegExp(pattern, 'm')` once; an invalid
 * regex resolves immediately with matched:false and logs.
 *
 * Returns:
 *   { matched: true, matchedLine: <first-matching-line>, ms }
 *   { matched: false, ms } on timeout
 */
export function waitForPattern(
  session: Session,
  opts: WaitForPatternOpts,
): Promise<WaitForResult> {
  const scanLines = opts.scanLines ?? 100;
  const tickMs = opts.tickMs ?? 200;
  const start = Date.now();

  let regex: RegExp | null = null;
  if (opts.mode === 'regex') {
    try {
      regex = new RegExp(opts.pattern, 'm');
    } catch (err) {
      log.warn('waitForPattern: invalid regex', {
        pattern: opts.pattern,
        err: (err as Error).message,
      });
      return Promise.resolve({ matched: false, ms: 0 });
    }
  }

  return new Promise((resolve) => {
    const finish = (r: WaitForResult): void => {
      clearInterval(iv);
      resolve(r);
    };

    const check = (): void => {
      // Scan FIRST, then check timeout. Audit M7: pre-fix the order was
      // reversed, so a match arriving in the same tick a timeout was due
      // would lose to the timeout and report matched:false despite the
      // pattern being live on screen.
      const tail = session.term.renderTail(scanLines);
      const lines = tail.text.split('\n');
      for (const line of lines) {
        if (opts.mode === 'substring') {
          if (line.includes(opts.pattern)) {
            finish({ matched: true, matchedLine: line, ms: Date.now() - start });
            return;
          }
        } else if (regex && regex.test(line)) {
          finish({ matched: true, matchedLine: line, ms: Date.now() - start });
          return;
        }
      }
      const elapsed = Date.now() - start;
      if (elapsed >= opts.timeoutMs) {
        finish({ matched: false, ms: elapsed });
      }
    };

    // Run an immediate check so already-present patterns resolve instantly.
    const iv = setInterval(check, tickMs);
    iv.unref?.();
    check();
  });
}

// ---------- waitForIdle ----------

export type WaitForIdleOpts = {
  timeoutMs?: number;
  stableTicks?: number;
  tickMs?: number;
  minSilentMs?: number;
};

/**
 * Implements EXECUTION Anhang B verbatim.
 * - Every `tickMs`, if `now - lastOutputAt < minSilentMs`, the tick is SKIPPED
 *   (we don't push a hash because output is still actively changing).
 * - Otherwise hash the last 3 rendered rows with animation masking, push to
 *   a FIFO sized `stableTicks`.
 * - When the FIFO is full AND all entries equal, resolve `idle:true`.
 * - On `elapsed > timeoutMs`, resolve `idle:false`.
 *
 * Note: "skip" means the FIFO is NOT modified that tick — neither pushed nor
 * cleared. This matches the algorithm in the spec. If output bursts, the FIFO
 * can be flushed implicitly because new (different) hashes will arrive once
 * the silent gate clears, and a single mismatch in a 5-slot FIFO is enough
 * to defeat the equality test.
 */
export function waitForIdle(session: Session, opts: WaitForIdleOpts = {}): Promise<WaitForIdleResult> {
  const timeoutMs = opts.timeoutMs ?? WAIT_FOR_IDLE_DEFAULT_TIMEOUT_MS;
  const stableTicks = opts.stableTicks ?? WAIT_FOR_IDLE_DEFAULT_STABLE_TICKS;
  const tickMs = opts.tickMs ?? WAIT_FOR_IDLE_TICK_MS;
  const minSilentMs = opts.minSilentMs ?? WAIT_FOR_IDLE_MIN_SILENT_MS;

  const start = Date.now();
  const hashes: string[] = [];

  return new Promise((resolve) => {
    const iv = setInterval(() => {
      const elapsed = Date.now() - start;
      if (elapsed > timeoutMs) {
        clearInterval(iv);
        resolve({ idle: false, ms: elapsed });
        return;
      }
      if (Date.now() - session.lastOutputAt < minSilentMs) {
        // Output still recent — defer measurement, don't push a hash.
        return;
      }
      const h = session.term.hashLastN(3, true);
      hashes.push(h);
      if (hashes.length > stableTicks) hashes.shift();
      if (hashes.length === stableTicks) {
        const first = hashes[0];
        if (first !== undefined && hashes.every((x) => x === first)) {
          clearInterval(iv);
          resolve({ idle: true, ms: elapsed });
        }
      }
    }, tickMs);
    iv.unref?.();
  });
}

/**
 * Fire-and-forget version of waitForIdle for the notification system.
 * Returns a handle whose `cancel()` aborts the watcher silently.
 * `onResolve` fires with the silent-ms duration only when idle was detected;
 * on timeout or cancel, nothing fires (the notification system has its own
 * cap behavior — silent expiry is fine).
 */
export function startIdleWatcher(
  session: Session,
  opts: WaitForIdleOpts & { onIdle: (silentMs: number) => void },
): { cancel: () => void } {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000; // 5min default for background watchers
  const stableTicks = opts.stableTicks ?? WAIT_FOR_IDLE_DEFAULT_STABLE_TICKS;
  const tickMs = opts.tickMs ?? WAIT_FOR_IDLE_TICK_MS;
  const minSilentMs = opts.minSilentMs ?? WAIT_FOR_IDLE_MIN_SILENT_MS;

  const start = Date.now();
  const hashes: string[] = [];
  let cancelled = false;

  const iv = setInterval(() => {
    if (cancelled) {
      clearInterval(iv);
      return;
    }
    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) {
      clearInterval(iv);
      return;
    }
    if (Date.now() - session.lastOutputAt < minSilentMs) return;
    const h = session.term.hashLastN(3, true);
    hashes.push(h);
    if (hashes.length > stableTicks) hashes.shift();
    if (hashes.length === stableTicks) {
      const first = hashes[0];
      if (first !== undefined && hashes.every((x) => x === first)) {
        clearInterval(iv);
        if (!cancelled) opts.onIdle(elapsed);
      }
    }
  }, tickMs);
  iv.unref?.();

  return {
    cancel: () => {
      cancelled = true;
      clearInterval(iv);
    },
  };
}
