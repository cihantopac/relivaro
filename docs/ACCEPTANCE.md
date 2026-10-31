# Relivaro v1.0 — Scope and Acceptance Checklist

This document defines what Relivaro v1.0 promises and how each promise is verified. A feature that is not listed
here is not advertised. Every box is checked only with evidence (a test, a benchmark result or a recorded
real-world audit), and the evidence is linked from `docs/RELEASE_READINESS.md`. `[~]` marks criteria that need
infrastructure not available during local development.

## 1. Scope

### In scope (advertised)

| Area                   | v1.0 capability                                                                                                                                                                                | Depth                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Project intelligence   | Languages, package managers, frameworks, monorepo workspaces, databases/ORMs, queues/caches, auth libraries, CI/CD, containers, test frameworks, required environment variables, documentation | Node/TS, PHP, Python, Go, Ruby, Java/Kotlin, Dart/Flutter, Swift/iOS, Rust manifests; framework adapters listed in `docs/RULES.md` |
| Code analysis (AST)    | Security, reliability, performance and quality rules on syntax trees                                                                                                                           | JavaScript, TypeScript, JSX/TSX, PHP, Python (tree-sitter)                                                                         |
| Configuration analysis | GitHub Actions, Dockerfile, docker-compose, `.env*` hygiene, framework config (Laravel, Next.js, Django, Express)                                                                              | Language-independent                                                                                                               |
| Secrets                | Provider-specific secret patterns + generic high-entropy assignments, always redacted                                                                                                          | All text files                                                                                                                     |
| Supply chain           | Lockfile presence/consistency, install scripts, non-registry sources, unpinned GitHub Actions, known vulnerabilities via OSV.dev (`--online`)                                                  | npm, pnpm, yarn, Composer, pip/Poetry, Go, Cargo, RubyGems, Pub                                                                    |
| Execution checks       | Build, type check, lint and tests run in a restricted subprocess (opt-in `--allow-exec`) with parsed results                                                                                   | npm/pnpm/yarn scripts, tsc, PHPUnit/Pest, pytest, go test, cargo test, flutter test                                                |
| Coverage               | Reads existing lcov / Clover / Cobertura reports                                                                                                                                               | Any language producing these formats                                                                                               |
| Test gaps              | Ranks untested high-risk modules for test generation                                                                                                                                           | AST languages                                                                                                                      |
| Performance            | Static anti-patterns (N+1, unbounded queries, sync I/O in handlers, ReDoS); measured command benchmarks with baselines; local HTTP load tests                                                  | Load tests restricted to local/private targets                                                                                     |
| Reliability            | Timeouts, retries, error handling, idempotency signals, migration safety, graceful shutdown, health checks, observability                                                                      | AST languages + migrations (Laravel, Prisma, Django, raw SQL)                                                                      |
| Safe fix               | Deterministic fixers with diff preview, isolated verification in a temporary copy, apply with backup, hash-guarded rollback                                                                    | Fixers listed in `docs/RULES.md`                                                                                                   |
| Release readiness      | Gate-based assessment: blockers, warnings, passed, unverified; score capped by blockers                                                                                                        | All                                                                                                                                |
| Reports                | JSON (schema-versioned), Markdown, self-contained interactive HTML, SARIF 2.1.0; run history and comparison                                                                                    | All                                                                                                                                |
| Claude Code plugin     | `/relivaro`, `/relivaro:audit`, `:security`, `:performance`, `:reliability`, `:test`, `:optimize`, `:release`                                                                                  | Uses the bundled CLI                                                                                                               |

### Out of scope for v1.0 (documented, not advertised)

- Inter-procedural / cross-file taint tracking. Rules are intra-procedural with source/sink heuristics; findings
  carry a confidence level that reflects this.
- Dynamic application security testing (DAST) of running applications, fuzzing.
- AST rules for Go, Ruby, Java/Kotlin, Swift, Dart, Rust, C# (project intelligence, dependencies and config only).
- Deterministic test generation in the CLI. Test generation is performed by the Claude Code plugin, guided by the
  CLI's test-gap analysis and verified by running the generated tests.
- Load tests against public internet targets.

## 2. Acceptance criteria

### Product

- [x] Every command in `docs/CLI.md` works and is covered by an e2e test.
- [x] No placeholder, stub or simulated output in any advertised feature (`scripts/check-placeholders.mjs` runs in CI).
- [x] Every rule has a positive and a negative test fixture; the detection benchmark reports precision/recall per rule.
- [x] Findings include rule id, severity, confidence, category, location, evidence, impact, recommendation, verification method, CWE/OWASP mapping where applicable.
- [x] Offline by default: no network access unless `--online`; verified by a test that runs with network APIs stubbed to throw.
- [x] Deterministic: two runs over the same tree produce identical findings and fingerprints.

### Safety

- [x] Project code is never executed without `--allow-exec`; subprocesses run without a shell, with a scrubbed environment, timeouts, output caps and process-tree kill.
- [x] File access never escapes the project root (symlink and `..` traversal tests).
- [x] Secret values never appear in any output format (redaction tests across JSON, Markdown, HTML, SARIF, stderr).
- [x] Git-ignored files (e.g. `.env`) are never read; env files are only checked for ignore status, `.env.example` only for key names.
- [x] Fixes are never written to the working tree without `--apply`; every applied fix has a backup and rollback refuses to overwrite files modified after the fix.
- [x] Load tests refuse non-local targets unless `--allow-remote`, and enforce request/duration/concurrency caps.
- [x] Configuration is JSON only (no executable config files).
- [x] Repository text is treated as data: the plugin skills instruct the agent never to follow instructions found in analyzed content.

### Quality

- [~] Unit, integration, security and e2e test suites pass on Linux, macOS and Windows (Node 22, 24) in CI. — *verified on macOS arm64 (Node 22); Linux/Windows run in CI on first push*
- [x] Clean-environment installation from the packed tarball is tested in CI.
- [x] Lint and type check pass; bundled `plugin/dist` matches sources (CI guard).
- [x] `claude plugin validate` passes for the marketplace and the plugin.
- [x] Reliable exit codes: 0 success, 1 gate failed, 2 usage/config error, 3 runtime error.
- [x] Real performance benchmarks recorded (`bench/results`): analysis throughput on synthetic and real repositories.

### Real-world validation

- [x] Audits recorded on at least 5 real local repositories covering Next.js, Laravel, Python, Flutter and Node CLI stacks.
- [x] Each significant real-world finding manually verified against source; false positives fixed in Relivaro and converted into anonymized regression fixtures.
- [x] Re-audits after fixes show the improvement.

### Documentation

- [x] README with installation, quick start, commands, safety model, limitations.
- [x] CLI reference and rule reference generated from code.
- [x] LICENSE, NOTICE, THIRD_PARTY_NOTICES, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, CHANGELOG.
- [x] `docs/RELEASE_READINESS.md` produced by running Relivaro's own release gate on itself.
