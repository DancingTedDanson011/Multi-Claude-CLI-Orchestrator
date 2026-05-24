// Daemon-side rotating file logger for ~/.bridge-clis/bridged.log.
// Never writes to stdout/stderr — the daemon may be detached with stdio: 'ignore',
// so anything sent there would be silently dropped or, worse, fill an inherited
// pipe and block. All operational telemetry MUST go through this file logger.

import { promises as fsp, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const LOG_DIR = path.join(homedir(), '.bridge-clis');
const LOG_FILE = path.join(LOG_DIR, 'bridged.log');
const MAX_BYTES = 1 * 1024 * 1024; // 1MB before rotation
const MAX_ROTATIONS = 3;

let ensured = false;

function ensureDirSync(): void {
  if (ensured) return;
  try {
    if (!existsSync(LOG_DIR)) {
      mkdirSync(LOG_DIR, { recursive: true });
    }
    ensured = true;
  } catch {
    // swallow
  }
}

function rotateIfNeeded(): void {
  try {
    if (!existsSync(LOG_FILE)) return;
    const s = statSync(LOG_FILE);
    if (s.size < MAX_BYTES) return;
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const src = `${LOG_FILE}.${i}`;
      const dst = `${LOG_FILE}.${i + 1}`;
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      renameSync(LOG_FILE, `${LOG_FILE}.1`);
    } catch {
      /* ignore */
    }
  } catch {
    // swallow
  }
}

function formatLine(level: string, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const pid = process.pid;
  const metaStr = meta ? ` ${safeJson(meta)}` : '';
  return `${ts} pid=${pid} ${level} ${msg}${metaStr}\n`;
}

function safeJson(o: unknown): string {
  try {
    return JSON.stringify(o);
  } catch {
    return '"[unserializable]"';
  }
}

async function write(level: string, msg: string, meta?: Record<string, unknown>): Promise<void> {
  ensureDirSync();
  rotateIfNeeded();
  const line = formatLine(level, msg, meta);
  try {
    await fsp.appendFile(LOG_FILE, line, { encoding: 'utf8' });
  } catch {
    // swallow
  }
}

export const log = {
  info(msg: string, meta?: Record<string, unknown>): void {
    void write('INFO', msg, meta);
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    void write('WARN', msg, meta);
  },
  error(msg: string, meta?: Record<string, unknown>): void {
    void write('ERROR', msg, meta);
  },
  debug(msg: string, meta?: Record<string, unknown>): void {
    void write('DEBUG', msg, meta);
  },
};

export const LOG_PATH = LOG_FILE;
export const BRIDGE_DIR = LOG_DIR;
