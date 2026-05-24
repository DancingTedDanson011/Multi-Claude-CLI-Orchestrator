// scripts/build-dist.ts
//
// Assembles dist-bundle/bridge-clis/ — the shippable folder.
//
// NEEDS DEP (root devDeps): esbuild (already there), tsx (already there).
// Optional: rimraf (already there).
//
// Prerequisite: run `pnpm -r build` first to TS-compile each package.
//   This script will do that automatically unless --skip-tsc is passed.
//
// Prerequisite (separate): node.exe (embedded zip) must already be copied
// into dist-bundle/bridge-clis/ before final ship. Use:
//     scripts/fetch-node.ps1
// This script will WARN but not fail if node.exe is missing — it only
// builds the JS/native bits; the Node runtime is fetched out-of-band so
// CI can cache it.
//
// Bundle strategy (EXECUTION.md Anhang E):
//   - esbuild each package's compiled JS into a single .cjs
//   - Externalize native / heavy deps so they load from sibling node_modules
//   - Copy ONLY the externalized deps + their transitive native bits
//   - Generate .cmd wrappers: @"%~dp0node.exe" "%~dp0<name>.cjs" %*

import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = join(ROOT, 'dist-bundle', 'bridge-clis');

const args = new Set(process.argv.slice(2));
const SKIP_TSC = args.has('--skip-tsc');

// Each package: which .cjs we emit and what stays external.
// External entries land in dist-bundle/bridge-clis/node_modules/<dep>/.
// Native deps (node-pty) MUST be external — esbuild cannot bundle .node files.
// @xterm/headless: pure JS but large; externalize keeps esbuild fast and
//                  avoids bundling its embedded UTF parsers redundantly.
// @modelcontextprotocol/sdk: complex package layout with many sub-paths;
//                  bundling it tends to break its dynamic-import shape.
type PkgSpec = {
  name: string;       // workspace pkg
  outCjs: string;     // basename written to OUT_DIR
  externals: string[];
};

const PACKAGES: PkgSpec[] = [
  { name: 'cb',         outCjs: 'cb.cjs',         externals: ['node-pty'] },
  { name: 'bridged',    outCjs: 'bridged.cjs',    externals: ['node-pty', '@xterm/headless'] },
  { name: 'bridge-mcp', outCjs: 'bridge-mcp.cjs', externals: ['@modelcontextprotocol/sdk'] },
];

// Union of all externals — these get copied into the bundle's node_modules.
// (bridged needs node-pty too because it spawns its own PID-watchers; safer to
//  always have it available to whatever .cjs gets node-required.)
const ALL_EXTERNALS = Array.from(new Set(PACKAGES.flatMap(p => p.externals))).concat([
  // transitive heavies pulled in by externals — keep them as siblings:
  'ulid', // small, but shared package depends on it via cb
]);

function log(msg: string) { process.stderr.write(`[build-dist] ${msg}\n`); }

function step(label: string, fn: () => void | Promise<void>) {
  log(`>> ${label}`);
  return Promise.resolve(fn());
}

function runPnpm(...cliArgs: string[]) {
  const cmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const r = spawnSync(cmd, cliArgs, { cwd: ROOT, stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    throw new Error(`pnpm ${cliArgs.join(' ')} failed with exit ${r.status}`);
  }
}

async function main() {
  // 1. Clean output
  await step('clean dist-bundle', () => {
    if (existsSync(OUT_DIR)) {
      // Preserve node.exe across builds (it's fetched out-of-band)
      const preservedNode = join(OUT_DIR, 'node.exe');
      const hasNode = existsSync(preservedNode);
      let nodeBytes: Buffer | null = null;
      if (hasNode) nodeBytes = readFileSync(preservedNode);
      rmSync(OUT_DIR, { recursive: true, force: true });
      mkdirSync(OUT_DIR, { recursive: true });
      if (nodeBytes) writeFileSync(preservedNode, nodeBytes);
    } else {
      mkdirSync(OUT_DIR, { recursive: true });
    }
  });

  // 2. TS-compile each package (unless skipped)
  if (!SKIP_TSC) {
    await step('pnpm -r build (tsc)', () => {
      runPnpm('-r', 'build');
    });
  } else {
    log('skipping tsc (--skip-tsc)');
  }

  // 3. esbuild bundle each package
  for (const pkg of PACKAGES) {
    const entry = join(ROOT, 'packages', pkg.name, 'dist', 'index.js');
    const outfile = join(OUT_DIR, pkg.outCjs);
    if (!existsSync(entry)) {
      throw new Error(
        `Missing TS-compiled entry: ${entry}\n` +
        `Run \`pnpm -r build\` first or remove --skip-tsc.`
      );
    }
    await step(`esbuild ${pkg.name} → ${pkg.outCjs}`, async () => {
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        outfile,
        external: pkg.externals,
        // Workspace deps (shared) get bundled inline; we don't externalize them.
        // legalComments: 'none' keeps the .cjs tighter.
        legalComments: 'none',
        // Banner ensures the .cjs is recognized as a script even if node.exe
        // is invoked without --experimental-modules. CJS by default — no banner needed.
        logLevel: 'warning',
      });
    });
  }

  // 4. Copy externalized node_modules
  await step('copy externalized node_modules', () => {
    const targetNm = join(OUT_DIR, 'node_modules');
    mkdirSync(targetNm, { recursive: true });
    for (const dep of ALL_EXTERNALS) {
      copyDepWithTransitives(dep, targetNm);
    }
  });

  // 5. Emit .cmd wrappers
  await step('emit .cmd wrappers', () => {
    for (const pkg of PACKAGES) {
      const name = pkg.name; // cb, bridged, bridge-mcp
      const cmdContent = `@"%~dp0node.exe" "%~dp0${pkg.outCjs}" %*\r\n`;
      writeFileSync(join(OUT_DIR, `${name}.cmd`), cmdContent, { encoding: 'utf8' });
    }
  });

  // 6. Copy installer scripts
  await step('copy installer/*.ps1', () => {
    const instSrc = join(ROOT, 'installer');
    for (const f of ['install.ps1', 'uninstall.ps1']) {
      const src = join(instSrc, f);
      if (!existsSync(src)) {
        log(`WARN: installer/${f} missing — skipping`);
        continue;
      }
      cpSync(src, join(OUT_DIR, f));
    }
  });

  // 7. Sanity: node.exe present?
  const nodeExe = join(OUT_DIR, 'node.exe');
  if (!existsSync(nodeExe)) {
    log('');
    log('WARNING: node.exe NOT FOUND in dist-bundle/bridge-clis/');
    log('         Bundle is NOT shippable until you run:');
    log('             pwsh -ExecutionPolicy Bypass -File scripts/fetch-node.ps1');
    log('         (downloads Node 20.10 LTS x64 embedded zip from nodejs.org)');
    log('');
  } else {
    const sz = statSync(nodeExe).size;
    log(`node.exe present (${(sz / 1024 / 1024).toFixed(1)} MB)`);
  }

  log(`done. bundle at: ${OUT_DIR}`);
}

// ----- helpers -----

/**
 * Copy a dep from the root node_modules to the bundle's node_modules.
 * pnpm uses a content-addressable store with symlinks, so we resolve
 * through `require.resolve` to find the actual location, then copy
 * the entire package folder (including its own node_modules if present).
 *
 * Native deps (node-pty) ship prebuilt .node binaries inside themselves.
 * We rely on the prebuilt that matches the bundled Node version (20.x).
 */
function copyDepWithTransitives(dep: string, targetNm: string) {
  const resolved = resolvePkgRoot(dep);
  if (!resolved) {
    throw new Error(
      `Could not resolve ${dep} from project root. ` +
      `Make sure it is installed via pnpm install.`
    );
  }
  const dest = join(targetNm, dep);
  mkdirSync(dirname(dest), { recursive: true });
  // dereference symlinks (pnpm uses them heavily) — we want real files.
  cpSync(resolved, dest, { recursive: true, dereference: true });
  log(`  copied ${dep} (${(dirSize(dest) / 1024 / 1024).toFixed(1)} MB)`);

  // Also copy transitive runtime deps declared in this dep's package.json.
  // Best-effort — if a dep is hoisted up, resolvePkgRoot finds it; if it
  // ships its own nested node_modules we already copied that via cpSync.
  const pjPath = join(dest, 'package.json');
  if (existsSync(pjPath)) {
    const pj = JSON.parse(readFileSync(pjPath, 'utf8')) as { dependencies?: Record<string, string> };
    const subDeps = Object.keys(pj.dependencies ?? {});
    for (const sub of subDeps) {
      // Skip if already present in our bundle's node_modules (top-level or nested)
      if (existsSync(join(targetNm, sub))) continue;
      // Skip if nested in the dep itself
      if (existsSync(join(dest, 'node_modules', sub))) continue;
      // Otherwise, hoist it
      try {
        copyDepWithTransitives(sub, targetNm);
      } catch (e) {
        log(`  WARN: could not copy transitive ${sub}: ${(e as Error).message}`);
      }
    }
  }
}

function resolvePkgRoot(dep: string): string | null {
  try {
    // require.resolve doesn't exist in ESM; use createRequire equivalent.
    // Easiest: read pnpm's flat structure under root node_modules.
    const candidates = [
      join(ROOT, 'node_modules', dep, 'package.json'),
      join(ROOT, 'node_modules', '.pnpm', 'node_modules', dep, 'package.json'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return dirname(c);
    }
    // Walk .pnpm/* looking for the dep
    const pnpmDir = join(ROOT, 'node_modules', '.pnpm');
    if (existsSync(pnpmDir)) {
      for (const entry of readdirSync(pnpmDir)) {
        const candidate = join(pnpmDir, entry, 'node_modules', dep, 'package.json');
        if (existsSync(candidate)) return dirname(candidate);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function dirSize(dir: string): number {
  let total = 0;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    const st = statSync(p);
    if (st.isDirectory()) total += dirSize(p);
    else total += st.size;
  }
  return total;
}

main().catch(err => {
  log(`FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
