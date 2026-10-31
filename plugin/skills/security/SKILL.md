---

name: security
description: Relivaro security analysis — injection, XSS, SSRF, path traversal, deserialization, crypto, JWT/session/CORS, mass assignment and tenant/privilege risks, secrets, CI/CD and container hardening, dependency and supply-chain risks (OWASP Top 10:2025, API Security Top 10:2023, OpenSSF), with findings verified in code.
argument-hint: "[path] [--online]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs" *) Bash(node ${CLAUDE_PLUGIN_ROOT}/dist/relivaro.mjs *) Read Grep Glob
---

# Relivaro · Security

Request: $ARGUMENTS

Toolchain and rules as in `${CLAUDE_PLUGIN_ROOT}/skills/relivaro/SKILL.md`. Secret values are always redacted by
Relivaro; never try to reveal them, and never print a secret you encounter while reading files.

1. `relivaro security <path> --json --compact`. With the user's OK add `--online` to check resolved dependency versions
   against OSV.dev (only package names and versions are sent).
2. Verify each critical/high finding in the code:
   - Trace the data flow yourself: does user-controlled input really reach the sink? Is there validation,
     allowlisting, parameter binding, escaping or an authorization check Relivaro could not see (other files,
     middleware, framework defaults)?
   - For secrets: is it a live credential, a test fixture or a placeholder? Recommend rotation first for live ones.
   - For CI/CD findings: who can trigger the workflow and with which permissions?
3. Look beyond the rules where the code warrants it — especially authorization and multi-tenant isolation (object
   access checked against the current user/tenant? admin-only actions protected? IDs from the request trusted?).
   Report such issues only with concrete file:line evidence and label them as your own review findings.
4. Answer with confirmed vulnerabilities (severity, exploit scenario, evidence, fix, verification test), rejected
   candidates with reasons, dependency advisories with fixed versions, and limitations. State that this review does
   not prove the absence of vulnerabilities.
