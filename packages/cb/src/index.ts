#!/usr/bin/env node
// cb — transparent PTY wrapper that bridges interactive CLIs to the bridged daemon.
//
// Usage:
//   cb [--label <name>] [--no-bridge] <cmd> [args...]
//   cb --help | -h
//
// Output discipline: nothing ever goes to the user's terminal except via PTY passthrough.
// All daemon-related errors are written silently to ~/.bridge-clis/cb.log.

// CI-debug only: when BRIDGE_CB_DEBUG is set, dump every uncaught error to
// stderr immediately. Otherwise cb stays silent (transparent wrapper contract).
if (process.env['BRIDGE_CB_DEBUG']) {
  process.stderr.write(`[cb-debug] pid=${process.pid} starting, argv=${JSON.stringify(process.argv)}\n`);
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[cb-debug] uncaughtException: ${(e as Error).stack ?? String(e)}\n`);
    process.exit(91);
  });
  process.on('unhandledRejection', (e) => {
    process.stderr.write(`[cb-debug] unhandledRejection: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    process.exit(92);
  });
}

import path from 'node:path';
import { ulid } from 'ulid';
import { log } from './log.js';
import { spawnPty, initialSize } from './pty.js';
import { PipeClient, type SessionMeta } from './pipe-client.js';
import { ensureDaemonRunning } from './spawn-daemon.js';

type ParsedArgs = {
  label?: string;
  noBridge: boolean;
  help: boolean;
  cmd?: string;
  cmdArgs: string[];
  parseError?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { noBridge: false, help: false, cmdArgs: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === undefined) break;
    if (a === '--help' || a === '-h') {
      out.help = true;
      i++;
      continue;
    }
    if (a === '--no-bridge') {
      out.noBridge = true;
      i++;
      continue;
    }
    if (a === '--label') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        out.parseError = '--label requires a value';
        return out;
      }
      out.label = v;
      i += 2;
      continue;
    }
    // First non-flag positional is the command. Everything after is argv-passthrough.
    out.cmd = a;
    out.cmdArgs = argv.slice(i + 1);
    break;
  }
  return out;
}

function printUsage(): void {
  // Stderr per spec for --help.
  process.stderr.write(
    [
      'Usage: cb [--label <name>] [--no-bridge] <cmd> [args...]',
      '',
      'Options:',
      '  --label <name>   Session label (default: basename of cwd)',
      '  --no-bridge      Skip daemon bridging — pure PTY passthrough',
      '  -h, --help       Show this help',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (args.parseError) {
    process.stderr.write(`cb: ${args.parseError}\n`);
    printUsage();
    process.exit(2);
  }
  if (!args.cmd) {
    process.stderr.write('cb: missing command\n');
    printUsage();
    process.exit(2);
  }

  const cwd = process.cwd();
  const label = (args.label ?? path.basename(cwd)) || 'session';
  const id = ulid();
  const startedAt = Date.now();
  const { cols, rows } = initialSize();

  log.info('cb starting', { cmd: args.cmd, args: args.cmdArgs, label, id, noBridge: args.noBridge });

  // Phase E: set OSC window title so the user can identify bridged sessions
  // in the taskbar / Alt-Tab. We set it ONCE at startup; if the inner program
  // (Claude Code) later sets its own title, we let it — fighting over the
  // title is a worse UX than just an initial hint.
  if (process.stdout.isTTY) {
    try {
      process.stdout.write(`\x1b]0;[bclaude: ${label}]\x07`);
    } catch { /* ignore */ }
  }

  // --no-bridge: pure PTY passthrough, no daemon paths at all.
  if (args.noBridge) {
    spawnPty(args.cmd, args.cmdArgs, {
      onExit: (exitCode, signal) => {
        log.info('child exited', { exitCode, signal });
        process.exit(exitCode);
      },
    });
    return;
  }

  // Bridged mode: best-effort daemon spawn, then wire up the pipe client.
  // We do NOT await daemon-ready before spawning the PTY — user must not
  // perceive any startup latency. The pipe client handles connect/reconnect silently.
  void ensureDaemonRunning().catch(err => {
    log.error('ensureDaemonRunning threw', { err: (err as Error).message });
  });

  const sessionMeta: SessionMeta = {
    id,
    label,
    cwd,
    cmdline: [args.cmd, ...args.cmdArgs],
    pid: process.pid, // updated below to child.pid once spawn returns
    cols,
    rows,
    startedAt,
  };

  let pipe: PipeClient | null = null;
  let childExited = false;
  // Mutable label tracker: starts with locally-computed value, replaced by
  // daemon-assigned label after hello_ack (audit C4 / additional fix).
  let activeLabel = label;

  const ptyHandle = spawnPty(args.cmd, args.cmdArgs, {
    onData: chunk => {
      // Stdout already written to process.stdout by pty.ts BEFORE this callback.
      // Order matters: user-visible output must not lag behind daemon notifications.
      // Pre-handshake chunks are queued by PipeClient (audit C2 bounded FIFO).
      pipe?.sendStdout(chunk);
    },
    onStdin: _chunk => {
      // ONLY throttled user_input notification. The full `stdin` frame was
      // removed after audit M4 to avoid leaking passwords typed at sub-shell
      // prompts (sudo etc.). The throttled signal is what drives
      // wait_for_user_idle on the daemon side; the actual keystrokes never
      // leave the cb process.
      pipe?.notifyUserInput();
    },
    onResize: (c, r) => {
      pipe?.sendResize(c, r);
    },
    onExit: (exitCode, signal) => {
      childExited = true;
      log.info('child exited', { exitCode, signal });
      // Best-effort bye. Do not block exit on the pipe.
      try {
        pipe?.sendByeBestEffort(exitCode);
      } catch {
        /* ignore */
      }
      // Give the bye frame a tiny window to flush, then exit.
      setTimeout(() => {
        try {
          pipe?.shutdown();
        } catch {
          /* ignore */
        }
        process.exit(exitCode);
      }, 50);
    },
  });

  // Now that PTY is up, update the pid we report to the daemon to the actual child pid.
  sessionMeta.pid = ptyHandle.pid;

  pipe = new PipeClient(sessionMeta, {
    onInject: data => {
      // Daemon -> PTY. Write verbatim bytes.
      ptyHandle.write(data);
    },
    onConnect: () => {
      log.info('bridged', { label: activeLabel, id: sessionMeta.id });
    },
    onHelloAck: (assignedLabel, resumed) => {
      // Daemon may have auto-suffixed the label (`hwm-2` etc.). Adopt it for
      // future logs but emit nothing user-visible — cb stays transparent.
      if (assignedLabel && assignedLabel !== activeLabel) {
        log.info('label remapped by daemon', { from: activeLabel, to: assignedLabel });
        activeLabel = assignedLabel;
      }
      if (resumed) {
        log.info('session resumed (rebound by daemon)', { id: sessionMeta.id });
      }
    },
    onAuthFailed: msg => {
      // Daemon refused auth (bad/stale secret, daemon mismatch). cb stays
      // transparent: shut down the pipe and continue as a normal PTY wrapper.
      // The user keeps their session — they just lose bridging until they
      // restart cb (and the daemon-secret is regenerated/re-read).
      log.error('daemon auth failed — continuing unbridged', { msg });
      try { pipe?.shutdown(); } catch { /* ignore */ }
      pipe = null;
    },
    onDead: () => {
      // Silent. log.warn already done inside PipeClient.
    },
  });
  pipe.start();

  // Defensive: if the host process is asked to terminate, try to send bye.
  const onHostExit = (sig: NodeJS.Signals): void => {
    if (childExited) return;
    log.info('host signal — forwarding to child', { sig });
    // Do not kill child here — pty.ts already wires SIGINT/SIGTERM to kill the child,
    // which triggers onExit -> bye -> process.exit above.
  };
  process.on('SIGINT', () => onHostExit('SIGINT'));
  process.on('SIGTERM', () => onHostExit('SIGTERM'));
}

main().catch(err => {
  // Last-resort: log and exit. Never throw to the user terminal.
  log.error('cb top-level error', { err: (err as Error).message, stack: (err as Error).stack });
  // We still need to terminate — but only via stderr if pty hasn't taken over the terminal yet.
  // If PTY is already active, raw mode is set; writing here is acceptable as we're exiting anyway.
  process.exit(1);
});
