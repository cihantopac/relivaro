---

name: test
description: Relivaro test engineering — discovers test frameworks and suites, runs them (with permission) with parsed results, reads existing coverage, ranks untested high-risk code, and writes meaningful regression tests that are executed and proven to pass.
argument-hint: "[path] [area to test]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs *) Read Grep Glob Edit Write
---

# Relivaro · Test

Request: $ARGUMENTS

Toolchain and rules as in `${CLAUDE_PLUGIN_ROOT}/skills/relivaro/SKILL.md`.

1. `relivaro test <path> --json --compact` — frameworks, test/source counts, coverage reports, `testGaps` (risk-ranked
   untested files; a heuristic) and test findings (focused or skipped tests).
2. With the user's OK, run the suites: `relivaro test <path> --allow-exec --json --compact`. Report pass/fail counts
   and failing test names from `checks`. Relivaro never installs dependencies; if a check is skipped because they are
   missing, tell the user the exact install command and let them run it.
3. Writing tests (only after the user approves the plan):
   - Pick targets from confirmed defects (a regression test that fails on the defect and passes after the fix) and
     from the top `testGaps`.
   - Follow the project's existing framework, file layout, naming and helpers; read 1–2 existing tests first.
   - Test behaviour and edge cases (invalid input, boundaries, error paths, authorization), not implementation
     details. No snapshot-only or assertion-free tests, no tests that only raise coverage.
   - Run the new tests (`relivaro test <path> --allow-exec`, or the project's test command through Relivaro's checks).
     A test is done only when it has been executed and passes; for regression tests also show it would fail on the
     old code when practical.
4. Answer with what was tested, results, coverage changes if a report is available, and remaining gaps.
