// IPC wire protocol. Length-prefixed JSON over Named Pipe.
// See DESIGN.md §5, EXECUTION.md Anhang C, AUDIT.md C4 (auth) + M2 (resume) + M10 (mcp_hello_ack) + M14 (error frame).

// =====================================================================
// cb (session owner) ↔ bridged
// =====================================================================

export type CbHelloMsg = {
  t: 'hello';
  /** Shared secret read from DAEMON_SECRET_PATH. Required after audit C4. */
  secret: string;
  session: {
    id: string;
    label: string;
    cwd: string;
    cmdline: string[];
    pid: number;
    cols: number;
    rows: number;
    startedAt: number;
  };
  /**
   * If set, cb is reconnecting after a transient drop and asks the daemon to
   * rebind the existing Session of this ULID (audit M2). Daemon may refuse if
   * the prior session is fully purged or pid no longer alive — in which case
   * a new session is created with the provided id.
   */
  resumeSessionId?: string;
};

/** Daemon's reply to a successful hello — confirms label assignment (auto-suffix). */
export type BridgedHelloAckMsg = {
  t: 'hello_ack';
  sessionId: string;
  /** Actual label assigned (may differ from requested due to auto-suffix). */
  assignedLabel: string;
  /** True when a prior session of resumeSessionId was rebound. */
  resumed: boolean;
};

export type CbStdoutMsg = { t: 'stdout'; data: string }; // base64
export type CbUserInputMsg = { t: 'user_input'; at: number }; // throttled, race-protection
export type CbResizeMsg = { t: 'resize'; cols: number; rows: number };
export type CbByeMsg = { t: 'bye'; exitCode: number };
export type CbPongMsg = { t: 'pong' };

// `stdin` (full base64 keystroke payload) was removed after audit M4 to avoid
// leaking passwords typed at sub-shell prompts. The throttled `user_input`
// frame is now the canonical race-protection signal.

export type CbToBridgedMsg =
  | CbHelloMsg
  | CbStdoutMsg
  | CbUserInputMsg
  | CbResizeMsg
  | CbByeMsg
  | CbPongMsg;

export type BridgedInjectMsg = { t: 'inject'; data: string }; // base64
export type BridgedPingMsg = { t: 'ping' };

export type BridgedToCbMsg =
  | BridgedInjectMsg
  | BridgedPingMsg
  | BridgedHelloAckMsg
  | BridgedErrorMsg;

// =====================================================================
// mcp-client ↔ bridged
// =====================================================================

export type McpHelloMsg = {
  t: 'mcp_hello';
  clientId: string;
  /** Shared secret. Required after audit C4. */
  secret: string;
};

/** Daemon's ack to a verified mcp_hello. Replaces the optimistic 100ms wait. */
export type McpHelloAckMsg = {
  t: 'mcp_hello_ack';
  daemonVersion: string;
};

export type McpListReq = { t: 'list'; reqId: string };

export type McpReadScreenReq = {
  t: 'read_screen';
  reqId: string;
  idOrLabel: string;
};

export type McpReadTailReq = {
  t: 'read_tail';
  reqId: string;
  idOrLabel: string;
  lines: number;
};

export type McpReadRawReq = {
  t: 'read_raw';
  reqId: string;
  idOrLabel: string;
  sinceMs?: number;
  maxBytes: number;
};

export type McpInjectReq = {
  t: 'inject_req';
  reqId: string;
  idOrLabel: string;
  bytesBase64: string;
  /** Daemon wraps payload with ESC[200~/ESC[201~ when true. Single source of truth. */
  bracketed: boolean;
  /** For audit attribution; daemon falls back to bracketed-heuristic if absent. */
  clientOp?: 'paste' | 'write' | 'send_keys';
  waitForUserIdleMs?: number;
  /** Bypasses race-protection. Daemon rejects unless ENV_ALLOW_FORCE is set (audit H2). */
  force?: boolean;
};

export type McpWaitForReq = {
  t: 'wait_for';
  reqId: string;
  idOrLabel: string;
  pattern: string;
  timeoutMs: number;
  mode: 'regex' | 'substring';
};

export type McpWaitForIdleReq = {
  t: 'wait_for_idle';
  reqId: string;
  idOrLabel: string;
  timeoutMs: number;
  stableTicks: number;
};

/**
 * Drain the daemon-side notification queue for this MCP client.
 * Returns all events since last call AND empties the queue. Phase E.
 */
export type McpNotificationsReq = {
  t: 'notifications';
  reqId: string;
};

/**
 * Phase G: return the persisted session history (recent N entries) so master
 * can show "what was running last time" and offer to restore.
 */
export type McpHistoryReq = {
  t: 'history';
  reqId: string;
  limit?: number;
  /** If true, only return sessions that did NOT have endedAt set (= live at last shutdown). */
  liveOnly?: boolean;
};

/**
 * Phase G: ask the daemon to look up the named labels in history AND return
 * their full restore-blob. The MCP layer (NOT the daemon) does the actual
 * window spawning — keeps daemon UI-free.
 */
export type McpRestoreLookupReq = {
  t: 'restore_lookup';
  reqId: string;
  labels: string[];
};

export type McpToBridgedMsg =
  | McpHelloMsg
  | McpListReq
  | McpReadScreenReq
  | McpReadTailReq
  | McpReadRawReq
  | McpInjectReq
  | McpWaitForReq
  | McpWaitForIdleReq
  | McpNotificationsReq
  | McpHistoryReq
  | McpRestoreLookupReq;

// =====================================================================
// bridged → any client: responses + errors
// =====================================================================

export type McpRespOk<T> = {
  t: 'resp';
  reqId: string;
  ok: true;
  value: T;
};

export type McpRespErr = {
  t: 'resp';
  reqId: string;
  ok: false;
  error: string;
  details?: unknown;
};

export type McpResp<T = unknown> = McpRespOk<T> | McpRespErr;

/**
 * Out-of-band error frame for handshake / protocol failures (no reqId).
 * Sent immediately before destroying the connection so clients can log a
 * useful diagnostic instead of an opaque socket-close (audit M14).
 */
export type BridgedErrorMsg = {
  t: 'error';
  code:
    | 'auth_failed'
    | 'unknown_role'
    | 'label_invalid'
    | 'protocol_violation'
    | 'frame_too_large'
    | 'internal_error';
  message?: string;
};

export type BridgedToMcpMsg = McpResp | BridgedErrorMsg | McpHelloAckMsg;

// =====================================================================
// value shapes returned over MCP
// =====================================================================

export type SessionInfo = {
  id: string;
  label: string;
  cwd: string;
  /** ALWAYS redacted in MCP responses (audit C5). */
  cmdline: string[];
  pid: number;
  status: 'alive' | 'dead';
  startedAt: number;
  lastActivityAt: number;
  lineCount: number;
};

export type ScreenSnapshot = {
  cols: number;
  rows: number;
  lines: string[];
  cursor: { row: number; col: number };
};

export type TailSnapshot = {
  text: string;
  truncated: boolean;
};

export type RawSnapshot = {
  bytesBase64: string;
  latestTimestamp: number;
  warning?: string;
};

export type WaitForResult = {
  matched: boolean;
  matchedLine?: string;
  ms: number;
};

export type WaitForIdleResult = {
  idle: boolean;
  ms: number;
};

export type InjectResult = {
  written: number;
};

/**
 * Async event the daemon queues per MCP-client. Drained by bridge_notifications.
 * Phase E + F.
 */
export type BridgeNotification = {
  id: string;          // ULID-ish, monotonic, for client-side dedup/ordering
  ts: number;
  sessionId: string;
  label: string;
  kind: 'session_added' | 'task_complete' | 'session_dead' | 'session_exited';
  details?: {
    silentForMs?: number;     // task_complete
    exitCode?: number;        // session_exited
    reason?: string;          // session_dead
    cwd?: string;             // session_added (Phase F: helpful identifier)
    pid?: number;             // session_added
  };
};

export type NotificationsResult = {
  events: BridgeNotification[];
  /** Live status snapshot piggy-backed so the master sees current state too. */
  sessions: Array<{ label: string; status: 'alive' | 'dead'; activeMs: number }>;
};

/**
 * Phase G: persisted session record (what the daemon writes to disk so
 * sessions survive daemon restarts for restore purposes).
 */
export type PersistedSession = {
  id: string;
  label: string;
  cwd: string;
  /** Full original cmdline from cb hello (e.g. ["npx","--yes","@anthropic-ai/claude-code","--dangerously-skip-permissions"]). */
  cmdline: string[];
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  exitCode?: number;
  endReason?: string;
};

export type HistoryResult = {
  sessions: PersistedSession[];
};

export type RestoreLookupResult = {
  found: PersistedSession[];
  missing: string[];
};

// =====================================================================
// error codes used in McpRespErr.error
// =====================================================================

export type BridgedErrorCode =
  | 'session_not_found'
  | 'session_dead'
  | 'user_active'
  | 'pattern_invalid'
  | 'timeout'
  | 'raw_disabled'
  | 'force_disabled'
  | 'internal_error';
