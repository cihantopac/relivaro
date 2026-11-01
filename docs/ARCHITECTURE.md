# Architecture

Relivaro is a TypeScript (Node.js ≥ 22) application bundled into a single ESM file (`plugin/dist/relivaro.mjs`) plus
WebAssembly tree-sitter grammars. The same bundle is the npm CLI and the engine behind the Claude Code plugin, so the
plugin needs no installation step and has no runtime dependencies.

```
src/
  cli/          argument parsing, commands, terminal output, generated CLI reference
  audit.ts      orchestration: index → discover → analyse → (OSV) → (execute) → baseline → coverage → run record
  core/         types, config (JSON only), errors/exit codes, secrets & redaction, fingerprints, workspace, globs
  fs/           FileSet: guarded enumeration and reads (git-aware, symlink-safe, sensitive-file policy)
  parse/        tree-sitter loader (WASM) and language-neutral AST helpers, intra-procedural taint
  intel/        project intelligence: dependency catalogue, units, technologies, CI, deploy, env vars, API surface
  deps/         manifest and lockfile parsers (npm/pnpm/yarn, Composer, PyPI/Poetry/uv, Go, Cargo, RubyGems, Pub, Maven), OSV client
  rules/        rule engine + packs: security (code, files), supply-chain, reliability, performance, quality
  checks/       execution checks (build/test/typecheck/lint) with output parsers; coverage reports; test-gap ranking
  fix/          deterministic fixers, GitHub Action SHA resolution, unified diff, plan/apply/verify/rollback workflow
  review/       review artifact: recorded verdicts per run, fingerprint-bound, carried to later runs
  perf/         statistics, command benchmarks, HTTP load tests with target policy
  contract/     OpenAPI validation and breaking-change diff
  release/      release-readiness gates and scoring
  report/       JSON, Markdown, HTML, SARIF renderers; remediation paths; fix-prompt builder; run comparison
```

## Pipeline

1. **Index** — `FileSet` lists files via hardened `git ls-files` (or a walk), classifies each (language, kind,
   test/fixture), applies excludes, size/binary/minified limits and the sensitive-file policy.
2. **Discover** — manifests and lockfiles are parsed; directories with manifests become *units*; dependencies map to
   technologies through a catalogue; CI, containers, deploy targets, routes, env vars and docs are collected.
3. **Analyse** — the rule engine parses each source file once (tree-sitter), builds a node-type index shared by all
   rules, precomputes call information, and runs three rule kinds:
   - *AST rules* on JS/TS/PHP/Python syntax trees, with framework-aware user-input sources, sanitizers and
     intra-procedural taint (assignments, destructuring, loops; comparisons and validators stop taint),
   - *file rules* on text/YAML/Dockerfile content (secrets, workflows, containers, templates, SQL migrations),
   - *project rules* on the profile (lockfiles, EOL runtimes, operability).
   The `FindingBuilder` turns hits into findings: snippet extraction and redaction, line-independent fingerprints,
   inline suppressions (`relivaro-ignore`), config overrides, and confidence/severity adjustment for test code.
4. **Optional stages** — OSV lookup (`--online`); execution checks (`--allow-exec`) whose failures become findings
   with command evidence; coverage report ingestion; test-gap ranking; baseline matching.
5. **Assess** — `release` evaluates gates from the run (and stored benchmark results) and caps the score while
   blockers exist.
6. **Report** — the run record (schema-versioned JSON) is rendered to Markdown, HTML and SARIF and stored for
   `compare`, `report`, `baseline` and `fix`.

## Key decisions

| Decision | Rationale |
| --- | --- |
| tree-sitter (WASM) for parsing | One query/traversal model for four languages, error-tolerant parsing, no native builds on any OS. TypeScript 7's compiler is native Go and not usable as a library parser. |
| Intra-procedural taint with explicit confidence | Predictable, fast and explainable; cross-function flows are reported with lower confidence or left to agent review instead of guessing. |
| Offline by default, OSV opt-in | Deterministic, private by default; vulnerability data is fresh when enabled. |
| No dependency installation, ever | Install scripts are the most common supply-chain attack vector; Relivaro reports skipped checks instead. |
| Deterministic fixers on syntax trees | Fixes are reproducible, minimal and refuse to apply when code no longer matches; AI-authored fixes go through the same verification (tests + re-analysis) in the plugin workflow. |
| Fingerprints from rule + file + normalized line text | Finding ids survive unrelated edits, enabling baselines and run comparison. |
| Release status from gates, not from the score | A score is a summary; blockers decide. The score is capped at 40 while any blocker exists. |
| Bundled single file committed to the repo | The Claude Code plugin works immediately after install; CI checks the bundle matches sources. |
