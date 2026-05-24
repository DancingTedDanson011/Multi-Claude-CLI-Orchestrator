// Append-only audit log for all Master→Session writes.
// Format: one JSON object per line (audit H4). Switching from k=v to JSON
// removes the audit-injection vector where a session label containing `=`,
// quotes, control chars or Unicode line-separators could forge fake records.
// JSON.stringify always escapes those.
//
// Writes go through a single long-lived appendable stream (audit M3) — the
// pre-audit appendFileSync blocked the event loop on every inject. The
// stream is reopened after rotation. We DO NOT await the write before
// returning from audit(); ordering is preserved by the stream's internal
// queue and a fatal write error is logged via the file logger.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  type WriteStream,
} from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { BRIDGE_DIR, log } from './log.js';

const AUDIT_FILE = path.join(BRIDGE_DIR, 'audit.log');
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_ROTATIONS = 5;

let ensured = false;
function ensureDirSync(): void {
  if (ensured) return;
  try {
    if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
    ensured = true;
  } catch {
    // swallow
  }
}

let stream: WriteStream | null = null;
let streamBytes = 0;

function openStream(): WriteStream {
  ensureDirSync();
  // Track existing size so rotation can fire even on first open after restart.
  try {
    streamBytes = existsSync(AUDIT_FILE) ? statSync(AUDIT_FILE).size : 0;
  } catch {
    streamBytes = 0;
  }
  const s = createWriteStream(AUDIT_FILE, { flags: 'a', encoding: 'utf8' });
  s.on('error', (err) => {
    log.error('audit stream error', { err: (err as Error).message });
  });
  return s;
}

function getStream(): WriteStream {
  if (stream) return stream;
  stream = openStream();
  return stream;
}

function rotateIfNeeded(nextLineBytes: number): void {
  if (streamBytes + nextLineBytes < MAX_BYTES) return;
  // Close the current stream synchronously-ish, rename, reopen.
  const old = stream;
  stream = null;
  if (old) {
    try {
      old.end();
    } catch {
      /* ignore */
    }
  }
  try {
    if (!existsSync(AUDIT_FILE)) return;
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const src = `${AUDIT_FILE}.${i}`;
      const dst = `${AUDIT_FILE}.${i + 1}`;
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
    } catch {
      /* ignore */
    }
  } catch {
    // swallow
  }
  // Force re-open on next getStream().
  streamBytes = 0;
}

export type AuditOp = 'paste' | 'write' | 'send_keys';

export function audit(params: {
  op: AuditOp;
  sessionLabel: string;
  bytes: number;
  callerId: string;
}): void {
  // JSON.stringify handles all the escaping the old sanitize() pretended to:
  // newlines, quotes, control chars, Unicode line-separators.
  const record = {
    ts: new Date().toISOString(),
    op: params.op,
    session: params.sessionLabel,
    bytes: params.bytes,
    caller: params.callerId,
  };
  let line: string;
  try {
    line = JSON.stringify(record) + '\n';
  } catch (err) {
    log.error('audit serialize failed', { err: (err as Error).message });
    return;
  }
  const byteLen = Buffer.byteLength(line, 'utf8');
  rotateIfNeeded(byteLen);
  const s = getStream();
  try {
    s.write(line);
    streamBytes += byteLen;
  } catch (err) {
    log.error('audit write failed', { err: (err as Error).message });
  }
}

export const AUDIT_PATH = AUDIT_FILE;
