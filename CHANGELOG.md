# Changelog

All notable changes to Relivaro are documented here. The format follows [Keep a Changelog](https://keepachangelog.com)
and the project uses [Semantic Versioning](https://semver.org).

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
