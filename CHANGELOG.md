# Changelog

All notable changes to Relivaro are documented here. The format follows [Keep a Changelog](https://keepachangelog.com)
and the project uses [Semantic Versioning](https://semver.org).

## [1.5.0] — 2026-11-12

Integration and hosted scanning: bounded runs, a hard lockdown for untrusted code, documented contracts, privacy
controls and richer SARIF, from the Frameva hosted-engine reports (RELIVARO-001 to 010 and 023). No rule finds
anything new or different.

### Added

- **Run record schema.** `schemas/run.schema.json` ships in the package; every `run.json` names it in `$schema`, and a
  test validates real records from every fixture against it. Version policy in `docs/REPORT.md`: an optional new field
  keeps `schemaVersion`; removing or renaming a field or changing a type bumps it.
- **Structured progress.** `--progress tty|plain|ndjson|off` (global). `ndjson` writes one JSON event per line on
  stderr, also with `--json`: stage events (`index`, `discover`, `analyse`, `osv`, `checks`, `report`, each with
  `start`/`end` and `elapsedMs`) and file counts every 200 files.
- **Run limits and partial results.** `--max-duration <seconds>`, `--max-files <n>`, `--max-bytes <size>` (K/M/G) and
  the config keys `limits.maxDuration`, `limits.maxFiles`, `limits.maxBytes`. A reached limit stops the analysis (root
  manifests and lockfiles are analysed first), writes the record with `partial`, puts a limitation first, adds an
  unverified gate so the release verdict is at best *needs verification*, prints `PARTIAL RUN` even with `--quiet`, and
  exits with the new **exit code 4** (a gate the partial results already fail still exits 1). A parse slower than 5 s
  is skipped and recorded on bounded runs only.
- **Graceful SIGTERM/SIGINT** for analysis commands: OSV requests and build/test commands are cancelled and a partial
  record is written atomically (exit code 4); a second signal exits at once. Other commands keep the default
  behaviour.
- **Lockdown for hosted scanning.** `--lockdown` or `RELIVARO_LOCKDOWN` (any value except empty, `0`, `false`, `no`,
  `off`) refuses `--allow-exec`, `--online`, `--open`, `fix apply`/`rollback`, `baseline`, `init`, `load`, `bench`,
  `review add`, and any workspace or `--out` inside the audited directory (exit 2). It ignores the repository config,
  a committed baseline file and inline `relivaro-ignore`/`relivaro-accept` comments, applies `.gitignore` to nothing
  and never starts git, so no child process is spawned and no socket is opened. `--ignore-repo-config` alone uses only
  defaults or `--config`.
- **Output privacy.** `--root-label <name>` replaces the absolute project path in the run record, messages, snippets,
  limitations and every report. `--no-snippets` and `--snippet-lines <n>` (default 3) control source excerpts.
- **SARIF enrichment.** `originalUriBaseIds`, `versionControlProvenance` (revision, branch, and the `origin` URL with
  credentials removed), a `rulesetHash`, a source snippet in `region.snippet`, and a truthful invocation (`exitCode`,
  `executionSuccessful` false for usage errors and partial runs, `endTimeUtc`).
- **Programmatic API.** `import { runAudit, toSarif, compareRuns, assessRelease, gateFailed, VERSION } from 'relivaro'`
  (ESM) with hand-written, compile-time-pinned type declarations. `package.json` gets `exports` and `types`, and
  `relivaro/schemas/*` exports the schemas. The `--json --compact` shape is pinned by
  `tests/fixtures/contract/compact.json`.
- **OSV cache and mirror.** `--osv-cache <file>` (shared; a read-only file is used without being written; malformed
  entries are ignored), `--osv-api <https-url>` (with `--online`), and `--offline-osv` (answers from the cache only,
  works under lockdown, and names the uncached packages as unverified). Each cache entry expires 24 h after it was
  fetched; the 1.4 cache format is still read.
- **Coverage line.** Every run prints `Coverage: security N rules/M files · …`, and `metrics.coverage` records rules
  run and files matched per category.
- **`rules list --json`** exports every rule's id, category, severity, confidence, CWE, OWASP, fixer, title,
  description, impact, recommendation and verification, with the same keys for every rule.
- **Baseline hint.** After an audit with open findings and no baseline, the summary suggests
  `relivaro baseline <path>`; with a baseline it says `N findings in baseline (not shown)`.
- **`--since <git-ref>`** shows only findings on lines changed since the ref (new, renamed, copied, binary and
  untracked files count in full) while still analysing the whole tree. Without git it is a usage error.

### Changed

- `--json --compact`: `reports` is the directory the reports were written to, or `null` with `--no-write`; `partial`
  and `since` appear when set.
- `rules list --json`: `cwe` and `owasp` are always arrays and `fixer` is `null` when there is none.
- The OSV cache file format is version 2 (package lookups plus advisory details).

## [1.4.0] — 2026-11-11

Correctness release: every false positive and silent blind spot from the Frameva field reports on 1.3.0, the false
negatives that fall inside existing rules, and the deferred minors of the 1.3.0 review. No new rule ids.

### Fixed (false positives)

- **Docker stages inherit `USER`.** A final stage `FROM <earlier stage>` now inherits that stage's `USER` through any
  chain of aliases (case-insensitive), so `sec/docker-runs-as-root` no longer fires on multi-stage images that drop
  root in a base stage. A parent stage that ends as root is still reported and named.
- **`sec/docker-context-leak` finds the real build context.** The context comes from a compose `build.context`, a CI
  `docker build -f … <ctx>` step or `docker/build-push-action` (`context:`/`file:`). An unknown context checks the
  Dockerfile's directory, its parents and the workspace root's `.dockerignore`; when nothing is found the finding says
  the context is not determined; its confidence is low when another `.dockerignore` exists in the tree.
- **Constant SQL fragments.** `sec/sql-injection` treats a ternary whose two branches are literals
  (`${lock ? 'FOR UPDATE' : ''}`), number arithmetic over `.length`/`.size`/`.count` of non-request values (`$${params.length + 1}`) and a
  `.map(…).join(…)` over a constant array whose callback only formats its own parameter as constant. A branch with
  user input is still reported.
- **Tests and short literal lists.** `perf/query-in-loop` and `sec/sensitive-data-in-logs` no longer report in test
  files, and `perf/query-in-loop` skips a query whose enclosing loops all run over
  a literal array of at most 10 constants.
- **Libraries are not services.** In a JS/TS or Python package, a backend framework among the dependencies no
  longer makes it a service:
  it needs a server entry (`.listen(`, `createServer(`, `serve(`, `uvicorn.run(`, `app.run(`, `Deno.serve(`, a
  `start`/`dev` script that runs a file or framework server, or a `Dockerfile`/`Procfile`/`main.py`/`manage.py`/
  `artisan`). `rel/no-health-check` recognises versioned routes such as `/v1/health` and `/api/v2/healthz`.
- **Workspace packages audited alone.** Relivaro reads a fixed allowlist of metadata files (`package.json`,
  `pnpm-workspace.yaml`, lockfiles, `.dockerignore`) above the audit root, and only from an ancestor whose workspace
  globs include the audit root. `sc/missing-lockfile` then sees the workspace root's lockfile, and the "no
  typecheck/test commands" limitation names the root's scripts.
- **Large lockfiles.** Lockfiles have their own size limit (`maxLockfileSizeKb`, default 51200), so an 8.9 MB
  `package-lock.json` is analysed. A lockfile over the limit is named in a limitation and still counts as present.
- **Symlinks.** A symlink to an in-tree file is analysed once, and a link to an in-tree directory (including a loop
  such as `loop -> .`) is no longer counted as pointing outside the root.
- **1.3.0 review minors.** A commented-out `output: 'export'` is not a static export; `nginx/*.conf.template` is an
  nginx config; an unterminated Caddy backtick value stops at the end of its block; a Caddy `@matcher { header … }`
  is not a response header; only a SARIF file written by Relivaro, Jourilo or Searvex is skipped as a tool report; the
  `Generated … · Relivaro` marker counts only in the first 5 lines; the `Next:` hint quotes paths with `&`, `;`, `|`
  and other shell metacharacters; the HTML report's open-findings KPI shows the accepted count.

### Fixed (false negatives)

- `sec/docker-context-leak` no longer stays silent for every Dockerfile when the audit root has a `.dockerignore`
  that is not the Dockerfile's build context.
- `sec/command-injection`: Python subscript sources (`request.args["cmd"]`) passed to `subprocess` with
  `shell=True`, and `spawn('sh', ['-c', input])`.
- `sec/xss`: Express `res.send`/`write`/`end` with HTML concatenated with request data.
- `sec/cors-misconfiguration`: `require('cors')({…})` and an options object held in a `const`.
- `sec/hardcoded-signing-secret`: a JS JWT secret held in a `const`.
- `sec/path-traversal`: archive entry names (`entry.path`, `header.name`, `member.name`, `namelist()` elements)
  flowing into file-system calls in a file that imports an archive library (zip slip), and Python `tarfile`
  `extractall()` without `filter=`.
- Without git (walk mode), files hidden by `.gitignore` are counted and named in a limitation instead of
  disappearing silently.

### Added

- **`relivaro-accept` comments.** `// relivaro-accept-next-line perf/query-in-loop: sequential row locks, bounded`
  records an accepted risk in the code. The finding stays in every report (*Accepted in code: …*; SARIF `inSource`
  suppression with status `accepted`), counts as accepted, and does not fail `--fail-on` or release gates. A rule id
  and a reason are required; a comment without them accepts nothing and is listed in `errors.rules`.
- **`--no-inline-suppressions`** ignores `relivaro-ignore*` and `relivaro-accept*` comments in code you do not trust.
- **`--no-gitignore`** analyses files matched by `.gitignore` when there is no git metadata.
- **`--assume-tracked`** treats every file as committed when there is no git metadata (archives, exports), so
  `sec/env-file-committed` reports `.env` files and key material by path; their content is never read.
- **`maxLockfileSizeKb`** config key (1–204800 KB).

### Changed

- `metrics.dependencies` counts unique `ecosystem/name@version`, the same unit as the OSV query count;
  `metrics.dependencyEntries` keeps the raw sum of lockfile entries.
- The "files larger than … were skipped" limitation names up to 5 of the files.

## [1.3.0] — 2026-11-03

Fixes and blind spots found by auditing two real projects (a static Next.js site behind Caddy, and a pnpm 12 +
Turborepo monorepo). Thanks to the field reports that made them reproducible.

### Fixed

- **pnpm 12 lockfiles were silently dropped.** pnpm 12 writes two YAML documents (an env lock for pnpm itself, then
  the project lock); parsing failed, so the project showed 0 dependencies, queried nothing on OSV.dev and still
  looked clean. Both documents are now read and the env lock is skipped.
- **A lockfile or manifest that fails to parse never looks clean again.** Each one becomes a limitation
  (``Lockfile `…` could not be parsed (…); its dependencies were not analysed.``), and the release `dependencies` gate
  becomes *unverified* with `Could not parse …`, online or offline; a known-vulnerability blocker still blocks. A pnpm
  lock cut at a line boundary (still valid YAML) is reported as incomplete instead of looking empty and clean.
- **Workspace packages inherit the root package manager.** In a pnpm, yarn or bun workspace, a package without its
  own `packageManager` field or lockfile used to get `npm ci` in skip hints and `npm` commands; it now uses the
  nearest parent's manager.

### Added

- **`accepted` review verdict.** `relivaro review add --verdict accepted --reason "…"` records a risk the user
  explicitly accepted. Reports show it as *Accepted risk* (Markdown: `accepted risk`), it leaves the action-center
  counts and *Fix first* like a false positive, and it stays in the explorer under its verification filter. Release
  gates still count it, as they do for every verdict; use a baseline when an accepted finding should stop gating.
- **Web server security headers.** Caddy (`Caddyfile`, `*.caddy`), nginx (`add_header`) and `_headers` files are
  parsed, with five new rules: `sec/web-missing-csp` (a `<meta http-equiv>` CSP in served HTML counts),
  `sec/web-csp-unsafe-inline`, `sec/web-missing-frame-protection`, `sec/web-missing-hsts` (low confidence: it may be
  set at a CDN or tunnel) and the informational `sec/web-hsts-include-subdomains`. `discover` lists Caddy as a deploy
  target. The "missing header" rules need a config that serves files itself (`root`, `file_server`, `try_files`,
  `_headers`); a config that only reverse-proxies an app leaves the headers to the app. Generic `default.conf` /
  `site.conf` files count only when they read like nginx, and a CSP `<meta>` tag in HTML or page components (JSX
  `httpEquiv`, Astro, Vue, Svelte) counts as a CSP.
- **Next.js static export.** A literal `output: 'export'` in `next.config.*` makes the unit a frontend (`static
  export` in `discover`), so server rules such as `rel/no-error-monitoring` and `rel/no-health-check` no longer fire on
  it. A value computed at build time (`output: process.env.X`) is not treated as a static export.
- `relivaro audit` (and the other analysis commands without a release verdict) ends with
  `Next: relivaro release <path> for a release verdict (add --allow-exec --online to verify more)`.
- The offline dependency limitation and release gate now say exactly what `--online` sends: ecosystem, package name
  and version to OSV.dev, no source code.
- `--help` mentions that boolean flags can be negated with `--no-<flag>`. (Unknown flags were already rejected with
  exit code 2.)

### Changed

- **Generated reports are not analysed.** Reports written by Relivaro, Jourilo or Searvex (for example with `--out`
  into the repository) are skipped, tracked or not, and counted in a limitation. They are recognised by exact output
  markers (the HTML generator meta tag, the run-record JSON head, the Markdown header lines) and every `.sarif` file;
  a project file that merely mentions a tool is still analysed. Searvex HTML reports carry no generator marker today,
  so only Searvex Markdown and JSON reports are recognised.
- **GitHub-owned actions have their own rule id.** Unpinned `actions/*` and `github/*` actions are reported as
  `sec/gha-unpinned-first-party-action` (low); `sec/gha-unpinned-action` now covers third-party actions only
  (medium), so counts by rule id are no longer mixed. The `gha-pin-action` fixer handles both. Baselines created
  before 1.3.0 list the first-party findings as new once; re-run `relivaro baseline` to accept them.
- File rules for one file now share a single context, so the workflow parse is reused across GitHub Actions rules.

## [1.2.2] — 2026-11-01

Visual polish and brand consistency; no changes to analysis, CLI flags, run records or report formats.

### Changed

- HTML report palette follows the Relivaro identity (teal, ink, paper, stone from `assets/brand/tokens.css`) in light
  and dark themes, with contrast-checked text colours; severity and gate colours keep their meaning.
- The theme button is now a **Light / Dark / System** switch; the choice is remembered (System by default).
- The action center opens with **Fix first**: the three most severe root causes, each linking to its findings, and
  one button that turns them into a fix prompt.
- Clearer hierarchy and spacing; on phones the section navigation stays available as a scrollable row and the action
  center, flow and gate tiles are more compact. Limitations show the first three items and expand for the rest.
- Turkish interface text reworded where it was literal or ambiguous ("tarayıcı adayı" became "aday", "Bastırılmış"
  became "Yok sayılan", deterministic fixes are "Otomatik düzeltme").
- README rewritten as a shorter product page with new screenshots of the 1.2.2 report and absolute image URLs, so
  images render on npm as well as GitHub. Workflow diagrams use the brand palette and the correct fixer count (15).

### Added

- `scripts/screenshots.mjs` regenerates the README screenshots from real reports (Playwright, development only).

## [1.2.1] — 2026-11-01

Brand update; no functional changes. 1.2.0 was released on GitHub only, so on npm this release follows 1.1.0 and
includes everything in 1.2.0.

### Changed

- New Relivaro identity ("Cairn"): the HTML report header shows the logo and the report has a favicon, both inlined
  as outlined SVG (no font or network). The README header, the Claude Code plugin icon and `assets/brand/` use the
  same marks. The identity was designed with [Markilo](https://github.com/cihantopac/markilo).

## [1.2.0] — 2026-11-01

Actionable reports and agent-assisted fixes. No breaking changes: run records (schema v1), SARIF, Markdown, CLI
flags and configuration from 1.1 keep working. `--json --compact` gains fields and is printed unindented.

### Added

- **Action center** in the HTML report: open findings per remediation path — *deterministic fix* (a Relivaro fixer
  produces a patch), *agent-assisted* (a coding agent investigates, changes and tests) and *manual review* (needs
  runtime evidence, an operational decision or approval) — with the steps from selection to a fix.
- **Selection and fix prompts**: checkboxes per finding and per root-cause group, *Select visible*, *Select by
  severity*, a selection bar, and **Generate fix prompt** — an editable Markdown brief for Claude Code, Codex or any
  coding agent with the run id, stable finding ids, locations, severity, verification state, evidence, expected
  outcome, re-check step, permission boundaries and verification requirements. Copy (with a selection fallback for
  `file://` pages) or download as `.md`. Hostile repository text stays inert: flattened or fenced, inside
  nonce-marked delimiters, secrets redacted again, secret snippets omitted.
- **Verification states** next to every raw detection: detected, confirmed, false positive, needs verification;
  filters and badges for verification and remediation; grouping by root cause.
- **`relivaro review add|list`**: record verdicts (confirmed / false-positive / needs-runtime) with justification,
  evidence locations, optional severity and reviewer provenance in `runs/<run>/review.json`
  ([schema](schemas/review.schema.json)); reports re-render immediately. Verdicts bind to the finding fingerprint and
  carry to later runs for the same code, labelled with their origin. Original findings are never modified. Safe to
  call in parallel (agents do): writes are serialised with a lock file.
- **`relivaro recheck`**: re-runs only the rules behind given finding ids and reports each as present, moved or gone,
  so findings from a report or prompt are revalidated before any repair.
- **`gha-pin-action` fixer** (`fix plan --online`): pins GitHub Actions to the commit their tag points to, resolved
  from the action's own repository with `git ls-remote` (annotated tags peeled to the commit), keeping the tag as a
  comment. The plan shows every SHA and its source; `fix apply` never goes online.
- `--open` on analysis commands and `relivaro report` opens the HTML report; the terminal summary and compact JSON
  print the absolute report path and the platform's open command.
- Compact JSON for agents: `groups` (every open finding by rule with count, remediation path, review count and ids),
  per-finding `remediation` and `review`, `remediation` and `review` totals, `report.html` / `report.open`.

### Changed

- Plugin skills end with one short answer (about 80–150 words): status, a few numbers, up to three root-cause groups,
  what was not covered, the report path with its open command and one next step. Agents record verified verdicts
  with `relivaro review add` and call unreviewed findings candidates.
- Compact JSON lists the 30 most severe open findings in detail (snippets for medium and above) and is printed without
  indentation; `report.json` keeps everything.
- `fix plan --finding <ids>` names ids that the current source no longer produces, and open ids no fixer applies to.
- The Markdown report shows each finding's review status and remediation path.

### Fixed

- `php-unserialize-allowed-classes` and `tls-verify-enable` were offered for test files, where tests round-trip
  objects or use self-signed certificates on purpose; findings in tests no longer carry these fixers.

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
