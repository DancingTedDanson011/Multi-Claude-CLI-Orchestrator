// Bounded byte ring buffer of timestamped chunks.
// Stores raw PTY output as Buffer chunks. Each chunk carries the wall-clock
// timestamp at which it arrived at the daemon (NOT the time the byte was
// produced in the child process — clocks aren't shared). Eviction is FIFO,
// oldest-first, until totalBytes <= maxBytes. There is no compaction or
// re-fragmentation of chunks; chunks are stored intact so that timestamps
// remain meaningful for `readSince`.

import { Buffer } from 'node:buffer';
import { RING_BUFFER_MAX_BYTES } from '@bridge-clis/shared';

export type Chunk = { ts: number; bytes: Buffer };

export class RingBuffer {
  private chunks: Chunk[] = [];
  private totalBytes = 0;
  private latestTs = 0;

  constructor(private readonly maxBytes: number = RING_BUFFER_MAX_BYTES) {}

  pushChunk(bytes: Buffer, ts: number = Date.now()): void {
    if (bytes.length === 0) return;
    // If a single chunk is larger than maxBytes, slice the tail — keep the
    // most-recent maxBytes worth. This is a degenerate path; normal PTY
    // chunks are <64KB.
    let payload = bytes;
    if (bytes.length > this.maxBytes) {
      payload = bytes.subarray(bytes.length - this.maxBytes);
    }
    this.chunks.push({ ts, bytes: payload });
    this.totalBytes += payload.length;
    if (ts > this.latestTs) this.latestTs = ts;
    this.evict();
  }

  private evict(): void {
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const dropped = this.chunks.shift();
      if (!dropped) break;
      this.totalBytes -= dropped.bytes.length;
    }
  }

  /**
   * Concatenate all chunks with ts > sinceTs, capped at maxBytes returned.
   * If the matching window exceeds the cap, the trailing portion is returned
   * (most-recent bytes wins). Returns { bytes, latestTimestamp } so callers
   * can pass `latestTimestamp` back as the next `sinceMs`.
   */
  readSince(sinceTs: number, maxReturnBytes: number): { bytes: Buffer; latestTimestamp: number } {
    const slices: Buffer[] = [];
    let total = 0;
    let latest = sinceTs;
    for (const c of this.chunks) {
      if (c.ts <= sinceTs) continue;
      slices.push(c.bytes);
      total += c.bytes.length;
      if (c.ts > latest) latest = c.ts;
    }
    let out = slices.length === 0 ? Buffer.alloc(0) : Buffer.concat(slices, total);
    if (out.length > maxReturnBytes) {
      out = out.subarray(out.length - maxReturnBytes);
    }
    return { bytes: out, latestTimestamp: latest };
  }

  get size(): number {
    return this.totalBytes;
  }

  get latestTimestamp(): number {
    return this.latestTs;
  }
}
