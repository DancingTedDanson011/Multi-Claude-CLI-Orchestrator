// Per-MCP-client notification queue.
//
// Phase E. Triggers:
//   - "task_complete": session became idle after a successful inject from this
//     client (background wait-for-idle resolved).
//   - "session_dead": any session a client was watching (recently injected to,
//     OR all currently-connected clients) transitioned to dead.
//   - "session_exited": cb sent bye{exitCode}.
//
// Queue is bounded (drops oldest beyond cap). Drained via bridge_notifications
// MCP-tool which empties the per-client queue and returns its contents.

import { randomBytes } from 'node:crypto';
import type { BridgeNotification } from '@bridge-clis/shared';
import { log } from './log.js';

const MAX_QUEUE_PER_CLIENT = 100;
/**
 * After an inject we set up a background watcher. If a NEW inject for the
 * same (clientId, sessionId) arrives before the watcher resolves, we cancel
 * the previous one — only the most recent task gets a completion notification.
 */
export type WatcherHandle = {
  cancel(): void;
};

export class NotificationCenter {
  /** clientId → ordered list of pending notifications (oldest first). */
  private queues = new Map<string, BridgeNotification[]>();

  /** Tracks (clientId, sessionId) → active watcher so we can cancel on re-inject. */
  private watchers = new Map<string, WatcherHandle>();

  private nextId = 0;

  private nextNotificationId(): string {
    // Monotonic-ish hex id. Time-prefixed for natural ordering across daemon
    // lifetime; random suffix avoids collisions if two fire in same millisecond.
    const ts = Date.now().toString(16).padStart(12, '0');
    const seq = (this.nextId++).toString(16).padStart(4, '0');
    const rnd = randomBytes(4).toString('hex');
    return `${ts}-${seq}-${rnd}`;
  }

  private enqueue(clientId: string, evt: Omit<BridgeNotification, 'id' | 'ts'>): void {
    const full: BridgeNotification = {
      id: this.nextNotificationId(),
      ts: Date.now(),
      ...evt,
    };
    let q = this.queues.get(clientId);
    if (!q) {
      q = [];
      this.queues.set(clientId, q);
    }
    q.push(full);
    if (q.length > MAX_QUEUE_PER_CLIENT) {
      q.splice(0, q.length - MAX_QUEUE_PER_CLIENT);
    }
    log.debug('notification queued', {
      clientId,
      kind: full.kind,
      sessionId: full.sessionId,
      queueDepth: q.length,
    });
  }

  /** Drain & return all pending events for this client. */
  drain(clientId: string): BridgeNotification[] {
    const q = this.queues.get(clientId);
    if (!q || q.length === 0) return [];
    const out = q.slice();
    q.length = 0;
    return out;
  }

  /** Called by pipe-server when an MCP client disconnects — frees its queue. */
  clientDisconnected(clientId: string): void {
    this.queues.delete(clientId);
    // Cancel any watchers owned by this client.
    for (const [key, w] of this.watchers.entries()) {
      if (key.startsWith(clientId + '\0')) {
        w.cancel();
        this.watchers.delete(key);
      }
    }
  }

  /**
   * Register a background wait-for-idle that fires a task_complete
   * notification when resolved. Cancels any prior watcher for the
   * same (clientId, sessionId) — only the most-recent task is tracked.
   */
  registerInjectFollowup(
    clientId: string,
    sessionId: string,
    label: string,
    startWatcher: (onResolve: (silentMs: number) => void) => WatcherHandle,
  ): void {
    const key = `${clientId}\0${sessionId}`;
    const prior = this.watchers.get(key);
    if (prior) prior.cancel();

    const handle = startWatcher((silentMs) => {
      this.watchers.delete(key);
      this.enqueue(clientId, {
        sessionId,
        label,
        kind: 'task_complete',
        details: { silentForMs: silentMs },
      });
    });
    this.watchers.set(key, handle);
  }

  /** Fanout: session-death events go to all currently-connected MCP clients. */
  fanoutSessionDead(
    connectedClientIds: Iterable<string>,
    sessionId: string,
    label: string,
    reason: string,
    exitCode?: number,
  ): void {
    const kind = exitCode !== undefined ? 'session_exited' : 'session_dead';
    for (const clientId of connectedClientIds) {
      this.enqueue(clientId, {
        sessionId,
        label,
        kind,
        details: { reason, ...(exitCode !== undefined ? { exitCode } : {}) },
      });
      // Cancel any pending task_complete watchers for this dead session.
      const watcherKey = `${clientId}\0${sessionId}`;
      const w = this.watchers.get(watcherKey);
      if (w) {
        w.cancel();
        this.watchers.delete(watcherKey);
      }
    }
  }

  /**
   * Phase F: fanout when a brand-new cb session connects (NOT resume).
   * Master then sees "new window appeared" on its next bridge_notifications
   * call or via the status-footer of the next tool response.
   */
  fanoutSessionAdded(
    connectedClientIds: Iterable<string>,
    sessionId: string,
    label: string,
    cwd: string,
    pid: number,
  ): void {
    for (const clientId of connectedClientIds) {
      this.enqueue(clientId, {
        sessionId,
        label,
        kind: 'session_added',
        details: { cwd, pid },
      });
    }
  }

  /** Test/diagnostic only. */
  _depth(clientId: string): number {
    return this.queues.get(clientId)?.length ?? 0;
  }
}
