# Contributing

Thanks for helping make Relivaro trustworthy.

## Setup

```bash
npm ci --ignore-scripts
npm run build
npm test
```

`npm run ci` runs lint, type check, build, all tests and the dist check — the same as CI.

## Adding or changing a rule

1. Implement it in `src/rules/` with complete metadata (description, impact, recommendation, verification, CWE/OWASP).
2. Add positive **and** negative cases to a fixture under `fixtures/projects/` with inline `expect: <rule-id>`
   annotations (or `.expect.json` for findings without a line). Secrets must use `__RLV_SECRET_<KIND>__` placeholders.
3. `npm run build && node scripts/bench.mjs` — the corpus must stay at 100% precision and recall.
4. If the change was motivated by a false positive in real code, add an anonymized reproduction to
   `fixtures/projects/regressions`.
5. `npm run build` regenerates `docs/RULES.md` and `docs/CLI.md`; commit them together with `plugin/dist`.

## Principles

- Never fabricate: findings need evidence; tests must exercise real behaviour.
- Prefer precision: a rule that is noisy on real code is worse than no rule. Use `confidence` honestly.
- Keep the safety model: no new network access, code execution or file writes without an explicit flag and docs.

## Commits and pull requests

English commit messages, small focused changes, tests included. By contributing you agree that your contributions
are licensed under the Apache License 2.0.
