// Phase G — session persistence.
//
// Persists the session registry to ~/.bridge-clis/sessions.json so master can
// see "what was open last time" after a daemon (or PC) restart.
//
// Atomic-write pattern: write to .tmp, fsync, rename. JSON format with a
// `version` field so future schema migrations have a hook.
//
// Capped at MAX_ENTRIES — oldest "endedAt" entries evicted first. Currently
// alive sessions (no endedAt) are NEVER evicted, even if their lastActivityAt
// is old.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { BRIDGE_DIR, type PersistedSession } from '@bridge-clis/shared';
import { log } from './log.js';

const FILE = path.join(BRIDGE_DIR, 'sessions.json');
const TMP = `${FILE}.tmp`;
const MAX_ENTRIES = 100;
const SCHEMA_VERSION = 1;

type FileShape = {
  version: number;
  sessions: PersistedSession[];
};

function ensureDir(): void {
  try {
    if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
  } catch {
    // Best effort — write will fail and be caught below.
  }
}

function load(): PersistedSession[] {
  try {
    if (!existsSync(FILE)) return [];
    const raw = readFileSync(FILE, 'utf8');
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as Partial<FileShape>;
    if (!Array.isArray(parsed?.sessions)) return [];
    return parsed.sessions.filter(
      (s): s is PersistedSession =>
        typeof s === 'object' &&
        s !== null &&
        typeof s.id === 'string' &&
        typeof s.label === 'string' &&
        typeof s.cwd === 'string' &&
        Array.isArray(s.cmdline),
    );
  } catch (err) {
    log.warn('persistence load failed; starting with empty history', {
      err: (err as Error).message,
    });
    return [];
  }
}

function persist(sessions: PersistedSession[]): void {
  ensureDir();
  try {
    const body: FileShape = { version: SCHEMA_VERSION, sessions };
    writeFileSync(TMP, JSON.stringify(body, null, 2), { encoding: 'utf8' });
    renameSync(TMP, FILE);
  } catch (err) {
    log.warn('persistence write failed', { err: (err as Error).message });
  }
}

function evictIfOverflow(sessions: PersistedSession[]): PersistedSession[] {
  if (sessions.length <= MAX_ENTRIES) return sessions;
  // Keep all alive (endedAt undefined); among ended, keep the most-recent ones.
  const alive = sessions.filter((s) => s.endedAt === undefined);
  const ended = sessions
    .filter((s) => s.endedAt !== undefined)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const room = Math.max(0, MAX_ENTRIES - alive.length);
  return [...alive, ...ended.slice(0, room)];
}

export class SessionPersistence {
  private state: PersistedSession[];

  constructor() {
    this.state = load();
    log.info('persistence loaded', {
      file: FILE,
      entries: this.state.length,
      alive: this.state.filter((s) => s.endedAt === undefined).length,
    });
    // On startup, mark all previously-alive sessions as ended with reason
    // "daemon_shutdown" — they cannot really be still-alive after our restart.
    // We keep them in history (so master can offer to restore them) but flip
    // the endedAt field so subsequent queries know they're stale.
    let mutated = false;
    const now = Date.now();
    for (const s of this.state) {
      if (s.endedAt === undefined) {
        s.endedAt = now;
        s.endReason = 'daemon_shutdown';
        mutated = true;
      }
    }
    if (mutated) persist(this.state);
  }

  /** Called on cb hello accept (fresh, not resume). */
  addOrUpdate(meta: Omit<PersistedSession, 'endedAt' | 'exitCode' | 'endReason'>): void {
    const existing = this.state.find((s) => s.id === meta.id);
    if (existing) {
      existing.label = meta.label;
      existing.cwd = meta.cwd;
      existing.cmdline = meta.cmdline;
      existing.lastActivityAt = meta.lastActivityAt;
      delete existing.endedAt;
      delete existing.exitCode;
      delete existing.endReason;
    } else {
      this.state.push({ ...meta });
    }
    this.state = evictIfOverflow(this.state);
    persist(this.state);
  }

  /** Called on session_dead / session_exited. */
  markEnded(id: string, reason: string, exitCode?: number): void {
    const s = this.state.find((x) => x.id === id);
    if (!s) return;
    if (s.endedAt !== undefined) return; // already ended
    s.endedAt = Date.now();
    s.endReason = reason;
    if (exitCode !== undefined) s.exitCode = exitCode;
    this.state = evictIfOverflow(this.state);
    persist(this.state);
  }

  /** Bump lastActivityAt — called periodically by registry so persistence reflects current activity. */
  touchActivity(id: string, at: number): void {
    const s = this.state.find((x) => x.id === id);
    if (!s) return;
    if (s.endedAt !== undefined) return;
    s.lastActivityAt = at;
    // Don't persist on every touch — too chatty. Persist only on add/end.
  }

  /** Most-recent first. */
  recent(limit?: number, opts?: { liveOnly?: boolean }): PersistedSession[] {
    let snapshot = [...this.state];
    if (opts?.liveOnly) {
      snapshot = snapshot.filter((s) => s.endedAt === undefined);
    }
    snapshot.sort((a, b) => {
      const aTs = a.endedAt ?? a.lastActivityAt;
      const bTs = b.endedAt ?? b.lastActivityAt;
      return bTs - aTs;
    });
    return typeof limit === 'number' && limit > 0 ? snapshot.slice(0, limit) : snapshot;
  }

  /** Look up by label — returns the MOST RECENT entry per label (in case of historical reuse). */
  lookupByLabels(labels: string[]): { found: PersistedSession[]; missing: string[] } {
    const found: PersistedSession[] = [];
    const missing: string[] = [];
    for (const label of labels) {
      const matches = this.state
        .filter((s) => s.label === label)
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
      const top = matches[0];
      if (top) found.push(top);
      else missing.push(label);
    }
    return { found, missing };
  }
}
