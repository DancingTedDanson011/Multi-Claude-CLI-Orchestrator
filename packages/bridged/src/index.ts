// bridged — daemon entry point.
// Lifecycle:
//   1. Initialize the per-daemon shared secret (idempotent, atomic) — must
//      precede any pipe operation so a racing cb / mcp client reading the
//      file always sees the value we're about to verify against.
//   2. Try to listen on PIPE_NAME. The pipe IS the mutex (audit C4 / H7) —
//      EADDRINUSE → another daemon already runs → exit 0 silently.
//   3. Start the registry (PID watchdog + dead-retain sweeper).
//   4. Arm idle-shutdown: when zero alive sessions AND no MCP activity for
//      MCP_IDLE_ACTIVITY_TIMEOUT_MS, schedule exit after DAEMON_IDLE_SHUTDOWN_MS.
//      Pre-audit (C6) the gate was "no MCP connections" — but master-Claude
//      holds the socket open for hours, so the daemon never idled.
//   5. Trap SIGTERM/SIGINT for graceful shutdown.
//
// The daemon may be spawned detached with stdio:'ignore' — DO NOT write
// to stdout/stderr from this process; use `log` for everything.

import process from 'node:process';
import {
  DAEMON_IDLE_SHUTDOWN_MS,
  DAEMON_SECRET_PATH,
  MCP_IDLE_ACTIVITY_TIMEOUT_MS,
  initDaemonSecret,
} from '@bridge-clis/shared';
import { log } from './log.js';
import { Registry } from './registry.js';
import { PipeServer } from './pipe-server.js';
import { NotificationCenter } from './notifications.js';
import { SessionPersistence } from './persistence.js';

type DaemonOpts = {
  idleShutdownMs: number;
};

const DAEMON_VERSION = '0.1.0';

function parseArgs(argv: string[]): DaemonOpts {
  let idleShutdownMs = DAEMON_IDLE_SHUTDOWN_MS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--idle-shutdown-ms' && i + 1 < argv.length) {
      const next = argv[i + 1];
      if (next !== undefined) {
        const v = Number(next);
        if (Number.isFinite(v) && v >= 0) idleShutdownMs = v;
        i++;
      }
    }
  }
  return { idleShutdownMs };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  log.info('bridged starting', { pid: process.pid, ...opts });

  // --- Step 1: secret ---
  // Idempotent: if the file exists we read it, otherwise we generate + write
  // atomically. Two racing daemons → one wins the O_EXCL write, the other
  // reads what the winner produced. Either way the same secret is in memory
  // before we attempt to bind the pipe (and reject our peer's hello if its
  // secret doesn't match).
  let secret: string;
  try {
    secret = initDaemonSecret(DAEMON_SECRET_PATH);
  } catch (err) {
    log.error('daemon secret init failed', { err: (err as Error).message });
    process.exit(1);
  }

  // --- Step 2 + 3: registry + pipe server ---
  const registry = new Registry();
  registry.start();

  let idleTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;

  // Forward-declared placeholders so the lifecycle closures below can capture
  // stable references; the real implementations are assigned right after the
  // PipeServer is constructed.
  let resetIdleTimer = (): void => {};
  let maybeArmIdleTimer = (): void => {};
  let shutdown = async (_reason: string): Promise<void> => {};

  const notifications = new NotificationCenter();
  const persistence = new SessionPersistence();

  const pipeServer = new PipeServer({
    registry,
    expectedSecret: secret,
    daemonVersion: DAEMON_VERSION,
    notifications,
    persistence,
    onClientJoin: () => resetIdleTimer(),
    onClientLeave: () => maybeArmIdleTimer(),
  });

  // Phase E: when a session dies, fan a notification to every currently
  // connected MCP client. The reason string carries the exitCode for bye
  // paths ("bye:<n>") so we can emit the more specific 'session_exited' kind.
  // Phase G: also persist the end state so master's restore tools can see it.
  registry.onSessionDeath((s, reason) => {
    const exitMatch = /^bye:(-?\d+)$/.exec(reason);
    const exitCode = exitMatch && exitMatch[1] !== undefined ? parseInt(exitMatch[1], 10) : undefined;
    notifications.fanoutSessionDead(
      pipeServer.connectedMcpClientIds(),
      s.id,
      s.label,
      reason,
      exitCode,
    );
    persistence.markEnded(s.id, reason, exitCode);
  });

  resetIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  /**
   * Idle-shutdown gate (audit C6):
   *   - zero alive sessions, AND
   *   - no MCP frame in the last MCP_IDLE_ACTIVITY_TIMEOUT_MS.
   *
   * "no MCP connections" was the wrong question: master-Claude keeps the
   * socket open for hours. The right question is "has anybody talked to me".
   * If MCP reconnects after we shut down, the MCP server's reconnect logic
   * re-spawns the daemon on the next tool call.
   */
  maybeArmIdleTimer = (): void => {
    if (shuttingDown) return;
    if (registry.aliveCount() > 0) return;
    const sinceLastMcp = Date.now() - pipeServer.getLastMcpActivityAt();
    if (sinceLastMcp < MCP_IDLE_ACTIVITY_TIMEOUT_MS) return;
    // Both gates open: shut down NOW. The earlier double-timer added a second
    // 60s grace on top of the already-elapsed quiet window — net 120s+ between
    // last activity and exit. Smoke (and humans) only wait the documented 60s.
    log.info('idle-shutdown firing', { sinceLastMcpMs: sinceLastMcp });
    void shutdown('idle');
  };

  // Registry membership changes (session add/remove/death) can affect liveness.
  registry.onChange(() => {
    if (registry.aliveCount() === 0) {
      maybeArmIdleTimer();
    } else {
      resetIdleTimer();
    }
  });

  // --- Step 2: bind the pipe (it IS the mutex) ---
  try {
    await pipeServer.start();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      // Another daemon already owns the pipe — our job is being done.
      log.info('pipe already bound, another daemon detected, exiting 0');
      process.exit(0);
    }
    log.error('pipe-server failed to start', {
      code,
      err: (err as Error).message,
    });
    process.exit(1);
  }

  // Periodically re-evaluate idle-shutdown — MCP-quiet time needs polling
  // because there is no event when "nothing happens for 60s".
  const idlePoll = setInterval(() => {
    if (registry.aliveCount() === 0) maybeArmIdleTimer();
  }, Math.min(opts.idleShutdownMs, 10_000));
  idlePoll.unref?.();

  // No connections at boot → arm timer immediately if we already crossed the
  // MCP-quiet threshold (boot time counts as "last activity").
  maybeArmIdleTimer();

  shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown', { reason });
    resetIdleTimer();
    clearInterval(idlePoll);
    registry.stop();
    try {
      await pipeServer.stop();
    } catch (err) {
      log.warn('pipe-server stop error', { err: (err as Error).message });
    }
    // Give the log queue a beat to flush before exit.
    setTimeout(() => process.exit(0), 50).unref?.();
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { err: err.message, stack: err.stack });
    // Don't exit on uncaught — log and continue. Best chance of preserving
    // session buffers for post-mortem inspection.
  });
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', {
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });

  log.info('bridged ready');
}

void main();
