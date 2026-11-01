# Release readiness — Relivaro 1.2.0

Produced by running Relivaro on itself: `relivaro release . --allow-exec --online` (run `20261101-004621-69c5e1`, 2026-11-01, darwin/arm64, Node v22.23.2).

## Result: **READY** — score 90/100

13 passed · 0 warnings · 0 unverified · 0 blockers (3 not applicable). The basis column says what each result rests on:
`executed` (the command ran), `advisory-db` (OSV.dev was queried), `measured` (a benchmark), `static` (rules only).

| Gate | Status | Basis | Evidence |
| --- | --- | --- | --- |
| Build succeeds | ✅ passed | executed | `npm run build --silent` passed in 0.3s |
| Automated tests pass | ✅ passed | executed | `npm test --silent` passed in 11.5s (154 passed) |
| Type checking passes | ✅ passed | executed | `npm run typecheck --silent` passed in 0.4s |
| Lint passes | ✅ passed | executed | `npm run lint --silent` passed in 0.4s |
| No exposed secrets | ✅ passed | static | No secrets detected in analysed files. |
| No unresolved high-risk security findings | ✅ passed | static | No security findings at medium or above with medium/high confidence. |
| No known-vulnerable dependencies | ✅ passed | advisory-db | 131 resolved packages checked against OSV.dev; no advisories. |
| Reproducible dependency installs | ✅ passed | static | 1 lockfile(s), consistent with manifests. |
| CI runs tests on every change | ✅ passed | static | GitHub Actions configured and runs tests. |
| No high-risk reliability defects | ✅ passed | static | No medium or higher reliability findings. |
| Database migrations are safe to deploy and roll back | ➖ n/a | static | No migrations found. |
| Required environment variables are documented | ➖ n/a | static | No environment variables read by the code. |
| Supported runtimes and frameworks | ✅ passed | static | No end-of-life runtime or framework versions detected. |
| Operational readiness (health checks, monitoring, shutdown) | ➖ n/a | static | No deployable service detected. |
| Performance budgets met | ✅ passed | measured | 1 budget(s) met by the latest measurements. |
| Installation and usage documentation | ✅ passed | static | README (12 KB), LICENSE, CHANGELOG, SECURITY policy. |

> This assessment is based on automated checks and their stated limitations. Passing it does not prove the software is free of vulnerabilities or defects.

## Open findings

35 open findings: 0 critical, 0 high, 4 medium, 31 low, 0 info. All are `qual/high-complexity` (maintainability observations on long, linear functions such as `discover`, `assessRelease`, `validateConfig` and the `fix` command) — tracked in the backlog, not changed to raise a score.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| Advertised features work | 154 automated tests (unit, integration, security, e2e) passing; e2e tests cover every CLI command |
| Detection accuracy | Fixture corpus: 155 expected findings, precision 100%, recall 100% ([BENCHMARKS.md](BENCHMARKS.md)) |
| Real-world validation | 5 local repositories, all significant findings verified, 19 false-positive patterns fixed and captured as regressions ([VALIDATION.md](VALIDATION.md)) |
| Safe fix / verify / rollback | Integration tests: static verification, isolated command verification rejecting a regression without touching the tree, stale-plan and rollback-conflict refusal, exact restore, transactional multi-file apply (failed write restored), interrupted-apply rollback, forced rollback preserving later edits, corrupt-backup refusal, symlinks in the verification copy, unverifiable findings never counted as resolved |
| Security boundaries | Security tests: secret redaction in all formats, untracked `.env` never read, symlink escape, git `core.fsmonitor` execution attempt, no-shell argv, env scrubbing, output caps, offline guarantee, load-target policy (incl. IPv4-mapped/NAT64/CGNAT and connection-time DNS re-validation), HTML injection and offline self-containment, EN/TR string parity |
| Report actions | Fix-prompt builder tested against hostile titles, messages, paths, snippets, forged markers and secrets; selection, prompt, copy and download checked in Chromium, WebKit and Firefox (EN/TR, light/dark, 375 px, keyboard, `file://`, no network) |
| Clean installation | `scripts/smoke-install.mjs`: npm pack → install into an empty directory → `doctor` + audit of a fixture |
| Performance | 3060 files in 1.43 s (2134 files/s), 241k-line monorepo in 2.9–3.2 s, peak RSS 208 MB; self-audit budget met |
| Claude Code plugin | `claude plugin validate --strict` passes for marketplace and plugin; headless `/relivaro:audit` runs on clones of repo-1 answered in 150–183 words with the report path and recorded verdicts; a report-generated fix prompt led Claude Code to re-check, reject false positives and ask before changing code ([VALIDATION.md](VALIDATION.md)) |
| Exit codes, errors | e2e tests for 0/1/2, JSON errors on stderr |
| CI and quality gates | Green on GitHub Actions — `.github/workflows/ci.yml`: Linux/macOS/Windows × Node 22/24, lint, typecheck, dist check, tests, clean install, benchmark gate, plugin validation, self-audit with SARIF |
| Documentation and OSS files | README, CLI and rule references (generated), configuration, security model, architecture, plugin, validation, benchmarks, research; LICENSE (Apache-2.0), NOTICE, third-party notices, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT, CHANGELOG |

## Cross-platform verification

The CI matrix (Ubuntu, macOS, Windows × Node 22 and 24) passes on GitHub-hosted runners, including the clean-install test, benchmark gate, strict plugin validation and the self-audit release gate with SARIF upload. The first Windows run exposed a real defect (8.3 short paths made git-listed files look outside the root), fixed before release.

## Remaining limitations

- Limitations of the analysis itself are listed in the README (intra-procedural taint, AST languages, static performance suspects, no sandbox for executed commands).
