// Session registry — single source of truth for live and recently-dead sessions.
// Auto-label collision is resolved by suffixing -2, -3, ... to find the lowest
// free integer (DESIGN §9.4 decision). PID watchdog polls every PID_POLL_MS to
// detect orphans where cb died without sending `bye`. Dead sessions linger for
// DEAD_SESSION_RETAIN_MS so post-mortem reads still work.

import {
  DEAD_SESSION_RETAIN_MS,
  PID_POLL_MS,
} from '@bridge-clis/shared';
import { Session } from './session.js';
import { log } from './log.js';

export class Registry {
  private sessions = new Map<string, Session>();
  private pidTimer: NodeJS.Timeout | null = null;
  private retainTimer: NodeJS.Timeout | null = null;
  /** Subscribers notified on add/remove/death-change — daemon uses this for idle-shutdown timer reset. */
  private listeners = new Set<() => void>();

  start(): void {
    if (!this.pidTimer) {
      this.pidTimer = setInterval(() => this.pidPoll(), PID_POLL_MS);
      this.pidTimer.unref();
    }
    if (!this.retainTimer) {
      // Run retain-sweep on the same cadence; cheap O(n) scan.
      this.retainTimer = setInterval(() => this.sweepDead(), PID_POLL_MS);
      this.retainTimer.unref();
    }
  }

  stop(): void {
    if (this.pidTimer) {
      clearInterval(this.pidTimer);
      this.pidTimer = null;
    }
    if (this.retainTimer) {
      clearInterval(this.retainTimer);
      this.retainTimer = null;
    }
  }

  /** Register a notification callback (fired after add/remove/death). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private fire(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        log.error('registry listener threw', { err: (err as Error).message });
      }
    }
  }

  /**
   * Phase E: session-death observers (different signature: receives the
   * session and reason). Used by pipe-server to fanout notifications.
   * Fires for EVERY markDead transition exactly once.
   */
  private deathListeners = new Set<(s: Session, reason: string) => void>();
  onSessionDeath(fn: (s: Session, reason: string) => void): () => void {
    this.deathListeners.add(fn);
    return () => this.deathListeners.delete(fn);
  }
  private fireDeath(s: Session, reason: string): void {
    for (const fn of this.deathListeners) {
      try {
        fn(s, reason);
      } catch (err) {
        log.error('death listener threw', { err: (err as Error).message });
      }
    }
  }

  add(s: Session): void {
    // Wire markDead → fire so every dead-transition (heartbeat, bye, pid-poll,
    // pipe close, inject sync-probe) notifies listeners exactly once. Audit
    // bonus: closes the "markDead notification gap" code-auditor flagged.
    s.onMarkDead = (reason?: string): void => {
      this.fireDeath(s, reason ?? 'unknown');
      this.fire();
    };
    this.sessions.set(s.id, s);
    log.info('session added', { id: s.id, label: s.label, pid: s.pid, cwd: s.cwd });
    this.fire();
  }

  remove(id: string): boolean {
    const ok = this.sessions.delete(id);
    if (ok) {
      log.info('session removed', { id });
      this.fire();
    }
    return ok;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Lookup by session id (ULID), used by the resume-on-reconnect path
   * (audit M2). Does not fall back to label.
   */
  byId(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /**
   * Lookup by session id (ULID) OR by daemon-assigned label.
   * Alive sessions take precedence over dead ones with the same label
   * (a label can be reused after the prior session died and was kept in
   * the retain window).
   */
  byIdOrLabel(s: string): Session | undefined {
    const byId = this.sessions.get(s);
    if (byId) return byId;
    let aliveMatch: Session | undefined;
    let deadMatch: Session | undefined;
    for (const sess of this.sessions.values()) {
      if (sess.label === s) {
        if (sess.status === 'alive') {
          aliveMatch = sess;
          break;
        } else if (!deadMatch) {
          deadMatch = sess;
        }
      }
    }
    return aliveMatch ?? deadMatch;
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  /**
   * Returns the count of sessions still considered alive (for idle-shutdown).
   */
  aliveCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.status === 'alive') n++;
    return n;
  }

  /**
   * Compute a non-colliding label given the requested base. If `requested`
   * is free (no ALIVE session holds it), return it. Else append `-2`, `-3`, …
   * finding the lowest integer suffix that doesn't clash with an ALIVE session.
   *
   * Audit M6: when a dead-but-retained session holds the exact base label the
   * new session wants, rename the dead one to `${label}~dead-${diedAt}` so
   * `bridge_list` shows two unambiguous entries instead of two "hwm"s.
   * We rename ALL dead matches (transitively) for the chosen label so the
   * new session always wins the clean string.
   */
  resolveLabel(requested: string): string {
    let chosen = requested;
    if (this.labelTaken(requested)) {
      chosen = requested;
      for (let i = 2; i < 10_000; i++) {
        const candidate = `${requested}-${i}`;
        if (!this.labelTaken(candidate)) {
          chosen = candidate;
          break;
        }
      }
      if (chosen === requested) {
        // Pathological fallback — should never hit in practice.
        chosen = `${requested}-${Date.now()}`;
      }
    }
    this.renameDeadCollisions(chosen);
    return chosen;
  }

  /**
   * Find any DEAD sessions that hold the about-to-be-assigned label and
   * rename them out of the way. Idempotent: a session that already wears
   * its post-mortem `~dead-` suffix is left alone.
   */
  private renameDeadCollisions(newLabel: string): void {
    for (const s of this.sessions.values()) {
      if (s.status === 'dead' && s.label === newLabel) {
        const ts = s.diedAt ?? Date.now();
        s.label = `${newLabel}~dead-${ts}`;
        log.info('renamed dead-session label to free collision', {
          id: s.id,
          from: newLabel,
          to: s.label,
        });
      }
    }
  }

  private labelTaken(label: string): boolean {
    for (const s of this.sessions.values()) {
      if (s.status === 'alive' && s.label === label) return true;
    }
    return false;
  }

  // ---------- watchdog ----------

  private pidPoll(): void {
    for (const s of this.sessions.values()) {
      if (s.status !== 'alive') continue;
      if (!isProcessAlive(s.pid)) {
        // markDead now fires the onMarkDead callback → no manual fire() here.
        s.markDead('pid_gone');
      }
    }
  }

  private sweepDead(): void {
    const now = Date.now();
    for (const s of [...this.sessions.values()]) {
      if (s.status === 'dead' && s.diedAt !== null && now - s.diedAt > DEAD_SESSION_RETAIN_MS) {
        this.sessions.delete(s.id);
        log.info('session purged after retain TTL', { id: s.id, label: s.label });
        this.fire();
      }
    }
  }
}

/**
 * `process.kill(pid, 0)` is the POSIX "signal 0 = liveness probe" idiom.
 * On Windows this is supported by libuv: it returns success if the process
 * exists and we have permission to signal it, throws ESRCH if not.
 * EPERM means the process exists but we can't signal it — still "alive".
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}
