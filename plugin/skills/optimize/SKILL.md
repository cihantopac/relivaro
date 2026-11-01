---

name: optimize
description: Relivaro verified, controlled improvements — deterministic fix plans with diffs, approval, isolated verification with the project's tests, application with backups, re-audit and reliable rollback; minimal manual patches for findings without automated fixers.
argument-hint: "[path] [finding ids or rule ids]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs *) Read Grep Glob Edit Write
---

# Relivaro · Optimize

Request: $ARGUMENTS

Toolchain and rules as in `${CLAUDE_PLUGIN_ROOT}/skills/relivaro/SKILL.md`. Never change code merely to improve a
score; every change must remove a confirmed root cause.

Findings may come from an earlier run (a report or a fix prompt). Re-check them first:
`relivaro recheck <path> --finding <ids> --run <runId>` — skip `gone` ones, use the new line for `moved` ones.

1. `relivaro fix list <path>` — fixable findings (fixer, safety `safe`/`review`). Confirm each targeted finding in the
   code first (see the audit workflow).
2. `relivaro fix plan <path> [--finding <ids>] [--rule <ids>]` — show the user the diff and explain each change.
   `review` fixers intentionally change behaviour (e.g. re-enabling TLS verification, adding a timeout): call that out.
   `gha-pin-action` needs `--online` (with the user's OK): it resolves each tag to a commit SHA from the action's own
   repository; show the SHAs. Never pin to a SHA you did not get this way.
3. Ask for approval. Then apply with verification:
   `relivaro fix apply <plan-id> --yes --verify "<project test command>" --allow-exec`
   The command runs in an isolated copy before and after the change; the working tree changes only if it passes
   (and every targeted finding disappears without introducing new ones). Without a test command, apply with
   `--yes` only and say verification was static.
4. Findings without a fixer: propose the smallest patch (show it), apply with Edit only after approval, run the tests
   through Relivaro (`relivaro test <path> --allow-exec`), then re-run the relevant analysis
   (`relivaro security|reliability|performance <path> --json --compact`) and compare (`relivaro compare`).
5. Never use a fixer or a manual patch for changes that need a decision first (container user, capabilities,
   payment logic, dependency upgrades, data migrations): propose them and wait.
6. Report in the **Final response** format of the main skill: resolved / still open / introduced as numbers, what
   was verified and how, the rollback command (`relivaro fix rollback <apply-id>`), the new report link and one next
   step. If anything regressed, roll back and explain.
