import { Buffer } from 'node:buffer';
import { MAX_FRAME_BYTES, MAX_FIRST_FRAME_BYTES } from './constants.js';

export function encodeFrame(msg: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  if (json.length > MAX_FRAME_BYTES) {
    throw new Error(`Frame too large to encode: ${json.length} bytes`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export type DecoderOpts = {
  /**
   * Cap before the first frame is decoded. After the first frame parses,
   * the cap auto-relaxes to MAX_FRAME_BYTES. Audit H3 / M14.
   */
  firstFrameCap?: number;
  /** Hard cap for any single frame. Default MAX_FRAME_BYTES. */
  maxFrameBytes?: number;
};

export type Decoder<T = unknown> = {
  push(chunk: Buffer): T[];
  remaining(): number;
};

/**
 * Length-prefixed JSON frame decoder.
 *
 * Uses a list-of-chunks accumulator and concatenates only when a frame
 * boundary needs to be crossed. Avoids the O(n²) Buffer.concat-on-every-push
 * hot-path the audit (H3 / code-auditor HIGH) flagged.
 */
export function createDecoder<T = unknown>(opts: DecoderOpts = {}): Decoder<T> {
  const maxFrame = opts.maxFrameBytes ?? MAX_FRAME_BYTES;
  const firstCap = opts.firstFrameCap ?? MAX_FIRST_FRAME_BYTES;
  const chunks: Buffer[] = [];
  let pending = 0;
  let framesEmitted = 0;

  /** Concatenate exactly `n` leading bytes into a single Buffer; mutate `chunks`. */
  function consume(n: number): Buffer {
    if (n === 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(n);
    let written = 0;
    while (written < n) {
      const first = chunks[0];
      if (!first) throw new Error('decoder internal: chunk list empty during consume');
      const need = n - written;
      if (first.length <= need) {
        first.copy(out, written);
        written += first.length;
        chunks.shift();
      } else {
        first.copy(out, written, 0, need);
        chunks[0] = first.subarray(need);
        written += need;
      }
    }
    pending -= n;
    return out;
  }

  /** Peek the length-prefix without consuming. Returns -1 if not enough bytes. */
  function peekLen(): number {
    if (pending < 4) return -1;
    const first = chunks[0];
    if (!first) return -1;
    if (first.length >= 4) return first.readUInt32LE(0);
    // length spans chunks → fold the first 4 bytes
    const hdr = consume(4);
    chunks.unshift(hdr);
    pending += 4;
    return hdr.readUInt32LE(0);
  }

  return {
    push(chunk: Buffer): T[] {
      chunks.push(chunk);
      pending += chunk.length;
      const out: T[] = [];
      // Loop while we can decode another full frame.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const len = peekLen();
        if (len < 0) break;
        const cap = framesEmitted === 0 ? firstCap : maxFrame;
        if (len > cap) {
          throw new Error(
            framesEmitted === 0
              ? `First frame exceeds ${cap} bytes: ${len}`
              : `Frame length exceeds maximum ${cap}: ${len}`,
          );
        }
        if (pending < 4 + len) break;
        consume(4); // drop header
        const payload = consume(len);
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload.toString('utf8'));
        } catch (e) {
          throw new Error(`Invalid JSON in frame: ${(e as Error).message}`);
        }
        out.push(parsed as T);
        framesEmitted++;
      }
      return out;
    },
    remaining(): number {
      return pending;
    },
  };
}

/**
 * Validate that a string round-trips as base64 cleanly. Buffer.from(s, 'base64')
 * silently truncates invalid input, so we must verify (audit M12).
 */
export function decodeBase64Strict(s: string): Buffer | null {
  if (typeof s !== 'string') return null;
  // Empty input is a valid empty buffer (e.g. bridge_paste with empty text).
  if (s.length === 0) return Buffer.alloc(0);
  // Standard base64 alphabet only; reject whitespace / urlsafe variants.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  // Length must be a multiple of 4 for canonical base64.
  if (s.length % 4 !== 0) return null;
  const buf = Buffer.from(s, 'base64');
  // Round-trip check: re-encode and compare. Cheap because base64 is deterministic.
  if (buf.toString('base64') !== s) return null;
  return buf;
}
