import path from 'node:path';
import os from 'node:os';

export const PIPE_NAME = '\\\\.\\pipe\\bridge-clis';

// The wire pipe IS the mutex (single-bind contention). The separate MUTEX_NAME
// was removed after the audit revealed a TOCTOU window between binding the
// mutex pipe and the session pipe. See AUDIT.md H7.

export const BRIDGE_DIR = path.join(os.homedir(), '.bridge-clis');

// --- Lifecycle ---
export const DAEMON_IDLE_SHUTDOWN_MS = 60_000;
/** Daemon shuts down when no MCP activity for this long AND no alive sessions. */
export const MCP_IDLE_ACTIVITY_TIMEOUT_MS = 60_000;
export const DEAD_SESSION_RETAIN_MS = 5 * 60_000;
export const PID_POLL_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_MISS_LIMIT = 3;
/** Drop pipe connections that have a partial frame outstanding longer than this. */
export const SOCKET_IDLE_TIMEOUT_MS = 30_000;

// --- Buffers ---
export const RING_BUFFER_MAX_BYTES = 10 * 1024 * 1024;
export const SCROLLBACK_LINES = 5000;
/** Bounded pre-connect queue in cb's pipe client (covers daemon cold-start). */
export const PRE_CONNECT_QUEUE_MAX_BYTES = 1 * 1024 * 1024;

// --- Inject race-protection ---
export const DEFAULT_WAIT_FOR_USER_IDLE_MS = 1500;
export const USER_IDLE_HARD_CAP_MS = 10_000;

// --- wait_for_idle defaults (raised from 800/5 after audit H1) ---
export const WAIT_FOR_IDLE_DEFAULT_TIMEOUT_MS = 30_000;
export const WAIT_FOR_IDLE_DEFAULT_STABLE_TICKS = 8;
export const WAIT_FOR_IDLE_TICK_MS = 200;
export const WAIT_FOR_IDLE_MIN_SILENT_MS = 1500;

// --- Tool defaults ---
export const READ_RAW_DEFAULT_MAX_BYTES = 100_000;
export const READ_TAIL_DEFAULT_LINES = 200;

// --- Framing ---
/** Hard cap on any post-handshake frame. Down from 16MB after audit H3. */
export const MAX_FRAME_BYTES = 1 * 1024 * 1024;
/** Pre-handshake (first frame from any peer) cap — hello/mcp_hello fit easily. */
export const MAX_FIRST_FRAME_BYTES = 4 * 1024;

// --- Auth (audit C4) ---
/** Filename under BRIDGE_DIR for the per-daemon shared secret. */
export const DAEMON_SECRET_FILE_NAME = 'daemon.secret';
/** Length in bytes of the random secret (hex-encoded → 64 hex chars). */
export const DAEMON_SECRET_BYTES = 32;
export const DAEMON_SECRET_PATH = path.join(BRIDGE_DIR, DAEMON_SECRET_FILE_NAME);

// --- Label validation (audit H4) ---
/** Allowed character class + length for cb-supplied labels. */
export const LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// --- Env flags (audit H2 / H8) ---
export const ENV_ALLOW_FORCE = 'BRIDGE_ALLOW_FORCE';
export const ENV_ALLOW_RAW = 'BRIDGE_ALLOW_RAW';
export const ENV_PASTE_MODE = 'BRIDGE_PASTE_MODE'; // 'bracketed' (default) | 'chunked'
