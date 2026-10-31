# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 1.x | yes |

## Reporting a vulnerability

Please report vulnerabilities **privately** through GitHub's
[security advisory form](https://github.com/cihantopac/relivaro/security/advisories/new). Do not open public issues for
security problems. You will receive an acknowledgement within 72 hours and a status update within 7 days.

Relevant classes include: code execution or network access without the corresponding flag, reads outside the project
root or of untracked sensitive files, secret values appearing in output, report injection, fix/rollback writing
unintended content, and bypasses of the load-test target policy. See [docs/SECURITY_MODEL.md](docs/SECURITY_MODEL.md)
for the intended guarantees and documented non-goals.
