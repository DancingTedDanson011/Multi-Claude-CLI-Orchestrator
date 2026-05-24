// tests/smoke/pipe-helper.ts
//
// Minimal client that speaks the bridged daemon's MCP-client protocol
// directly over the Named Pipe — no MCP SDK layer.
// Used by smoke tests to assert end-to-end daemon behavior without
// requiring claude or @modelcontextprotocol/sdk to be present.
//
// After audit C4 the daemon requires an authenticated mcp_hello with the
// shared secret + we wait for mcp_hello_ack (audit M10). After audit M8 the
// default `force` flag for inject() is FALSE so race-protection is exercised
// for real.

import net from 'node:net';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import {
  PIPE_NAME,
  DAEMON_SECRET_PATH,
  readDaemonSecretWithRetry,
  encodeFrame,
  createDecoder,
  type McpToBridgedMsg,
  type McpResp,
  type SessionInfo,
  type ScreenSnapshot,
  type TailSnapshot,
  type WaitForResult,
  type WaitForIdleResult,
  type InjectResult,
} from '@bridge-clis/shared';

type Pending = {
  resolve: (v: McpResp) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

const HANDSHAKE_ACK_TIMEOUT_MS = 5_000;

export class PipeHelper {
  private socket: net.Socket | null = null;
  private decoder = createDecoder<{ t: string; reqId?: string } & Record<string, unknown>>();
  private pending = new Map<string, Pending>();
  private connected = false;
  private clientId = `smoke-${randomUUID().slice(0, 8)}`;
  private ackWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  async connect(timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      try {
        await this.tryConnectOnce();
        return;
      } catch (e) {
        lastErr = e as Error;
        await sleep(150);
      }
    }
    throw new Error(`pipe connect timed out after ${timeoutMs}ms: ${lastErr?.message}`);
  }

  private async tryConnectOnce(): Promise<void> {
    // Read the daemon secret before opening the socket so we fail fast if it's
    // missing (= daemon never came up cleanly).
    const secret = await readDaemonSecretWithRetry(DAEMON_SECRET_PATH, 10, 100);
    if (!secret) {
      throw new Error(`daemon secret not readable at ${DAEMON_SECRET_PATH}`);
    }

    await new Promise<void>((resolve, reject) => {
      const s = net.connect(PIPE_NAME);
      const onErr = (e: Error) => {
        s.removeAllListeners();
        reject(e);
      };
      s.once('error', onErr);
      s.once('connect', () => {
        s.removeListener('error', onErr);
        this.socket = s;
        this.connected = true;
        this.attachHandlers(s);
        const hello: McpToBridgedMsg = { t: 'mcp_hello', clientId: this.clientId, secret };
        s.write(encodeFrame(hello));
        resolve();
      });
    });

    // Wait for mcp_hello_ack before claiming success (audit M10).
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiter = null;
        reject(new Error(`mcp_hello_ack timeout after ${HANDSHAKE_ACK_TIMEOUT_MS}ms`));
      }, HANDSHAKE_ACK_TIMEOUT_MS);
      this.ackWaiter = {
        resolve: () => { clearTimeout(timer); this.ackWaiter = null; resolve(); },
        reject:  (e) => { clearTimeout(timer); this.ackWaiter = null; reject(e); },
      };
    });
  }

  private attachHandlers(s: net.Socket) {
    s.on('data', chunk => {
      let frames;
      try {
        frames = this.decoder.push(chunk);
      } catch (e) {
        // Fatal decoder error — reject all pending
        for (const p of this.pending.values()) p.reject(e as Error);
        this.pending.clear();
        if (this.ackWaiter) this.ackWaiter.reject(e as Error);
        s.destroy();
        return;
      }
      for (const f of frames) {
        if (f.t === 'mcp_hello_ack') {
          this.ackWaiter?.resolve();
          continue;
        }
        if (f.t === 'error') {
          const err = new Error(`daemon error: code=${(f as { code?: string }).code} msg=${(f as { message?: string }).message ?? ''}`);
          if (this.ackWaiter) this.ackWaiter.reject(err);
          else {
            for (const p of this.pending.values()) p.reject(err);
            this.pending.clear();
          }
          continue;
        }
        if (f.t === 'resp' && typeof f.reqId === 'string') {
          const pend = this.pending.get(f.reqId);
          if (pend) {
            clearTimeout(pend.timer);
            this.pending.delete(f.reqId);
            pend.resolve(f as unknown as McpResp);
          }
        }
        // pings/other frames: ignore
      }
    });
    s.on('close', () => {
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new Error('pipe closed before response'));
      this.pending.clear();
      if (this.ackWaiter) this.ackWaiter.reject(new Error('pipe closed during handshake'));
    });
    s.on('error', () => { /* surfaced via close */ });
  }

  close(): void {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private rpc<T>(msg: Omit<McpToBridgedMsg, 'reqId'> & { t: string }, timeoutMs = 10_000): Promise<T> {
    if (!this.socket || !this.connected) {
      return Promise.reject(new Error('not connected'));
    }
    const reqId = randomUUID();
    const fullMsg = { ...msg, reqId } as McpToBridgedMsg;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`RPC timeout (${msg.t}, ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(reqId, {
        resolve: (r: McpResp) => {
          if (r.ok) resolve(r.value as T);
          else reject(new Error(`bridged error: ${r.error}`));
        },
        reject,
        timer,
      });
      this.socket!.write(encodeFrame(fullMsg));
    });
  }

  // ------------ typed wrappers ------------

  list(): Promise<{ sessions: SessionInfo[] }> {
    return this.rpc({ t: 'list' });
  }

  readScreen(idOrLabel: string): Promise<ScreenSnapshot> {
    return this.rpc({ t: 'read_screen', idOrLabel });
  }

  readTail(idOrLabel: string, lines: number): Promise<TailSnapshot> {
    return this.rpc({ t: 'read_tail', idOrLabel, lines });
  }

  /**
   * Sends raw bytes (no bracketed-paste wrapper by default) — equivalent to bridge_write.
   * NOTE: `force` defaults to FALSE (audit M8). Pass `{ force: true }` only in tests that
   * explicitly want to bypass race-protection.
   */
  inject(
    idOrLabel: string,
    bytes: Buffer | string,
    opts?: { bracketed?: boolean; force?: boolean; waitForUserIdleMs?: number },
  ): Promise<InjectResult> {
    const b = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
    return this.rpc({
      t: 'inject_req',
      idOrLabel,
      bytesBase64: b.toString('base64'),
      bracketed: opts?.bracketed ?? false,
      force: opts?.force ?? false, // audit M8: default false to exercise race-protection.
      ...(opts?.waitForUserIdleMs !== undefined ? { waitForUserIdleMs: opts.waitForUserIdleMs } : {}),
    });
  }

  /** Send a raw user_input frame (no throttling). Used by tests to simulate typing. */
  sendUserInput(at: number = Date.now()): void {
    if (!this.socket || !this.connected) return;
    // user_input is a CB->bridged frame; tests cheat by sending it on an MCP
    // socket so the daemon's per-session typing tracker would NOT update.
    // For real coverage we'd need to drive a real cb. This is a noop kept for
    // API symmetry — actual race coverage uses the `tests/smoke/run.ts` flow
    // that types into the real PTY via stdin.
    this.socket.write(encodeFrame({ t: 'user_input', at }));
  }

  waitFor(idOrLabel: string, pattern: string, timeoutMs = 5000, mode: 'substring' | 'regex' = 'substring'): Promise<WaitForResult> {
    return this.rpc({ t: 'wait_for', idOrLabel, pattern, timeoutMs, mode }, timeoutMs + 2_000);
  }

  waitForIdle(idOrLabel: string, timeoutMs = 10_000, stableTicks = 5): Promise<WaitForIdleResult> {
    return this.rpc({ t: 'wait_for_idle', idOrLabel, timeoutMs, stableTicks }, timeoutMs + 2_000);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
