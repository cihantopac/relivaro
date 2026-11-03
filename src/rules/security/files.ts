import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  parse as parseYaml,
  type Node as YNode,
} from 'yaml';
import {
  GENERIC_SECRET_ASSIGNMENT,
  isPlaceholder,
  isSyntheticSample,
  maskSecret,
  SECRET_PATTERNS,
  shannonEntropy,
} from '../../core/secrets.js';
import { isEnvTemplate } from '../../fs/files.js';
import { OWASP } from '../helpers.js';
import type { FileContext, FileRule, Hit, ProjectRule } from '../types.js';

const SECRET_SCAN_SKIP =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|Gemfile\.lock|pubspec\.lock|go\.sum|Podfile\.lock|Package\.resolved)$|\.(?:svg|snap|lock)$/;

/** Cheap prefilters: a line can only match a provider pattern if it contains one of these markers. */
const SECRET_HINT =
  /AKIA|ASIA|aws_?secret|gh[pousr]_|github_pat_|glpat-|xox[baprs]-|hooks\.slack|[sr]k_(?:live|test)_|AIza|GOCSPX-|npm_|SG\.|T3BlbkFJ|sk-ant-|\bSK[0-9a-f]{8}|key-[0-9a-f]{8}|:AA|discord|AccountKey=|APP_KEY|:\/\/[^\s:@/]+:[^\s@/]+@|eyJ|PRIVATE KEY/i;
const GENERIC_HINT = /pass|pwd|secret|api[_-]?key|apikey|token|private[_-]?key/i;

const hardcodedSecret: FileRule = {
  kind: 'file',
  id: 'sec/hardcoded-secret',
  title: 'Hard-coded secret',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  cwe: ['CWE-798'],
  owasp: [OWASP.A07, OWASP.A04],
  description:
    'A credential (API key, token, private key, password, connection string with password) appears in a tracked file. Values are always redacted in Relivaro output.',
  impact:
    'Anyone with repository access — or anyone who obtains a clone, CI log, container image or package — can use the credential. Secrets in git history remain exposed after deletion.',
  recommendation:
    'Revoke and rotate the credential first, then move it to environment variables or a secrets manager. Remove it from history (git filter-repo / BFG) if the repository was ever shared.',
  verification:
    'Re-run `relivaro security`; the finding must disappear and the provider console must show the old key as revoked.',
  appliesTo: (f) =>
    !SECRET_SCAN_SKIP.test(f.path) &&
    (f.kind !== 'other' || /\.(?:txt|cfg|conf|ini|properties|pem|key|env)$/.test(f.path)),
  check(ctx) {
    const out: Hit[] = [];
    const isTemplate = isEnvTemplate(ctx.file.path);
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i]!;
      if (line.length > 4000 || !line.trim()) continue;
      const provider = SECRET_HINT.test(line);
      if (!provider && !GENERIC_HINT.test(line)) continue;
      let matched = false;
      for (const p of provider ? SECRET_PATTERNS : []) {
        p.regex.lastIndex = 0;
        for (const m of line.matchAll(p.regex)) {
          const value = p.group === 0 ? m[0] : m[p.group];
          if (!value) continue;
          if (p.minEntropy && shannonEntropy(value) < p.minEntropy) continue;
          if (p.id !== 'private-key' && isSyntheticSample(value)) continue;
          // A PEM header alone (docs, tests, parsers) is not a key: require base64 key material to follow.
          if (
            p.id === 'private-key' &&
            !/^[A-Za-z0-9+/=]{40,}\s*$/.test(ctx.lines[i + 1] ?? '') &&
            !/^[A-Za-z0-9+/=]{40,}\s*$/.test(ctx.lines[i + 2] ?? '')
          )
            continue;
          if (
            p.id === 'db-url-password' &&
            (isPlaceholder(value) ||
              /^\$\{|^%|^<|password|secret|pass$|root$|postgres$|^user$|^admin$|^test/i.test(value))
          )
            continue;
          if (p.id === 'jwt' && ctx.file.isTest) continue;
          matched = true;
          out.push({
            line: i + 1,
            column: (m.index ?? 0) + 1,
            message: `${p.name} found (${p.id === 'private-key' ? 'PEM block' : maskSecret(value)}).`,
            severity: p.severity,
            confidence: p.id === 'jwt' || p.id === 'google-api-key' ? 'medium' : 'high',
            facts: { type: p.id },
            anchor: `${p.id}:${maskSecret(value)}`,
          });
        }
      }
      if (matched) continue;
      // Test files are full of literal passwords for fake users; only provider-format tokens are reported there.
      if (ctx.file.isTest) continue;
      GENERIC_SECRET_ASSIGNMENT.lastIndex = 0;
      for (const m of line.matchAll(GENERIC_SECRET_ASSIGNMENT)) {
        const name = m[1]!;
        const value = m[2]!;
        if (isPlaceholder(value) || shannonEntropy(value) < 3.5 || value.length < 10) continue;
        if (/^(?:https?:|\/|\.\/|[\w.-]+\.(?:js|ts|php|py|json|html|png|svg)$)/.test(value)) continue;
        if (
          /(?:_?(?:field|label|name|key_?name|header|param|input|placeholder|route|path|url|type|id|hint|message|regex|pattern|policy|reset|confirm|min|max|length|rule)s?)$/i.test(
            name,
          )
        )
          continue;
        if (/\$\{|\{\{|%\(|\bprocess\.env\b|\benv\(|getenv|os\.environ/.test(value)) continue;
        // Framework signing keys in code are reported (more precisely) by sec/hardcoded-signing-secret.
        if (/\.py$/.test(ctx.file.path) && /^(?:SECRET_KEY|app\.secret_key|JWT_SECRET(?:_KEY)?)$/.test(name))
          continue;
        out.push({
          line: i + 1,
          column: (m.index ?? 0) + 1,
          message: `\`${name}\` is assigned a literal that looks like a real secret (${maskSecret(value)}).`,
          severity: isTemplate ? 'medium' : 'high',
          confidence: 'medium',
          facts: { type: 'generic', name },
          anchor: `generic:${name}:${maskSecret(value)}`,
        });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// GitHub Actions

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  line: number;
}

interface Workflow {
  doc: Document;
  data: Record<string, unknown>;
  lc: LineCounter;
  triggers: string[];
  steps: Step[];
  jobs: { id: string; data: Record<string, unknown>; line: number }[];
}

const wfCache = new WeakMap<FileContext, Workflow | null>();

function lineOf(node: YNode | null | undefined, lc: LineCounter): number {
  const r = (node as { range?: [number, number, number] } | null)?.range;
  return r ? lc.linePos(r[0]).line : 1;
}

function loadWorkflow(ctx: FileContext): Workflow | null {
  if (wfCache.has(ctx)) return wfCache.get(ctx) ?? null;
  let wf: Workflow | null = null;
  try {
    const lc = new LineCounter();
    const doc = parseDocument(ctx.text, { lineCounter: lc, uniqueKeys: false });
    const data = (doc.toJS({ maxAliasCount: 100 }) ?? {}) as Record<string, unknown>;
    const on = data.on ?? data.true;
    const triggers =
      typeof on === 'string'
        ? [on]
        : Array.isArray(on)
          ? on.map(String)
          : on && typeof on === 'object'
            ? Object.keys(on)
            : [];
    const steps: Step[] = [];
    const jobs: Workflow['jobs'] = [];
    const jobsNode = doc.get('jobs', true);
    if (isMap(jobsNode)) {
      for (const pair of jobsNode.items) {
        const id = String((pair.key as { value?: unknown })?.value ?? pair.key);
        const jobNode = pair.value as YNode;
        const jobData = ((jobNode as { toJSON?: () => unknown })?.toJSON?.() ?? {}) as Record<
          string,
          unknown
        >;
        jobs.push({ id, data: jobData, line: lineOf(pair.key as YNode, lc) });
        const stepsNode = isMap(jobNode) ? jobNode.get('steps', true) : null;
        if (isSeq(stepsNode))
          for (const s of stepsNode.items) {
            const js = ((s as { toJSON?: () => unknown }).toJSON?.() ?? {}) as Step;
            steps.push({
              uses: typeof js.uses === 'string' ? js.uses : undefined,
              run: typeof js.run === 'string' ? js.run : undefined,
              with: js.with,
              line: lineOf(s as YNode, lc),
            });
          }
        const uses = jobData.uses;
        if (typeof uses === 'string') steps.push({ uses, line: lineOf(pair.key as YNode, lc) });
      }
    }
    wf = { doc, data, lc, triggers, steps, jobs };
  } catch {
    wf = null;
  }
  wfCache.set(ctx, wf);
  return wf;
}

function findLine(lines: string[], re: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i]!)) return i + 1;
  return 1;
}

const UNTRUSTED_CONTEXT =
  /\$\{\{\s*(github\.event\.(?:issue\.(?:title|body)|pull_request\.(?:title|body|head\.ref|head\.label|head\.repo\.default_branch)|comment\.body|review\.body|review_comment\.body|pages\.[^}]*\.page_name|commits\.[^}]*\.(?:message|author\.(?:email|name))|head_commit\.(?:message|author\.(?:email|name))|workflow_run\.(?:head_branch|head_commit\.message|display_title)|discussion\.(?:title|body))|github\.head_ref|inputs\.[\w-]+)\s*\}\}/g;

const ghaScriptInjection: FileRule = {
  kind: 'file',
  id: 'sec/gha-script-injection',
  title: 'GitHub Actions script injection',
  category: 'supply-chain',
  severity: 'high',
  confidence: 'high',
  cwe: ['CWE-78', 'CWE-94'],
  owasp: [OWASP.A03, OWASP.A05],
  description:
    'An attacker-controllable GitHub context value (issue/PR title or body, branch name, commit message, comment) is interpolated directly into a `run:` script.',
  impact:
    'Anyone who can open an issue or PR can execute arbitrary commands in the workflow, steal `GITHUB_TOKEN` and secrets, or push malicious code.',
  recommendation:
    'Pass the value through an environment variable (`env: TITLE: ${{ github.event.issue.title }}` and use `"$TITLE"` in the script) or an action input; never expand `${{ }}` with untrusted data inside `run:`.',
  verification:
    'Re-run `relivaro security` and review the workflow; open a test PR whose title contains `$(id)` in a fork and confirm it is printed literally.',
  appliesTo: (f) => f.kind === 'workflow',
  check(ctx) {
    const wf = loadWorkflow(ctx);
    if (!wf) return [];
    const out: Hit[] = [];
    const seen = new Set<string>();
    for (const s of wf.steps) {
      if (!s.run) continue;
      UNTRUSTED_CONTEXT.lastIndex = 0;
      for (const m of s.run.matchAll(UNTRUSTED_CONTEXT)) {
        const expr = m[1]!;
        if (
          expr.startsWith('inputs.') &&
          !wf.triggers.includes('workflow_dispatch') &&
          !wf.triggers.includes('workflow_call')
        )
          continue;
        const line = findLine(ctx.lines, new RegExp(m[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), s.line - 1);
        if (seen.has(`${line}:${expr}`)) continue;
        seen.add(`${line}:${expr}`);
        out.push({
          line,
          message: `\`${m[0]}\` is expanded inside a \`run:\` script.`,
          severity: expr.startsWith('inputs.') ? 'medium' : 'high',
          confidence: expr.startsWith('inputs.') ? 'medium' : 'high',
          facts: { expression: expr },
        });
      }
    }
    return out;
  },
};

const ghaPwnRequest: FileRule = {
  kind: 'file',
  id: 'sec/gha-pwn-request',
  title: '`pull_request_target` checks out untrusted code',
  category: 'supply-chain',
  severity: 'critical',
  confidence: 'high',
  cwe: ['CWE-829'],
  owasp: [OWASP.A03, OWASP.A08],
  description:
    'A workflow triggered by `pull_request_target` (or `workflow_run`) checks out the pull request head and therefore runs fork code with a privileged token and secrets.',
  impact:
    'Any GitHub user can open a PR from a fork and obtain repository secrets or write access ("pwn request").',
  recommendation:
    'Use `pull_request` for building/testing untrusted code. If `pull_request_target` is required, never check out `github.event.pull_request.head.*`, or split into an unprivileged build workflow and a privileged follow-up that only consumes artifacts.',
  verification:
    'Inspect the workflow after the change: no checkout of PR head refs under `pull_request_target`/`workflow_run`.',
  appliesTo: (f) => f.kind === 'workflow',
  check(ctx) {
    const wf = loadWorkflow(ctx);
    if (!wf || !(wf.triggers.includes('pull_request_target') || wf.triggers.includes('workflow_run')))
      return [];
    const out: Hit[] = [];
    for (const s of wf.steps) {
      if (!s.uses?.startsWith('actions/checkout')) continue;
      const ref = String(s.with?.ref ?? '') + String(s.with?.repository ?? '');
      if (/github\.event\.pull_request\.head|github\.head_ref|github\.event\.workflow_run\.head/.test(ref))
        out.push({
          line: s.line,
          message: `Checks out \`${ref}\` in a \`${wf.triggers.find((t) => t === 'pull_request_target' || t === 'workflow_run')}\` workflow.`,
        });
    }
    return out;
  },
};

const FIRST_PARTY_ACTION = /^(?:actions|github)\//;

/** Steps whose `uses:` is a mutable ref, split into third-party and GitHub-owned actions. */
function unpinnedSteps(ctx: FileContext): { thirdParty: Hit[]; firstParty: string[] } | null {
  const wf = loadWorkflow(ctx);
  if (!wf) return null;
  const thirdParty: Hit[] = [];
  const firstParty: string[] = [];
  for (const s of wf.steps) {
    if (!s.uses || s.uses.startsWith('./') || s.uses.startsWith('docker://')) continue;
    const [name, ref] = s.uses.split('@');
    if (!ref || /^[0-9a-f]{40}$/.test(ref)) continue;
    if (FIRST_PARTY_ACTION.test(name!)) {
      if (!firstParty.includes(s.uses)) firstParty.push(s.uses);
      continue;
    }
    thirdParty.push({
      line: s.line,
      message: `\`${s.uses}\` is pinned to a mutable ref.`,
      facts: { action: name!, ref },
    });
  }
  return { thirdParty, firstParty };
}

const ghaUnpinned: FileRule = {
  kind: 'file',
  id: 'sec/gha-unpinned-action',
  title: 'Third-party GitHub Action not pinned to a commit SHA',
  category: 'supply-chain',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-829', 'CWE-1357'],
  owasp: [OWASP.A03],
  description:
    'A third-party action is referenced by a mutable tag or branch (`@v3`, `@main`) instead of a full commit SHA (OpenSSF Scorecard: Pinned-Dependencies).',
  impact:
    "If the action's repository or tag is compromised (as in the tj-actions/changed-files incident), malicious code runs in your CI with access to secrets.",
  recommendation:
    'Pin to the full 40-character commit SHA and keep the version in a comment (`uses: owner/action@<sha> # v4.1.0`); let Dependabot/Renovate update the pins.',
  verification: 'Every `uses:` of a third-party action ends in a 40-hex-character SHA.',
  fixer: 'gha-pin-action',
  appliesTo: (f) => f.kind === 'workflow',
  check(ctx) {
    return unpinnedSteps(ctx)?.thirdParty ?? [];
  },
};

const ghaUnpinnedFirstParty: FileRule = {
  kind: 'file',
  id: 'sec/gha-unpinned-first-party-action',
  title: 'GitHub-owned action not pinned to a commit SHA',
  category: 'supply-chain',
  severity: 'low',
  confidence: 'high',
  cwe: ['CWE-829', 'CWE-1357'],
  owasp: [OWASP.A03],
  description:
    'A GitHub-owned action (`actions/*`, `github/*`) is referenced by a mutable tag instead of a full commit SHA. GitHub controls these repositories, so the risk is lower than for third-party actions, but a moved tag still changes what runs in CI (OpenSSF Scorecard: Pinned-Dependencies).',
  impact: 'The code that runs with your CI secrets can change without a change in your repository.',
  recommendation:
    'Pin to the full 40-character commit SHA and keep the version in a comment (`uses: actions/checkout@<sha> # v4.2.2`); let Dependabot/Renovate update the pins.',
  verification: 'Every `uses:` of a GitHub-owned action ends in a 40-hex-character SHA.',
  fixer: 'gha-pin-action',
  appliesTo: (f) => f.kind === 'workflow',
  check(ctx) {
    const firstParty = unpinnedSteps(ctx)?.firstParty ?? [];
    if (!firstParty.length) return [];
    return [
      {
        line: findLine(ctx.lines, /uses:\s*(?:actions|github)\//),
        message: `GitHub-owned actions use mutable tags: ${firstParty.join(', ')}.`,
        facts: { actions: firstParty.join(',') },
        anchor: `first-party:${[...firstParty].sort().join(',')}`,
      },
    ];
  },
};

const WRITES_NEEDED =
  /softprops\/action-gh-release|peter-evans\/create-pull-request|actions\/deploy-pages|actions\/create-release|ncipollo\/release-action|stefanzweifel\/git-auto-commit|changesets\/action|release-please|semantic-release|gh release|gh pr (?:create|merge|comment)|git push|actions\/github-script|docker\/login-action|github\.token|GITHUB_TOKEN|codecov|upload-sarif|dependabot|pages/;

const ghaPermissions: FileRule = {
  kind: 'file',
  id: 'sec/gha-excessive-permissions',
  title: 'Workflow token permissions not restricted',
  category: 'supply-chain',
  severity: 'medium',
  confidence: 'medium',
  cwe: ['CWE-250'],
  owasp: [OWASP.A03, OWASP.A01],
  fixer: 'gha-permissions-read',
  description:
    'The workflow does not declare `permissions:` (inheriting the repository default, which is read/write on many repositories) or requests `write-all` (OpenSSF Scorecard: Token-Permissions).',
  impact:
    'A compromised step or dependency can use the `GITHUB_TOKEN` to push code, create releases or modify issues.',
  recommendation:
    'Declare `permissions: contents: read` at the top level and grant additional scopes only to the jobs that need them.',
  verification: 'The workflow has a top-level `permissions:` block and still passes in CI.',
  appliesTo: (f) => f.kind === 'workflow',
  check(ctx) {
    const wf = loadWorkflow(ctx);
    if (!wf) return [];
    const top = wf.data.permissions;
    if (top === 'write-all')
      return [
        {
          line: findLine(ctx.lines, /^permissions:/),
          message: '`permissions: write-all` grants every scope to the workflow token.',
          severity: 'high',
          fixer: null,
        },
      ];
    if (top !== undefined) return [];
    if (wf.jobs.length && wf.jobs.every((j) => j.data.permissions !== undefined)) return [];
    const needsWrite = WRITES_NEEDED.test(ctx.text);
    return [
      {
        line: findLine(ctx.lines, /^on:|^"on":|^'on':/),
        message: 'No `permissions:` block; the token gets the repository default scopes.',
        fixer: needsWrite ? null : 'gha-permissions-read',
        facts: { autoFixable: !needsWrite },
      },
    ];
  },
};

const ghaTimeout: FileRule = {
  kind: 'file',
  id: 'rel/gha-no-timeout',
  title: 'CI jobs without a timeout',
  category: 'reliability',
  severity: 'low',
  confidence: 'high',
  cwe: ['CWE-400'],
  description: 'Workflow jobs do not set `timeout-minutes`, so a hung step runs for the 6-hour default.',
  impact: 'Hung jobs block merges and releases and consume CI minutes.',
  recommendation: 'Set `timeout-minutes` on each job to a small multiple of its normal duration.',
  verification: 'Each job in the workflow declares `timeout-minutes`.',
  appliesTo: (f) => f.kind === 'workflow',
  check(ctx) {
    const wf = loadWorkflow(ctx);
    if (!wf) return [];
    const missing = wf.jobs.filter(
      (j) => j.data['timeout-minutes'] === undefined && typeof j.data.uses !== 'string',
    );
    if (!missing.length) return [];
    return [
      {
        line: missing[0]!.line,
        message: `Jobs without \`timeout-minutes\`: ${missing.map((j) => j.id).join(', ')}.`,
        anchor: `jobs:${missing.map((j) => j.id).join(',')}`,
      },
    ];
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Dockerfile

interface DockerInstr {
  op: string;
  args: string;
  line: number;
}

function dockerInstructions(text: string): DockerInstr[] {
  const out: DockerInstr[] = [];
  const lines = text.split(/\r?\n/);
  let buf = '';
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (!buf && (/^\s*#/.test(raw) || !raw.trim())) continue;
    if (!buf) start = i + 1;
    buf += `${raw.replace(/\\\s*$/, '')} `;
    if (/\\\s*$/.test(raw)) continue;
    const m = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(buf.trim());
    if (m) out.push({ op: m[1]!.toUpperCase(), args: m[2]!.trim(), line: start });
    buf = '';
  }
  return out;
}

const dockerRoot: FileRule = {
  kind: 'file',
  id: 'sec/docker-runs-as-root',
  title: 'Container runs as root',
  category: 'security',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-250'],
  owasp: [OWASP.A02],
  description:
    'The final image stage has no `USER` instruction (or switches back to root), so the application runs as UID 0.',
  impact:
    'A vulnerability in the application gives the attacker root inside the container, easing container escape and host compromise.',
  recommendation:
    'Create an unprivileged user and add `USER <name>` (or a numeric UID) in the final stage; official images often ship one (`node`, `www-data`).',
  verification: '`docker run --rm <image> id -u` prints a non-zero UID.',
  appliesTo: (f) => f.kind === 'dockerfile',
  check(ctx) {
    const ins = dockerInstructions(ctx.text);
    const lastFrom = ins.map((x) => x.op).lastIndexOf('FROM');
    if (lastFrom < 0) return [];
    const from = ins[lastFrom]!;
    if (/^scratch\b|distroless|chainguard|nonroot|rootless/i.test(from.args)) return [];
    const users = ins.slice(lastFrom).filter((x) => x.op === 'USER');
    const last = users[users.length - 1];
    if (!last)
      return [{ line: from.line, message: `Final stage \`FROM ${from.args}\` has no \`USER\` instruction.` }];
    if (/^(?:root|0)(?::|$)/.test(last.args))
      return [{ line: last.line, message: 'The final `USER` is root.' }];
    return [];
  },
};

const dockerLatest: FileRule = {
  kind: 'file',
  id: 'sec/docker-unpinned-base-image',
  title: 'Base image uses `latest` or no tag',
  category: 'supply-chain',
  severity: 'low',
  confidence: 'high',
  cwe: ['CWE-1357'],
  owasp: [OWASP.A03],
  description:
    'A `FROM` line uses `:latest` or no tag, so builds are not reproducible and can silently pick up breaking or compromised images.',
  impact: 'Unreviewed base image changes reach production; rollbacks cannot reproduce the previous image.',
  recommendation:
    'Pin a specific version tag, ideally with a digest (`node:22.11-alpine@sha256:…`), and update it deliberately.',
  verification: 'Every `FROM` references an explicit version tag or digest.',
  appliesTo: (f) => f.kind === 'dockerfile',
  check(ctx) {
    const ins = dockerInstructions(ctx.text);
    const stages = new Set(
      ins
        .filter((x) => x.op === 'FROM')
        .map((x) => /\bAS\s+(\S+)/i.exec(x.args)?.[1]?.toLowerCase())
        .filter(Boolean),
    );
    const out: Hit[] = [];
    for (const x of ins) {
      if (x.op !== 'FROM') continue;
      const image = x.args.replace(/--platform=\S+\s+/, '').split(/\s+/)[0]!;
      if (
        image === 'scratch' ||
        stages.has(image.toLowerCase()) ||
        image.includes('$') ||
        image.includes('@sha256:')
      )
        continue;
      const tag = image.includes(':') && !/:\d+\//.test(image) ? image.split(':').pop() : undefined;
      if (!tag || tag === 'latest')
        out.push({ line: x.line, message: `\`FROM ${image}\` is not pinned to a version.` });
    }
    return out;
  },
};

const dockerCurlPipe: FileRule = {
  kind: 'file',
  id: 'sec/docker-remote-script-execution',
  title: 'Remote script piped to a shell during build',
  category: 'supply-chain',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-494'],
  owasp: [OWASP.A08],
  description:
    'A `RUN` step downloads a script and pipes it directly into a shell (`curl … | sh`), or `ADD` fetches a remote URL without a checksum.',
  impact: 'A compromised or hijacked download server injects code into every image you build.',
  recommendation:
    'Download to a file, verify a pinned checksum or signature, then execute; prefer distribution packages or multi-stage copies from official images.',
  verification: 'The Dockerfile verifies checksums (`sha256sum -c`) or uses `ADD --checksum=`.',
  appliesTo: (f) => f.kind === 'dockerfile',
  check(ctx) {
    const out: Hit[] = [];
    for (const x of dockerInstructions(ctx.text)) {
      if (x.op === 'RUN' && /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/.test(x.args))
        out.push({ line: x.line, message: 'Downloads a script and pipes it into a shell.' });
      if (x.op === 'ADD' && /https?:\/\//.test(x.args) && !/--checksum=/.test(x.args))
        out.push({
          line: x.line,
          message: '`ADD` fetches a remote URL without `--checksum`.',
          severity: 'low',
        });
    }
    return out;
  },
};

const dockerSecretEnv: FileRule = {
  kind: 'file',
  id: 'sec/docker-secret-in-image',
  title: 'Secret baked into the image',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  cwe: ['CWE-798', 'CWE-538'],
  owasp: [OWASP.A02],
  description:
    '`ENV`/`ARG` assigns a literal value to a variable whose name indicates a secret. Build args and env values are stored in image metadata and layer history.',
  impact: 'Anyone who can pull the image can read the secret with `docker history` / `docker inspect`.',
  recommendation:
    'Use BuildKit secrets (`RUN --mount=type=secret`) at build time and inject runtime secrets via the orchestrator.',
  verification: '`docker history --no-trunc <image>` shows no secret values.',
  appliesTo: (f) => f.kind === 'dockerfile',
  check(ctx) {
    const out: Hit[] = [];
    for (const x of dockerInstructions(ctx.text)) {
      if (x.op !== 'ENV' && x.op !== 'ARG') continue;
      for (const m of x.args.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*[= ]\s*("[^"]*"|'[^']*'|\S+)/g)) {
        const name = m[1]!;
        const value = m[2]!.replace(/^['"]|['"]$/g, '');
        if (!/(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?)$/i.test(name))
          continue;
        if (!value || value.startsWith('$') || isPlaceholder(value)) continue;
        out.push({
          line: x.line,
          message: `\`${x.op} ${name}\` has a literal value (${maskSecret(value)}).`,
        });
      }
    }
    return out;
  },
};

const dockerCopyAll: ProjectRule = {
  kind: 'project',
  id: 'sec/docker-context-leak',
  title: 'Docker build copies the whole context without `.dockerignore`',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  cwe: ['CWE-538'],
  owasp: [OWASP.A02],
  description:
    '`COPY . .` (or `ADD . .`) is used but the build context has no `.dockerignore`, so `.env` files, `.git`, local credentials and build artifacts end up in the image.',
  impact:
    'Secrets from developer machines or CI workspaces are shipped inside images that may be pushed to registries.',
  recommendation:
    'Add a `.dockerignore` that excludes at least `.git`, `.env*`, `node_modules`, `vendor`, test data and local configuration.',
  verification:
    'Build the image and list its files (`docker run --rm <image> ls -la`); no `.env` or `.git` must be present.',
  check(ctx) {
    const out: Hit[] = [];
    for (const f of ctx.files.byKind('dockerfile')) {
      const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      const ignore = dir ? `${dir}/.dockerignore` : '.dockerignore';
      if (
        ctx.files.has(ignore) ||
        ctx.files.readAny(ignore) !== undefined ||
        ctx.files.readAny('.dockerignore') !== undefined
      )
        continue;
      if (ctx.files.has(`${f.path}.dockerignore`)) continue;
      for (const x of dockerInstructions(ctx.files.read(f.path) ?? ''))
        if (
          (x.op === 'COPY' || x.op === 'ADD') &&
          /(?:^|\s)\.\/?\s+\S+$/.test(x.args.replace(/--\S+\s+/g, '')) &&
          !/--from=/.test(x.args)
        ) {
          out.push({
            file: f.path,
            line: x.line,
            message: `\`${x.op} ${x.args}\` copies the entire build context and no \`.dockerignore\` exists.`,
          });
          break;
        }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// docker-compose

const DB_PORTS = /^(?:5432|3306|27017|6379|9200|5672|11211|1433|1521|9042|8086)$/;

const composeRisks: FileRule = {
  kind: 'file',
  id: 'sec/compose-insecure-service',
  title: 'Insecure docker-compose service configuration',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  cwe: ['CWE-250', 'CWE-668'],
  owasp: [OWASP.A02],
  description:
    'A compose service runs privileged, mounts the Docker socket, uses host networking, or publishes a database/cache port on all interfaces.',
  impact:
    'Privileged containers and the Docker socket give full control of the host; databases bound to 0.0.0.0 are reachable from the network (often without authentication).',
  recommendation:
    'Remove `privileged: true` and Docker socket mounts (use specific capabilities), avoid `network_mode: host`, and bind internal services to `127.0.0.1:` or keep them on the internal network without `ports:`.',
  verification:
    'Run `docker compose config` and confirm the settings; from another machine the database port must be unreachable.',
  appliesTo: (f) => f.kind === 'compose',
  check(ctx) {
    let y: { services?: Record<string, Record<string, unknown>> } | null;
    try {
      y = parseYaml(ctx.text) as typeof y;
    } catch {
      return [];
    }
    const out: Hit[] = [];
    for (const [name, svc] of Object.entries(y?.services ?? {})) {
      if (!svc || typeof svc !== 'object') continue;
      const at = (re: RegExp) =>
        findLine(ctx.lines, re, Math.max(0, findLine(ctx.lines, new RegExp(`^\\s+${name}:`)) - 1));
      if (svc.privileged === true)
        out.push({
          line: at(/privileged:\s*true/),
          message: `Service \`${name}\` runs privileged.`,
          anchor: `${name}:privileged`,
        });
      const vols = Array.isArray(svc.volumes)
        ? svc.volumes.map((v) =>
            typeof v === 'string' ? v : String((v as { source?: string })?.source ?? ''),
          )
        : [];
      if (vols.some((v) => v.includes('/var/run/docker.sock')))
        out.push({
          line: at(/docker\.sock/),
          message: `Service \`${name}\` mounts the Docker socket.`,
          anchor: `${name}:docker.sock`,
        });
      if (svc.network_mode === 'host')
        out.push({
          line: at(/network_mode:\s*host/),
          message: `Service \`${name}\` uses host networking.`,
          severity: 'low',
          anchor: `${name}:host-net`,
        });
      const ports = Array.isArray(svc.ports) ? svc.ports.map(String) : [];
      for (const p of ports) {
        const parts = p.replace(/\/(?:tcp|udp)$/, '').split(':');
        const container = parts[parts.length - 1]!;
        const hostIp = parts.length === 3 ? parts[0] : undefined;
        if (DB_PORTS.test(container) && (!hostIp || hostIp === '0.0.0.0'))
          out.push({
            line: at(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
            message: `Service \`${name}\` publishes port ${container} on all interfaces.`,
            severity: 'low',
            confidence: 'medium',
            anchor: `${name}:port:${p}`,
          });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Environment files and key material

const envCommitted: ProjectRule = {
  kind: 'project',
  id: 'sec/env-file-committed',
  title: 'Environment or key file committed to git',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  cwe: ['CWE-538', 'CWE-312'],
  owasp: [OWASP.A02],
  description:
    'A real environment file (`.env`, `.env.production`, …) or private key/keystore file is tracked by git.',
  impact: 'Every clone, fork and CI log exposes the values; they remain in history even after deletion.',
  recommendation:
    'Rotate every credential in the file, `git rm --cached` it, add it to `.gitignore`, keep only a placeholder `.env.example`, and purge history if the repository was shared.',
  verification: '`git ls-files` no longer lists the file and the credentials are rotated.',
  check(ctx) {
    const out: Hit[] = [];
    for (const f of ctx.files.files) {
      if (f.tracked !== true) continue;
      const b = f.path.split('/').pop()!;
      if (/^\.env(?:\.[\w.-]+)?$/i.test(b) && !isEnvTemplate(f.path) && !/\.(?:test|testing|ci)$/i.test(b))
        out.push({ file: f.path, message: `\`${f.path}\` is tracked by git.`, anchor: f.path });
      else if (/\.(?:p12|pfx|jks|keystore|ppk)$|^id_(?:rsa|dsa|ecdsa|ed25519)$/i.test(b))
        out.push({
          file: f.path,
          message: `Key material \`${f.path}\` is tracked by git.`,
          anchor: f.path,
          confidence: 'medium',
        });
    }
    return out;
  },
};

const envNotIgnored: ProjectRule = {
  kind: 'project',
  id: 'sec/env-file-not-ignored',
  title: 'Environment file is not git-ignored',
  category: 'security',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-538'],
  owasp: [OWASP.A02],
  fixer: 'gitignore-env',
  description:
    'A local environment or key file exists in the working tree but is neither tracked nor ignored, so the next `git add .` commits it. Relivaro never reads its contents.',
  impact: 'Credentials are one careless commit away from the repository history.',
  recommendation: 'Add `.env` and `.env.*` (with `!.env.example`) and key files to `.gitignore`.',
  verification: '`git check-ignore <file>` prints the path.',
  check(ctx) {
    if (!ctx.files.gitRepo) return [];
    return ctx.files.sensitiveUnread
      .filter((s) => s.ignored === false)
      .map((s) => ({
        file: undefined,
        message: `\`${s.path}\` is not ignored by git.`,
        anchor: s.path,
        facts: { path: s.path },
      }));
  },
};

const NEXT_PUBLIC = /^(?:NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_|REACT_APP_|NUXT_PUBLIC_|PUBLIC_|GATSBY_)/;

const publicEnvSecret: ProjectRule = {
  kind: 'project',
  id: 'sec/secret-exposed-to-client',
  title: 'Secret exposed through a public environment variable',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  cwe: ['CWE-200'],
  owasp: [OWASP.A02],
  description:
    'A variable with a browser-exposed prefix (`NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, `REACT_APP_`) has a name that indicates a server secret. Bundlers inline these values into client JavaScript.',
  impact:
    'The secret is downloadable by every visitor from the JavaScript bundle (e.g. Supabase service-role keys, Stripe secret keys).',
  recommendation:
    'Rename the variable without the public prefix and access it only in server code (API routes, server components, edge functions); rotate the exposed value.',
  verification:
    'Build the app and search the client bundle (`.next/static`, `dist/assets`) for the value; it must not appear.',
  check(ctx) {
    const out: Hit[] = [];
    const names = new Map<string, string>();
    for (const v of ctx.profile.envVars) names.set(v.name, v.usedIn[0] ?? '');
    for (const t of ctx.profile.envTemplates)
      for (const m of (ctx.files.read(t) ?? '').matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm))
        if (!names.has(m[1]!)) names.set(m[1]!, t);
    for (const [name, file] of names) {
      if (!NEXT_PUBLIC.test(name)) continue;
      const rest = name.replace(NEXT_PUBLIC, '');
      if (
        !/(?:SECRET|PRIVATE|PASSWORD|SERVICE_ROLE|SERVICE_KEY|ADMIN_KEY|_SK$|SECRET_KEY|WEBHOOK_SECRET|DB_URL|DATABASE_URL)/.test(
          rest,
        )
      )
        continue;
      if (/PUBLISHABLE|PUBLIC_KEY|ANON/.test(rest)) continue;
      out.push({
        file: file || undefined,
        message: `\`${name}\` is exposed to the browser bundle.`,
        anchor: name,
        facts: { variable: name },
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Templates (Blade, Vue, Jinja/Django) — text rules because these are not parsed as code.

const templateXss: FileRule = {
  kind: 'file',
  id: 'sec/template-unescaped-output',
  title: 'Unescaped output in a template',
  category: 'security',
  severity: 'medium',
  confidence: 'low',
  cwe: ['CWE-79'],
  owasp: [OWASP.A05],
  description:
    'A template prints raw HTML (`{!! !!}` in Blade, `v-html` in Vue, `|safe`/`autoescape off` in Jinja/Django) from a variable.',
  impact: "If the variable can contain user-provided markup, scripts run in visitors' browsers.",
  recommendation:
    'Use escaped output (`{{ }}`) or sanitize the HTML server-side with an allowlist sanitizer before marking it safe.',
  verification:
    'Render the template with `<img src=x onerror=alert(1)>` in the variable and confirm it is escaped or stripped.',
  appliesTo: (f) => f.kind === 'template',
  check(ctx) {
    const out: Hit[] = [];
    const SAFE_BLADE =
      /^\s*(?:csrf_field\(\)|method_field\(|\$slot\b|\$\w+->links\(|\$attributes|json_encode\(|Js::from|@json|\$__env|\$\w+->render\(|\$\w+->toHtml\(|nl2br\(\s*e\(|e\(|clean\(|Purifier::clean|\$errors|session\(|__\(|trans\(|\$\w+(?:Html|_html|Svg|Icon)\b)/;
    const LITERAL_TERNARY = /^[^'"?]*\?\s*(['"])(?:(?!\1).)*\1\s*:\s*(['"])(?:(?!\2).)*\2\s*$/;
    for (let i = 0; i < ctx.lines.length; i++) {
      const l = ctx.lines[i]!;
      if (ctx.file.path.endsWith('.blade.php')) {
        for (const m of l.matchAll(/\{!!\s*([\s\S]*?)\s*!!\}/g))
          if (!SAFE_BLADE.test(m[1]!) && !LITERAL_TERNARY.test(m[1]!))
            out.push({
              line: i + 1,
              column: (m.index ?? 0) + 1,
              message: `Blade prints \`{!! ${m[1]!.slice(0, 50)} !!}\` without escaping.`,
              confidence: /\$request|request\(|\$_(?:GET|POST)/.test(m[1]!) ? 'high' : 'low',
              severity: /\$request|request\(|\$_(?:GET|POST)/.test(m[1]!) ? 'high' : 'medium',
            });
      } else if (/\.vue$/.test(ctx.file.path)) {
        for (const m of l.matchAll(/\sv-html\s*=\s*"([^"]+)"/g))
          if (!/sanitize|purify|DOMPurify/i.test(m[1]!))
            out.push({ line: i + 1, message: `\`v-html="${m[1]!.slice(0, 50)}"\` renders raw HTML.` });
      } else if (/\.(?:html|jinja2?|j2|djhtml)$/.test(ctx.file.path)) {
        for (const m of l.matchAll(/\{\{\s*([^}|]+)\|\s*safe\s*\}\}/g))
          out.push({ line: i + 1, message: `\`{{ ${m[1]!.trim()}|safe }}\` disables escaping.` });
        if (/\{%\s*autoescape\s+(?:off|false)\s*%\}/.test(l))
          out.push({ line: i + 1, message: 'Autoescaping is turned off for a template block.' });
      }
    }
    return out;
  },
};

const laravelEnvDebug: FileRule = {
  kind: 'file',
  id: 'sec/production-env-debug',
  title: 'Production environment template enables debug mode',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  cwe: ['CWE-489'],
  owasp: [OWASP.A02],
  description: 'An environment template intended for production sets `APP_DEBUG=true` / `DEBUG=True`.',
  impact: 'Deployments created from the template expose stack traces and configuration.',
  recommendation: 'Set debug to false in production templates and document how to enable it locally.',
  verification: 'Inspect the template; production values default to `false`.',
  appliesTo: (f) => f.kind === 'env' && /prod/i.test(f.path),
  check(ctx) {
    const out: Hit[] = [];
    ctx.lines.forEach((l, i) => {
      const m =
        /^\s*((?:APP_DEBUG|DEBUG|FLASK_DEBUG|DJANGO_DEBUG)\s*=\s*["']?(?:true|1|True|on|yes)["']?)(?:\s|#|$)/.exec(
          l,
        );
      if (m) out.push({ line: i + 1, message: `\`${m[1]}\` in a production environment template.` });
    });
    return out;
  },
};

const nextConfigRisks: FileRule = {
  kind: 'file',
  id: 'qual/build-ignores-errors',
  title: 'Production build ignores type or lint errors',
  category: 'quality',
  severity: 'medium',
  confidence: 'high',
  description:
    'The framework build is configured to succeed despite TypeScript or lint errors (`typescript.ignoreBuildErrors`, `eslint.ignoreDuringBuilds`).',
  impact: 'Type errors that indicate real bugs ship to production without anyone noticing.',
  recommendation:
    'Remove the override and fix the errors, or run type checking as a required CI step if the build must stay fast.',
  verification: '`next build` (or the CI type-check job) fails on a deliberately introduced type error.',
  appliesTo: (f) => /(?:^|\/)next\.config\.[cm]?[jt]s$/.test(f.path),
  check(ctx) {
    const out: Hit[] = [];
    ctx.lines.forEach((l, i) => {
      if (/ignoreBuildErrors\s*:\s*true/.test(l))
        out.push({
          line: i + 1,
          message: '`typescript.ignoreBuildErrors: true` lets builds pass with type errors.',
        });
      if (/ignoreDuringBuilds\s*:\s*true/.test(l))
        out.push({
          line: i + 1,
          message: '`eslint.ignoreDuringBuilds: true` skips lint during builds.',
          severity: 'low',
        });
    });
    return out;
  },
};

export const securityFileRules: FileRule[] = [
  hardcodedSecret,
  ghaScriptInjection,
  ghaPwnRequest,
  ghaUnpinned,
  ghaUnpinnedFirstParty,
  ghaPermissions,
  ghaTimeout,
  dockerRoot,
  dockerLatest,
  dockerCurlPipe,
  dockerSecretEnv,
  composeRisks,
  templateXss,
  laravelEnvDebug,
  nextConfigRisks,
];

export const securityProjectRules: ProjectRule[] = [
  dockerCopyAll,
  envCommitted,
  envNotIgnored,
  publicEnvSecret,
];

void isScalar;
