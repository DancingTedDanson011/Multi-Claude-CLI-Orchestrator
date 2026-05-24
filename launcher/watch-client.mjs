// bclaude --watch JS-side: connects to the daemon via the pipe-helper protocol
// (same secret-auth, same wire format as bridge-mcp) and polls bridge_list +
// bridge_notifications on a tick. Renders a compact dashboard using ANSI
// cursor positioning.
//
// Phase E. Runs only against a built bridge-clis (uses @bridge-clis/shared types
// at runtime via the dist of the bridged package). To stay launcher-portable
// (no separate npm install), we re-implement the minimum framing + auth here
// instead of taking a workspace dep.

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';

const INTERVAL_MS = parseInt(process.argv[2] ?? '2000', 10);
const PIPE_NAME = '\\\\.\\pipe\\bridge-clis';
const SECRET_PATH = path.join(os.homedir(), '.bridge-clis', 'daemon.secret');
const HANDSHAKE_TIMEOUT_MS = 5000;

// --- minimal framing (matches packages/shared/src/framing.ts) ---
function encodeFrame(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

function createDecoder() {
  const chunks = [];
  let pending = 0;
  function consume(n) {
    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const first = chunks[0];
      const need = n - written;
      if (first.length <= need) {
        first.copy(out, written); written += first.length; chunks.shift();
      } else {
        first.copy(out, written, 0, need);
        chunks[0] = first.subarray(need);
        written += need;
      }
    }
    pending -= n;
    return out;
  }
  return {
    push(chunk) {
      chunks.push(chunk); pending += chunk.length;
      const out = [];
      while (pending >= 4) {
        // peek length
        let len;
        if (chunks[0].length >= 4) {
          len = chunks[0].readUInt32LE(0);
        } else {
          const hdr = consume(4); chunks.unshift(hdr); pending += 4;
          len = hdr.readUInt32LE(0);
        }
        if (pending < 4 + len) break;
        consume(4);
        const payload = consume(len);
        try { out.push(JSON.parse(payload.toString('utf8'))); }
        catch (e) { throw new Error(`bad frame: ${e.message}`); }
      }
      return out;
    },
  };
}

function readSecret() {
  if (!fs.existsSync(SECRET_PATH)) return null;
  const s = fs.readFileSync(SECRET_PATH, 'utf8').trim();
  return s || null;
}

// --- ANSI ---
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const CURSOR_HOME = '\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';

function fmt(s, color) { return `${color}${s}${RESET}`; }
function ago(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  return `${Math.floor(ms / 3_600_000)}h`;
}

function render(sessions, notifications, daemonVersion, errMsg) {
  const lines = [];
  lines.push(fmt(`bclaude watch · daemon ${daemonVersion ?? 'unknown'} · ${new Date().toLocaleTimeString()}`, BOLD));
  lines.push('');
  if (errMsg) {
    lines.push(fmt(`! ${errMsg}`, RED));
    lines.push('');
  }
  if (!sessions || sessions.length === 0) {
    lines.push(fmt('(no bridged sessions)', DIM));
  } else {
    lines.push(`${BOLD}  ${'LABEL'.padEnd(20)} ${'STATUS'.padEnd(8)} ${'PID'.padEnd(8)} ${'IDLE FOR'.padEnd(10)} ${'CWD'}${RESET}`);
    for (const s of sessions) {
      const statusColored =
        s.status === 'alive' ? fmt(s.status.padEnd(8), GREEN) :
        fmt(s.status.padEnd(8), RED);
      const idleMs = Date.now() - s.lastActivityAt;
      const idle = ago(idleMs).padEnd(10);
      const cwd = (s.cwd ?? '').length > 40 ? '…' + s.cwd.slice(-39) : s.cwd ?? '';
      lines.push(`  ${s.label.padEnd(20)} ${statusColored} ${String(s.pid).padEnd(8)} ${idle} ${cwd}`);
    }
  }
  lines.push('');
  if (notifications && notifications.length > 0) {
    lines.push(fmt(`recent notifications:`, YELLOW));
    for (const n of notifications.slice(-5)) {
      const when = ago(Date.now() - n.ts);
      lines.push(`  ${fmt(when.padEnd(6), DIM)} ${fmt(n.kind, CYAN)} → ${n.label}`);
    }
  } else {
    lines.push(fmt('(no recent notifications)', DIM));
  }
  lines.push('');
  lines.push(fmt(`Press Ctrl-C to exit · refresh every ${INTERVAL_MS}ms`, DIM));
  return lines.join('\n');
}

// --- main loop ---
async function main() {
  process.stdout.write(HIDE_CURSOR);
  process.on('exit', () => process.stdout.write(SHOW_CURSOR));
  process.on('SIGINT', () => {
    process.stdout.write(SHOW_CURSOR + '\n');
    process.exit(0);
  });

  let sock = null;
  let decoder = null;
  let connected = false;
  let pending = new Map();
  let reqCounter = 0;
  let daemonVersion = null;
  const recentNotifs = [];

  function nextReqId() { return `watch-${++reqCounter}`; }

  function request(msgBuilder) {
    return new Promise((resolve, reject) => {
      if (!connected || !sock) return reject(new Error('not connected'));
      const reqId = nextReqId();
      pending.set(reqId, { resolve, reject });
      const msg = msgBuilder(reqId);
      try { sock.write(encodeFrame(msg)); }
      catch (e) { pending.delete(reqId); reject(e); }
      setTimeout(() => {
        if (pending.has(reqId)) { pending.delete(reqId); reject(new Error('timeout')); }
      }, 10_000);
    });
  }

  async function connect() {
    return new Promise((resolve, reject) => {
      const secret = readSecret();
      if (!secret) return reject(new Error('daemon secret not readable yet'));
      const s = net.createConnection({ path: PIPE_NAME });
      const d = createDecoder();
      const timeout = setTimeout(() => {
        try { s.destroy(); } catch {}
        reject(new Error('connect timed out'));
      }, HANDSHAKE_TIMEOUT_MS);

      s.on('error', err => {
        clearTimeout(timeout); reject(err);
      });
      s.on('connect', () => {
        const clientId = `watch-${randomBytes(4).toString('hex')}`;
        s.write(encodeFrame({ t: 'mcp_hello', clientId, secret }));
      });
      s.on('data', chunk => {
        let frames;
        try { frames = d.push(chunk); }
        catch (e) { clearTimeout(timeout); reject(e); return; }
        for (const f of frames) {
          if (f.t === 'mcp_hello_ack') {
            clearTimeout(timeout);
            daemonVersion = f.daemonVersion;
            sock = s; decoder = d; connected = true;
            s.on('data', onData); // re-subscribe for steady-state handling
            // remove the handshake-only handler by detaching this listener implicitly through cleanup
            resolve();
            return;
          }
          if (f.t === 'error') {
            clearTimeout(timeout);
            reject(new Error(`daemon error: ${f.code} ${f.message ?? ''}`));
            return;
          }
        }
      });
      s.on('close', () => {
        connected = false;
        sock = null;
      });

      function onData(chunk) {
        let frames;
        try { frames = d.push(chunk); }
        catch { return; }
        for (const f of frames) {
          if (f.t === 'resp' && pending.has(f.reqId)) {
            const p = pending.get(f.reqId); pending.delete(f.reqId);
            if (f.ok) p.resolve(f.value); else p.reject(new Error(f.error));
          }
        }
      }
    });
  }

  let lastErr = null;
  async function tick() {
    if (!connected) {
      try { await connect(); lastErr = null; }
      catch (e) { lastErr = e.message; }
    }
    let sessions = [];
    let notifs = [];
    if (connected) {
      try {
        const listResp = await request(reqId => ({ t: 'list', reqId }));
        sessions = listResp.sessions ?? [];
        const notifResp = await request(reqId => ({ t: 'notifications', reqId }));
        const newEvents = notifResp.events ?? [];
        for (const e of newEvents) recentNotifs.push(e);
        if (recentNotifs.length > 20) recentNotifs.splice(0, recentNotifs.length - 20);
        notifs = recentNotifs;
        lastErr = null;
      } catch (e) {
        lastErr = e.message;
        try { sock?.destroy(); } catch {}
        connected = false; sock = null;
      }
    }
    process.stdout.write(CLEAR_SCREEN + render(sessions, notifs, daemonVersion, lastErr));
  }

  await tick();
  setInterval(tick, INTERVAL_MS);
}

main().catch(err => {
  process.stdout.write(SHOW_CURSOR + '\n');
  console.error(`watch fatal: ${err.message}`);
  process.exit(1);
});
