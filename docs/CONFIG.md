# Configuration

Relivaro reads `relivaro.config.json` (or `.relivaro.json`) from the project root, or the file given with `--config`.
Configuration is JSON only and validated strictly: unknown keys or invalid values are errors (exit code 2).
JSON Schema: [`schemas/config.schema.json`](../schemas/config.schema.json). `relivaro init` creates a starter file.

```json
{
  "$schema": "https://raw.githubusercontent.com/cihantopac/relivaro/main/schemas/config.schema.json",
  "exclude": ["legacy/**", "**/*.generated.ts"],
  "include": [],
  "failOn": "high",
  "maxFileSizeKb": 1024,
  "maxLockfileSizeKb": 51200,
  "rules": {
    "perf/unbounded-query": "off",
    "sec/sensitive-data-in-logs": { "severity": "medium", "exclude": ["scripts/**"] }
  },
  "commands": { "test": "npm run test:ci", "build": "npm run build" },
  "timeouts": { "commandSeconds": 900 },
  "release": { "requireTests": true, "requireCi": true, "minCoverage": 70, "blockOn": "high" },
  "performance": { "budgets": { "api-health": { "p95Ms": 150, "errorRate": 0.01 }, "build": { "meanMs": 60000, "maxRegressionPct": 15 } } },
  "env": { "optional": ["SENTRY_DSN"] }
}
```

| Key | Meaning |
| --- | --- |
| `exclude` / `include` | Glob patterns relative to the root (`**`, `*`, `?`, `{a,b}`). Dependency, build and cache directories are always excluded. |
| `failOn` | Default for `--fail-on`: exit 1 when an open finding with medium/high confidence is at or above this severity. `none` disables. |
| `maxFileSizeKb` | Larger files are skipped (reported as a limitation that names up to 5 of them). |
| `maxLockfileSizeKb` | Size limit for lockfiles (default 51200 KB, at most 204800). A larger lockfile is not analysed, is named in a limitation, and still counts as present for `sc/missing-lockfile`. |
| `rules` | Per rule: `"off"`, or `{ "severity": …, "exclude": [globs] }`. Rule ids: `relivaro rules`. |
| `commands` | Override detected `build`, `test`, `typecheck`, `lint` commands (run without a shell; use a script for pipelines). |
| `timeouts.commandSeconds` | Per-command timeout for execution checks, benchmarks and fix verification. |
| `release.requireTests` | No test files → blocker (default `true`). |
| `release.requireCi` | No CI → warning (default `true`). |
| `release.minCoverage` | Line coverage gate, from existing lcov/Clover/Cobertura reports. |
| `release.blockOn` | Security/dependency severity that blocks a release (`critical`, `high` or `medium`). |
| `performance.budgets` | Per benchmark/load-test name: `meanMs`, `p95Ms`, `p99Ms`, `errorRate`, `maxRegressionPct`. Enforced by `bench`, `load` and `release`. |
| `env.optional` | Environment variables that are intentionally undocumented/optional. |

## Suppressions

- Inline, same line or the line above: `// relivaro-ignore sec/xss: sanitized by renderMarkdown()` (any comment
  syntax). Without a rule id it suppresses every rule on that line. `relivaro-ignore-next-line` and
  `relivaro-ignore-file [rule-ids]` are also supported. Suppressed findings stay visible in reports with the reason.
- Inline acceptance, on its own line (`relivaro-accept`) or for the line below (`relivaro-accept-next-line`):
  `// relivaro-accept-next-line perf/query-in-loop: sequential row locks, bounded by plan size`. A rule id and a reason
  (at least 3 characters) are required; a comment without them accepts nothing and is listed in `errors.rules`. An
  accepted finding is not hidden: it stays open in reports, marked *Accepted in code* with the reason, and counts as
  an accepted risk. Unlike a review verdict, it does not fail `--fail-on` or block `relivaro release`.
- `--no-inline-suppressions` ignores every `relivaro-ignore*` and `relivaro-accept*` comment in the audited code, for
  code you do not trust (third-party archives, hostile fixtures). The run records a limitation when it is set.
- Baseline: `relivaro baseline` writes `relivaro-baseline.json` (fingerprints only). Baseline findings are reported but
  do not fail gates; commit the file to share it. Use `--no-baseline` to ignore it.
