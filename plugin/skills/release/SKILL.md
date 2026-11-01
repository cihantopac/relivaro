---

name: release
description: Relivaro production-readiness evaluation — build, tests, type check and lint execution, security and dependency risk, CI/CD, migrations, configuration and environment variables, operability, performance budgets and documentation, reported as explicit blockers, warnings, passed and unverified gates.
argument-hint: "[path] [--allow-exec] [--online]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs *) Read Grep Glob
---

# Relivaro · Release

Request: $ARGUMENTS

Toolchain and rules as in `${CLAUDE_PLUGIN_ROOT}/skills/relivaro/SKILL.md`.

1. Explain that a meaningful assessment executes the build and tests (`--allow-exec`, runs project code) and checks
   dependencies online (`--online`); ask for both. Without them, those gates stay **unverified**.
2. `relivaro release <path> [--allow-exec] [--online] --json --compact`. Exit code 1 means NOT READY.
3. Verify every blocker in the code or in the check output (a blocker that turns out to be a false positive must be
   explained, and suppressed only with the user's approval and a reason).
4. Answer with the **Final response** format from the main skill, with the release status first and unsoftened:
   `NOT READY` / `NEEDS VERIFICATION` / …, the score (capped while blockers exist), blockers as the numbered items
   (with evidence location), unverified gates under "Not covered" with what would verify them, the report link and
   one next step (e.g. `/relivaro:optimize` for fixable blockers). Gate-by-gate details stay in the report.
