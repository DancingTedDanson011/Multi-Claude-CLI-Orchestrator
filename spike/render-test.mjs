// Tag-0 Spike — single question: does @xterm/headless render Claude Code's
// Ink TUI through node-pty + ConPTY on Windows cleanly?
//
// Run:  npm i && node render-test.mjs
// Then: type into Claude as normal. After ~5s, inspect snapshot.txt.
//
// Acceptance per EXECUTION §1.3:
//   A) User terminal shows normal Claude UI with no visual glitch
//   B) snapshot.txt shows coherent screen (input box bottom, welcome top, cursor sane)
//   C) Send a short prompt, get response — snapshot afterwards contains the response as readable text

import pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import fs from 'node:fs';
import process from 'node:process';

const { Terminal } = xtermHeadless;

const COLS = process.stdout.columns || 120;
const ROWS = process.stdout.rows || 36;

const term = new Terminal({
  cols: COLS,
  rows: ROWS,
  allowProposedApi: true,
  scrollback: 5000,
});

const cmd = process.argv[2] || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
const args = process.argv.slice(3);

const shell = pty.spawn(cmd, args, {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: process.cwd(),
  env: { ...process.env, TERM: 'xterm-256color' },
});

shell.onData((data) => {
  term.write(data);
  process.stdout.write(data);
});

shell.onExit(({ exitCode }) => {
  // give one final snapshot a moment to flush
  setTimeout(() => {
    snapshot();
    console.error(`\n[spike] exit code ${exitCode}, final snapshot written.`);
    process.exit(exitCode);
  }, 200);
});

function snapshot() {
  const buf = term.buffer.active;
  let out = `=== ${new Date().toISOString()} cursor=(${buf.cursorY},${buf.cursorX}) cols=${COLS} rows=${ROWS} ===\n`;
  for (let y = 0; y < ROWS; y++) {
    const line = buf.getLine(y);
    out += (line ? line.translateToString(true) : '~') + '\n';
  }
  out += '--- end ---\n';
  fs.writeFileSync('snapshot.txt', out);
}

setInterval(snapshot, 2000);

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (d) => {
  shell.write(d.toString('utf8'));
});

// SIGWINCH does not exist on Windows; use stdout 'resize' event there.
if (process.platform === 'win32') {
  process.stdout.on('resize', () => {
    const c = process.stdout.columns;
    const r = process.stdout.rows;
    if (c && r) {
      shell.resize(c, r);
      term.resize(c, r);
    }
  });
} else {
  process.on('SIGWINCH', () => {
    const c = process.stdout.columns;
    const r = process.stdout.rows;
    if (c && r) {
      shell.resize(c, r);
      term.resize(c, r);
    }
  });
}

process.on('SIGINT', () => {
  shell.kill();
});
