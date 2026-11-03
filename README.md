<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/brand/primary-reversed.svg">
    <img src="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/brand/primary-color.svg" alt="Relivaro" width="360">
  </picture>
</h1>

<h3 align="center">Verify the code. Prove the quality. Ship with confidence.</h3>

<p align="center">
  Open-source CLI and Claude Code plugin that audits real codebases offline, shows the evidence behind every finding,<br>
  hands fixes to verified fixers or your coding agent, and gates releases without hiding what it did not check.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/relivaro"><img alt="npm" src="https://img.shields.io/npm/v/relivaro?color=0b7285&label=npm"></a>
  <a href="https://github.com/cihantopac/relivaro/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/cihantopac/relivaro/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/cihantopac/relivaro/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-0b7285"></a>
  <img alt="Node.js ≥ 22" src="https://img.shields.io/badge/node-%E2%89%A5%2022-121620">
  <img alt="Linux, macOS, Windows" src="https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-121620">
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-overview-dark.png">
    <img src="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-overview-light.png" alt="Relivaro HTML report: release readiness score, gate tally, key numbers and the action center" width="900">
  </picture>
  <br><sub>Relivaro's release report for its own repository (build, tests, type check and lint executed; dependencies checked on OSV.dev). English / Türkçe · light / dark / system.</sub>
</p>

## How it works

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/diagrams/workflow-dark.svg">
    <img src="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/diagrams/workflow-light.svg" alt="Workflow: Audit, Evidence, Fix, Verify, Release" width="900">
  </picture>
</p>

- **Audit** — 89 rules on tree-sitter syntax trees with taint tracking, plus project intelligence: stacks, monorepo
  units, data stores, CI/CD, routes and environment variables. Offline and read-only.
- **Evidence** — every finding carries `file:line`, a redacted snippet, facts, confidence, impact and CWE/OWASP mapping.
- **Fix** — 15 deterministic fixers produce a reviewable diff; everything else becomes a fix prompt for your coding agent.
- **Verify** — a fix must remove its findings, add none and keep your tests green, in an isolated copy, with rollback.
- **Release** — up to 18 gates, each marked *executed*, *measured*, *static analysis* or ***not run***. Unverified is
  never a silent pass.

## From findings to fixes

<table>
<tr>
<td width="50%" valign="top">

**Start with what matters.** The action center splits open findings by how they get fixed and puts the most severe
root causes first:

- **Deterministic fix** — a Relivaro fixer produces a concrete patch.
- **Agent-assisted** — a coding agent investigates, changes the code and adds a regression test.
- **Manual review** — needs runtime evidence, an operational decision or approval first.

</td>
<td width="50%" valign="top">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-actions-dark.png">
  <img alt="Action center: findings by remediation path and the three most severe root causes" src="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-actions-light.png">
</picture>

</td>
</tr>
<tr>
<td width="50%" valign="top">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-prompt-dark.png">
  <img alt="Editable fix prompt with copy and Markdown download" src="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-prompt-light.png">
</picture>

</td>
<td width="50%" valign="top">

**Hand it to your coding agent.** Select findings and press **Generate fix prompt**: an editable brief for Claude
Code, Codex or any coding agent with the run id, stable finding ids, locations, evidence and permission boundaries.
The agent re-checks each finding against the current code (`relivaro recheck`), rejects false positives and asks
before changing anything.

The report is one self-contained file: no network, no CDN, a strict CSP, secrets redacted.

</td>
</tr>
<tr>
<td width="50%" valign="top">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-findings-dark.png">
  <img alt="Findings explorer with selection, evidence snippet, verification and remediation badges" src="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-findings-light.png">
</picture>

</td>
<td width="50%" valign="top">

**Every claim is checkable.** Findings show the code that triggered them with the line highlighted, how to verify the
fix, and whether someone reviewed them: *detected*, *confirmed*, *false positive*, *needs verification* or *accepted risk*
(`relivaro review add`).

<img alt="The report on a phone, dark theme, in Turkish" src="https://raw.githubusercontent.com/cihantopac/relivaro/main/assets/screenshots/report-mobile-tr-dark.png" width="200">

</td>
</tr>
</table>

## Quick start

**Claude Code plugin** — no npm install needed:

```text
/plugin marketplace add cihantopac/relivaro
/plugin install relivaro@relivaro
```

Then run `/relivaro` in your project, or a single step: `/relivaro:audit`, `:security`, `:performance`,
`:reliability`, `:test`, `:optimize`, `:release`. Claude checks significant findings in your code and asks before
executing project commands, going online or editing anything. [Plugin guide](docs/PLUGIN.md)

**CLI** — requires Node.js 22+, no runtime dependencies, no install scripts:

```bash
npm install -g relivaro
```

```bash
relivaro audit . --open
```

```bash
relivaro release . --allow-exec --online
```

```bash
relivaro fix apply latest --yes --verify "npm test" --allow-exec
```

Reports land in `.relivaro/runs/<run-id>/` (`report.html`, `.md`, `.json`, optional `.sarif`). No install:
`npx relivaro audit .`. All commands: [docs/CLI.md](docs/CLI.md).

**Safe by default.** Read-only and offline. Project code runs only with `--allow-exec`, the network is used only with
`--online`, and files change only through `fix apply --yes` — with backups and hash-guarded rollback.

## Evidence

- **181 tests** (unit, integration, security, end-to-end) on Linux, macOS and Windows × Node 22 and 24 in CI.
- **Detection corpus:** 8 fixture projects, 158 expected findings, **precision and recall 100%**, enforced in CI.
  A controlled corpus — real code will produce false positives and misses.
- **Real repositories:** validated read-only on 5 production codebases; every significant finding checked by hand
  ([validation](docs/VALIDATION.md)).
- **Speed:** a 3,060-file repository in about 1.5 s; a 241k-line monorepo in about 3 s on an Apple M4
  ([benchmarks](docs/BENCHMARKS.md)).
- **Report safety:** tests inject `</script>` payloads through analysed source; the report stays inert and makes no
  network requests.

Source-level rules cover **JavaScript, TypeScript (JSX/TSX), PHP and Python**; Go, Ruby, Java/Kotlin, Swift,
Dart/Flutter and Rust projects get project intelligence, dependency, configuration, CI/CD and secret analysis.
[Rule reference](docs/RULES.md)

## Limitations

Taint tracking is intra-procedural, static performance findings are suspicions until measured, and Relivaro is not a
DAST tool or fuzzer. `--allow-exec` uses process controls, not a sandbox. Passing Relivaro does not mean software is
secure or bug-free. Details: [security model](docs/SECURITY_MODEL.md).

## Documentation

[CLI](docs/CLI.md) · [Configuration](docs/CONFIG.md) · [Rules](docs/RULES.md) · [HTML report](docs/REPORT.md) ·
[Plugin](docs/PLUGIN.md) · [Security model](docs/SECURITY_MODEL.md) · [Architecture](docs/ARCHITECTURE.md) ·
[Release readiness](docs/RELEASE_READINESS.md) · [Changelog](CHANGELOG.md)

## Product family

Independent open-source tools by the same author. Each works on its own.

| | |
| --- | --- |
| [**Markilo**](https://github.com/cihantopac/markilo) | Brand identity and vector design for Claude Code |
| [**Searvex**](https://github.com/cihantopac/searvex) | SEO, GEO and search intelligence with sourced audits |
| [**Jourilo**](https://github.com/cihantopac/jourilo) | UX, user journeys and conversion engineering in a real browser |
| **Relivaro** | Software quality, security and release readiness |

The Relivaro logo and icons ([`assets/brand/`](assets/brand/)) were designed with
[Markilo](https://github.com/cihantopac/markilo).

## License

[Apache-2.0](LICENSE). Bundled tree-sitter runtime and grammars are MIT-licensed; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
