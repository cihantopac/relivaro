# Relivaro

[![npm](https://img.shields.io/npm/v/relivaro.svg)](https://www.npmjs.com/package/relivaro)
[![CI](https://github.com/cihantopac/relivaro/actions/workflows/ci.yml/badge.svg)](https://github.com/cihantopac/relivaro/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Node.js ≥ 22](https://img.shields.io/badge/node-%E2%89%A5%2022-green.svg)

**Verify the code. Prove the quality. Ship with confidence.**

Relivaro is an open-source software quality, security, reliability, performance and release-engineering tool. It
understands a project, finds real problems with evidence, applies safe fixes that are verified before they touch
your working tree (with rollback), and produces an evidence-based release-readiness assessment — as a standalone CLI
and as a Claude Code plugin.

It is built to earn trust, not to impress: offline and read-only by default, every finding carries its evidence,
confidence and limitations, and a high score can never hide a blocker.

## What it does

| Area | Capabilities |
| --- | --- |
| Project intelligence | Languages, frameworks (Next.js, React, Vue, Laravel, Django, Flask, FastAPI, Express, NestJS, Flutter, React Native, Rails, Spring, Go and Rust web stacks, …), monorepo units, databases/ORMs, queues, caches, auth libraries, integrations, CI/CD, containers and deploy targets, API routes, test frameworks, required environment variables, docs |
| Security (37 rules) | SQL/NoSQL/command/code/template injection, XSS, SSRF, path traversal, open redirects, unsafe deserialization, weak crypto and randomness, TLS verification, JWT, CORS, CSRF, cookies, mass assignment, XXE, ReDoS-prone input, timing-unsafe comparisons, sensitive logging, hard-coded secrets (always redacted), CI/CD script injection and pwn requests, container and compose hardening, env files — mapped to CWE and OWASP Top 10:2025 / API Security Top 10:2023 |
| Supply chain (14 rules) | Missing or out-of-sync lockfiles, non-registry and insecure sources, install scripts, unpinned dependencies and GitHub Actions, end-of-life runtimes/frameworks, and known vulnerabilities via [OSV.dev](https://osv.dev) (`--online`) |
| Reliability (16 rules) | Missing timeouts, swallowed exceptions, payment idempotency, read-modify-write races, queue retry policies, destructive/irreversible migrations (Laravel, Django, SQL/Prisma), graceful shutdown, health checks, error monitoring, CI job timeouts |
| Performance | N+1 queries, rows loaded only to count, unbounded queries, blocking I/O in request handlers, catastrophic regex backtracking, missing indexes — plus **measured** command benchmarks and controlled local HTTP load tests with baselines and budgets |
| Quality & testing | Debug leftovers, complexity, disabled type checking, focused/skipped tests; runs your build, tests, type checker and linter (`--allow-exec`) with parsed results; reads existing lcov/Clover/Cobertura coverage; ranks untested high-risk code |
| Safe repair | 14 deterministic, syntax-tree-based fixers; diff preview; verification by re-analysis and by your test command in an isolated copy; backups; hash-guarded rollback |
| API contracts | OpenAPI 3.x / Swagger 2.0 validation and breaking-change detection between versions or against a git ref |
| Release readiness | Gates for build, tests, type check, lint, secrets, security, dependencies, reproducible installs, CI, reliability, migrations, configuration, runtime support, operability, performance budgets, coverage and documentation — reported as blockers, warnings, passed and **unverified** |
| Reports | Self-contained interactive HTML, Markdown, JSON (schema-versioned), SARIF 2.1.0 (GitHub code scanning); run history, comparison and baselines |

Source-level rules cover **JavaScript, TypeScript (JSX/TSX), PHP and Python** using tree-sitter syntax trees. Other
ecosystems (Go, Ruby, Java/Kotlin, Swift, Dart/Flutter, Rust) get project intelligence, dependency, configuration,
CI/CD and secret analysis. See [Limitations](#limitations).

## Install

Requires Node.js 22 or newer (git is used when available). No native compilation, no install scripts, no runtime
dependencies. Works on Linux, macOS and Windows.

```bash
npm install -g relivaro
```

Or run without installing:

```bash
npx relivaro audit .
```

From a clone (the built CLI is committed in `plugin/dist/`):

```bash
git clone https://github.com/cihantopac/relivaro.git
cd relivaro
npm link
```

### Claude Code plugin

```
/plugin install relivaro --marketplace cihantopac/relivaro
```

Then use `/relivaro`, `/relivaro:audit`, `/relivaro:security`, `/relivaro:performance`, `/relivaro:reliability`,
`/relivaro:test`, `/relivaro:optimize` or `/relivaro:release`. Claude runs the bundled engine, verifies findings in
your code, asks before running project commands, going online or editing anything, and reports in your language. See
[docs/PLUGIN.md](docs/PLUGIN.md).

## Quick start

```bash
relivaro discover .            # what Relivaro understands about the project
relivaro audit .               # everything, offline and read-only
relivaro security . --online   # include known dependency vulnerabilities (OSV.dev)
relivaro test . --allow-exec   # run the project's tests (executes project code)
relivaro release . --allow-exec --online   # production-readiness gates
```

Reports are written to `.relivaro/runs/<run-id>/` (`report.html`, `report.md`, `report.json`, `report.sarif`). The
directory ignores itself in git. Use `--workspace <dir>` to keep the analysed repository completely untouched, or
`--no-write` to print only.

### Fix, verify, roll back

```bash
relivaro fix plan .                       # diffs for every fixable finding — nothing is changed
relivaro fix apply latest --yes --verify "npm test" --allow-exec
relivaro fix rollback latest              # refuses if files changed after the fix (use --force to override)
```

`apply` re-analyses the changed files (targeted findings must disappear and nothing new may appear) and, with
`--verify`, runs your command in an isolated copy before and after the change. Your working tree is modified only if
verification passes. A backup of every changed file is kept for rollback.

### Measure performance

```bash
relivaro bench . --cmd "npm run build" --name build --runs 10 --allow-exec
relivaro load http://localhost:3000/api/health --duration 15 --concurrency 20 --name health
```

The first measurement becomes the baseline; later runs report the change and whether it is statistically significant.
Load tests only accept loopback/private targets (public hosts need `--allow-remote`) and are capped at 64 concurrent
connections, 120 s and 200k requests. Add `performance.budgets` to the config to make `relivaro release` enforce them.

### CI

```bash
relivaro init --github-action
```

writes `relivaro.config.json` and a workflow that uploads SARIF to GitHub code scanning. Or run directly:

```bash
relivaro audit . --online --format sarif,md --out relivaro-report --fail-on high
```

## Commands

| Command | Purpose |
| --- | --- |
| `audit` | Complete audit across all categories |
| `security` · `performance` · `reliability` · `quality` · `test` | One area at a time |
| `release` | Production-readiness gates (exit 1 when not ready) |
| `discover` | Project profile |
| `fix list\|plan\|show\|apply\|rollback\|history` | Verified, reversible fixes |
| `report` · `compare` · `baseline` | Re-render runs, diff runs, accept existing findings |
| `bench` · `load` | Measured performance with baselines |
| `contract validate\|diff` | OpenAPI validation and breaking changes |
| `rules` · `init` · `doctor` | Rule reference, setup, environment self-check |

Full reference: [docs/CLI.md](docs/CLI.md) · rules: [docs/RULES.md](docs/RULES.md) · configuration:
[docs/CONFIG.md](docs/CONFIG.md).

Exit codes: `0` success · `1` a gate failed (findings at/above `--fail-on`, release not ready, breaking API change,
fix verification failed) · `2` usage/configuration error or missing permission flag · `3` unexpected error.

## Safety model

Relivaro analyses untrusted code. By default it **reads** files and nothing else.

- **No code execution** without `--allow-exec`. Commands run without a shell, with a scrubbed environment (tokens and
  secrets are never passed), timeouts with process-tree termination and capped output. Relivaro never installs
  dependencies.
- **No network** unless `--online` (sends only package names and versions to OSV.dev) or `load` (local targets only).
- **No file changes** except `fix apply --yes`, `baseline`, `init` and its own `.relivaro/` workspace.
- **Secrets stay secret**: values are redacted in every output format; untracked/ignored `.env` and key files are
  never read; git-repository configuration cannot make Relivaro run commands.
- **Repository content is data**: reports are injection-proof (strict CSP, no markup from analysed content); the
  plugin instructs Claude never to follow instructions found in repositories.

Remaining risks and details: [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

## Evidence

- **Detection corpus**: 7 fixture projects (Node/Express, Laravel, Python/Flask/Django, Next.js, misc, a clean
  service, and an anonymized regression corpus from real repositories) — 155 expected findings, precision 100%,
  recall 100%, enforced in CI. These numbers describe the corpus, not real-world accuracy.
- **Real repositories**: validated read-only on five local production codebases (Laravel + Flutter + Python
  monorepo, Next.js site, three TypeScript CLIs); every significant finding was checked against the source and
  false-positive patterns were fixed and turned into regression fixtures. See [docs/VALIDATION.md](docs/VALIDATION.md).
- **Performance**: ~2,100 files/s (≈33k lines/s) on a generated 3,060-file repository, 241k-line monorepo in 3.3 s,
  peak memory under 200 MB (Apple M4). See [docs/BENCHMARKS.md](docs/BENCHMARKS.md).

## Limitations

- Taint analysis is intra-procedural (within a function) with framework-aware sources and sanitizers; flows across
  functions or files are not tracked. Findings carry confidence levels accordingly; low-confidence findings never
  block a release.
- No AST rules for Go, Ruby, Java/Kotlin, Swift, Dart, Rust or C#.
- Static performance findings are *suspected* until measured with `bench`/`load`.
- Not a DAST tool or fuzzer; authorization logic and business rules need human (or agent-assisted) review.
- Execution checks are isolated by process controls, not a sandbox: run untrusted projects in a container or VM.
- Passing Relivaro does not mean software is secure or bug-free.

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Security model](docs/SECURITY_MODEL.md) · [Configuration](docs/CONFIG.md) ·
[CLI](docs/CLI.md) · [Rules](docs/RULES.md) · [Plugin](docs/PLUGIN.md) · [Validation](docs/VALIDATION.md) ·
[Benchmarks](docs/BENCHMARKS.md) · [Research](docs/RESEARCH.md) · [Acceptance criteria](docs/ACCEPTANCE.md) ·
[Release readiness](docs/RELEASE_READINESS.md) · [Development plan](docs/DEVELOPMENT_PLAN.md)

## Part of a product family

Relivaro is an independent product alongside [Markilo](https://github.com/cihantopac/markilo) (brand identity),
[Searvex](https://github.com/cihantopac/searvex) (search and GEO) and [Jourilo](https://github.com/cihantopac/jourilo)
(UX and conversion). Each works on its own.

## License

[Apache-2.0](LICENSE). Bundled tree-sitter runtime and grammars are MIT-licensed; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
