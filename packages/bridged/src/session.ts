// Session — one bridged CLI under the daemon's care.
// Holds the raw ring buffer, headless terminal, the cb-side pipe socket
// (so the daemon can send `inject` frames back), and the timing markers
// that wait_for_idle and race-protection depend on.

import type { Socket } from 'node:net';
import { Buffer } from 'node:buffer';
import {
  DEFAULT_WAIT_FOR_USER_IDLE_MS,
  encodeFrame,
  type BridgedInjectMsg,
  type SessionInfo,
} from '@bridge-clis/shared';
import { HeadlessTerm } from './headless-term.js';
import { RingBuffer } from './ring-buffer.js';
import { log } from './log.js';
import { redact } from './redact.js';

export type SessionStatus = 'alive' | 'dead';

export type SessionInit = {
  id: string;
  label: string;
  cwd: string;
  cmdline: string[];
  pid: number;
  cols: number;
  rows: number;
  startedAt: number;
  pipeClient: Socket;
};

export class Session {
  readonly id: string;
  // label is mutable so the registry can rename a dead session out of the way
  // when a new alive session reuses the same base label (audit M6).
  label: string;
  readonly cwd: string;
  readonly cmdline: string[];
  readonly pid: number;
  readonly startedAt: number;

  pipeClient: Socket | null;
  status: SessionStatus = 'alive';
  /** When status transitioned to 'dead'. Used by registry to expire after retain TTL. */
  diedAt: number | null = null;

  readonly raw: RingBuffer;
  readonly term: HeadlessTerm;

  /** Updated on every `stdout` frame from cb. Drives wait_for_idle's minSilentMs gate. */
  lastOutputAt: number;
  /** Updated on every `user_input` frame from cb. Drives race-protection. */
  lastUserInputAt: number;
  /** Updated on any output or any inject. SessionInfo.lastActivityAt. */
  lastActivityAt: number;

  /** Heartbeat tracking: how many pings have gone unanswered. */
  missedPongs = 0;

  /**
   * Registered by registry.add() so any path that flips status to 'dead'
   * (heartbeat loss, bye, pid-poll, pipe close) notifies listeners exactly
   * once without each caller remembering to fire manually. Audit bonus.
   */
  onMarkDead?: (reason: string) => void;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.label = init.label;
    this.cwd = init.cwd;
    this.cmdline = init.cmdline;
    this.pid = init.pid;
    this.startedAt = init.startedAt;
    this.pipeClient = init.pipeClient;
    this.raw = new RingBuffer();
    this.term = new HeadlessTerm(init.cols, init.rows);
    const now = Date.now();
    this.lastOutputAt = now;
    // Initialize as "the user has been silent for longer than the default
    // wait window" so an immediate first inject is not blocked by phantom
    // race-protection. Audit M1 (was init.startedAt → 1.5s artificial latency).
    this.lastUserInputAt = init.startedAt - DEFAULT_WAIT_FOR_USER_IDLE_MS - 1;
    this.lastActivityAt = now;
  }

  /** Called on each `stdout` frame from cb. */
  onStdout(bytes: Buffer): void {
    const ts = Date.now();
    this.raw.pushChunk(bytes, ts);
    this.term.write(bytes);
    this.lastOutputAt = ts;
    this.lastActivityAt = ts;
  }

  /** Called on each `user_input` frame from cb. */
  onUserInput(at: number): void {
    // Use the cb-supplied timestamp if reasonable, else fall back to now.
    const now = Date.now();
    // Guard against clock skew sending future timestamps.
    this.lastUserInputAt = at > 0 && at <= now + 1000 ? at : now;
    this.lastActivityAt = this.lastUserInputAt;
  }

  onResize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /**
   * Write bytes to the cb pipe as an `inject` frame. cb will write them into
   * the PTY. Returns the byte count actually queued for write, or 0 on any
   * failure (dead session, destroyed socket, write throw). Callers MUST treat
   * 0 as failure — see inject.ts:doInject for the wrapper that converts it
   * into a session_dead error rather than a silent successful-looking ack.
   *
   * We cache pipeClient into a local before the destroyed-check and write so
   * that a concurrent markDead() (which nulls pipeClient) between the two
   * statements can't NPE us. Audit C3.
   *
   * Before writing we also run a sync `process.kill(pid, 0)` liveness probe.
   * The PID-poll timer only ticks every 30s, so there is a window where the
   * cb process died but the socket hasn't FIN'd yet. Without this probe an
   * inject in that window returns ok:true with the bytes going into the
   * doomed pipe buffer. Audit C3.
   */
  inject(bytes: Buffer): number {
    if (this.status === 'dead') return 0;
    const pc = this.pipeClient;
    if (!pc || pc.destroyed) {
      log.warn('session.inject: pipe gone', { id: this.id, label: this.label });
      return 0;
    }
    try {
      process.kill(this.pid, 0);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM') {
        // ESRCH (or anything not "permission denied") — process is gone.
        log.info('session.inject: pid gone (sync probe)', {
          id: this.id,
          label: this.label,
          pid: this.pid,
          code,
        });
        this.markDead('pid_gone_inject');
        return 0;
      }
      // EPERM = process exists, we just can't signal it. Continue.
    }
    const msg: BridgedInjectMsg = { t: 'inject', data: bytes.toString('base64') };
    try {
      const ok = pc.write(encodeFrame(msg));
      if (!ok) {
        // Backpressure — log but the OS buffer will catch up. We count as
        // written because the frame is queued in Node's stream.
        log.debug('session.inject: backpressure', { id: this.id });
      }
      this.lastActivityAt = Date.now();
      return bytes.length;
    } catch (err) {
      log.error('session.inject: write failed', {
        id: this.id,
        err: (err as Error).message,
      });
      return 0;
    }
  }

  markDead(reason: string): void {
    if (this.status === 'dead') return;
    this.status = 'dead';
    this.diedAt = Date.now();
    log.info('session marked dead', { id: this.id, label: this.label, reason });
    // Detach pipe so we stop writing to a broken socket.
    if (this.pipeClient) {
      try {
        this.pipeClient.destroy();
      } catch {
        /* ignore */
      }
      this.pipeClient = null;
    }
    // Notify registry so idle-shutdown timer and other listeners react. The
    // callback is set by registry.add() and intentionally not awaited.
    if (this.onMarkDead) {
      try {
        this.onMarkDead(reason);
      } catch (err) {
        log.error('session.onMarkDead listener threw', { err: (err as Error).message });
      }
    }
  }

  toInfo(): SessionInfo {
    // cmdline frequently contains API keys (e.g. `claude --api-key sk-ant-…`).
    // bridge_list previously returned this raw — anyone who could open the
    // pipe got credentials for free. Run each entry through the same redactor
    // we use for read_screen / read_tail. Audit C5.
    return {
      id: this.id,
      label: this.label,
      cwd: this.cwd,
      cmdline: this.cmdline.map((a) => redact(a)),
      pid: this.pid,
      status: this.status,
      startedAt: this.startedAt,
      lastActivityAt: this.lastActivityAt,
      lineCount: this.term.lineCount(),
    };
  }
}
