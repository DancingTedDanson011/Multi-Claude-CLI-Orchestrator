# Security Policy

## Threat model

This project is built for single-user local development on a personal machine.
It is **not designed for**:

- shared / multi-user machines
- remote access (no network listener exists by design)
- production server environments
- untrusted code execution

Within the single-user local model, the project assumes:

- the user's home directory and `~/.bridge-clis/` are owner-only
- the user controls every `cb` (worker) process they start
- the master Claude Code instance is trusted (running with `--dangerously-skip-permissions`)
- any code running in the user's session is trusted (no privilege separation)

## What we protect against

- Cross-user pipe access (Windows Named Pipe ACL plus per-daemon shared secret)
- Credential leakage in MCP read paths (regex-based redaction for Anthropic, OpenAI, Stripe live, AWS, Slack, GitHub, JWT, and PEM private keys)
- Master Claude trampling user input (race-protection blocks injects while the user is typing)
- Forensic deniability of the audit log (JSON-per-line format, label validation)
- Frame-decoder DoS (1 MB per-frame cap, 4 KB first-frame cap, 30 s idle timeout pre-handshake)
- ReDoS via user-supplied redaction regex (count cap, empty-match rejection, time-budget probe)
- Persisted-session restore attacks (master can only restore labels already in history, never arbitrary cwds)

## What we do not protect against

- A user with write access to `~/.bridge-clis/redact.json` can shape what credentials get redacted
- Inline credentials wrapped at terminal column boundaries may evade per-line redaction
- `bridge_read_raw` (opt-in via `BRIDGE_ALLOW_RAW=1`) returns bytes unredacted by design
- `--dangerously-skip-permissions` on the master is intentional: the master can run shell commands

## Reporting a vulnerability

This is a personal project. If you believe you have found a security issue:

1. Do not open a public issue
2. Open a private security advisory via the GitHub Security tab on this repository

If the issue is in a dependency, please file upstream first.

## Audit history

A full audit pass was performed before initial release. Three auditors (security-engineer, code-auditor-ml, backend-architect) reviewed the codebase. The consolidated report and resolution status is at [docs/AUDIT.md](docs/AUDIT.md). All 6 CRITICAL and all 6 load-bearing HIGH findings were resolved before the initial release.
