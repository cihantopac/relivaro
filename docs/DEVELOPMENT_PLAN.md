# Development plan and log

Persistent record of scope, decisions, verified progress and open issues. Update it with every significant change.

## Status (2026-11-12)

v1.6.0 prepared with four new rules from the Frameva field reports: `sec/ssrf-hostname-denylist`,
`sec/ssrf-redirect-bypass`, `rel/unbounded-poll-loop` and `sec/sql-grant-append-only` (all medium or low confidence
until they have field evidence from two repositories). Read-only field check on frameva-engines and frameva.io
(`packages/preflight`, `apps/worker`, `packages/db`): the first SQL run produced 11 findings, 9 of them wrong (later
REVOKEs, rollback scripts, SECURITY DEFINER owner roles, a conditional guard); all became negative fixtures. After the
review fixes the rule also follows dropped triggers, and the final run reports nothing on those repositories, which
matches their hardened state. 93 rules; 11 fixture projects with 185 expected findings at 100% precision/recall; 338
tests. v1.5.0 (CI and hosted scanning) is released.

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

## Cross-platform

CI passes on Ubuntu, macOS and Windows with Node 22 and 24. The first Windows run found a file-listing defect (8.3 short paths), fixed in 1.0.0.

## Backlog (post-1.0)

- Inter-procedural taint within a file; cross-file summaries for common frameworks.
- AST rules for Go and Dart.
- Git history secret scanning (opt-in).
- Split `discover()` and `assessRelease()` into smaller units.

## 1.1.0 — polish and release experience (2026-11-01)

| Phase | Result |
| --- | --- |
| Technical fixes | Transactional multi-file `fix apply`, interrupted-apply rollback, conflict-preserving forced rollback, symlink-safe verification copies with a report of files changed outside the copy; connection-time load-target validation and complete private-range classification; gate `basis` + tally, `ready` only when every gate is verified, `unverifiable` fix findings; `report` default formats and `rules <id>` CLI defects; plugin install command in the docs. Each with a regression test. |
| Brand identity | Started with Markilo (research: 53 sources, 12 competitor brands; 4 directions, 2 sketch rounds, critic gate). Paused at the owner's request until Markilo 1.0.0; the report and README use the product name as text and the researched petrol colour. |
| HTML report | Rebuilt as a bilingual (EN/TR) dashboard; screenshots in `assets/screenshots/` come from real runs (Relivaro on itself with `--allow-exec --online`, and the `node-api` fixture) via `scripts/screenshots.mjs`. |
| README / npm | Product-style README with real numbers; npm description and keywords updated. |

## 1.2.0 — actionable reports and agent-assisted fixes

Problem: on a real monorepo (repo-1 in [VALIDATION.md](VALIDATION.md)) the plugin answered with pages of text, the
HTML report was easy to miss, and nothing led from a finding to a verified fix.

| Area | Result |
| --- | --- |
| Agent answers | One shared 80–150 word format for every skill; report path + open command; verdicts recorded with `relivaro review add`. Compact JSON 57 KB → 22 KB on repo-1 (`groups`, 30 detailed findings, unindented). Tested headlessly in Claude Code on a copy of repo-1. |
| Report | Action center, remediation paths, verification states, selection, grouping, sticky selection bar, fix-prompt dialog (copy with fallback, download, editable). Tested in Chromium, WebKit and Firefox: EN/TR, light/dark, 375 px, keyboard, `file://`, no network requests, hostile content. |
| Review artifact | `runs/<run>/review.json` (schema v1), fingerprint-bound, carried to later runs with provenance; `relivaro recheck` for stale ids. |
| Fixers | `gha-pin-action` (online SHA resolution, peeled annotated tags — found by comparing with the GitHub API on repo-1); test files no longer get behaviour-changing fixers. Deliberately not automated: container users, capabilities, dependency upgrades, lockfile generation, payment logic. |

