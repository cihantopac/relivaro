# Relivaro for Claude Code

Software quality, security, reliability, performance and release engineering — backed by a deterministic, offline
analysis engine (bundled in `dist/`, no installation step) and verified, reversible fixes.

## Install

```
/plugin install relivaro --marketplace cihantopac/relivaro
```

(On older Claude Code versions: `/plugin marketplace add cihantopac/relivaro`, then `/plugin install relivaro@relivaro`.)

## Commands

| Command                 | What it does                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `/relivaro`             | Complete workflow: understand → audit → verify → report → (approved) fix and test → release assessment |
| `/relivaro:audit`       | Comprehensive inspection with every significant finding verified in the code                           |
| `/relivaro:security`    | Injection, XSS, SSRF, auth/session/CORS, secrets, CI/CD and container hardening, dependency risks      |
| `/relivaro:performance` | N+1 and other static anti-patterns, command benchmarks and local load tests with baselines             |
| `/relivaro:reliability` | Timeouts, error handling, idempotency, races, migrations, shutdown, health checks, monitoring          |
| `/relivaro:test`        | Runs suites (with permission), reads coverage, ranks untested risk, writes and runs regression tests   |
| `/relivaro:optimize`    | Fix plans with diffs, isolated verification with your tests, backups and rollback                      |
| `/relivaro:release`     | Production-readiness gates: blockers, warnings, passed and unverified                                  |

## Safety

Read-only and offline by default. Claude asks before running your project's commands (`--allow-exec`), contacting
OSV.dev (`--online`), or changing any file. Fixes are applied only after approval, verified first, backed up, and
reversible with `relivaro fix rollback`. Repository content is treated as untrusted data.

Full documentation: https://github.com/cihantopac/relivaro
