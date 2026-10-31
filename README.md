<h1 align="center">Relivaro</h1>

<h3 align="center">Verify the code. Prove the quality. Ship with confidence.</h3>

<p align="center">
  Open-source release engineering for real codebases: an offline audit engine that shows its evidence,<br>
  fixes that are verified before they touch your tree, and release gates that never hide what they did not check.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/relivaro"><img alt="npm" src="https://img.shields.io/npm/v/relivaro?color=0b7285&label=npm"></a>
  <a href="https://github.com/cihantopac/relivaro/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cihantopac/relivaro/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-0b7285"></a>
  <img alt="Node.js ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A5%2022-121620">
  <img alt="Platforms" src="https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-121620">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-report">The report</a> ·
  <a href="#claude-code-plugin">Claude Code plugin</a> ·
  <a href="#evidence">Evidence</a> ·
  <a href="#limitations">Limitations</a> ·
  <a href="docs/">Docs</a>
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/screenshots/report-hero-dark.png">
    <img src="assets/screenshots/report-hero.png" alt="Relivaro release dashboard: readiness score, gate tally, KPIs, audit-to-release flow and findings charts" width="900">
  </picture>
</p>

## Why Relivaro

Most scanners give you a list. Relivaro gives you a decision you can defend.

- **Evidence, not opinions.** Every finding carries the file and line, a redacted snippet, structured facts,
  confidence, impact, remediation, how to verify it, and CWE/OWASP mapping.
- **Fixes you can trust.** Deterministic, syntax-tree fixers. A fix is re-analysed and, if you want, tested in an
  isolated copy *before* your working tree changes — with backups and hash-guarded rollback.
- **Honest release gates.** Build, tests, secrets, security, dependencies, CI, migrations and more, each marked as
  executed, measured, static analysis or **not run**. Unverified is a state, never a silent pass.
- **Safe by default.** Offline and read-only. Project code runs only with `--allow-exec`, the network is used only
  with `--online`, and files change only through `fix apply --yes`.

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/diagrams/workflow-dark.svg">
    <img src="assets/diagrams/workflow-light.svg" alt="Audit → Evidence → Fix → Verify → Release" width="900">
  </picture>
</p>

| | What happens | You get |
| --- | --- | --- |
| **Audit** | Project intelligence (stacks, monorepo units, data stores, CI/CD, routes, env vars) and 83 rules over tree-sitter syntax trees with intra-procedural taint | Findings with confidence, not keyword hits |
| **Evidence** | Each finding is tied to code, facts and standards; secrets are always redacted | A reason to act — or to suppress with a reason |
| **Fix** | 14 deterministic fixers produce a reviewable diff plan | Nothing changes until you approve |
| **Verify** | Targeted findings must disappear, nothing new may appear, your test command must still pass | `verified`, `static-only` or a refused change |
| **Release** | Gates combine executed checks, measurements and static analysis | ready · ready with warnings · needs verification · not ready |

## Quick start

```bash
npm install -g relivaro
```

```bash
relivaro audit .                            # everything, offline and read-only
relivaro release . --allow-exec --online    # run build/tests, check OSV.dev, assess readiness
```

Open `.relivaro/runs/<run-id>/report.html` — or `report.md`, `report.json`, `report.sarif`. No install? Use
`npx relivaro audit .`. Requires Node.js 22+; no native builds, no install scripts, no runtime dependencies.

### Fix, verify, roll back

```bash
relivaro fix plan .                                              # diffs only
relivaro fix apply latest --yes --verify "npm test" --allow-exec # verified in an isolated copy first
relivaro fix rollback latest                                     # refuses to overwrite later edits
```

A multi-file apply is transactional: if any write fails, the files already written are restored. An interrupted
apply can be rolled back, and a forced rollback saves your later edits before restoring.

### More

```bash
relivaro security . --online                          # code + supply chain + known vulnerabilities
relivaro bench . --cmd "npm run build" --runs 10 --allow-exec   # measured, with baselines
relivaro load http://localhost:3000/health --duration 15        # local/private targets only
relivaro contract diff openapi.yaml --base main                 # breaking API changes
relivaro init --github-action                                   # SARIF to GitHub code scanning
```

## The report

One self-contained HTML file per run: no CDN, no fonts, no network — open it from disk or attach it to a ticket.

<table>
  <tr>
    <td width="66%"><img src="assets/screenshots/report-findings.png" alt="Findings explorer with evidence snippet, impact, remediation and automated fix command"></td>
    <td width="34%"><img src="assets/screenshots/report-mobile-dark-tr.png" alt="The report on a phone, dark theme, in Turkish"></td>
  </tr>
  <tr>
    <td><sub>Findings explorer: search, filter by severity, category, gate or fixability; evidence with the reported line highlighted.</sub></td>
    <td><sub>Responsive, light and dark, <b>English | Türkçe</b>.</sub></td>
  </tr>
</table>

Gate tiles show what each result rests on; charts are drawn only from what the run measured; a "what this run did
not verify" panel lists every limitation. Details: [docs/REPORT.md](docs/REPORT.md).

## Coverage

| Area | Highlights |
| --- | --- |
| Security · 37 rules | Injection (SQL/NoSQL/command/code/template), XSS, SSRF, path traversal, open redirects, unsafe deserialization, weak crypto, TLS, JWT, CORS, CSRF, cookies, mass assignment, XXE, ReDoS, secrets, CI/CD script injection, container hardening |
| Supply chain · 14 rules | Lockfiles, non-registry sources, install scripts, unpinned dependencies and GitHub Actions, end-of-life runtimes, known vulnerabilities via [OSV.dev](https://osv.dev) |
| Reliability · 16 rules | Timeouts, swallowed exceptions, payment idempotency, races, queue retries, destructive migrations, graceful shutdown, health checks, monitoring |
| Performance · 6 rules | N+1 queries, counting by loading rows, unbounded queries, blocking I/O, catastrophic backtracking, missing indexes — plus measured benchmarks and load tests |
| Quality & testing · 9 rules | Debug leftovers, complexity, disabled type checks, focused/skipped tests; executes build, tests, type checker and linter; reads coverage; ranks untested risk |
| API contracts | OpenAPI 3.x / Swagger 2.0 validation and breaking-change detection |

Source-level rules cover **JavaScript, TypeScript (JSX/TSX), PHP and Python**. Go, Ruby, Java/Kotlin, Swift,
Dart/Flutter and Rust projects get project intelligence, dependency, configuration, CI/CD and secret analysis.
Rule reference: [docs/RULES.md](docs/RULES.md).

## Claude Code plugin

```text
/plugin marketplace add cihantopac/relivaro
/plugin install relivaro@relivaro
```

Then `/relivaro` runs the whole flow, or use `/relivaro:audit`, `:security`, `:performance`, `:reliability`, `:test`,
`:optimize` and `:release`. Claude runs the bundled engine, checks significant findings in your code, asks before
executing project commands, going online or editing anything, and reports in your language.
[docs/PLUGIN.md](docs/PLUGIN.md)

## Evidence

Numbers from the 1.1.0 release build (Apple M4, Node 22). They describe the test corpus and these machines, not
real-world accuracy in general.

| Claim | Measurement |
| --- | --- |
| Tests | **139 tests** (unit, integration, security, end-to-end) on Linux, macOS and Windows × Node 22 and 24 in CI |
| Detection corpus | 7 fixture projects, **155 expected findings: precision 100%, recall 100%**, 77 rules exercised — enforced in CI. A controlled corpus: real code will produce false positives and misses |
| Real repositories | Validated read-only on 5 production codebases (Laravel + Flutter + Python monorepo, a Next.js site, three TypeScript CLIs); every significant finding checked by hand, false-positive patterns fixed and kept as regression fixtures — [docs/VALIDATION.md](docs/VALIDATION.md) |
| Speed | 3,060-file synthetic repository in **1.39 s** (2,207 files/s, peak RSS 129 MB); a 241k-line monorepo in about 3 s — [docs/BENCHMARKS.md](docs/BENCHMARKS.md) |
| Fix safety | Regression tests for interrupted and failed multi-file applies, corrupt backups, forced rollbacks and symlinks in the verification copy |
| Report safety | Tests inject `</script>` payloads through analysed source; the report stays inert and makes no network requests |

## Limitations

- Taint tracking is intra-procedural; flows across functions or files are not followed. Low-confidence findings never
  block a release.
- No syntax-tree rules for Go, Ruby, Java/Kotlin, Swift, Dart, Rust or C#.
- Static performance findings are suspicions until measured with `bench` or `load`.
- Not a DAST tool or fuzzer; authorization logic and business rules still need human review.
- `--allow-exec` runs project code with process controls, not a sandbox: use a container or VM for untrusted code.
- Passing Relivaro does not mean software is secure or bug-free. Details:
  [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md).

## Documentation

[CLI](docs/CLI.md) · [Configuration](docs/CONFIG.md) · [Rules](docs/RULES.md) · [HTML report](docs/REPORT.md) ·
[Plugin](docs/PLUGIN.md) · [Security model](docs/SECURITY_MODEL.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Validation](docs/VALIDATION.md) · [Benchmarks](docs/BENCHMARKS.md) · [Release readiness](docs/RELEASE_READINESS.md) ·
[Changelog](CHANGELOG.md)

## Product family

Independent tools by the same author. Each works on its own; none requires another.

| | |
| --- | --- |
| [**Markilo**](https://github.com/cihantopac/markilo) | Brand identity and vector design — researched, verified, exported |
| [**Searvex**](https://github.com/cihantopac/searvex) | SEO, GEO and search intelligence with sourced audits |
| [**Jourilo**](https://github.com/cihantopac/jourilo) | UX, user journeys and conversion engineering in a real browser |
| **Relivaro** | Software quality, security and release readiness |

## License

[Apache-2.0](LICENSE). Bundled tree-sitter runtime and grammars are MIT-licensed; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
