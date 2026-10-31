# Development plan and log

Persistent record of scope, decisions, verified progress and open issues. Update it with every significant change.

## Status (2026-10-31)

v1.0.0 release candidate: all acceptance criteria in [ACCEPTANCE.md](ACCEPTANCE.md) are met except those that need
infrastructure not available locally (see *Pending external verification*). Publishing awaits the maintainer's
approval.

## Milestones (internal)

| Milestone | Result |
| --- | --- |
| M1 Core engine | FileSet, tree-sitter layer, discovery, rule engine, run records, reports, CLI |
| M2 Rule packs | 83 rules across security, supply chain, reliability, performance, quality, testing |
| M3 Fixture corpus | 7 fixture projects, 155 annotated expectations, 100% precision/recall |
| M4 Real-world validation | 5 local repositories; 19 false-positive patterns fixed and captured as regressions; 3 engine bugs fixed |
| M5 Safe repair | 14 fixers, plan/apply/verify (static + isolated command)/rollback, conflict detection |
| M6 Execution & measurement | build/test/typecheck/lint checks with parsers, OSV, coverage, test gaps, bench, load, contracts |
| M7 Plugin | 8 skills + verifier agent, strict validation, headless verification, compact agent output |
| M8 Release engineering | 124 tests, CI matrix, benchmark gate, clean-install test, self-audit, documentation |

## Decisions

See [ARCHITECTURE.md](ARCHITECTURE.md#key-decisions). Additional ones:

- **Node ≥ 22**: Node 20 reached end of life on 2026-04-30; Relivaro's own EOL rule would flag it.
- **Fixture secrets are injected at test time** so the repository never contains credential-shaped strings (push
  protection, secret scanners).
- **Generic secret assignments are skipped in test files**; provider-format tokens are reported everywhere.
- **Low-confidence findings never block a release** and are excluded from `--fail-on`.
- **Units inside fixture/example/bench directories** are excluded from unit-level project rules.

## Known limitations (documented, not defects)

- Intra-procedural taint only; framework middleware/validation in other files is invisible to rules (the plugin's
  verification step covers it).
- Complex functions in Relivaro itself (`discover`, `assessRelease`, `validateConfig`) are reported by its own
  complexity rule; they are linear and covered by tests. Refactoring them is tracked below, not done to raise a score.
- Command benchmarks report wall time only (no child-process memory).
- Execution checks are not sandboxed (documented in SECURITY_MODEL.md).

## Pending external verification

- CI on GitHub-hosted Windows and Linux runners (the workflows exist; local runs were on macOS arm64). Windows-specific
  code paths (`.cmd` shims, `taskkill`, path separators) are implemented but have not executed on Windows yet.
- npm publication and marketplace installation from GitHub (require the maintainer's approval).

## Backlog (post-1.0)

- Inter-procedural taint within a file; cross-file summaries for common frameworks.
- AST rules for Go and Dart.
- Git history secret scanning (opt-in).
- `relivaro fix` for unpinned GitHub Actions (resolve SHAs with `--online`).
- Split `discover()` and `assessRelease()` into smaller units.
