// Named Pipe server for `\\.\pipe\bridge-clis`.
// Accepts BOTH cb session-owners (first frame `{t:'hello'}`) and
// MCP read/write clients (first frame `{t:'mcp_hello'}`). The per-connection
// state machine decides the role after the first frame and rejects mixed/
// unrecognized frames. This avoids two separate pipes and keeps the deploy
// surface minimal.
//
// Single-instance contract: `server.listen(PIPE_NAME)` IS the daemon mutex.
// EADDRINUSE → another daemon owns it → caller exits 0. The pre-audit
// architecture used a separate `bridge-clis-mutex` pipe, which left a TOCTOU
// window where an attacker could pre-bind the wire pipe between mutex-acquire
// and wire-listen. Audit C4 / H7.

import { Buffer } from 'node:buffer';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import {
  PIPE_NAME,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_MISS_LIMIT,
  LABEL_PATTERN,
  ENV_ALLOW_FORCE,
  SOCKET_IDLE_TIMEOUT_MS,
  READ_RAW_DEFAULT_MAX_BYTES,
  READ_TAIL_DEFAULT_LINES,
  createDecoder,
  decodeBase64Strict,
  encodeFrame,
  verifyDaemonSecret,
  type BridgedErrorMsg,
  type BridgedHelloAckMsg,
  type BridgedPingMsg,
  type CbToBridgedMsg,
  type McpHelloAckMsg,
  type McpResp,
  type McpToBridgedMsg,
  type SessionInfo,
} from '@bridge-clis/shared';
import { Registry } from './registry.js';
import { Session } from './session.js';
import { log } from './log.js';
import { redact, redactRaw } from './redact.js';
import { waitForIdle, waitForPattern, startIdleWatcher } from './wait-for.js';
import { tryInject } from './inject.js';
import type { NotificationCenter } from './notifications.js';
import type { SessionPersistence } from './persistence.js';
import type {
  HistoryResult,
  NotificationsResult,
  RestoreLookupResult,
} from '@bridge-clis/shared';

type Role = 'unknown' | 'cb' | 'mcp';

type ConnState = {
  role: Role;
  /** For cb connections, set once `hello` is processed. */
  session: Session | null;
  /** For mcp connections. */
  clientId: string | null;
  /** Heartbeat interval handle (cb only). */
  heartbeat: NodeJS.Timeout | null;
  /** Connection-id for log correlation. */
  connId: string;
};

export type PipeServerOpts = {
  registry: Registry;
  /** Shared secret loaded from DAEMON_SECRET_PATH at daemon startup (audit C4). */
  expectedSecret: string;
  /** Daemon version string included in mcp_hello_ack. */
  daemonVersion: string;
  /** Async event queue for MCP clients (Phase E). */
  notifications: NotificationCenter;
  /** Cross-restart session history (Phase G). */
  persistence: SessionPersistence;
  /** Notified on every cb-hello or mcp-hello so daemon can reset idle-shutdown timer. */
  onClientJoin?: () => void;
  /** Notified on cb-bye or mcp-disconnect. */
  onClientLeave?: () => void;
  /** Live count of connected MCP clients (idle-shutdown gate). */
  getMcpClientCount?: () => number;
};

export class PipeServer {
  private server: net.Server | null = null;
  private mcpClients = new Set<net.Socket>();
  private cbConns = new Set<net.Socket>();

  /**
   * Monotonic wall-clock of the most recent MCP frame received on ANY mcp
   * connection. Daemon's idle-shutdown logic uses this to decide whether a
   * long-lived-but-quiet MCP client should keep the daemon alive. Audit C6.
   * Initialized to "boot time" so a daemon with zero MCP traffic still has
   * a meaningful timestamp.
   */
  private lastMcpActivityAt: number = Date.now();

  /** Tracks clientIds of currently-connected MCP peers (Phase E fanout). */
  private mcpClientIdBySock = new Map<net.Socket, string>();

  constructor(private readonly opts: PipeServerOpts) {}

  mcpClientCount(): number {
    return this.mcpClients.size;
  }

  /** Last time any MCP frame arrived. Daemon reads this for idle-shutdown. */
  getLastMcpActivityAt(): number {
    return this.lastMcpActivityAt;
  }

  /** Phase E: iterate clientIds of currently-connected MCP clients. */
  connectedMcpClientIds(): string[] {
    return Array.from(this.mcpClientIdBySock.values());
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((sock) => this.handleConnection(sock));
      // One-shot bind-error handler — EADDRINUSE here means another daemon
      // owns the pipe (it IS the mutex). Caller decides whether to exit 0.
      server.once('error', (err) => reject(err));
      server.listen(PIPE_NAME, () => {
        log.info('pipe-server listening', { pipe: PIPE_NAME });
        this.server = server;
        // Replace one-shot error listener with a logging one for runtime errors.
        server.on('error', (err) => {
          log.error('pipe-server runtime error', {
            err: (err as Error).message,
          });
        });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    // Close listener; existing connections terminate via their own paths.
    for (const sock of this.mcpClients) sock.destroy();
    for (const sock of this.cbConns) sock.destroy();
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  // ------------------- per-connection -------------------

  private handleConnection(sock: net.Socket): void {
    const state: ConnState = {
      role: 'unknown',
      session: null,
      clientId: null,
      heartbeat: null,
      connId: randomBytes(8).toString('hex'),
    };
    // Default-tight decoder: first frame capped at 4KB (hello/mcp_hello fit
    // easily); subsequent frames at MAX_FRAME_BYTES (1MB). Audit H3.
    const decoder = createDecoder<CbToBridgedMsg | McpToBridgedMsg>();

    // Pre-handshake idle-timeout: drop connections that don't send a hello
    // within SOCKET_IDLE_TIMEOUT_MS (slowloris-style partial-frame attacks).
    // After role establishment we DISABLE the timeout — Master-Claude can sit
    // idle for hours between tool calls, and cb heartbeats handle liveness.
    sock.setTimeout(SOCKET_IDLE_TIMEOUT_MS);
    sock.on('timeout', () => {
      if (state.role !== 'unknown') return; // established peers exempt
      log.warn('pre-handshake idle timeout, destroying', {
        connId: state.connId,
      });
      sock.destroy();
    });

    log.debug('connection accepted', { connId: state.connId });

    sock.on('data', (chunk: Buffer) => {
      let frames: (CbToBridgedMsg | McpToBridgedMsg)[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        log.warn('frame decode error, dropping connection', {
          connId: state.connId,
          err: (err as Error).message,
        });
        // Best-effort error frame before destroy so peer can log a diagnostic.
        sendError(sock, 'frame_too_large', (err as Error).message);
        sock.destroy();
        return;
      }
      for (const frame of frames) {
        try {
          this.dispatch(sock, state, frame);
        } catch (err) {
          log.error('dispatch threw', {
            connId: state.connId,
            err: (err as Error).message,
          });
        }
      }
    });

    sock.on('error', (err) => {
      log.debug('socket error', {
        connId: state.connId,
        role: state.role,
        err: err.message,
      });
    });

    sock.on('close', () => this.handleClose(sock, state));
  }

  private dispatch(
    sock: net.Socket,
    state: ConnState,
    frame: CbToBridgedMsg | McpToBridgedMsg,
  ): void {
    // Role-establishment phase.
    if (state.role === 'unknown') {
      if (frame.t === 'hello') {
        this.acceptCb(sock, state, frame);
      } else if (frame.t === 'mcp_hello') {
        this.acceptMcp(sock, state, frame);
      } else {
        // Audit M14: previously silent-destroy → client saw opaque close.
        log.warn('first frame is neither hello nor mcp_hello, dropping', {
          connId: state.connId,
          t: (frame as { t?: string }).t ?? 'unknown',
        });
        sendError(sock, 'unknown_role', 'first frame must be hello or mcp_hello');
        sock.destroy();
      }
      return;
    }

    if (state.role === 'cb') {
      this.handleCbFrame(state, frame as CbToBridgedMsg);
    } else {
      // Every post-handshake MCP frame counts as activity, even malformed
      // ones — the gate is about "is anybody home", not "did the call succeed".
      this.lastMcpActivityAt = Date.now();
      void this.handleMcpFrame(sock, state, frame as McpToBridgedMsg);
    }
  }

  // ------------------- cb path -------------------

  private acceptCb(
    sock: net.Socket,
    state: ConnState,
    frame: Extract<CbToBridgedMsg, { t: 'hello' }>,
  ): void {
    // Audit C4 — every cb hello carries the daemon secret. Reject before any
    // session state mutates.
    if (!verifyDaemonSecret(frame.secret, this.opts.expectedSecret)) {
      log.warn('cb hello: auth_failed', { connId: state.connId });
      sendError(sock, 'auth_failed', 'bad or missing secret');
      sock.destroy();
      return;
    }

    // Audit H4 — label is forensic-log-injection vector. Validate strictly.
    const rawLabel =
      frame.session.label && frame.session.label.length > 0 ? frame.session.label : 'session';
    if (!LABEL_PATTERN.test(rawLabel)) {
      log.warn('cb hello: label_invalid', { connId: state.connId, label: rawLabel });
      sendError(sock, 'label_invalid', 'label must match [A-Za-z0-9._-]{1,64}');
      sock.destroy();
      return;
    }

    // Audit M2 — resume path. If cb says "I'm reconnecting after a blip and
    // here is my prior ULID", and we still have an alive session at that ID
    // whose pid is still alive, rebind the socket instead of creating a new
    // duplicate session with a `-2` suffix.
    if (frame.resumeSessionId) {
      const prior = this.opts.registry.byId(frame.resumeSessionId);
      if (prior && prior.status === 'alive' && isProcessAlive(prior.pid)) {
        // Detach the old socket if any — it may already be half-closed.
        const oldSock = prior.pipeClient;
        if (oldSock && oldSock !== sock) {
          this.cbConns.delete(oldSock);
          try {
            oldSock.destroy();
          } catch {
            /* ignore */
          }
        }
        prior.pipeClient = sock;
        prior.missedPongs = 0;
        prior.lastActivityAt = Date.now();
        this.cbConns.add(sock);
        state.role = 'cb';
        state.session = prior;
        this.startHeartbeat(sock, state, prior);
        this.opts.onClientJoin?.();
        sendAck(sock, {
          t: 'hello_ack',
          sessionId: prior.id,
          assignedLabel: prior.label,
          resumed: true,
        });
        log.info('cb session resumed', {
          id: prior.id,
          label: prior.label,
          connId: state.connId,
        });
        return;
      }
      // Fall through — prior is gone or dead. cb wants its old ULID back.
      // If the dead session is still in retain TTL, we evict it explicitly
      // (with a warn-log) rather than letting registry.add silently overwrite
      // it. The user reconnect supersedes any post-mortem inspection that the
      // retain window was preserving. Audit Phase-D regression-MEDIUM.
      if (prior) {
        log.warn('purging dead session to free ULID for resume', {
          id: prior.id,
          label: prior.label,
          status: prior.status,
        });
        this.opts.registry.remove(prior.id);
      }
    }

    const finalLabel = this.opts.registry.resolveLabel(rawLabel);

    const session = new Session({
      id: frame.session.id,
      label: finalLabel,
      cwd: frame.session.cwd,
      cmdline: frame.session.cmdline,
      pid: frame.session.pid,
      cols: frame.session.cols,
      rows: frame.session.rows,
      startedAt: frame.session.startedAt,
      pipeClient: sock,
    });

    this.opts.registry.add(session);
    this.cbConns.add(sock);
    state.role = 'cb';
    state.session = session;
    this.opts.onClientJoin?.();

    // Phase F: notify all currently-connected MCP clients that a fresh worker
    // appeared (NOT a resume — that path returned earlier above).
    this.opts.notifications.fanoutSessionAdded(
      this.connectedMcpClientIds(),
      session.id,
      session.label,
      session.cwd,
      session.pid,
    );

    // Phase G: persist for cross-restart restore.
    this.opts.persistence.addOrUpdate({
      id: session.id,
      label: session.label,
      cwd: session.cwd,
      cmdline: session.cmdline,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
    });

    sendAck(sock, {
      t: 'hello_ack',
      sessionId: session.id,
      assignedLabel: session.label,
      resumed: false,
    });

    this.startHeartbeat(sock, state, session);

    log.info('cb session attached', {
      id: session.id,
      label: session.label,
      pid: session.pid,
      cwd: session.cwd,
      requestedLabel: rawLabel,
    });
  }

  private startHeartbeat(sock: net.Socket, state: ConnState, session: Session): void {
    if (state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
    const ping: BridgedPingMsg = { t: 'ping' };
    state.heartbeat = setInterval(() => {
      if (sock.destroyed) return;
      session.missedPongs++;
      if (session.missedPongs > HEARTBEAT_MISS_LIMIT) {
        log.warn('cb heartbeat missed limit, marking dead', {
          id: session.id,
          label: session.label,
        });
        session.markDead('heartbeat_lost');
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      try {
        sock.write(encodeFrame(ping));
      } catch (err) {
        log.debug('cb ping write failed', {
          id: session.id,
          err: (err as Error).message,
        });
      }
    }, HEARTBEAT_INTERVAL_MS);
    state.heartbeat.unref?.();
  }

  private handleCbFrame(state: ConnState, frame: CbToBridgedMsg): void {
    const session = state.session;
    if (!session) {
      log.warn('cb frame before session bound, ignoring', { t: frame.t });
      return;
    }
    switch (frame.t) {
      case 'hello':
        // Duplicate hello on already-attached connection — ignore.
        log.warn('duplicate hello on cb connection, ignoring', { id: session.id });
        return;
      case 'stdout': {
        // Strict base64 — silent-truncate on invalid input would corrupt the
        // terminal model. Audit M12.
        const decoded = decodeBase64Strict(frame.data);
        if (!decoded) {
          log.warn('cb stdout: invalid base64, dropping frame', { id: session.id });
          return;
        }
        session.onStdout(decoded);
        return;
      }
      case 'user_input':
        session.onUserInput(frame.at);
        return;
      case 'resize':
        session.onResize(frame.cols, frame.rows);
        return;
      case 'bye':
        log.info('cb bye', { id: session.id, exitCode: frame.exitCode });
        // Phase E: fanout happens in the centralized onSessionDeath listener
        // wired from index.ts via registry.onSessionDeath(). The reason string
        // carries the exitCode for the listener to parse.
        session.markDead(`bye:${frame.exitCode}`);
        return;
      case 'pong':
        session.missedPongs = 0;
        // Audit M5: pong proves the cb peer is still talking; without bumping
        // lastActivityAt a quiet-but-healthy session appeared idle in SessionInfo.
        session.lastActivityAt = Date.now();
        return;
      default: {
        const _exhaust: never = frame;
        void _exhaust;
        log.warn('unknown cb frame', { t: (frame as { t?: string }).t });
      }
    }
  }

  // ------------------- mcp path -------------------

  private acceptMcp(
    sock: net.Socket,
    state: ConnState,
    frame: Extract<McpToBridgedMsg, { t: 'mcp_hello' }>,
  ): void {
    if (!verifyDaemonSecret(frame.secret, this.opts.expectedSecret)) {
      log.warn('mcp hello: auth_failed', { connId: state.connId });
      sendError(sock, 'auth_failed', 'bad or missing secret');
      sock.destroy();
      return;
    }
    state.role = 'mcp';
    state.clientId = frame.clientId || `mcp-${state.connId}`;
    this.mcpClients.add(sock);
    this.mcpClientIdBySock.set(sock, state.clientId);
    this.lastMcpActivityAt = Date.now();
    this.opts.onClientJoin?.();
    const ack: McpHelloAckMsg = {
      t: 'mcp_hello_ack',
      daemonVersion: this.opts.daemonVersion,
    };
    try {
      sock.write(encodeFrame(ack));
    } catch (err) {
      log.debug('mcp_hello_ack write failed', {
        connId: state.connId,
        err: (err as Error).message,
      });
    }
    log.info('mcp client attached', {
      connId: state.connId,
      clientId: state.clientId,
    });
  }

  private async handleMcpFrame(
    sock: net.Socket,
    state: ConnState,
    frame: McpToBridgedMsg,
  ): Promise<void> {
    if (frame.t === 'mcp_hello') {
      // Duplicate hello — ignore quietly.
      return;
    }

    const reqId = (frame as { reqId: string }).reqId;
    const respond = (resp: McpResp): void => {
      if (sock.destroyed) return;
      try {
        sock.write(encodeFrame(resp));
      } catch (err) {
        log.warn('mcp response write failed', {
          reqId,
          err: (err as Error).message,
        });
      }
    };

    try {
      switch (frame.t) {
        case 'list': {
          const sessions: SessionInfo[] = this.opts.registry.list().map((s) => s.toInfo());
          respond({ t: 'resp', reqId, ok: true, value: { sessions } });
          return;
        }

        case 'read_screen': {
          const s = this.opts.registry.byIdOrLabel(frame.idOrLabel);
          if (!s) {
            respond({ t: 'resp', reqId, ok: false, error: 'session_not_found' });
            return;
          }
          const snap = s.term.renderScreen();
          const redactedLines = snap.lines.map((l) => redact(l));
          respond({
            t: 'resp',
            reqId,
            ok: true,
            value: { ...snap, lines: redactedLines },
          });
          return;
        }

        case 'read_tail': {
          const s = this.opts.registry.byIdOrLabel(frame.idOrLabel);
          if (!s) {
            respond({ t: 'resp', reqId, ok: false, error: 'session_not_found' });
            return;
          }
          const n = frame.lines > 0 ? frame.lines : READ_TAIL_DEFAULT_LINES;
          const tail = s.term.renderTail(n);
          respond({
            t: 'resp',
            reqId,
            ok: true,
            value: { text: redact(tail.text), truncated: tail.truncated },
          });
          return;
        }

        case 'read_raw': {
          const s = this.opts.registry.byIdOrLabel(frame.idOrLabel);
          if (!s) {
            respond({ t: 'resp', reqId, ok: false, error: 'session_not_found' });
            return;
          }
          const sinceMs = frame.sinceMs ?? 0;
          const max = frame.maxBytes > 0 ? frame.maxBytes : READ_RAW_DEFAULT_MAX_BYTES;
          const { bytes, latestTimestamp } = s.raw.readSince(sinceMs, max);
          const { buf, warning } = redactRaw(bytes);
          respond({
            t: 'resp',
            reqId,
            ok: true,
            value: {
              bytesBase64: buf.toString('base64'),
              latestTimestamp,
              ...(warning ? { warning } : {}),
            },
          });
          return;
        }

        case 'inject_req': {
          // Audit H2: force is a security-sensitive bypass — gate behind env.
          if (frame.force && !process.env[ENV_ALLOW_FORCE]) {
            respond({
              t: 'resp',
              reqId,
              ok: false,
              error: 'force_disabled',
              details: { hint: `set ${ENV_ALLOW_FORCE}=1 to enable force` },
            });
            return;
          }
          const s = this.opts.registry.byIdOrLabel(frame.idOrLabel);
          if (!s) {
            respond({ t: 'resp', reqId, ok: false, error: 'session_not_found' });
            return;
          }
          if (s.status === 'dead') {
            respond({ t: 'resp', reqId, ok: false, error: 'session_dead' });
            return;
          }
          // Strict base64 — Buffer.from silently truncates invalid input,
          // which would inject a half-keystroke. Audit M12.
          const decoded = decodeBase64Strict(frame.bytesBase64);
          if (!decoded) {
            respond({
              t: 'resp',
              reqId,
              ok: false,
              error: 'internal_error',
              details: { reason: 'protocol_violation: bytesBase64 not strict base64' },
            });
            return;
          }
          let bytes = decoded;
          if (frame.bracketed) {
            // bracketed-paste-mode wrappers (ESC[200~ … ESC[201~).
            bytes = Buffer.concat([Buffer.from('\x1b[200~'), bytes, Buffer.from('\x1b[201~')]);
          }
          // Op classification for audit: prefer explicit clientOp from MCP layer
          // (distinguishes write/send_keys/paste); fall back to bracketed-heuristic
          // for direct daemon-pipe callers (e.g. smoke tests) that omit clientOp.
          const op: 'paste' | 'write' | 'send_keys' =
            frame.clientOp ?? (frame.bracketed ? 'paste' : 'write');
          const outcome = await tryInject(s, bytes, {
            waitForUserIdleMs: frame.waitForUserIdleMs,
            force: frame.force,
            op,
            callerId: state.clientId ?? 'unknown',
          });
          if (outcome.ok) {
            respond({
              t: 'resp',
              reqId,
              ok: true,
              value: { written: outcome.written },
            });
            // Phase E: register background idle-watcher so the originating
            // client gets a task_complete notification when the worker is done.
            // Re-injects to the same session cancel the prior watcher.
            const clientId = state.clientId ?? 'unknown';
            this.opts.notifications.registerInjectFollowup(
              clientId,
              s.id,
              s.label,
              (onResolve) => startIdleWatcher(s, { onIdle: onResolve }),
            );
          } else if (outcome.error === 'user_active') {
            respond({
              t: 'resp',
              reqId,
              ok: false,
              error: 'user_active',
              details: { silentMs: outcome.silentMs },
            });
          } else {
            respond({ t: 'resp', reqId, ok: false, error: 'session_dead' });
          }
          return;
        }

        case 'wait_for': {
          const s = this.opts.registry.byIdOrLabel(frame.idOrLabel);
          if (!s) {
            respond({ t: 'resp', reqId, ok: false, error: 'session_not_found' });
            return;
          }
          const result = await waitForPattern(s, {
            pattern: frame.pattern,
            mode: frame.mode,
            timeoutMs: frame.timeoutMs,
          });
          respond({ t: 'resp', reqId, ok: true, value: result });
          return;
        }

        case 'wait_for_idle': {
          const s = this.opts.registry.byIdOrLabel(frame.idOrLabel);
          if (!s) {
            respond({ t: 'resp', reqId, ok: false, error: 'session_not_found' });
            return;
          }
          const result = await waitForIdle(s, {
            timeoutMs: frame.timeoutMs,
            stableTicks: frame.stableTicks,
          });
          respond({ t: 'resp', reqId, ok: true, value: result });
          return;
        }

        case 'notifications': {
          // Phase E: drain async events queued for this MCP client.
          const clientId = state.clientId ?? 'unknown';
          const events = this.opts.notifications.drain(clientId);
          // Piggy-back a current live status snapshot so master always has
          // an up-to-date view even when the queue was empty.
          const sessions = this.opts.registry
            .list()
            .map((s) => ({
              label: s.label,
              status: s.status,
              activeMs: Date.now() - s.lastActivityAt,
            }));
          const value: NotificationsResult = { events, sessions };
          respond({ t: 'resp', reqId, ok: true, value });
          return;
        }

        case 'history': {
          // Phase G: persisted history of sessions across daemon restarts.
          const limit = typeof frame.limit === 'number' ? frame.limit : undefined;
          const liveOnly = frame.liveOnly === true;
          const value: HistoryResult = {
            sessions: this.opts.persistence.recent(limit, { liveOnly }),
          };
          respond({ t: 'resp', reqId, ok: true, value });
          return;
        }

        case 'restore_lookup': {
          // Phase G: return restore-blobs for labels master wants to spawn.
          // The actual window spawning happens in bridge-mcp (UI-spawning out
          // of the daemon's responsibility surface).
          if (!Array.isArray(frame.labels)) {
            respond({
              t: 'resp', reqId, ok: false, error: 'internal_error',
              details: { reason: 'labels must be an array of strings' },
            });
            return;
          }
          const labels = frame.labels.filter((l): l is string => typeof l === 'string');
          const { found, missing } = this.opts.persistence.lookupByLabels(labels);
          const value: RestoreLookupResult = { found, missing };
          respond({ t: 'resp', reqId, ok: true, value });
          return;
        }

        default: {
          // mcp_hello is filtered above; any other 't' is a protocol violation.
          respond({
            t: 'resp',
            reqId,
            ok: false,
            error: 'internal_error',
            details: { reason: 'unknown frame type', t: (frame as { t?: string }).t },
          });
        }
      }
    } catch (err) {
      log.error('mcp handler threw', {
        reqId,
        t: frame.t,
        err: (err as Error).message,
      });
      respond({
        t: 'resp',
        reqId,
        ok: false,
        error: 'internal_error',
        details: { message: (err as Error).message },
      });
    }
  }

  // ------------------- close handling -------------------

  private handleClose(sock: net.Socket, state: ConnState): void {
    if (state.heartbeat) {
      clearInterval(state.heartbeat);
      state.heartbeat = null;
    }
    if (state.role === 'cb') {
      this.cbConns.delete(sock);
      // Audit M2: only mark dead if THIS socket is still the active one.
      // A resume that rebound the session attached a NEW socket and destroyed
      // this one; the old close callback firing here must not nuke the live
      // session.
      if (
        state.session &&
        state.session.status === 'alive' &&
        state.session.pipeClient === sock
      ) {
        // Pipe closed without a `bye`. The cb process may be gone, or this is
        // a transient drop and a reconnect-with-resumeSessionId is en route.
        // We mark dead conservatively — if a resume arrives within the retain
        // window, byId() still finds the dead entry but acceptCb's
        // `prior.status === 'alive'` guard will reject resume and create a
        // new session. Future improvement: short grace period before markDead.
        state.session.markDead('pipe_closed');
      }
      log.debug('cb connection closed', { connId: state.connId });
      this.opts.onClientLeave?.();
    } else if (state.role === 'mcp') {
      this.mcpClients.delete(sock);
      this.mcpClientIdBySock.delete(sock);
      log.debug('mcp connection closed', { connId: state.connId });
      // Phase E: free any queued notifications + cancel watchers for this client.
      if (state.clientId) this.opts.notifications.clientDisconnected(state.clientId);
      this.opts.onClientLeave?.();
    } else {
      log.debug('connection closed before role established', { connId: state.connId });
    }
  }
}

// ------------------- helpers -------------------

function sendError(sock: net.Socket, code: BridgedErrorMsg['code'], message?: string): void {
  if (sock.destroyed) return;
  try {
    const frame: BridgedErrorMsg = { t: 'error', code, ...(message ? { message } : {}) };
    sock.write(encodeFrame(frame));
  } catch {
    /* best effort — we destroy the socket right after */
  }
}

function sendAck(sock: net.Socket, ack: BridgedHelloAckMsg): void {
  if (sock.destroyed) return;
  try {
    sock.write(encodeFrame(ack));
  } catch (err) {
    log.debug('hello_ack write failed', { err: (err as Error).message });
  }
}

/** Mirror of registry.isProcessAlive — duplicated to keep the resume path self-contained. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}
