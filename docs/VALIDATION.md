# Real-world validation

Relivaro v1.0 was validated read-only against five real, actively developed codebases on the maintainer's machine, in
addition to the synthetic fixture corpus. Repository names and code are not published; findings were verified by
reading the source at every reported location. No repository was modified (audits used `--no-write`/`--workspace`),
no untracked secret files were read, and no project commands were executed against them.

| Id | Stack | Files | Lines |
| --- | --- | --- | --- |
| repo-1 | Monorepo: Laravel 12 API (Filament, Livewire), Flutter app, Python analysis service, static site, deploy configs, GitHub Actions | 4,873 | 241k |
| repo-2 | Next.js / React site, pnpm, GitHub Actions | 114 | 5.9k |
| repo-3 | TypeScript CLI + Claude Code plugin with fixture apps (Astro, Flutter, Laravel, Next.js, Vue) | 421 | 18.5k |
| repo-4 | TypeScript CLI + plugin with benchmark scenario projects (Next.js, Electron, Django, Flutter, Rust) | 1,065 | 23.6k |
| repo-5 | TypeScript CLI + plugin with fixture sites (Astro, Laravel, Next.js) | 380 | 13.2k |

## Process

1. Audit each repository (all categories, offline).
2. Read the code behind every critical, high and medium finding; classify as confirmed, false positive or
   needs-runtime-confirmation.
3. For every false-positive *pattern*, fix the rule, add an anonymized reproduction to
   `fixtures/projects/regressions`, and re-run the whole corpus (which must stay at 100% precision and recall).
4. Re-audit the repositories and compare.

## Results

| Repo | Open findings, first run (high/medium) | After fixes (high/medium) |
| --- | --- | --- |
| repo-1 | 125 (2 / 49) | 100 (0 / 26) |
| repo-2 | 11 (1 / 5) | 7 (0 / 2) |
| repo-3 | 84 (2 / 40) | 34 (0 / 7) |
| repo-4 | 68 (1 / 12) | 38 (0 / 11) |
| repo-5 | 46 (1 / 8) | 31 (0 / 7) |

All seven first-run *high* findings were false positives; none remained after the fixes. Remaining medium findings
were reviewed: they are confirmed patterns (N+1 lookups in import/notification services, containers running as root,
unpinned third-party actions, workflow tokens without `permissions`, a missing lockfile, a token compared with `!==`,
a regex with ambiguous nested quantifiers) or explicitly low-confidence review items (raw HTML in templates).

## False-positive patterns found and fixed

| Pattern (real code shape) | Rule | Fix |
| --- | --- | --- |
| A file path chosen from DB records by `$request->query('variant') === 'processed' ? … : …` | path traversal | Comparison results and ternary conditions no longer propagate taint |
| `redirect()->to(route(...) . '?' . $query)` / `PATHS[$locale] . '?' . $qs` | open redirect | App-controlled base URL (incl. `route()`) makes appended query/path safe |
| `if (!file.startsWith(ROOT)) return 403;` before reading | path traversal | Containment guards in the same function are recognised |
| Proxy target passed through `allowed(req.url)` | SSRF | Validator-named functions act as sanitizers |
| `/(?:[^\]\\]|\\.)+/`, `([^/]+\/)*` | ReDoS | Character sets with negation; disjoint alternatives and separators are unambiguous |
| CLI command functions with a `ctx` parameter using `readFileSync` | sync I/O in handler | Request handlers require req/res parameters or a Koa/Hono-style import; CLI paths skipped |
| `$validator->errors()->first()` inside a loop | N+1 | Known non-relationship methods excluded |
| `foreach (Post::all() as $post)` | N+1 | Loop headers run once; only loop bodies count |
| Seeders, console routes, scripts | N+1 | Reported as low severity/confidence (offline code) |
| `except ImportError: pass`, `except FileNotFoundError: pass` | swallowed exception | Idiomatic benign exceptions skipped |
| `} catch (e) {} // comment` | swallowed exception | tree-sitter attaches trailing comments inside the block; only comments before `}` count |
| `$table->string('provider_asset_id')` | missing FK index | String columns are not treated as foreign keys |
| Fake passwords in feature tests | hard-coded secret | Generic assignments skipped in test files (provider tokens still reported) |
| `{!! $p === $period ? ' aria-current="page"' : '' !!}` | template XSS | Ternaries of literals are safe |
| `holder.innerHTML = '…' + String(name).replace(/[^a-z-]/g, '') + '…'` | XSS | Allowlist `replace` filtering is a sanitizer |
| `const bootScript = [ … ].join('')`, `jsonLd(schema)` in `dangerouslySetInnerHTML` | XSS | Constant expressions and JSON serialisers are safe |
| `$cond = '1 = 1'` / `$cond = 'x >= ?'` interpolated into `selectRaw` | SQL injection | Variables only ever assigned constants are safe |
| Fixture/example/benchmark sub-projects inside a repository | lockfile, monitoring, shutdown | Units under test/fixture/example/bench paths are excluded from unit-level rules |
| `process.env.Path`, `process.env.X` in comments, `SYSTEMROOT` | env documentation gate | Name boundaries, comment lines and OS-ambient variables handled |

Self-audit (Relivaro on its own repository) additionally fixed: header-only PEM blocks and sequential sample keys
in tests treated as secrets.

## Bugs found by validation

- Node identity comparisons in the AST walker (`n !== root`) were always true because tree-sitter returns fresh node
  objects: complexity was always 1 and PHP/Python taint never propagated through variables. Fixed with id
  comparisons and regression tests.
- macOS `/var` → `/private/var` symlink made the fix workflow reject paths inside temporary directories; real-path
  resolution fixed it.
- Fix verification compared finding messages, which legitimately change when code changes; it now compares counts
  per rule and file.

## Reproduce

```bash
RELIVARO_BENCH_REPOS=/path/to/repo-a,/path/to/repo-b node scripts/bench.mjs
relivaro audit /path/to/repo --workspace /tmp/relivaro-ws
```

## Execution checks on real projects

`relivaro test` / `relivaro release` with `--allow-exec --online` were run on **isolated clones** (dependency folders
symlinked, separate `--workspace`) of two TypeScript repositories:

| Repo | Detected checks | Result parsed by Relivaro |
| --- | --- | --- |
| repo-5 | build, tests (Vitest), type check | 317 passed, 1 skipped; build and type check passed; OSV: no advisories; release *ready with warnings* (EOL Node 20 minimum, a `workflow_dispatch` input expanded in a `run:` script) |
| repo-4 | tests (Vitest) | 194 passed |

This run found two more issues, both fixed with regression tests: benchmark scenario sub-projects were planned for
execution (e.g. `cargo test`), and fixture web apps inside a CLI repository made it look like a deployable service.
The monorepo's (repo-1) test suite needs a local PostgreSQL test database and was not executed to avoid side effects.
