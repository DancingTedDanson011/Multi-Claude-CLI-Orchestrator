// Wraps @xterm/headless Terminal for one session.
// Headless xterm parses raw PTY bytes into a screen + scrollback model. The
// `buffer.active` view is indexed in BUFFER-ABSOLUTE coordinates: row 0 is the
// oldest scrollback row, the visible viewport sits at rows [baseY, baseY+rows).
// Treating y as viewport-relative (the pre-audit bug, C1) returns scrollback
// instead of the visible screen and silently flips wait_for_idle / read_screen
// / read_tail into garbage as soon as the program scrolls.

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
// @xterm/headless is CJS-only; named ESM imports fail under Node ESM. Use
// default-import + named destructure (verified at runtime).
import xtermHeadless from '@xterm/headless';
import {
  SCROLLBACK_LINES,
  type ScreenSnapshot,
  type TailSnapshot,
} from '@bridge-clis/shared';

const { Terminal } = xtermHeadless;
type Terminal = InstanceType<typeof xtermHeadless.Terminal>;

// Characters frequently used by terminal spinners. Masking them lets two
// spinner-rotation frames hash to the same value, which is the whole point
// of `wait_for_idle`. Full Braille block (U+2800..U+28FF) + Block/half-block
// glyphs commonly used in progress bars. Audit M11.
const ANIM_CHARS = /[⠀-⣿▀-▟•·*✦◆●○◐◑◒◓▰▱]/g;

export class HeadlessTerm {
  readonly term: Terminal;
  private _cols: number;
  private _rows: number;

  constructor(cols: number, rows: number) {
    this._cols = cols;
    this._rows = rows;
    this.term = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK_LINES,
      allowProposedApi: true,
    });
  }

  write(data: Buffer | string): void {
    // xterm/headless accepts both string and Uint8Array; passing the Buffer
    // directly preserves byte-level fidelity for any non-UTF8 sequences.
    this.term.write(data as unknown as Uint8Array);
  }

  resize(cols: number, rows: number): void {
    if (cols === this._cols && rows === this._rows) return;
    this._cols = cols;
    this._rows = rows;
    this.term.resize(cols, rows);
  }

  get cols(): number {
    return this._cols;
  }
  get rows(): number {
    return this._rows;
  }

  /**
   * Walk the visible viewport rows [baseY, baseY+rows) in buffer-absolute
   * coordinates. Cursor is also reported in absolute coords; callers that
   * want viewport-relative can subtract baseY. (Existing ScreenSnapshot
   * shape keeps row/col raw to preserve the wire format.)
   */
  renderScreen(): ScreenSnapshot {
    const buf = this.term.buffer.active;
    const lines: string[] = [];
    const baseY = buf.baseY;
    for (let y = baseY; y < baseY + this._rows; y++) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    return {
      cols: this._cols,
      rows: this._rows,
      lines,
      cursor: { row: buf.cursorY, col: buf.cursorX },
    };
  }

  /**
   * Last `n` rendered lines from the active buffer (scrollback + viewport),
   * joined by '\n'. We walk the trailing n rows of `buffer.active` directly —
   * the old alt-screen branching mixed alt-screen content with normal-buffer
   * scrollback and duplicated rows. The active buffer already aggregates the
   * right view for the current mode. Trailing empty rows are trimmed.
   */
  renderTail(n: number): TailSnapshot {
    if (n <= 0) return { text: '', truncated: false };

    const active = this.term.buffer.active;
    const total = active.length;
    const start = Math.max(0, total - n);
    const collected: string[] = [];
    for (let y = start; y < total; y++) {
      const line = active.getLine(y);
      collected.push(line ? line.translateToString(true) : '');
    }
    while (collected.length > 0 && collected[collected.length - 1] === '') {
      collected.pop();
    }
    // truncated == "buffer had more than n rows, callers got the tail".
    const truncated = total > n;
    return { text: collected.join('\n'), truncated };
  }

  /**
   * MD5 of the last `n` rendered lines ending at the cursor row inclusive.
   * Cursor is buffer-absolute (baseY + cursorY); using cursorY alone walks
   * scrollback once any output has scrolled, which is what made wait_for_idle
   * resolve instantly against unchanging history (audit C1).
   */
  hashLastN(n: number, maskAnim: boolean): string {
    const buf = this.term.buffer.active;
    const cursorAbs = buf.baseY + buf.cursorY;
    const start = Math.max(0, cursorAbs - n + 1);
    let s = '';
    for (let y = start; y <= cursorAbs; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      let text = line.translateToString(true);
      if (maskAnim) text = text.replace(ANIM_CHARS, ' ');
      s += text + '\n';
    }
    return createHash('md5').update(s).digest('hex');
  }

  /** Count of rendered lines currently visible/in scrollback. Used by SessionInfo.lineCount. */
  lineCount(): number {
    return this.term.buffer.active.length;
  }
}
