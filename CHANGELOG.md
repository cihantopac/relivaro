# Changelog

All notable changes to Relivaro are documented here. The format follows [Keep a Changelog](https://keepachangelog.com)
and the project uses [Semantic Versioning](https://semver.org).

## [1.1.0] — 2026-11-01

Polish and release-experience update. No breaking changes: JSON (schema v1), SARIF, Markdown, configuration
and workspace files from 1.0 keep working.

### Added

- Redesigned HTML report: a dashboard with release-readiness score, gate tiles, KPI cards, an audit → evidence → fix →
  verify → release flow, severity/category/hotspot charts, a searchable and filterable findings explorer with
  evidence snippets, verification results, coverage, measured benchmarks, comparison with the previous run and an
  explicit "what this run did not verify" panel. English and Türkçe with a language switcher (browser language by
  default), light and dark themes, keyboard accessible, responsive, still a single offline file under a strict CSP.
- Release gates carry their `basis` (`executed`, `measured`, `advisory-db`, `static`, `not-run`) and the assessment a
  `tally`, so a static "pass" is never mistaken for an executed one. CLI and Markdown show both.
- `relivaro rules <id>` as a shorthand for `rules show <id>`.

### Changed

- `release` reports `ready` only when every applicable gate passed **and was verified**; unverified gates now yield
  `ready-with-warnings` (exit codes are unchanged).
- Fix verification reports findings it cannot re-check statically as `unverifiable` instead of `resolved`.

### Fixed

- `fix apply` is transactional across files: targets are re-checked right before writing, a failed write restores
  the files already written, and an interrupted apply is recorded (`state: applying`) and can be rolled back.
- `fix rollback --force` saves later edits under `.relivaro/fixes/<id>/conflicts/` before restoring, validates every
  backup before touching any file, and leaves files that are already in their original state alone.
- Isolated verification copies dereference symlinks, never write through a link into the project, and report files
  the verification command changed in the original project.
- `load` re-validates the target address on every connection (DNS rebinding) and classifies shared (100.64/10),
  benchmarking (198.18/15), "this network" (0/8), IPv4-mapped and NAT64 addresses correctly; `.test` hosts are
  resolved instead of assumed local. Keep-alive connections are closed when the test ends.
- `relivaro report` without `--format` wrote no files (list option defaults were not split).

## [1.0.0] — 2026-10-31

First public release.

### Added

- Standalone CLI (`relivaro`) bundled as a single file with WebAssembly tree-sitter grammars; no runtime dependencies,
  no native builds; Node.js ≥ 22 on Linux, macOS and Windows.
- Project intelligence across npm/pnpm/yarn, Composer, PyPI/Poetry/uv, Go, Cargo, RubyGems, Pub, Maven/Gradle,
  CocoaPods/SwiftPM: units, frameworks, data stores, queues, auth, integrations, CI/CD, containers, deploy targets,
  API routes, tests, environment variables and documentation.
- 83 rules: 37 security, 14 supply-chain, 16 reliability, 6 performance, 6 quality, 3 testing, 1 release; AST rules
  for JavaScript, TypeScript/TSX, PHP and Python with intra-procedural taint; CWE and OWASP Top 10:2025 / API Top
  10:2023 mapping.
- Known-vulnerability lookup through OSV.dev (`--online`) with CVSS-based severity and fixed versions.
- Execution checks (`--allow-exec`) for build, tests, type checking and linting with parsed results; coverage report
  ingestion (lcov, Clover, Cobertura, Istanbul); risk-ranked test gaps.
- 14 deterministic fixers; `fix plan|show|apply|rollback|history` with diff preview, static and isolated
  command verification, backups and hash-guarded rollback.
- `release` readiness gates with blockers, warnings, passed and unverified states and a score capped by blockers.
- Reports: JSON (schema v1), Markdown, interactive self-contained HTML, SARIF 2.1.0; `report`, `compare`, `baseline`.
- `bench` (command benchmarks with baselines and significance) and `load` (local/private HTTP load tests with caps).
- `contract validate|diff` for OpenAPI 3.x / Swagger 2.0 breaking-change detection (files or git refs).
- Claude Code plugin with `/relivaro` and `audit`, `security`, `performance`, `reliability`, `test`, `optimize`,
  `release` skills and a `finding-verifier` agent; `--json --compact` output for agents.
- Inline suppressions, baselines, JSON configuration with schema, `init` (config + GitHub workflow), `doctor`.
