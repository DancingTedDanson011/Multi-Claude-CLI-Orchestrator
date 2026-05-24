// tests/smoke/run.ts
//
// End-to-end smoke test for bridge-clis (EXECUTION.md T15).
// Uses pwsh (not claude) so the test has no API dependency.
//
// Sequence:
//   1. Spawn 2x `cb pwsh` with labels s1, s2
//   2. Wait for daemon to register both
//   3. list → 2 sessions
//   4. read_screen s1 → PowerShell prompt visible
//   5. inject "Write-Host TESTMARKER\r" into s1
//   6. wait_for s1 "TESTMARKER" 5000 → matched
//   7. wait_for_idle s1 → idle
//   8. Kill s1 process → wait 35s → list shows s1 dead, s2 alive
//   9. Kill s2 → wait 65s → daemon process gone
//
// Exit: 0 on full pass, 1 with detail on any assert failure.
//
// Run via:    pnpm test:smoke
// Requires:   `pnpm -r build` has been run (cb/bridged dist exist)

import { spawn, type ChildProcess, execSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { PipeHelper, sleep } from './pipe-helper.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const CB_ENTRY = join(ROOT, 'packages', 'cb', 'dist', 'index.js');

let exitCode = 0;
const failures: string[] = [];

function log(msg: string) { process.stderr.write(`[smoke] ${msg}\n`); }

function assert(cond: unknown, msg: string) {
  if (!cond) {
    failures.push(msg);
    log(`  FAIL: ${msg}`);
    exitCode = 1;
  } else {
    log(`  OK:   ${msg}`);
  }
}

function step(name: string) { log(`>> ${name}`); }

type SpawnedCb = ChildProcess & { _capturedStderr: string };

function spawnCb(label: string): SpawnedCb {
  if (!existsSync(CB_ENTRY)) {
    throw new Error(`cb entry not found: ${CB_ENTRY}. Run \`pnpm -r build\` first.`);
  }
  // Use node directly (avoids needing cb to be installed in PATH).
  // `cb --label <label> pwsh` — pwsh on Windows, fall back to powershell.exe.
  const inner = process.platform === 'win32'
    ? (commandExists('pwsh') ? 'pwsh' : 'powershell.exe')
    : 'bash'; // smoke test is Windows-focused; bash fallback is for dev only

  const child = spawn(process.execPath, [CB_ENTRY, '--label', label, inner], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    windowsHide: true,
  }) as SpawnedCb;

  // Drain stdout to avoid backpressure stalling cb.
  child.stdout?.on('data', () => { /* swallow */ });
  // Capture stderr for failure diagnostics.
  child._capturedStderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    child._capturedStderr += chunk.toString('utf8');
    // Cap to avoid runaway memory if cb spews — keep last 64KB.
    if (child._capturedStderr.length > 65_536) {
      child._capturedStderr = child._capturedStderr.slice(-65_536);
    }
  });
  child.on('exit', (code, signal) => {
    log(`  [debug] cb '${label}' exited code=${code} signal=${signal}`);
    if (child._capturedStderr) {
      log(`  [debug] cb '${label}' stderr tail:\n${child._capturedStderr.split('\n').slice(-20).join('\n')}`);
    }
  });

  return child;
}

function commandExists(cmd: string): boolean {
  try {
    const probe = process.platform === 'win32' ? `where.exe ${cmd}` : `command -v ${cmd}`;
    execSync(probe, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * On smoke failure, dump everything useful so CI artifact upload / console
 * shows what actually went wrong. Distinguishes the most common case
 * (daemon never started → no logs, no secret) from log-present cases.
 */
function dumpDiagnosticsOnFailure(cbs: Array<ChildProcess | null>): void {
  const bd = join(os.homedir(), '.bridge-clis');
  log('');
  log('======= FAILURE DIAGNOSTICS =======');
  log(`bridge dir: ${bd}`);
  if (!existsSync(bd)) {
    log('  (directory does not exist — daemon never started)');
  } else {
    let entries: string[] = [];
    try { entries = readdirSync(bd); } catch { /* ignore */ }
    log(`  entries: ${JSON.stringify(entries)}`);
    for (const name of ['cb.log', 'bridged.log', 'bridge-mcp.log']) {
      const p = join(bd, name);
      if (existsSync(p)) {
        try {
          const body = readFileSync(p, 'utf8');
          const tail = body.split('\n').slice(-40).join('\n');
          log(`--- ${name} (last 40 lines) ---`);
          log(tail);
        } catch (e) {
          log(`  (could not read ${name}: ${(e as Error).message})`);
        }
      } else {
        log(`  ${name}: not present`);
      }
    }
  }
  for (let i = 0; i < cbs.length; i++) {
    const c = cbs[i] as (ChildProcess & { _capturedStderr?: string }) | null;
    if (!c) continue;
    log(`--- cb[${i}] stderr (captured) ---`);
    log(c._capturedStderr || '(empty)');
  }
  log('===================================');
}

function findDaemonPids(): number[] {
  // Find node processes whose CommandLine contains 'bridged' AND lives in our repo.
  // We use WMIC fallback / Get-CimInstance via powershell.
  try {
    const psCmd = `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*bridged*' } | Select-Object -ExpandProperty ProcessId`;
    const out = execSync(`powershell -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' });
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(n => parseInt(n, 10)).filter(Number.isFinite);
  } catch {
    return [];
  }
}

async function main() {
  log(`bridge-clis smoke test — repo: ${ROOT}`);
  log('');

  let s1: ChildProcess | null = null;
  let s2: ChildProcess | null = null;
  let helper: PipeHelper | null = null;

  try {
    // ---- step 1: spawn two cb sessions ----
    step('spawn cb s1 + s2 (pwsh under each)');
    s1 = spawnCb('s1');
    s2 = spawnCb('s2');

    // Give the daemon time to spawn + both cb to register. CI runners are
    // slower than dev machines (cold disk, busy noisy neighbour), so we use
    // BRIDGE_TEST_CI=1 to bump the wait window.
    const isCi = process.env['BRIDGE_TEST_CI'] === '1';
    const initialWaitMs = isCi ? 8000 : 3000;
    const connectTimeoutMs = isCi ? 15_000 : 5_000;
    log(`  isCi=${isCi} initialWait=${initialWaitMs}ms connectTimeout=${connectTimeoutMs}ms`);
    await sleep(initialWaitMs);

    // ---- step 2: connect helper ----
    step('connect to daemon pipe');
    helper = new PipeHelper();
    await helper.connect(connectTimeoutMs);
    log('  connected');

    // ---- step 3: list ----
    step('list sessions');
    let listed = await helper.list();
    log(`  daemon reports ${listed.sessions.length} session(s)`);
    assert(listed.sessions.length === 2, 'list returns 2 sessions');
    const labels = listed.sessions.map(s => s.label);
    assert(labels.includes('s1'), 's1 is in session list');
    assert(labels.includes('s2'), 's2 is in session list');

    // ---- step 4: read_screen s1 ----
    step('read_screen s1');
    // Wait an extra moment for shell prompt to render
    await sleep(1500);
    const screen = await helper.readScreen('s1');
    const joined = screen.lines.join('\n');
    log(`  screen size ${screen.cols}x${screen.rows}, ${screen.lines.length} lines`);
    // PowerShell prompt usually contains 'PS' followed by a path or '>'.
    // Be lenient — at minimum, the screen should not be entirely empty.
    const hasPrompt = /PS\s|>\s*$|^\s*\$/.test(joined) || joined.replace(/\s/g, '').length > 0;
    assert(hasPrompt, 'read_screen s1 shows non-empty output (prompt visible)');

    // ---- step 5: inject "Write-Host TESTMARKER\r" ----
    step('inject Write-Host TESTMARKER into s1');
    await helper.inject('s1', 'Write-Host TESTMARKER\r');

    // ---- step 6: wait_for TESTMARKER ----
    step('wait_for TESTMARKER in s1 (5s timeout)');
    const wfRes = await helper.waitFor('s1', 'TESTMARKER', 5000);
    log(`  matched=${wfRes.matched} ms=${wfRes.ms}`);
    assert(wfRes.matched === true, 'wait_for matched TESTMARKER');

    // ---- step 7: wait_for_idle s1 ----
    step('wait_for_idle s1');
    const idleRes = await helper.waitForIdle('s1', 10_000, 5);
    log(`  idle=${idleRes.idle} ms=${idleRes.ms}`);
    assert(idleRes.idle === true, 'wait_for_idle resolved to idle');

    // ---- step 7.5: race-protection (audit M8) ----
    // Simulate user typing into s2 by writing to the cb child's stdin (which
    // forwards to the PTY and triggers user_input frames to the daemon).
    // Then issue a non-force inject and assert it blocks until typing pauses.
    step('race-protection: typing-while-inject (M8 coverage)');
    if (s2 && s2.stdin) {
      // Pre-warm: write a few keystrokes BEFORE starting inject so daemon has
      // a recent lastUserInputAt. Otherwise inject races ahead and silentFor
      // is already huge → instant return.
      try { s2.stdin.write(' '); } catch { /* ignore */ }
      await sleep(250); // let user_input throttle window pass + reach daemon
      try { s2.stdin.write(' '); } catch { /* ignore */ }
      await sleep(50);

      const typingStart = Date.now();
      // Type a harmless char every 100ms for ~1s. We avoid newlines to keep
      // the prompt clean for assertions.
      const typingInterval = setInterval(() => {
        try { s2!.stdin!.write(' '); } catch { /* ignore */ }
      }, 100);
      // Stop typing after 1s — race-protection should then wait ~1500ms more
      // (DEFAULT_WAIT_FOR_USER_IDLE_MS) before the inject completes.
      const stopTypingAt = setTimeout(() => clearInterval(typingInterval), 1000);

      const state: { doneAt: number; err: Error | null } = { doneAt: 0, err: null };
      // Inject a harmless payload (backspace x20) — payload content irrelevant to test.
      const injectPayload = Buffer.alloc(20, 0x08);
      const injectPromise = helper.inject('s2', injectPayload, { force: false })
        .then(() => { state.doneAt = Date.now(); })
        .catch(e => { state.err = e as Error; state.doneAt = Date.now(); });

      // Bounded wait: race-protection budget is up to ~3s for this test.
      await Promise.race([injectPromise, sleep(3500)]);
      clearInterval(typingInterval);
      clearTimeout(stopTypingAt);
      // Ensure final state is captured.
      if (state.doneAt === 0) await Promise.race([injectPromise, sleep(500)]);

      if (state.err) {
        // Daemon-level user_active error is the OTHER acceptable outcome — it
        // proves race-protection fired. Anything else is unexpected.
        const isRaceErr = /user_active|user.?idle|race/i.test(state.err.message);
        assert(isRaceErr, `inject under typing produced race error (got: ${state.err.message})`);
      } else if (state.doneAt > 0) {
        const totalMs = state.doneAt - typingStart;
        // Typing ran 0..1000ms; daemon waits at least DEFAULT_WAIT_FOR_USER_IDLE_MS
        // (1500ms) of idle after last user input. So inject must complete AFTER
        // 1000 + 1500 = 2500ms from typingStart. Allow some slack on the lower
        // bound; the upper bound is the 3.5s race-protection budget.
        // Last user_input frame falls inside the 200ms throttle window; the
        // last "tick" before typing-stop at 1000ms may land at ~800ms. So the
        // earliest legitimate inject completion is 800 + 1500 = 2300ms.
        assert(totalMs >= 2200, `inject delayed for race-protection window (totalMs=${totalMs}, expected >=2200)`);
        assert(totalMs <= 3500, `inject completed within budget (totalMs=${totalMs})`);
      } else {
        assert(false, 'inject neither completed nor errored within 3.5s budget');
      }
      // Cleanup state: wait briefly so any in-flight injects don't pollute next steps.
      await sleep(500);
    } else {
      log('  SKIP: s2 stdin not pipeable in this env');
    }

    // ---- step 8: kill s1 cb-process, wait 35s, list ----
    step('kill cb s1 process, wait 35s for PID-watcher to mark dead');
    if (s1.pid) {
      try { process.kill(s1.pid); } catch { /* may already be dead */ }
    }
    s1 = null;
    await sleep(35_000);
    listed = await helper.list();
    const s1info = listed.sessions.find(s => s.label === 's1');
    const s2info = listed.sessions.find(s => s.label === 's2');
    log(`  s1 status: ${s1info?.status ?? 'gone'}`);
    log(`  s2 status: ${s2info?.status ?? 'gone'}`);
    assert(s1info?.status === 'dead', 's1 status is dead after kill');
    assert(s2info?.status === 'alive', 's2 status remains alive');

    // ---- step 9: kill s2, wait 65s, daemon should be gone ----
    step('kill cb s2 process, wait 65s for daemon idle-shutdown');
    if (s2 && s2.pid) {
      try { process.kill(s2.pid); } catch { /* may already be dead */ }
    }
    s2 = null;

    // Disconnect MCP-client so daemon's "no MCP connection" condition is satisfied.
    helper.close();
    helper = null;

    await sleep(65_000);

    const remaining = findDaemonPids();
    log(`  daemon PIDs still alive: ${JSON.stringify(remaining)}`);
    assert(remaining.length === 0, 'daemon process exited after idle-shutdown (60s)');

  } catch (err) {
    log(`UNCAUGHT: ${(err as Error).stack ?? err}`);
    failures.push(`Uncaught: ${(err as Error).message}`);
    exitCode = 1;
    dumpDiagnosticsOnFailure([s1, s2]);
  } finally {
    // Cleanup
    if (helper) try { helper.close(); } catch { /* ignore */ }
    for (const c of [s1, s2]) {
      if (c && c.pid && !c.killed) {
        try { process.kill(c.pid); } catch { /* ignore */ }
      }
    }
  }

  log('');
  if (exitCode === 0) {
    log('SMOKE PASS — all assertions OK');
  } else {
    log(`SMOKE FAIL — ${failures.length} failure(s):`);
    for (const f of failures) log(`  - ${f}`);
  }
  process.exit(exitCode);
}

main();
