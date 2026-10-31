---

name: performance
description: Relivaro performance and scalability analysis — N+1 queries, rows loaded only to count, unbounded queries, blocking I/O in request handlers, catastrophic regex backtracking, missing indexes — plus repeatable command benchmarks and controlled local load tests with baselines.
argument-hint: "[path] [benchmark command or local URL]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs *) Read Grep Glob
---

# Relivaro · Performance

Request: $ARGUMENTS

Toolchain and rules as in `${CLAUDE_PLUGIN_ROOT}/skills/relivaro/SKILL.md`.

1. `relivaro performance <path> --json --compact`. Static findings are **suspected** bottlenecks: verify each in code
   (how many iterations in practice? is the relation eager-loaded elsewhere? is the handler hot?).
2. Measure when possible, only with the user's OK:
   - Command benchmarks: `relivaro bench <path> --cmd "<command>" --name <name> --runs 10 --allow-exec`
     (first run becomes the baseline; later runs report the change and its significance).
   - HTTP load: `relivaro load <local-url> --duration 15 --concurrency 10 --name <name>` against a local or staging
     service the user controls. Never target production. Relivaro refuses public hosts unless `--allow-remote`;
     never add that flag without explicit permission for that specific host.
3. Clearly separate **measured** results (numbers from bench/load, with environment) from **suspected** issues.
4. If the user wants enforcement, suggest `performance.budgets` in `relivaro.config.json` so `relivaro release` gates on
   them.
