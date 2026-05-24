// node-pty wrapper. Transparent stdin/stdout passthrough, resize handling.
// Pure byte forwarding. We do not inspect or modify PTY output.

import * as pty from 'node-pty';
import { log } from './log.js';

export type PtyHandlers = {
  /** Called for every PTY stdout chunk. Always written to process.stdout first. */
  onData?: (chunk: Buffer) => void;
  /** Called for every user stdin chunk (after raw-mode capture). */
  onStdin?: (chunk: Buffer) => void;
  /** Called on terminal resize, after PTY has been resized. */
  onResize?: (cols: number, rows: number) => void;
  /** Called when the child process exits. cb's own exit code follows this. */
  onExit?: (exitCode: number, signal?: number) => void;
};

export type PtyHandle = {
  write(buf: Buffer | string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  readonly pid: number;
  readonly cols: number;
  readonly rows: number;
};

function termSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 120;
  const rows = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 36;
  return { cols, rows };
}

export function spawnPty(cmd: string, args: string[], handlers: PtyHandlers): PtyHandle {
  const { cols, rows } = termSize();

  const child = pty.spawn(cmd, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    // node-pty types are loose here; merge with current env so user shell config works.
    env: { ...process.env } as { [key: string]: string },
  });

  // PTY output -> user terminal + optional callback.
  // Order: write to stdout FIRST so the user-visible UI never lags behind the daemon notification.
  child.onData((data: string) => {
    const buf = Buffer.from(data, 'utf8');
    try {
      process.stdout.write(buf);
    } catch (e) {
      log.error('stdout write failed', { err: (e as Error).message });
    }
    handlers.onData?.(buf);
  });

  child.onExit(({ exitCode, signal }) => {
    handlers.onExit?.(exitCode, signal);
  });

  // Stdin: raw mode, byte-for-byte forwarding to PTY.
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
    } catch (e) {
      log.warn('setRawMode failed', { err: (e as Error).message });
    }
  }
  process.stdin.resume();

  process.stdin.on('data', (chunk: Buffer) => {
    try {
      child.write(chunk.toString('utf8'));
    } catch (e) {
      log.error('pty write failed', { err: (e as Error).message });
    }
    handlers.onStdin?.(chunk);
  });

  // Windows: 'resize' event on stdout. SIGWINCH is POSIX-only.
  const onResize = (): void => {
    const { cols: c, rows: r } = termSize();
    try {
      child.resize(c, r);
    } catch (e) {
      log.warn('pty resize failed', { err: (e as Error).message });
    }
    handlers.onResize?.(c, r);
  };
  process.stdout.on('resize', onResize);

  // Signal cleanup. On Windows, SIGINT may arrive on Ctrl-C if raw mode is off;
  // in raw mode, Ctrl-C bytes go through stdin to the PTY. We still wire these
  // as a defensive net so cb doesn't outlive the child on host-issued signals.
  const killChild = (sig: NodeJS.Signals): void => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    log.info('cb received signal', { sig });
  };
  process.on('SIGINT', () => killChild('SIGINT'));
  process.on('SIGTERM', () => killChild('SIGTERM'));

  return {
    write(buf: Buffer | string): void {
      const s = typeof buf === 'string' ? buf : buf.toString('utf8');
      try {
        child.write(s);
      } catch (e) {
        log.error('pty inject write failed', { err: (e as Error).message });
      }
    },
    resize(c: number, r: number): void {
      try {
        child.resize(c, r);
      } catch (e) {
        log.warn('pty manual resize failed', { err: (e as Error).message });
      }
    },
    kill(signal?: string): void {
      try {
        child.kill(signal);
      } catch {
        /* ignore */
      }
    },
    get pid(): number {
      return child.pid;
    },
    get cols(): number {
      return (child as unknown as { cols: number }).cols ?? cols;
    },
    get rows(): number {
      return (child as unknown as { rows: number }).rows ?? rows;
    },
  };
}

export function initialSize(): { cols: number; rows: number } {
  return termSize();
}
