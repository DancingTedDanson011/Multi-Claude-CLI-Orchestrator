// Race-protected inject — EXECUTION Anhang C verbatim.
// `force` bypasses the wait. Otherwise we wait until the user has been
// silent for `waitForUserIdleMs`, polling every (up to) 200ms with a
// hard cap of USER_IDLE_HARD_CAP_MS so a constantly-typing user can't
// pin the daemon's request forever — instead we return `user_active`.

import { Buffer } from 'node:buffer';
import {
  DEFAULT_WAIT_FOR_USER_IDLE_MS,
  USER_IDLE_HARD_CAP_MS,
} from '@bridge-clis/shared';
import type { Session } from './session.js';
import { audit, type AuditOp } from './audit.js';

export type InjectOpts = {
  waitForUserIdleMs?: number;
  force?: boolean;
  /** For audit log + op-classification. */
  op: AuditOp;
  callerId: string;
};

export type InjectOutcome =
  | { ok: true; written: number }
  | { ok: false; error: 'user_active'; silentMs: number }
  | { ok: false; error: 'session_dead' };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function tryInject(
  session: Session,
  bytes: Buffer,
  opts: InjectOpts,
): Promise<InjectOutcome> {
  if (session.status === 'dead') {
    return { ok: false, error: 'session_dead' };
  }

  if (opts.force) {
    return doInject(session, bytes, opts);
  }

  const need = opts.waitForUserIdleMs ?? DEFAULT_WAIT_FOR_USER_IDLE_MS;
  const deadline = Date.now() + USER_IDLE_HARD_CAP_MS;

  while (Date.now() < deadline) {
    const silentFor = Date.now() - session.lastUserInputAt;
    if (silentFor >= need) {
      return doInject(session, bytes, opts);
    }
    // Wait the smaller of: 200ms tick, or the remaining time until threshold.
    const wait = Math.min(200, Math.max(1, need - silentFor));
    await sleep(wait);
    // Re-check liveness across the await — Session.markDead can run between
    // ticks (heartbeat loss, cb bye). TS narrows status to 'alive' from the
    // top-of-function guard and doesn't widen across awaits, so we read
    // through a string cast to force the runtime check.
    if ((session.status as string) === 'dead') {
      return { ok: false, error: 'session_dead' };
    }
  }

  return {
    ok: false,
    error: 'user_active',
    silentMs: Date.now() - session.lastUserInputAt,
  };
}

function doInject(session: Session, bytes: Buffer, opts: InjectOpts): InjectOutcome {
  if (session.status === 'dead' || !session.pipeClient) {
    return { ok: false, error: 'session_dead' };
  }
  // session.inject returns 0 on ANY failure path (destroyed socket, sync pid
  // probe finding the process dead inside the 30s heartbeat window, write
  // throw). Pre-audit C3 we audited bytes.length here regardless, then told
  // the caller written=N — i.e. the MCP layer thought writes succeeded and
  // would only discover the truth via a 30s wait_for timeout. Now: 0 → dead.
  const written = session.inject(bytes);
  if (written === 0) {
    return { ok: false, error: 'session_dead' };
  }
  audit({
    op: opts.op,
    sessionLabel: session.label,
    bytes: written,
    callerId: opts.callerId,
  });
  return { ok: true, written };
}
