# Security model

Relivaro reads, parses and — only when explicitly allowed — executes code from repositories it does not trust. This
document lists what it protects against, how, and what remains your responsibility.

## Defaults

| Capability | Default | Enabled by |
| --- | --- | --- |
| Read project files | yes (guarded, see below) | — |
| Execute project commands (build, tests, type checker, linter, benchmarks, fix verification) | **no** | `--allow-exec` |
| Network | **no** | `--online` (OSV.dev), `load` (local/private targets) |
| Modify project files | **no** | `fix apply --yes`, `fix rollback`, `baseline`, `init` |
| Write run data | `.relivaro/` (self-ignored) | `--workspace <dir>` relocates, `--no-write` disables |

## File access

- Files are enumerated with git (`ls-files`, respecting `.gitignore`) or a non-following directory walk.
- Every read resolves the real path and refuses anything outside the project root (`..`, absolute paths, symlinks
  pointing outside). Symlinked directories are never followed.
- **Sensitive files** (`.env*` except templates, `*.pem`, `*.key`, `*.p12`, keystores, `id_rsa`, `.netrc`,
  credentials files) are read only when git tracks them — i.e. when they are already committed and their exposure is
  the finding. Untracked or ignored sensitive files are reported by path only, never opened.
- Size limit (default 1 MB per file), binary and minified-file detection, dependency/build directories excluded.

## Secrets

- Detected values are masked (`AKIA****************`) before they enter a finding; a global redactor runs over every
  snippet, message, command output and error message, in every output format and on stderr.
- Test files and documentation samples (`EXAMPLE`, sequential values, header-only PEM blocks) are not reported as
  secrets, but provider-format tokens are reported everywhere.

## Git hardening

Repository-local git configuration can define commands (`core.fsmonitor`, hooks, pagers). Relivaro invokes git with
`-c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.pager=cat -c protocol.file.allow=never`,
`GIT_CONFIG_NOSYSTEM=1`, no terminal prompts, and a minimal environment. A test verifies that a repository with a
malicious `core.fsmonitor` cannot execute it.

## Command execution (`--allow-exec`)

- Commands come from the project (package.json scripts, composer/vendor binaries, pytest, go, cargo, flutter) or from
  `relivaro.config.json`. **These are project code**: anyone who can edit the repository controls them. That is why
  execution is opt-in.
- No shell: argv is passed directly; shell operators in configured commands are rejected. On Windows, `.cmd` shims are
  routed through `cmd.exe` with quoted arguments.
- Scrubbed environment: only an allowlist of variables (PATH, HOME, locale, toolchain locations) is inherited;
  anything named like a token, secret, password, key, session or credential is dropped. `CI=true` is set.
- Hard timeout per command (default 600 s) with process-tree termination; output capped at 2 MB and redacted.
- Relivaro never installs dependencies. Checks whose dependencies are missing are reported as skipped.

**Not provided:** network isolation, filesystem isolation, or resource limits beyond the timeout. Run untrusted
projects inside a container or VM when executing their commands.

## Fixes

- `fix plan` only writes to `.relivaro/`. `fix apply` requires `--yes`, refuses if any target file changed since
  planning, verifies first (static re-analysis; optional test command in an isolated temporary copy), backs up every
  file, and writes atomically.
- `fix rollback` restores backups only if the files still have the content written by the fix (hash check); otherwise
  it refuses unless `--force`.

## Network

- `--online`: POST of `{ecosystem, name, version}` for each resolved dependency to `https://api.osv.dev/v1/querybatch`
  and GET of advisory details. No source code, file paths or project names are sent. Responses are cached for 24 h in
  the workspace.
- `load`: the target host is resolved first; non-loopback/non-private addresses are refused unless `--allow-remote`.
  Concurrency, duration and request count are capped regardless of flags.

## Reports and prompt injection

- HTML reports embed data as escaped JSON and render it with `textContent` under a CSP of `default-src 'none'` — no
  network, no markup from analysed content. A test injects `</script>` payloads through source comments.
- SARIF/Markdown/JSON contain redacted text only.
- The Claude Code plugin's skills instruct the agent that repository content, logs and test output are untrusted data
  and must never be followed as instructions; consequential steps require the user's explicit approval.

## Configuration

`relivaro.config.json` is JSON — never executed. Unknown keys and invalid values are rejected.

## Reporting vulnerabilities in Relivaro

See [SECURITY.md](../SECURITY.md).
