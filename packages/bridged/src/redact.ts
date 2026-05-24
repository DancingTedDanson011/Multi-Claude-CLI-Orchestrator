// Credential redaction for MCP read paths.
// Defaults are hard-coded and always apply first. User overrides from
// ~/.bridge-clis/redact.json are LOADED ADDITIVELY — the user can ADD
// patterns but cannot remove or alter the defaults (security: defaults
// catch known token shapes; a malicious or careless config file must
// not be able to silence them).
//
// NOTE on line-wrap evasion: xterm wraps at column 80 by default. A 40-char
// token written into a TUI may land split across two rendered lines, e.g.
//   "sk-ant-api03-AAA…BBB"  →  "sk-ant-api03-AAABBB…\n     CCC…"
// renderTail joins rows with '\n' before redact runs, so a regex anchored to
// a single line will miss it. Mitigation lives at the call-site (paste tools
// strip newlines from their argument before display); a daemon-side fix would
// require a second redact pass over a newline-stripped copy — punted, audit H5.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';
import { BRIDGE_DIR, log } from './log.js';

type Pattern = { name: string; re: RegExp };

const DEFAULTS: Pattern[] = [
  { name: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{20,}/gi },
  { name: 'env_secret', re: /\b(?:PASSWORD|TOKEN|SECRET|API_?KEY|PRIVATE_KEY)=\S+/gi },
  // --- Audit H5: cloud + service tokens ---
  { name: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  // AWS secret-access keys are 40 chars of [A-Za-z0-9/+=] — far too generic
  // to match unanchored. Require an `aws[_-]?secret` keyword nearby on the
  // same line; tighten further if false positives bite. Capture group 1 is
  // the secret itself so the replacement preserves the keyword.
  {
    name: 'aws_secret',
    re: /(aws[_-]?secret[_-]?(?:access[_-]?)?key\s*[:=]\s*)['"]?([A-Za-z0-9/+=]{40})['"]?/gi,
  },
  { name: 'stripe_live_sk', re: /sk_live_[0-9a-zA-Z]{24,}/g },
  { name: 'stripe_live_rk', re: /rk_live_[0-9a-zA-Z]{24,}/g },
  { name: 'stripe_live_pk', re: /pk_live_[0-9a-zA-Z]{24,}/g },
  { name: 'slack_token', re: /xox[abprs]-[0-9]{10,13}-[0-9]{10,13}-[A-Za-z0-9]{24,}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  { name: 'google_api', re: /AIza[0-9A-Za-z\-_]{35}/g },
  {
    name: 'pem_private',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
];

const REDACT_FILE = path.join(BRIDGE_DIR, 'redact.json');

// Audit H6 — DoS protection on user-supplied patterns.
const MAX_USER_PATTERNS = 32;
const REDOS_PROBE_INPUT = 'a'.repeat(10_000);
const REDOS_PROBE_BUDGET_MS = 10;

let patterns: Pattern[] = [...DEFAULTS];
let loaded = false;

type UserPatternEntry = { name?: unknown; regex?: unknown; flags?: unknown };
type UserPatternFile = { patterns?: unknown };

/** Reject regexes that match the empty string — they cause infinite-loop replace. */
function matchesEmpty(re: RegExp): boolean {
  try {
    const probe = re.exec('');
    return probe !== null;
  } catch {
    return true;
  } finally {
    re.lastIndex = 0;
  }
}

/** Run the regex against 10kB of 'a' with a 10ms budget; reject if it stalls. */
function isCatastrophic(re: RegExp): boolean {
  try {
    const start = performance.now();
    // Using replace ensures we exercise the same code path redact() uses,
    // catching catastrophic-backtracking that test() might short-circuit.
    REDOS_PROBE_INPUT.replace(re, '_');
    const elapsed = performance.now() - start;
    return elapsed > REDOS_PROBE_BUDGET_MS;
  } catch {
    return true;
  } finally {
    re.lastIndex = 0;
  }
}

function loadUserPatterns(): void {
  if (loaded) return;
  loaded = true;
  if (!existsSync(REDACT_FILE)) return;
  try {
    const raw = readFileSync(REDACT_FILE, 'utf8');
    const parsed = JSON.parse(raw) as UserPatternFile;
    if (!parsed || !Array.isArray(parsed.patterns)) {
      log.warn('redact.json: missing or invalid "patterns" array; using defaults only');
      return;
    }
    const entries = parsed.patterns as UserPatternEntry[];
    if (entries.length > MAX_USER_PATTERNS) {
      log.warn('redact.json: pattern count exceeds cap; truncating', {
        count: entries.length,
        cap: MAX_USER_PATTERNS,
      });
    }
    const capped = entries.slice(0, MAX_USER_PATTERNS);
    for (const entry of capped) {
      const name = typeof entry?.name === 'string' ? entry.name : null;
      const regex = typeof entry?.regex === 'string' ? entry.regex : null;
      const flags = typeof entry?.flags === 'string' ? entry.flags : 'g';
      if (!name || !regex) {
        log.warn('redact.json: skipping entry missing name or regex', { entry: entry as unknown });
        continue;
      }
      // Force global flag so .replace() hits every occurrence.
      const finalFlags = flags.includes('g') ? flags : flags + 'g';
      let re: RegExp;
      try {
        re = new RegExp(regex, finalFlags);
      } catch (err) {
        log.warn('redact.json: invalid regex, skipping', {
          name,
          regex,
          err: (err as Error).message,
        });
        continue;
      }
      if (matchesEmpty(re)) {
        log.warn('redact.json: regex matches empty string, rejected', { name, regex });
        continue;
      }
      if (isCatastrophic(re)) {
        log.warn('redact.json: regex exceeds ReDoS probe budget, rejected', {
          name,
          regex,
          budgetMs: REDOS_PROBE_BUDGET_MS,
        });
        continue;
      }
      patterns.push({ name, re });
      log.info('redact.json: loaded user pattern', { name });
    }
  } catch (err) {
    log.warn('redact.json: failed to parse, using defaults only', {
      err: (err as Error).message,
    });
  }
}

/**
 * Replace every credential match with `[REDACTED:<name>]`.
 * Defaults first, then user-extensions. Each pattern is wrapped in try/catch
 * so a single bad regex (catastrophic backtrack at runtime against weird
 * input) can't take the whole response down — audit H6.
 */
export function redact(text: string): string {
  loadUserPatterns();
  let out = text;
  for (const p of patterns) {
    p.re.lastIndex = 0;
    try {
      // The aws_secret pattern uses a capture group so the keyword survives;
      // for all others, a literal replacement is fine. Switching on capture
      // count keeps the API uniform without each pattern carrying a custom
      // replacer.
      if (p.name === 'aws_secret') {
        out = out.replace(p.re, `$1[REDACTED:${p.name}]`);
      } else {
        out = out.replace(p.re, `[REDACTED:${p.name}]`);
      }
    } catch (err) {
      log.warn('redact: pattern threw, skipping', {
        name: p.name,
        err: (err as Error).message,
      });
    }
  }
  return out;
}

/**
 * Raw bytes can contain interleaved ANSI sequences that split tokens across
 * "logical" character boundaries; running text-regex on the decoded bytes is
 * unreliable and may leak partial credentials. Per EXECUTION T11, we DO NOT
 * attempt redaction on raw output. The caller must surface the warning to
 * the user via the response payload.
 */
export function redactRaw(buf: Buffer): { buf: Buffer; warning?: string } {
  return { buf, warning: 'raw output is not redacted' };
}

// Test/inspection-only — not used by daemon code paths.
export function _resetForTest(): void {
  patterns = [...DEFAULTS];
  loaded = false;
}
