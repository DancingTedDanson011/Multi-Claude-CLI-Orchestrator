// Named-Pipe-Client zum bridged-Daemon.
// - Connect mit Auto-Spawn-Fallback (gleiche Logik wie cb).
// - Authenticated mcp_hello-Handshake (audit C4) + echtes mcp_hello_ack-Wait (audit M10).
// - Request/Response-Korrelation via reqId.
// - Reconnect mit linearem Backoff (1s → 30s).
// - Hartes per-Request-Timeout: 60s.
//
// Wichtig: dieser Client darf NICHTS auf stdout/stderr loggen, sobald MCP-Handshake
// gelaufen ist (StdioServerTransport teilt sich stdin/stdout mit Master-Claude).
// Stattdessen → File-Log via writeLog().

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Buffer } from 'node:buffer';

import {
  PIPE_NAME,
  DAEMON_SECRET_PATH,
  readDaemonSecretWithRetry,
  encodeFrame,
  createDecoder,
  type McpResp,
  type McpToBridgedMsg,
  type McpHelloAckMsg,
  type BridgedErrorMsg,
  type BridgedToMcpMsg,
  type Decoder,
} from '@bridge-clis/shared';

const REQUEST_TIMEOUT_MS = 60_000;
const HANDSHAKE_ACK_TIMEOUT_MS = 5_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const SPAWN_RETRY_MS = 250;
const SPAWN_RETRY_MAX = 12; // ~3s

// ---------- Logging (file only, never stdio) ----------

const LOG_DIR = path.join(os.homedir(), '.bridge-clis');
const LOG_FILE = path.join(LOG_DIR, 'bridge-mcp.log');

function writeLog(line: string): void {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Logging-Fehler dürfen den MCP-Server nicht töten.
  }
}

// ---------- Daemon-Pfad-Resolution ----------

/**
 * Daemon-Script-Pfad relativ zu dist/index.js suchen.
 * Bundled-Layout: bridge-mcp.cjs und bridged.cjs liegen nebeneinander.
 * Dev-Layout: dist/index.js → ../../../bridged/dist/index.js (Monorepo).
 */
function resolveDaemonScript(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '..', '..', 'bridged', 'dist', 'index.js'), // dev: packages/bridge-mcp/dist → packages/bridged/dist
    path.resolve(here, 'bridged.cjs'),                              // bundled layout
    path.resolve(here, '..', 'bridged', 'dist', 'index.js'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* keep going */
    }
  }
  return null;
}

function trySpawnDaemon(): void {
  const script = resolveDaemonScript();
  if (!script) {
    writeLog('spawnDaemon: no daemon script found, skipping');
    return;
  }
  try {
    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    writeLog(`spawnDaemon: launched pid=${child.pid ?? 'unknown'} script=${script}`);
  } catch (err) {
    writeLog(`spawnDaemon: failed: ${(err as Error).message}`);
  }
}

// ---------- Connect with retry ----------

function connectOnce(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(PIPE_NAME);
    const onErr = (err: Error): void => {
      sock.removeListener('connect', onOk);
      reject(err);
    };
    const onOk = (): void => {
      sock.removeListener('error', onErr);
      resolve(sock);
    };
    sock.once('error', onErr);
    sock.once('connect', onOk);
  });
}

async function connectWithSpawn(): Promise<net.Socket> {
  try {
    return await connectOnce();
  } catch {
    // Pipe nicht erreichbar → Daemon hochfahren und re-try.
    trySpawnDaemon();
    let lastErr: Error | null = null;
    for (let i = 0; i < SPAWN_RETRY_MAX; i++) {
      await sleep(SPAWN_RETRY_MS);
      try {
        return await connectOnce();
      } catch (err) {
        lastErr = err as Error;
      }
    }
    throw lastErr ?? new Error('daemon did not come up within budget');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- Client ----------

type Pending = {
  resolve: (v: McpResp) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/** Pre-response frames the daemon may emit on the same socket. */
type AnyInbound = (BridgedToMcpMsg | McpResp) & { t: string; reqId?: string };

export class DaemonClient {
  private readonly clientId = randomUUID();
  private socket: net.Socket | null = null;
  private decoder: Decoder<AnyInbound> = createDecoder<AnyInbound>();
  private pending = new Map<string, Pending>();
  private connecting: Promise<void> | null = null;
  private reconnectAttempts = 0;
  private closed = false;
  private cachedSecret: string | null = null;
  private lastDaemonVersion: string | null = null;
  /** Pre-ack waiters get resolved/rejected by the data handler. */
  private helloAckWaiter: {
    resolve: (v: McpHelloAckMsg) => void;
    reject: (e: Error) => void;
  } | null = null;

  async ensureConnected(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  /** Last successful handshake's daemon version, if any. Used for startup logging. */
  getDaemonVersion(): string | null {
    return this.lastDaemonVersion;
  }

  private async ensureSecret(): Promise<string> {
    if (this.cachedSecret) return this.cachedSecret;
    const s = await readDaemonSecretWithRetry(DAEMON_SECRET_PATH);
    if (!s) {
      throw new Error(`daemon secret not readable at ${DAEMON_SECRET_PATH}`);
    }
    this.cachedSecret = s;
    return s;
  }

  private async doConnect(): Promise<void> {
    const sock = await connectWithSpawn();
    this.socket = sock;
    this.decoder = createDecoder<AnyInbound>();

    sock.on('data', (chunk: Buffer) => {
      let frames: AnyInbound[];
      try {
        frames = this.decoder.push(chunk);
      } catch (err) {
        writeLog(`decoder error: ${(err as Error).message}`);
        sock.destroy();
        return;
      }
      for (const frame of frames) {
        this.routeFrame(frame);
      }
    });

    sock.on('error', (err) => {
      writeLog(`socket error: ${err.message}`);
    });

    sock.on('close', () => {
      this.socket = null;
      // Tear down any pending handshake.
      if (this.helloAckWaiter) {
        this.helloAckWaiter.reject(new Error('daemon socket closed during handshake'));
        this.helloAckWaiter = null;
      }
      this.failAllPending(new Error('daemon connection closed'));
      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    // Read+send authenticated mcp_hello (audit C4) and WAIT for the ack (audit M10).
    let secret: string;
    try {
      secret = await this.ensureSecret();
    } catch (err) {
      writeLog(`secret read failed: ${(err as Error).message}`);
      sock.destroy();
      throw err;
    }

    const helloMsg = { t: 'mcp_hello' as const, clientId: this.clientId, secret };
    try {
      sock.write(encodeFrame(helloMsg));
    } catch (err) {
      writeLog(`mcp_hello write failed: ${(err as Error).message}`);
      sock.destroy();
      throw err;
    }

    try {
      const ack = await this.waitForHelloAck();
      this.lastDaemonVersion = ack.daemonVersion;
      writeLog(`mcp_hello_ack received (daemon=${ack.daemonVersion})`);
    } catch (err) {
      writeLog(`mcp_hello_ack failed: ${(err as Error).message}`);
      try { sock.destroy(); } catch { /* ignore */ }
      throw err;
    }

    this.reconnectAttempts = 0;
  }

  private waitForHelloAck(): Promise<McpHelloAckMsg> {
    return new Promise<McpHelloAckMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helloAckWaiter = null;
        reject(new Error(`mcp_hello_ack timeout after ${HANDSHAKE_ACK_TIMEOUT_MS}ms`));
      }, HANDSHAKE_ACK_TIMEOUT_MS);
      timer.unref();
      this.helloAckWaiter = {
        resolve: (v) => { clearTimeout(timer); this.helloAckWaiter = null; resolve(v); },
        reject:  (e) => { clearTimeout(timer); this.helloAckWaiter = null; reject(e); },
      };
    });
  }

  private routeFrame(frame: AnyInbound): void {
    if (!frame || typeof frame !== 'object' || typeof frame.t !== 'string') {
      writeLog(`malformed inbound frame: ${JSON.stringify(frame)}`);
      return;
    }
    switch (frame.t) {
      case 'mcp_hello_ack': {
        if (this.helloAckWaiter) {
          this.helloAckWaiter.resolve(frame as McpHelloAckMsg);
        } else {
          writeLog('mcp_hello_ack arrived with no waiter — ignoring');
        }
        return;
      }
      case 'error': {
        const err = frame as BridgedErrorMsg;
        if (this.helloAckWaiter) {
          this.helloAckWaiter.reject(
            new Error(`daemon error during handshake: code=${err.code} msg=${err.message ?? ''}`),
          );
        } else {
          // Mid-session error frame — log and ignore. Daemon will close.
          writeLog(`daemon error frame: code=${err.code} msg=${err.message ?? ''}`);
        }
        return;
      }
      case 'resp': {
        this.dispatch(frame as McpResp);
        return;
      }
      default: {
        writeLog(`unknown frame type from daemon: ${(frame as { t?: string }).t}`);
      }
    }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_MIN_MS * Math.max(1, this.reconnectAttempts),
    );
    writeLog(`reconnect scheduled in ${delay}ms (attempt ${this.reconnectAttempts})`);
    setTimeout(() => {
      if (this.closed) return;
      this.ensureConnected().catch((err) => {
        writeLog(`reconnect failed: ${(err as Error).message}`);
      });
    }, delay).unref();
  }

  private dispatch(resp: McpResp): void {
    const p = this.pending.get(resp.reqId);
    if (!p) {
      writeLog(`orphan response reqId=${resp.reqId}`);
      return;
    }
    clearTimeout(p.timer);
    this.pending.delete(resp.reqId);
    p.resolve(resp);
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private sendRaw(msg: McpToBridgedMsg): void {
    const sock = this.socket;
    if (!sock || sock.destroyed) {
      throw new Error('daemon not connected');
    }
    sock.write(encodeFrame(msg));
  }

  /** Sendet eine RPC und wartet auf die zugehörige Response. */
  async request<T>(
    build: (reqId: string) => McpToBridgedMsg,
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    await this.ensureConnected();
    const reqId = randomUUID();
    const msg = build(reqId);

    const resp = await new Promise<McpResp>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`request timeout after ${timeoutMs}ms (t=${msg.t})`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.sendRaw(msg);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(err as Error);
      }
    });

    if (!resp.ok) {
      const e = new Error(resp.error || 'daemon error');
      (e as Error & { details?: unknown; code?: string }).details = resp.details;
      (e as Error & { details?: unknown; code?: string }).code = resp.error;
      throw e;
    }
    return resp.value as T;
  }

  close(): void {
    this.closed = true;
    this.failAllPending(new Error('client closed'));
    if (this.helloAckWaiter) {
      this.helloAckWaiter.reject(new Error('client closed during handshake'));
      this.helloAckWaiter = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }
}

export { writeLog };
