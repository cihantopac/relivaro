# HTML report

Every analysis command writes `report.html` next to `report.json`, `report.md` (and `report.sarif` on request) in
`.relivaro/runs/<run-id>/`. It is a single self-contained file: open it from disk, attach it to a ticket or publish it
as a CI artifact. It makes no network requests.

![Relivaro HTML report](../assets/screenshots/report-desktop-light.png)

## What it shows

| Section | Content | Source |
| --- | --- | --- |
| Release readiness | Score ring, status (ready · ready with warnings · needs verification · not ready), gate tally | `release` only |
| KPIs | Open findings, critical + high, auto-fixable, files and lines analysed, checks passed, analysis time | run record |
| Audit → Release flow | What happened at each stage of this run; stages that did not run are hatched | run record, fix history |
| Charts | Severity distribution, findings by category (stacked by severity), files with the most findings | open findings |
| Release gates | One tile per gate with its status and **basis** (executed, measured, advisory database, static analysis, not run). Select a tile to filter the findings behind it | `release` only |
| Findings | Search, severity chips, category, status, auto-fixable filter and sorting; each finding expands to evidence (with the reported line highlighted), facts, impact, remediation, verification steps, standards and the `fix plan` command | run record |
| Verification | Executed build/test/type-check/lint commands with test result bars, durations and skip reasons; coverage | `--allow-exec` |
| Compared with the previous run | Introduced, resolved and persisting findings, release status change | previous run in the same workspace |
| Performance measurements | Latest `bench` / `load` results with mean, p95 and error rate | `.relivaro/bench/` |
| Untested high-risk code | Heuristic ranking of source files without matching tests | run record |
| What this run did not verify | Every limitation of the run, stated plainly | run record |

Charts and numbers are only drawn from what the run actually measured. A gate that was not executed is shown as
**unverified** with a dashed outline, never as passed, and the status is never `ready` while a gate is unverified.

## Language and theme

The interface is available in **English** and **Türkçe**. The default follows the browser language (Turkish for
`tr*`, English otherwise); the `EN | TR` switch in the header changes it and is remembered in the browser's local
storage when available. Relivaro's own interface text is translated; repository content — code, paths, evidence,
rule messages and generated details — is shown exactly as produced. No translation service is used.

Light and dark themes follow the operating system; the theme button overrides it.

## Security

- All repository-derived text is embedded as escaped JSON and inserted with `textContent`; the page never parses
  analysed content as HTML.
- A Content Security Policy of `default-src 'none'` (inline styles and scripts only, `data:` images) blocks every
  network request, form submission and base-URL change.
- Secrets are redacted before they reach the run record, so they cannot appear in the report.
- Tests inject `</script>` payloads through analysed source and assert the report stays inert and self-contained.
