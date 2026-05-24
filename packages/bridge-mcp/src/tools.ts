// Implementierung der 9 MCP-Tools. Reine Übersetzungs-Schicht:
// validate args → daemon-RPC → MCP-Tool-Response.
// Schwere Arbeit (Buffer, Render, Wait-Logik) passiert im Daemon.

import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';

import {
  DEFAULT_WAIT_FOR_USER_IDLE_MS,
  READ_RAW_DEFAULT_MAX_BYTES,
  READ_TAIL_DEFAULT_LINES,
  WAIT_FOR_IDLE_DEFAULT_STABLE_TICKS,
  WAIT_FOR_IDLE_DEFAULT_TIMEOUT_MS,
  keysToBytes,
  type HistoryResult,
  type InjectResult,
  type Key,
  type McpInjectReq,
  type NotificationsResult,
  type RawSnapshot,
  type RestoreLookupResult,
  type ScreenSnapshot,
  type SessionInfo,
  type TailSnapshot,
  type WaitForIdleResult,
  type WaitForResult,
} from '@bridge-clis/shared';

import { DaemonClient } from './daemon-client.js';
import type { ToolGates } from './tool-schemas.js';

// ---------- helpers ----------

function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Argument '${name}' must be a non-empty string`);
  }
  return v;
}

function optionalInt(v: unknown, name: string, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    throw new Error(`Argument '${name}' must be an integer`);
  }
  return v;
}

function optionalBool(v: unknown, name: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') {
    throw new Error(`Argument '${name}' must be a boolean`);
  }
  return v;
}

function parseKeys(v: unknown): Key[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error("Argument 'keys' must be a non-empty array");
  }
  const out: Key[] = [];
  for (const k of v) {
    if (typeof k === 'string') {
      out.push(k as Key);
    } else if (k && typeof k === 'object' && typeof (k as { literal?: unknown }).literal === 'string') {
      out.push({ literal: (k as { literal: string }).literal });
    } else {
      throw new Error(`Invalid Key entry: ${JSON.stringify(k)}`);
    }
  }
  return out;
}

function pickIdOrLabel(args: Record<string, unknown>): string {
  // Snake-case kommt direkt aus dem Tool-Schema; camelCase nur als interne Fallback-Toleranz.
  const v = args['id_or_label'] ?? args['idOrLabel'];
  return requireString(v, 'id_or_label');
}

function pickWriteOpts(
  args: Record<string, unknown>,
  gates: ToolGates,
): {
  waitForUserIdleMs: number;
  force: boolean;
} {
  const waitForUserIdleMs = optionalInt(
    args['wait_for_user_idle_ms'],
    'wait_for_user_idle_ms',
    DEFAULT_WAIT_FOR_USER_IDLE_MS,
  );
  if (waitForUserIdleMs < 0 || waitForUserIdleMs > 60_000) {
    throw new Error('wait_for_user_idle_ms must be 0..60000');
  }
  // H2: `force` is only honored if BRIDGE_ALLOW_FORCE=1. Otherwise we silently
  // clamp to false regardless of what the caller passed, so a prompt-injected
  // Master-Claude cannot bypass race-protection.
  const requested = optionalBool(args['force'], 'force', false);
  const force = gates.allowForce ? requested : false;
  return { waitForUserIdleMs, force };
}

/**
 * Translate a daemon-side error code into a clearer MCP tool error message.
 * The daemon may return `force_disabled` when force was passed but
 * BRIDGE_ALLOW_FORCE is not set on the daemon side (defense-in-depth : we
 * already clamp in pickWriteOpts, but the daemon enforces too).
 */
function translateDaemonError(err: Error): Error {
  const code = (err as Error & { code?: string }).code;
  if (code === 'force_disabled') {
    return new Error(
      "force is disabled (set BRIDGE_ALLOW_FORCE=1 on the daemon side to enable; this is gated to prevent prompt-injected bypass of race-protection)",
    );
  }
  if (code === 'raw_disabled') {
    return new Error(
      "bridge_read_raw is disabled (set BRIDGE_ALLOW_RAW=1 on the MCP-server side to enable; output is NOT redacted when enabled)",
    );
  }
  return err;
}

// ---------- inject builder ----------

function buildInject(
  reqId: string,
  idOrLabel: string,
  bytes: Buffer,
  bracketed: boolean,
  clientOp: 'paste' | 'write' | 'send_keys',
  waitForUserIdleMs: number,
  force: boolean,
): McpInjectReq {
  return {
    t: 'inject_req',
    reqId,
    idOrLabel,
    bytesBase64: bytes.toString('base64'),
    bracketed,
    clientOp,
    waitForUserIdleMs,
    force,
  };
}

// ---------- 9 tool handlers ----------

export type ToolHandlers = Record<
  string,
  (args: Record<string, unknown>) => Promise<unknown>
>;

export function createHandlers(client: DaemonClient, gates: ToolGates): ToolHandlers {
  return {
    async bridge_list(_args) {
      const value = await client.request<{ sessions: SessionInfo[] }>((reqId) => ({
        t: 'list',
        reqId,
      }));
      return value;
    },

    async bridge_read_screen(args) {
      const idOrLabel = pickIdOrLabel(args);
      const value = await client.request<ScreenSnapshot>((reqId) => ({
        t: 'read_screen',
        reqId,
        idOrLabel,
      }));
      return value;
    },

    async bridge_read_tail(args) {
      const idOrLabel = pickIdOrLabel(args);
      const lines = optionalInt(args['lines'], 'lines', READ_TAIL_DEFAULT_LINES);
      if (lines < 1 || lines > 10_000) {
        throw new Error('lines must be 1..10000');
      }
      const value = await client.request<TailSnapshot>((reqId) => ({
        t: 'read_tail',
        reqId,
        idOrLabel,
        lines,
      }));
      return value;
    },

    async bridge_read_raw(args) {
      // H8: hard gate. Even if a client crafts the request manually (bypassing
      // the tool list), we refuse here.
      if (!gates.allowRaw) {
        throw new Error(
          "bridge_read_raw is disabled (set BRIDGE_ALLOW_RAW=1 on the MCP-server side to enable; output is NOT redacted when enabled)",
        );
      }
      const idOrLabel = pickIdOrLabel(args);
      const maxBytes = optionalInt(args['maxBytes'], 'maxBytes', READ_RAW_DEFAULT_MAX_BYTES);
      if (maxBytes < 1 || maxBytes > 1_000_000) {
        throw new Error('maxBytes must be 1..1000000');
      }
      const sinceMsRaw = args['sinceMs'];
      let sinceMs: number | undefined;
      if (sinceMsRaw !== undefined && sinceMsRaw !== null) {
        sinceMs = optionalInt(sinceMsRaw, 'sinceMs', 0);
        // H8 also requires sinceMs >= 0 (was previously unenforced).
        if (sinceMs < 0) {
          throw new Error('sinceMs must be >= 0');
        }
      }
      const value = await client.request<RawSnapshot>((reqId) => ({
        t: 'read_raw',
        reqId,
        idOrLabel,
        sinceMs,
        maxBytes,
      }));
      // Defensive: garantiere immer eine Warnung im Response, auch wenn der Daemon sie vergisst.
      const warning = value.warning ?? 'raw output is not redacted';
      return { ...value, warning };
    },

    async bridge_write(args) {
      const idOrLabel = pickIdOrLabel(args);
      const text = requireString(args['text'], 'text');
      const { waitForUserIdleMs, force } = pickWriteOpts(args, gates);
      const bytes = Buffer.from(text, 'utf8');
      try {
        return await client.request<InjectResult>((reqId) =>
          buildInject(reqId, idOrLabel, bytes, false, 'write', waitForUserIdleMs, force),
        );
      } catch (err) {
        throw translateDaemonError(err as Error);
      }
    },

    async bridge_send_keys(args) {
      const idOrLabel = pickIdOrLabel(args);
      const keys = parseKeys(args['keys']);
      const { waitForUserIdleMs, force } = pickWriteOpts(args, gates);
      const bytes = keysToBytes(keys);
      try {
        return await client.request<InjectResult>((reqId) =>
          buildInject(reqId, idOrLabel, bytes, false, 'send_keys', waitForUserIdleMs, force),
        );
      } catch (err) {
        throw translateDaemonError(err as Error);
      }
    },

    async bridge_paste(args) {
      const idOrLabel = pickIdOrLabel(args);
      const text = requireString(args['text'], 'text');
      const { waitForUserIdleMs, force } = pickWriteOpts(args, gates);
      // Send raw text + bracketed:true. The daemon is the single source of truth for the
      // ESC[200~/ESC[201~ wrappers (and for the chunked fallback if BRIDGE_PASTE_MODE=chunked).
      // Pre-wrapping here would result in double-wrap → broken paste in Claude Code.
      const bytes = Buffer.from(text, 'utf8');
      try {
        return await client.request<InjectResult>((reqId) =>
          buildInject(reqId, idOrLabel, bytes, true, 'paste', waitForUserIdleMs, force),
        );
      } catch (err) {
        throw translateDaemonError(err as Error);
      }
    },

    async bridge_wait_for(args) {
      const idOrLabel = pickIdOrLabel(args);
      const pattern = requireString(args['pattern'], 'pattern');
      const timeoutMs = optionalInt(args['timeoutMs'], 'timeoutMs', 30_000);
      if (timeoutMs < 100 || timeoutMs > 600_000) {
        throw new Error('timeoutMs must be 100..600000');
      }
      const modeRaw = args['mode'] ?? 'substring';
      if (modeRaw !== 'substring' && modeRaw !== 'regex') {
        throw new Error("mode must be 'substring' or 'regex'");
      }
      const mode = modeRaw;
      // Per-Request-Timeout: timeoutMs + 5s Slack (Daemon timeoutet selbst).
      const value = await client.request<WaitForResult>(
        (reqId) => ({
          t: 'wait_for',
          reqId,
          idOrLabel,
          pattern,
          timeoutMs,
          mode,
        }),
        timeoutMs + 5_000,
      );
      return value;
    },

    async bridge_wait_for_idle(args) {
      const idOrLabel = pickIdOrLabel(args);
      const timeoutMs = optionalInt(
        args['timeoutMs'],
        'timeoutMs',
        WAIT_FOR_IDLE_DEFAULT_TIMEOUT_MS,
      );
      if (timeoutMs < 100 || timeoutMs > 600_000) {
        throw new Error('timeoutMs must be 100..600000');
      }
      const stableTicks = optionalInt(
        args['stableTicks'],
        'stableTicks',
        WAIT_FOR_IDLE_DEFAULT_STABLE_TICKS,
      );
      if (stableTicks < 2 || stableTicks > 50) {
        throw new Error('stableTicks must be 2..50');
      }
      const value = await client.request<WaitForIdleResult>(
        (reqId) => ({
          t: 'wait_for_idle',
          reqId,
          idOrLabel,
          timeoutMs,
          stableTicks,
        }),
        timeoutMs + 5_000,
      );
      return value;
    },

    // Phase E: drain async notification queue (worker fertig, session tot, ...).
    // Master should call this at the top of each user turn to see what changed
    // while it was idle.
    async bridge_notifications(_args) {
      const value = await client.request<NotificationsResult>((reqId) => ({
        t: 'notifications',
        reqId,
      }));
      return value;
    },

    // Phase G: persisted history of sessions across daemon restarts. Use this
    // after PC restart to see what was running last time and offer restore.
    async bridge_session_history(args) {
      const limit = optionalInt(args['limit'], 'limit', 20);
      if (limit < 1 || limit > 200) {
        throw new Error('limit must be 1..200');
      }
      const liveOnly = optionalBool(args['live_only'], 'live_only', false);
      const value = await client.request<HistoryResult>((reqId) => ({
        t: 'history',
        reqId,
        limit,
        liveOnly,
      }));
      return value;
    },

    // Convenience: send a prompt to a worker AND wait for its answer AND
    // return the result, all in one tool call. Replaces the manual chain
    // bridge_paste -> bridge_send_keys[enter] -> bridge_wait_for_idle ->
    // bridge_read_tail that master Claudes frequently forget to complete
    // (asking the user "should I wait?" instead of just doing it).
    async bridge_send_and_wait(args) {
      const idOrLabel = pickIdOrLabel(args);
      const text = requireString(args['text'], 'text');
      const sendEnter = optionalBool(args['send_enter'], 'send_enter', true);
      const waitTimeoutMs = optionalInt(args['wait_timeout_ms'], 'wait_timeout_ms', 120_000);
      if (waitTimeoutMs < 1000 || waitTimeoutMs > 600_000) {
        throw new Error('wait_timeout_ms must be 1000..600000');
      }
      const readLines = optionalInt(args['read_lines'], 'read_lines', 120);
      if (readLines < 1 || readLines > 10_000) {
        throw new Error('read_lines must be 1..10000');
      }
      const { waitForUserIdleMs, force } = pickWriteOpts(args, gates);

      // Step 1: paste the prompt (bracketed, like bridge_paste).
      const pasteBytes = Buffer.from(text, 'utf8');
      let injected = 0;
      try {
        const pasteResult = await client.request<InjectResult>((reqId) =>
          buildInject(reqId, idOrLabel, pasteBytes, true, 'paste', waitForUserIdleMs, force),
        );
        injected += pasteResult.written;
      } catch (err) {
        throw translateDaemonError(err as Error);
      }

      // Step 2: optionally press enter to submit (default true : almost always wanted).
      if (sendEnter) {
        try {
          const enterBytes = keysToBytes(['enter']);
          const enterResult = await client.request<InjectResult>((reqId) =>
            // force=true here: we just successfully paste'd, race-protection
            // already won; sending enter on top is part of the same atomic action.
            buildInject(reqId, idOrLabel, enterBytes, false, 'send_keys', 0, true),
          );
          injected += enterResult.written;
        } catch (err) {
          throw translateDaemonError(err as Error);
        }
      }

      // Step 3: wait for worker to become idle (= finished its reply).
      const idleResult = await client.request<WaitForIdleResult>(
        (reqId) => ({
          t: 'wait_for_idle',
          reqId,
          idOrLabel,
          timeoutMs: waitTimeoutMs,
          stableTicks: WAIT_FOR_IDLE_DEFAULT_STABLE_TICKS,
        }),
        waitTimeoutMs + 5_000,
      );

      // Step 4: read the tail so master can show the answer to the user.
      const tailResult = await client.request<TailSnapshot>((reqId) => ({
        t: 'read_tail',
        reqId,
        idOrLabel,
        lines: readLines,
      }));

      return {
        injected,
        idle: idleResult.idle,
        idleMs: idleResult.ms,
        tail: tailResult.text,
        truncated: tailResult.truncated,
        ...(idleResult.idle
          ? {}
          : { warning: 'Worker did not become idle within wait_timeout_ms. Tail shows partial output. Re-call bridge_wait_for_idle or bridge_read_tail to check again.' }),
      };
    },

    // Phase I: spawn a fresh worker terminal in an arbitrary cwd. Master uses
    // this for `/bridge <path>` (user-typed path argument). DO NOT call based
    // on worker output : that path is prompt-injection territory.
    async bridge_create_session(args) {
      const cwd = requireString(args['cwd'], 'cwd');
      const fs = await import('node:fs');
      const pathMod = await import('node:path');
      // Validate cwd exists + is directory. Reject obvious garbage before
      // wt.exe spawns and fails opaquely.
      let stats;
      try {
        stats = fs.statSync(cwd);
      } catch (e) {
        throw new Error(`cwd does not exist: ${cwd} (${(e as Error).message})`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`cwd is not a directory: ${cwd}`);
      }
      // Derive label: explicit > basename. Sanitize via same rules as bclaude.ps1.
      const labelInput =
        (typeof args['label'] === 'string' && args['label'].length > 0)
          ? args['label']
          : pathMod.basename(cwd);
      const label = sanitizeLabel(labelInput);
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(label)) {
        throw new Error(`could not derive a valid label from '${labelInput}' (sanitized to '${label}')`);
      }
      let method: string;
      try {
        method = await spawnRestoreWindow(label, cwd);
      } catch (e) {
        throw new Error(`spawn failed: ${(e as Error).message}`);
      }
      return {
        spawned: { label, cwd, method },
        hint: `New terminal window is opening. Wait ~3s then call bridge_list to confirm the worker registered with label '${label}'.`,
      };
    },

    // Phase G: spawn fresh terminal windows for the requested labels, each
    // starting `bclaude --label <label>` in the original cwd. Sessions must
    // exist in the persistence history : master cannot spawn arbitrary cwds.
    async bridge_restore_sessions(args) {
      const labelsRaw = args['labels'];
      if (!Array.isArray(labelsRaw) || labelsRaw.length === 0) {
        throw new Error("'labels' must be a non-empty string array");
      }
      const labels = labelsRaw.map((l) => requireString(l, 'labels[]'));
      // Look up cwd/cmdline from daemon's persistence.
      const lookup = await client.request<RestoreLookupResult>((reqId) => ({
        t: 'restore_lookup',
        reqId,
        labels,
      }));
      const spawned: Array<{ label: string; cwd: string; method: string }> = [];
      const failed: Array<{ label: string; reason: string }> = [];
      for (const s of lookup.found) {
        try {
          const method = await spawnRestoreWindow(s.label, s.cwd);
          spawned.push({ label: s.label, cwd: s.cwd, method });
        } catch (e) {
          failed.push({ label: s.label, reason: (e as Error).message });
        }
      }
      return {
        spawned,
        missing: lookup.missing,
        failed,
        hint: spawned.length > 0
          ? 'New terminal windows are opening. Use bridge_list in ~3s to see them register.'
          : (lookup.missing.length > 0
              ? `No history found for labels: ${lookup.missing.join(', ')}. Call bridge_session_history first.`
              : 'No sessions spawned.'),
      };
    },
  };
}

/**
 * Phase G: spawn a new terminal window running `bclaude --label <label>` in
 * the given cwd. Tries Windows Terminal (wt.exe) first : modern default and
 * gives proper title bars + cwd. Falls back to plain cmd.exe if wt.exe is
 * not on PATH. Detached + unrefed so we don't block.
 */
async function spawnRestoreWindow(label: string, cwd: string): Promise<string> {
  // Try wt.exe.
  const wt = process.platform === 'win32' ? findOnPath('wt.exe') : null;
  if (wt) {
    const child = spawn(
      wt,
      [
        '-w', 'new',
        '--title', `[bclaude: ${label}]`,
        '--startingDirectory', cwd,
        'cmd', '/k', 'bclaude.cmd', '--label', label,
      ],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    child.on('error', () => {/* swallow : we surface via reject path */});
    child.unref();
    return 'wt.exe';
  }
  // Fallback: plain cmd.exe "start" : opens a new console window.
  if (process.platform === 'win32') {
    const child = spawn(
      'cmd.exe',
      ['/c', 'start', '""', '/D', cwd, 'cmd.exe', '/k', 'bclaude.cmd', '--label', label],
      { detached: true, stdio: 'ignore', windowsHide: false },
    );
    child.unref();
    return 'cmd.exe/start';
  }
  throw new Error('No supported terminal launcher on this platform');
}

/**
 * Mirror of the PowerShell Sanitize-Label helper in launcher/bclaude.ps1.
 * Keeps the daemon-side LABEL_PATTERN (A-Za-z0-9._-, 1..64) happy by replacing
 * invalid chars with '-', collapsing runs, trimming separators, and falling
 * back to 'session' if nothing usable remains.
 */
function sanitizeLabel(raw: string): string {
  if (!raw) return 'session';
  let clean = raw.replace(/[^A-Za-z0-9._-]/g, '-');
  clean = clean.replace(/-+/g, '-');
  clean = clean.replace(/^[-._]+|[-._]+$/g, '');
  if (clean.length > 64) clean = clean.substring(0, 64);
  return clean || 'session';
}

function findOnPath(name: string): string | null {
  const sep = process.platform === 'win32' ? ';' : ':';
  const dirs = (process.env.PATH ?? '').split(sep).filter(Boolean);
  // Synchronous fs check is fine here : happens once per restore call.
  // We use a dynamic require to avoid pulling fs at top of the file unnecessarily.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  for (const d of dirs) {
    const p = `${d}\\${name}`;
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}
