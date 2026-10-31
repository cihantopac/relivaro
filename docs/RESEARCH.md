# Research: standards, existing tools and positioning

Relivaro's scope and rules were designed against established standards and compared with existing tools. This is a
summary of what was used and why Relivaro is built the way it is.

## Standards

| Standard | Use in Relivaro |
| --- | --- |
| [OWASP Top 10:2025](https://owasp.org/Top10/2025/) (final January 2026) | Every security finding maps to a 2025 category (A01 Broken Access Control … A10 Mishandling of Exceptional Conditions). SSRF is folded into A01 as in the 2025 edition; A03 Software Supply Chain Failures covers dependency and CI/CD rules. |
| [OWASP API Security Top 10:2023](https://owasp.org/API-Security/) | Mass assignment (API3), SSRF (API7), unrestricted resource consumption (API4: unbounded queries, ReDoS, N+1), misconfiguration (API8). |
| OWASP ASVS 5.0 | Used as the checklist for the areas the rules cover (encoding and sanitisation, authentication, session management, self-contained tokens, cryptography, secure communication, configuration, logging and error handling). Requirement ids are not attached to findings because automated rules cannot prove full requirement compliance. |
| [CWE](https://cwe.mitre.org/) | Each rule lists the CWE ids it detects (e.g. CWE-89, CWE-78, CWE-918, CWE-502, CWE-798). |
| [OpenSSF Scorecard](https://github.com/ossf/scorecard) | Pinned-Dependencies (actions pinned to SHAs, base images), Token-Permissions (`permissions:`), dangerous workflow patterns (`pull_request_target` + PR checkout, script injection). |
| [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/) | Report format for GitHub code scanning (`partialFingerprints`, `security-severity`, rule help). |
| [OSV schema / API](https://google.github.io/osv.dev/) | Known-vulnerability lookup (`/v1/querybatch` returns ids only; details via `/v1/vulns/{id}`), CVSS v3 base-score computation from vectors when no severity label exists. |
| CVSS v3.1 (FIRST) | Severity mapping for advisories without a database severity. |
| [endoflife.date](https://endoflife.date) | Runtime/framework end-of-life dates (Node.js, PHP, Python, Ruby, Laravel, Django), dated in the rule. |

## Existing tools

| Tool | Strength | Relationship to Relivaro |
| --- | --- | --- |
| Semgrep | Large pattern rule ecosystem, many languages | Relivaro's rules are fewer but framework-aware, carry evidence/impact/verification text, and feed release gates and fixes. Semgrep can run alongside; SARIF from both merges in code scanning. |
| CodeQL | Deep inter-procedural data flow | Much deeper taint analysis on supported languages but requires a build/database and GitHub; Relivaro is instant, offline and covers PHP. |
| SonarQube / SonarCloud | Quality gates, maintainability | Relivaro is local-first with no server, adds execution checks, fixes with rollback and release readiness. |
| Snyk / Dependabot / OSV-Scanner / npm audit / composer audit | Dependency vulnerabilities | Relivaro uses OSV.dev for the same data across ecosystems and adds lockfile hygiene, install-script and source checks. |
| Gitleaks / TruffleHog | Secret scanning incl. history | Relivaro scans the working tree with provider patterns + entropy and never prints values; history scanning is out of scope. |
| Bandit / PHPStan / Psalm / ESLint security plugins / Larastan | Language-specific linting | Relivaro runs PHPStan/tsc/linters you already configured (`--allow-exec`) and reports their results as evidence. |
| Trivy / Hadolint / Checkov | Container and IaC scanning | Relivaro covers the most impactful Dockerfile/compose/workflow issues; dedicated IaC scanning is out of scope. |
| k6 / autocannon / hyperfine | Load and benchmark tools | `relivaro load` / `bench` provide safe-by-default, budget-aware measurements integrated with release gates. |

## What Relivaro adds

1. **One evidence-based workflow**: understand → find → verify → fix → re-test → assess, with the same finding ids
   across runs (baseline, compare).
2. **Release readiness with explicit uncertainty**: gates are passed, warned, blocked or *unverified*; the score is
   capped while blockers exist.
3. **Safe repair**: deterministic fixers verified by re-analysis and your tests in an isolated copy, with
   hash-guarded rollback.
4. **Agent-native**: a Claude Code plugin that uses the engine for facts and the model for verification, minimal
   patches and test writing — under explicit approval rules and prompt-injection hygiene.
5. **Safe by construction**: offline, read-only, no dependency installation, secret redaction, hardened git.
