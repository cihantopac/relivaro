---

name: reliability
description: Relivaro reliability and resilience analysis — timeouts, swallowed errors, idempotency of payments, race conditions on balances and counters, retry policies, destructive or irreversible migrations, graceful shutdown, health checks and error monitoring.
argument-hint: "[path]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs *) Read Grep Glob
---

# Relivaro · Reliability

Request: $ARGUMENTS

Toolchain and rules as in `${CLAUDE_PLUGIN_ROOT}/skills/relivaro/SKILL.md`.

1. `relivaro reliability <path> --json --compact`.
2. Verify findings in code. For each, describe the failure scenario concretely (what fails, what the user sees,
   what data could be lost or duplicated) — only when the code supports it.
3. Migrations: for destructive steps, check whether the release plan includes a backup and an expand/contract
   sequence; flag irreversible steps without `down()`.
4. Review what static rules cannot see when relevant: external calls without retries/backoff, queue consumers
   without dead-letter handling, webhook handlers without idempotency, transactions spanning network calls — always
   with file:line evidence, labelled as your review findings.
5. Answer with confirmed risks ordered by blast radius, the recommended minimal fix for each, and how to verify it
   (a test or a controlled failure experiment).
