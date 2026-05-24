// Named-Pipe client to the bridged daemon.
// - Length-prefixed JSON framing via @bridge-clis/shared.
// - Silent reconnect loop on disconnect.
// - Heartbeat tracking: 3 missed pings -> mark dead, reconnect.
// - Throttled user_input notifications for race-protection.
// - Bounded pre-connect queue (audit C2) absorbs PTY output before daemon ack.
// - Authenticated hello (audit C4) with daemon-secret + hello_ack handling.
// - Resume-by-ULID on reconnect (audit M2).

import net from 'node:net';
import {
  PIPE_NAME,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISS_LIMIT,
  PRE_CONNECT_QUEUE_MAX_BYTES,
  DAEMON_SECRET_PATH,
  readDaemonSecretWithRetry,
  createDecoder,
  encodeFrame,
  type CbToBridgedMsg,
  type BridgedToCbMsg,
} from '@bridge-clis/shared';
import { log } from './log.js';

// Cold-start: daemon usually binds the pipe within ~200ms of spawn. A 5s
// reconnect interval starves the first hello when smoke / Master-Claude only
// wait 3s. Use 300ms initially, growing exponentially to 5s cap.
const RECONNECT_INITIAL_MS = 300;
const RECONNECT_MAX_MS = 5000;
const USER_INPUT_THROTTLE_MS = 200;
// Detect missed pings: if we haven't seen one in ~3 heartbeat intervals, treat daemon as dead.
const PING_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISS_LIMIT;

export type PipeClientHandlers = {
  onConnect?: () => void;
  onInject?: (data: Buffer) => void;
  onDead?: () => void;
  /** Called once the daemon ack confirms label assignment. */
  onHelloAck?: (assignedLabel: string, resumed: boolean) => void;
  /** Called when daemon refuses the handshake (bad secret, label etc.) — fatal. */
  onAuthFailed?: (message: string | undefined) => void;
};

export type SessionMeta = {
  id: string;
  label: string;
  cwd: string;
  cmdline: string[];
  pid: number;
  cols: number;
  rows: number;
  startedAt: number;
};

export class PipeClient {
  private socket: net.Socket | null = null;
  private decoder = createDecoder<BridgedToCbMsg>();
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingWatchdog: NodeJS.Timeout | null = null;
  private lastPingAt = 0;
  private lastUserInputSentAt = 0;
  private loggedDownOnce = false;
  private shuttingDown = false;
  private isReconnect = false;
  private secret: string | null = null;
  private secretFetchInFlight: Promise<string | null> | null = null;
  /** Pre-handshake FIFO. Anything pushed here is drained verbatim on connect (audit C2). */
  private preConnectQueue: Buffer[] = [];
  private preConnectBytes = 0;
  private readonly handlers: PipeClientHandlers;
  private readonly sessionMeta: SessionMeta;

  constructor(sessionMeta: SessionMeta, handlers: PipeClientHandlers = {}) {
    this.sessionMeta = sessionMeta;
    this.handlers = handlers;
  }

  start(): void {
    this.connect();
  }

  /** Send a frame; queues if not connected so we never drop pre-handshake data. */
  send(msg: CbToBridgedMsg): void {
    const buf = encodeFrame(msg);
    if (!this.connected || !this.socket) {
      this.enqueuePreConnect(buf);
      return;
    }
    try {
      this.socket.write(buf);
    } catch (e) {
      log.warn('pipe send failed', { err: (e as Error).message, t: msg.t });
    }
  }

  /** Stdout chunk -> base64 -> stdout frame. Always queues pre-connect (audit C2). */
  sendStdout(chunk: Buffer): void {
    this.send({ t: 'stdout', data: chunk.toString('base64') });
  }

  /** Throttled to <=1 per USER_INPUT_THROTTLE_MS (200ms). */
  notifyUserInput(): void {
    const now = Date.now();
    if (now - this.lastUserInputSentAt < USER_INPUT_THROTTLE_MS) return;
    this.lastUserInputSentAt = now;
    this.send({ t: 'user_input', at: now });
  }

  sendResize(cols: number, rows: number): void {
    this.send({ t: 'resize', cols, rows });
  }

  /** Best-effort bye. Does not block exit; caller should not await network. */
  sendByeBestEffort(exitCode: number): void {
    if (!this.connected || !this.socket) return;
    try {
      this.socket.write(encodeFrame({ t: 'bye', exitCode } as CbToBridgedMsg));
    } catch {
      /* ignore — exiting anyway */
    }
  }

  /** Cleanly stop reconnects and close socket. */
  shutdown(): void {
    this.shuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingWatchdog) {
      clearInterval(this.pingWatchdog);
      this.pingWatchdog = null;
    }
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ---------- internal ----------

  private enqueuePreConnect(buf: Buffer): void {
    // Bounded by PRE_CONNECT_QUEUE_MAX_BYTES. Evict oldest on overflow.
    this.preConnectQueue.push(buf);
    this.preConnectBytes += buf.length;
    let evicted = 0;
    while (this.preConnectBytes > PRE_CONNECT_QUEUE_MAX_BYTES && this.preConnectQueue.length > 1) {
      const dropped = this.preConnectQueue.shift();
      if (!dropped) break;
      this.preConnectBytes -= dropped.length;
      evicted += dropped.length;
    }
    if (evicted > 0) {
      log.warn('pre-connect queue overflow — evicted oldest frames', {
        evictedBytes: evicted,
        queuedBytes: this.preConnectBytes,
        cap: PRE_CONNECT_QUEUE_MAX_BYTES,
      });
    }
  }

  private async ensureSecret(): Promise<string | null> {
    if (this.secret) return this.secret;
    if (!this.secretFetchInFlight) {
      this.secretFetchInFlight = readDaemonSecretWithRetry(DAEMON_SECRET_PATH).then(s => {
        this.secret = s;
        this.secretFetchInFlight = null;
        return s;
      });
    }
    return this.secretFetchInFlight;
  }

  private connect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const sock = net.createConnection({ path: PIPE_NAME });
    this.socket = sock;
    this.decoder = createDecoder<BridgedToCbMsg>();

    sock.once('connect', () => {
      // Async secret fetch then hello + drain. We do NOT set this.connected until
      // after the drain so any concurrent sendStdout calls still queue correctly.
      void this.handleOnConnect(sock).catch(err => {
        log.error('hello/drain failed', { err: (err as Error).message });
        try { sock.destroy(); } catch { /* ignore */ }
      });
    });

    sock.on('data', (chunk: Buffer) => {
      let frames: BridgedToCbMsg[];
      try {
        frames = this.decoder.push(chunk);
      } catch (e) {
        log.error('frame decode failed; closing socket', { err: (e as Error).message });
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      for (const msg of frames) this.handleInbound(msg);
    });

    const onClose = (err?: Error | boolean): void => {
      const wasConnected = this.connected;
      this.connected = false;
      if (this.pingWatchdog) {
        clearInterval(this.pingWatchdog);
        this.pingWatchdog = null;
      }
      this.socket = null;
      if (this.shuttingDown) return;
      // Future connects are reconnects → ask daemon to rebind original ULID (audit M2).
      this.isReconnect = true;
      if (wasConnected || !this.loggedDownOnce) {
        if (!this.loggedDownOnce) {
          log.warn('daemon down — entering reconnect loop', {
            err: err instanceof Error ? err.message : undefined,
          });
          this.loggedDownOnce = true;
        }
        this.handlers.onDead?.();
      }
      this.scheduleReconnect();
    };

    sock.on('error', (err: Error) => {
      // First failure during connect: don't spam, just schedule reconnect.
      if (!this.connected) {
        if (!this.loggedDownOnce) {
          log.warn('daemon connect failed', { err: err.message });
          this.loggedDownOnce = true;
        }
      } else {
        log.warn('pipe socket error', { err: err.message });
      }
    });

    sock.on('close', () => onClose());
  }

  private async handleOnConnect(sock: net.Socket): Promise<void> {
    this.lastPingAt = Date.now();
    log.info('pipe connected (handshaking)', { label: this.sessionMeta.label });

    // Fetch secret. Without it we cannot authenticate — fatal for cb (audit C4).
    const secret = await this.ensureSecret();
    if (!secret) {
      log.error('daemon secret unavailable — cannot authenticate; cb will exit', {
        path: DAEMON_SECRET_PATH,
      });
      this.handlers.onAuthFailed?.('daemon secret unavailable');
      try { sock.destroy(); } catch { /* ignore */ }
      return;
    }

    // Send authenticated hello. Include resumeSessionId on reconnect (audit M2).
    const hello: CbToBridgedMsg = {
      t: 'hello',
      secret,
      session: { ...this.sessionMeta },
      ...(this.isReconnect ? { resumeSessionId: this.sessionMeta.id } : {}),
    };
    try {
      sock.write(encodeFrame(hello));
    } catch (e) {
      log.warn('hello write failed', { err: (e as Error).message });
      try { sock.destroy(); } catch { /* ignore */ }
      return;
    }

    // Drain queued frames in order. Anything pushed during this microtask still
    // goes into the queue because this.connected is still false.
    const queued = this.preConnectQueue;
    this.preConnectQueue = [];
    this.preConnectBytes = 0;
    if (queued.length > 0) {
      log.info('draining pre-connect queue', { frames: queued.length });
      for (const buf of queued) {
        try {
          sock.write(buf);
        } catch (e) {
          log.warn('pre-connect drain write failed', { err: (e as Error).message });
        }
      }
    }

    // NOW we are live. Flip the flag last so the queue absorbs anything that
    // raced this microtask.
    this.connected = true;
    this.loggedDownOnce = false;
    this.reconnectAttempts = 0;
    this.startPingWatchdog();
    this.handlers.onConnect?.();
  }

  private reconnectAttempts = 0;

  private scheduleReconnect(): void {
    if (this.shuttingDown) return;
    if (this.reconnectTimer) return;
    const attempt = this.reconnectAttempts++;
    // Exponential: 300 → 600 → 1200 → 2400 → 4800 → 5000 (capped).
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_INITIAL_MS * Math.pow(2, attempt));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPingWatchdog(): void {
    if (this.pingWatchdog) clearInterval(this.pingWatchdog);
    // Check every heartbeat interval; if no ping for PING_TIMEOUT_MS, declare dead.
    this.pingWatchdog = setInterval(() => {
      if (!this.connected) return;
      if (Date.now() - this.lastPingAt > PING_TIMEOUT_MS) {
        log.warn('heartbeat lost — closing socket and reconnecting', {
          sincePingMs: Date.now() - this.lastPingAt,
        });
        try {
          this.socket?.destroy();
        } catch {
          /* ignore */
        }
        // 'close' handler will schedule reconnect.
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private handleInbound(msg: BridgedToCbMsg): void {
    switch (msg.t) {
      case 'ping': {
        this.lastPingAt = Date.now();
        this.send({ t: 'pong' });
        return;
      }
      case 'inject': {
        let buf: Buffer;
        try {
          buf = Buffer.from(msg.data, 'base64');
        } catch (e) {
          log.warn('inject decode failed', { err: (e as Error).message });
          return;
        }
        this.handlers.onInject?.(buf);
        return;
      }
      case 'hello_ack': {
        log.info('hello acknowledged', {
          assignedLabel: msg.assignedLabel,
          resumed: msg.resumed,
          sessionId: msg.sessionId,
        });
        this.handlers.onHelloAck?.(msg.assignedLabel, msg.resumed);
        return;
      }
      case 'error': {
        // Out-of-band error frame from daemon (handshake failure etc.).
        log.error('daemon error frame', { code: msg.code, message: msg.message });
        if (msg.code === 'auth_failed') {
          this.handlers.onAuthFailed?.(msg.message);
        }
        return;
      }
      default: {
        // Unknown message — log and ignore.
        log.warn('unknown inbound message', { msg: msg as unknown });
      }
    }
  }
}
