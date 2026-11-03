import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BASELINE_FILE, type BaselineFile, gateFailed, type RunRecord, runAudit } from '../audit.js';
import type { CheckKind } from '../checks/exec.js';
import { diffSpecs, loadSpec, validateSpec } from '../contract/openapi.js';
import { defaultConfig, loadConfig } from '../core/config.js';
import { EXIT, RelivaroError } from '../core/errors.js';
import { CATEGORIES, type Category, SEVERITIES, SEVERITY_RANK, type Severity } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { atomicWrite, Workspace } from '../core/workspace.js';
import { whichSync } from '../exec/runner.js';
import { resolveActionRef } from '../fix/actions.js';
import { FIXERS, findFixer } from '../fix/fixers.js';
import { applyPlan, createPlan, history, loadPlan, rollback, verifyInPlace } from '../fix/workflow.js';
import { runGit } from '../fs/files.js';
import { grammarAssets, parse } from '../parse/treesitter.js';
import {
  benchCommand,
  benchSnapshots,
  compareStats,
  loadBaseline,
  loadTest,
  saveBench,
} from '../perf/bench.js';
import { assessRelease } from '../release/readiness.js';
import { compareRuns } from '../report/compare.js';
import { type HtmlExtras, toHtml } from '../report/html.js';
import { toMarkdown } from '../report/markdown.js';
import { remediationOf } from '../report/remediation.js';
import { toSarif } from '../report/sarif.js';
import {
  effectiveReview,
  type ReviewEntry,
  recordReview,
  reviewIndex,
  reviewSummary,
  VERDICTS,
} from '../review/review.js';
import { allRuleMeta, findRule } from '../rules/index.js';
import type { CommandSpec, OptSpec, Parsed } from './args.js';
import { clearProgress, findingLine, type Out, paint, printRunSummary, sevLabel } from './output.js';

export interface Command {
  spec: CommandSpec;
  run(p: Parsed, out: Out): Promise<number>;
}

const FORMATS = ['json', 'md', 'html', 'sarif'] as const;

const ANALYSIS_OPTS: OptSpec[] = [
  {
    name: 'online',
    type: 'boolean',
    description:
      'Query OSV.dev for known dependency vulnerabilities (sends package names and versions only).',
  },
  {
    name: 'allow-exec',
    type: 'boolean',
    description:
      'Allow running project commands (tests, build, type check, lint). They execute project code.',
  },
  {
    name: 'format',
    type: 'list',
    value: '<list>',
    choices: FORMATS,
    description: 'Report formats to write: json, md, html, sarif.',
    default: 'json,md,html',
  },
  { name: 'out', type: 'string', value: '<dir>', description: 'Also copy the reports to this directory.' },
  {
    name: 'fail-on',
    type: 'string',
    value: '<severity>',
    choices: [...SEVERITIES, 'none'],
    description:
      'Exit with code 1 when an open finding (medium/high confidence) is at or above this severity.',
  },
  {
    name: 'rule',
    type: 'list',
    value: '<ids>',
    description: 'Only run these rules (prefix with * suffix allowed, e.g. "sec/*").',
  },
  { name: 'config', type: 'string', value: '<file>', description: 'Path to relivaro.config.json.' },
  {
    name: 'workspace',
    type: 'string',
    value: '<dir>',
    description:
      'Where run data is stored (default: <project>/.relivaro). Use it to keep the analysed repository untouched.',
  },
  {
    name: 'baseline',
    type: 'string',
    value: '<file>',
    description: `Baseline file (default: ${BASELINE_FILE} if present).`,
  },
  { name: 'no-baseline', type: 'boolean', description: 'Ignore any baseline file.' },
  { name: 'no-git', type: 'boolean', description: 'Do not use git to list files (walk the tree instead).' },
  { name: 'no-write', type: 'boolean', description: 'Do not write run data or reports (stdout only).' },
  {
    name: 'max-findings',
    type: 'number',
    value: '<n>',
    description: 'Findings printed to the terminal.',
    default: 15,
  },
  {
    name: 'compact',
    type: 'boolean',
    description:
      'With --json: summary, open findings without rule boilerplate, checks, test gaps, release and limitations (for agents).',
  },
  { name: 'open', type: 'boolean', description: 'Open the HTML report with the default application.' },
];

function rootArg(p: Parsed): string {
  const r = resolve(p.positionals[0] ?? '.');
  if (!existsSync(r)) throw new RelivaroError('NOT_FOUND', `Path does not exist: ${r}`);
  return r;
}

/** Platform command that opens a file with the default application (shown to users and agents). */
export function openCommand(file: string): string {
  if (process.platform === 'darwin') return `open "${file}"`;
  if (process.platform === 'win32') return `start "" "${file}"`;
  return `xdg-open "${file}"`;
}

/** Opens a file with the default application without waiting for it; failures are reported, not thrown. */
function openFile(file: string): boolean {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['explorer.exe', [file]]
        : ['xdg-open', [file]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function groupBy<T>(items: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of items) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

/** Token-efficient view of a run for AI agents: no rule boilerplate, open findings only, short snippets. */
export function compactRun(
  run: RunRecord,
  maxFindings = 30,
  files: Record<string, string> = {},
  review: Record<string, ReviewEntry> = {},
) {
  const open = run.findings.filter((f) => f.status === 'open');
  const rem = new Map(open.map((f) => [f.id, remediationOf(f, review[f.id])]));
  const remCount = (k: string) => open.filter((f) => rem.get(f.id)!.kind === k).length;
  return {
    runId: run.runId,
    command: run.command,
    project: {
      name: run.profile.name,
      units: run.profile.units.map((u) => `${u.path}: ${u.frameworks.join('/') || u.kind}`),
      languages: run.profile.languages.slice(0, 6).map((l) => `${l.name} (${l.files})`),
      technologies: [...new Set(run.profile.technologies.map((t) => t.name))],
    },
    summary: run.summary,
    findings: open.slice(0, maxFindings).map((f) => ({
      id: f.id,
      rule: f.ruleId,
      severity: f.severity,
      confidence: f.confidence,
      where: f.location ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}` : undefined,
      message: f.message,
      fixer: f.fixer,
      remediation: rem.get(f.id)!.kind,
      review: review[f.id]?.verdict,
      snippet:
        SEVERITY_RANK[f.severity] >= SEVERITY_RANK.medium
          ? f.evidence.snippet?.split('\n').slice(0, 3).join('\n')
          : undefined,
      output: f.evidence.output?.split('\n').slice(-8).join('\n'),
    })),
    omittedFindings: Math.max(0, open.length - maxFindings),
    // Every open finding, grouped by rule (root cause): enough to prioritise without reading each finding.
    groups: [...groupBy(open, (f) => f.ruleId)]
      .map(([rule, fs]) => ({
        rule,
        title: fs[0]!.title,
        count: fs.length,
        severity: fs[0]!.severity,
        remediation: rem.get(fs[0]!.id)!.kind,
        reviewed: fs.filter((f) => review[f.id]).length,
        where: [...new Set(fs.map((f) => f.location?.file).filter(Boolean))].slice(0, 3),
        ids: fs.slice(0, 12).map((f) => f.id),
      }))
      .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.count - a.count),
    checks: run.checks.map((c) => ({
      kind: c.kind,
      unit: c.unit,
      status: c.status,
      tests: c.tests,
      reason: c.reason,
    })),
    testGaps: run.testGaps.slice(0, 10),
    release: run.release && {
      status: run.release.status,
      score: run.release.score,
      blockers: run.release.blockers,
      warnings: run.release.warnings,
      unverified: run.release.unverified,
    },
    remediation: {
      deterministic: remCount('deterministic'),
      agent: remCount('agent'),
      manual: remCount('manual'),
    },
    review: reviewSummary(run, review),
    limitations: run.limitations,
    reports: `.relivaro/runs/${run.runId}/ (rule details: relivaro rules show <rule>)`,
    ...(files.html
      ? { report: { html: files.html, open: openCommand(files.html), markdown: files.md } }
      : {}),
  };
}

/** Context for the HTML dashboard: the previous run of this project, measured benchmarks and fix history. */
function htmlExtras(ws: Workspace, run: RunRecord, review: Record<string, ReviewEntry>): HtmlExtras {
  const runs = ws.listRuns();
  const prevId = runs[runs.indexOf(run.runId) - 1];
  const prev = prevId ? ws.readJson<RunRecord>(['runs', prevId, 'run.json']) : undefined;
  const fixes = history(ws).filter((r) => r.root === run.root);
  return {
    review,
    comparison: prev ? compareRuns(prev, run) : undefined,
    bench: benchSnapshots(ws),
    fixes: fixes.length
      ? {
          applied: fixes.filter((r) => r.state !== 'failed' && !r.rolledBackAt).length,
          verified: fixes.filter((r) => r.verification.verdict === 'verified' && !r.rolledBackAt).length,
          rolledBack: fixes.filter((r) => r.rolledBackAt).length,
        }
      : undefined,
  };
}

function writeReports(
  ws: Workspace,
  run: RunRecord,
  formats: string[],
  outDir?: string,
): Record<string, string> {
  const files: Record<string, string> = {};
  ws.writeJson(['runs', run.runId, 'run.json'], run);
  const review = effectiveReview(ws, run);
  const render: Record<string, () => [string, string]> = {
    json: () => ['report.json', `${JSON.stringify(run, null, 2)}\n`],
    md: () => ['report.md', toMarkdown(run, { review })],
    html: () => ['report.html', toHtml(run, htmlExtras(ws, run, review))],
    sarif: () => ['report.sarif', `${JSON.stringify(toSarif(run), null, 2)}\n`],
  };
  for (const f of formats) {
    const r = render[f];
    if (!r) continue;
    const [name, content] = r();
    files[f] = ws.writeText(['runs', run.runId, name], content);
    if (outDir) {
      const dest = join(resolve(outDir), name);
      atomicWrite(dest, content);
      files[f] = dest;
    }
  }
  return files;
}

async function analysisCommand(
  p: Parsed,
  out: Out,
  cfg: { command: string; categories: Category[]; checks: CheckKind[]; release?: boolean },
): Promise<number> {
  const root = rootArg(p);
  const cats = (p.opts.category as Category[] | undefined)?.length
    ? (p.opts.category as Category[])
    : cfg.categories;
  const checks = cfg.checks;
  const { run, config, workspace } = await runAudit({
    root,
    command: cfg.command,
    categories: cats,
    rules: p.opts.rule as string[] | undefined,
    online: !!p.opts.online,
    allowExec: !!p.opts['allow-exec'],
    checks,
    configPath: p.opts.config as string | undefined,
    workspace: p.opts.workspace as string | undefined,
    baseline: p.opts['no-baseline'] ? false : (p.opts.baseline as string | undefined),
    release: cfg.release,
    useGit: p.opts['no-git'] ? false : undefined,
    noWrite: !!p.opts['no-write'],
    onProgress: out.progress,
  });
  if (cfg.release) run.release = assessRelease(run, config, benchSnapshots(workspace));
  clearProgress();
  const formats = (p.opts.format as string[] | undefined) ?? ['json', 'md', 'html'];
  const files = p.opts['no-write']
    ? {}
    : writeReports(
        workspace,
        run,
        Array.isArray(formats) ? formats : String(formats).split(','),
        p.opts.out as string | undefined,
      );
  if (out.json)
    out.print(
      // Compact output is for agents: unindented, so a large run stays small enough to read in one go.
      p.opts.compact
        ? JSON.stringify(
            compactRun(run, 30, files, p.opts['no-write'] ? {} : effectiveReview(workspace, run)),
          )
        : JSON.stringify(run, null, 2),
    );
  else printRunSummary(out, run, files, Number(p.opts['max-findings'] ?? 15), openCommand);
  if (p.opts.open && files.html) openFile(files.html);
  const failOn = (p.opts['fail-on'] as Severity | 'none' | undefined) ?? config.failOn;
  if (cfg.release && run.release) {
    if (run.release.status === 'not-ready') return EXIT.GATE_FAILED;
    if (p.opts.strict && run.release.status !== 'ready' && run.release.status !== 'ready-with-warnings')
      return EXIT.GATE_FAILED;
  }
  return gateFailed(run, failOn) ? EXIT.GATE_FAILED : EXIT.OK;
}

const categoryOpt: OptSpec = {
  name: 'category',
  type: 'list',
  value: '<list>',
  choices: CATEGORIES,
  description: `Restrict to categories: ${CATEGORIES.join(', ')}.`,
};

function analysis(
  name: string,
  summary: string,
  description: string,
  categories: Category[],
  checks: CheckKind[],
  extra: OptSpec[] = [],
  release = false,
): Command {
  return {
    spec: {
      name,
      summary,
      usage: `relivaro ${name} [path] [options]`,
      description,
      positionals: ['path'],
      options: [...(name === 'audit' ? [categoryOpt] : []), ...ANALYSIS_OPTS, ...extra],
      examples: [
        `relivaro ${name}`,
        `relivaro ${name} ../my-app --online --format sarif --out reports`,
        `relivaro ${name} . --allow-exec --fail-on high`,
      ],
    },
    run: (p, out) => analysisCommand(p, out, { command: name, categories, checks, release }),
  };
}

// ---------------------------------------------------------------------------------------------------------------

const discoverCmd: Command = {
  spec: {
    name: 'discover',
    summary: 'Show what Relivaro understands about a project',
    usage: 'relivaro discover [path] [--json]',
    positionals: ['path'],
    options: [{ name: 'no-git', type: 'boolean', description: 'Do not use git to list files.' }],
  },
  async run(p, out) {
    const { FileSet } = await import('../fs/files.js');
    const { discover } = await import('../intel/discover.js');
    const root = rootArg(p);
    const { config } = loadConfig(root);
    const files = new FileSet(root, {
      include: config.include,
      exclude: config.exclude,
      useGit: p.opts['no-git'] ? false : undefined,
    });
    const profile = discover(files);
    if (out.json) {
      out.print(
        JSON.stringify(
          {
            ...profile,
            manifests: profile.manifests.map((m) => ({ ...m, deps: m.deps.length })),
            lockfiles: profile.lockfiles.map((l) => ({
              file: l.file,
              ecosystem: l.ecosystem,
              packages: l.packages.length,
            })),
          },
          null,
          2,
        ),
      );
      return EXIT.OK;
    }
    const on = out.color;
    out.print(
      paint(on, 'bold', `${profile.name}`) +
        paint(
          on,
          'gray',
          ` — ${profile.stats.files} files${profile.gitRepo ? ', git' : ''}${profile.monorepo ? ', monorepo' : ''}`,
        ),
    );
    out.print(
      `Languages: ${profile.languages
        .slice(0, 10)
        .map((l) => `${l.name} ${l.files}f/${l.lines}l`)
        .join(', ')}`,
    );
    out.print('Units:');
    for (const u of profile.units)
      out.print(
        `  ${u.path.padEnd(28)} ${u.kind.padEnd(13)} ${u.frameworks.join(', ') || '-'}${u.staticExport ? ' (static export)' : ''}${u.packageManager ? paint(on, 'gray', ` (${u.packageManager})`) : ''}${paint(on, 'gray', ` ${u.sourceFiles} src / ${u.testFiles} test`)}`,
      );
    const byKind = new Map<string, string[]>();
    for (const t of profile.technologies)
      byKind.set(t.kind, [...new Set([...(byKind.get(t.kind) ?? []), t.name])]);
    for (const [k, v] of byKind) out.print(`${k.padEnd(14)} ${v.join(', ')}`);
    out.print(
      `CI:            ${profile.ci.map((c) => `${c.system} (${c.file}${c.runsTests ? ', tests' : ''})`).join('; ') || 'none'}`,
    );
    out.print(
      `Deploy:        ${profile.deploy.map((d) => `${d.kind} (${d.file})`).join('; ') || 'none'}${profile.containers.dockerfiles.length ? `; Docker: ${profile.containers.dockerfiles.join(', ')}` : ''}`,
    );
    out.print(
      `API:           ${profile.api.routes} routes in ${profile.api.routeFiles.length} files${profile.api.specs.length ? `; specs: ${profile.api.specs.join(', ')}` : ''}`,
    );
    out.print(
      `Tests:         ${profile.tests.testFiles} test files (${profile.tests.frameworks.join(', ') || 'no framework detected'})${profile.tests.e2e.length ? `; e2e: ${profile.tests.e2e.length}` : ''}`,
    );
    out.print(
      `Env vars:      ${profile.envVars.length} read by code; templates: ${profile.envTemplates.join(', ') || 'none'}`,
    );
    const undocumented = profile.envVars.filter((v) => v.required && !v.documented);
    if (undocumented.length)
      out.print(
        paint(
          on,
          'yellow',
          `               undocumented required: ${undocumented
            .map((v) => v.name)
            .slice(0, 20)
            .join(', ')}`,
        ),
      );
    out.print(`Migrations:    ${profile.migrations.length}`);
    out.print(
      `Docs:          ${[profile.docs.readme, profile.docs.license, profile.docs.changelog, profile.docs.contributing, profile.docs.security].filter(Boolean).join(', ') || 'none'}`,
    );
    return EXIT.OK;
  },
};

const reportCmd: Command = {
  spec: {
    name: 'report',
    summary: 'Re-render a stored run in other formats',
    usage: 'relivaro report [run-id|latest] [--path <project>] [--format md,html,sarif,json] [--out dir]',
    positionals: ['run'],
    options: [
      { name: 'path', type: 'string', value: '<dir>', description: 'Project directory (default: .).' },
      { name: 'workspace', type: 'string', value: '<dir>', description: 'Workspace directory.' },
      {
        name: 'format',
        type: 'list',
        value: '<list>',
        choices: FORMATS,
        description: 'Formats to write.',
        default: 'md,html',
      },
      { name: 'out', type: 'string', value: '<dir>', description: 'Output directory.' },
      { name: 'open', type: 'boolean', description: 'Open the HTML report with the default application.' },
    ],
  },
  async run(p, out) {
    const ws = new Workspace(resolve((p.opts.path as string) ?? '.'), p.opts.workspace as string | undefined);
    const id = ws.resolveRun(p.positionals[0] ?? 'latest');
    const run = ws.readJson<RunRecord>(['runs', id, 'run.json'])!;
    const formats = p.opts.format as string[];
    const files = writeReports(
      ws,
      run,
      p.opts.open && !formats.includes('html') ? [...formats, 'html'] : formats,
      p.opts.out as string | undefined,
    );
    const opened = p.opts.open && files.html ? openFile(files.html) : false;
    if (out.json)
      out.print(
        JSON.stringify(
          { runId: id, files, ...(files.html ? { open: openCommand(files.html), opened } : {}) },
          null,
          2,
        ),
      );
    else {
      for (const [k, v] of Object.entries(files)) out.print(`${k.padEnd(6)} ${v}`);
      if (files.html && !opened) out.print(paint(out.color, 'gray', `Open: ${openCommand(files.html)}`));
    }
    return EXIT.OK;
  },
};

const compareCmd: Command = {
  spec: {
    name: 'compare',
    summary: 'Compare two runs: introduced, resolved and persisting findings, check regressions',
    usage: 'relivaro compare [base=previous] [head=latest] [--path <project>] [--fail-on <severity>]',
    positionals: ['base', 'head'],
    options: [
      { name: 'path', type: 'string', value: '<dir>', description: 'Project directory (default: .).' },
      { name: 'workspace', type: 'string', value: '<dir>', description: 'Workspace directory.' },
      {
        name: 'fail-on',
        type: 'string',
        value: '<severity>',
        choices: [...SEVERITIES, 'none'],
        description: 'Exit 1 if an introduced finding is at or above this severity, or a check regressed.',
        default: 'none',
      },
    ],
  },
  async run(p, out) {
    const ws = new Workspace(resolve((p.opts.path as string) ?? '.'), p.opts.workspace as string | undefined);
    const base = ws.readJson<RunRecord>(['runs', ws.resolveRun(p.positionals[0] ?? 'previous'), 'run.json'])!;
    const head = ws.readJson<RunRecord>(['runs', ws.resolveRun(p.positionals[1] ?? 'latest'), 'run.json'])!;
    const c = compareRuns(base, head);
    if (out.json) out.print(JSON.stringify(c, null, 2));
    else {
      const on = out.color;
      out.print(`${paint(on, 'bold', 'Compare')} ${c.base.runId} → ${c.head.runId}`);
      out.print(
        `Open findings ${c.base.open} → ${c.head.open}: ${paint(on, 'red', `+${c.introduced.length} introduced`)}, ${paint(on, 'green', `-${c.resolved.length} resolved`)}, ${c.persisting} persisting`,
      );
      if (c.releaseChange)
        out.print(
          `Release: ${c.releaseChange.from} (${c.releaseChange.scoreFrom}) → ${c.releaseChange.to} (${c.releaseChange.scoreTo})`,
        );
      for (const r of c.checkRegressions) out.print(paint(on, 'red', `  regression: ${r}`));
      for (const r of c.checkImprovements) out.print(paint(on, 'green', `  improved: ${r}`));
      if (c.introduced.length) out.print(paint(on, 'bold', '\nIntroduced:'));
      for (const f of c.introduced.slice(0, 20)) out.print(findingLine(on, f));
      if (c.resolved.length) out.print(paint(on, 'bold', '\nResolved:'));
      for (const f of c.resolved.slice(0, 20))
        out.print(`  ${sevLabel(on, f.severity)} ${f.title} ${paint(on, 'gray', f.location?.file ?? '')}`);
    }
    const failOn = p.opts['fail-on'] as Severity | 'none';
    if (
      failOn !== 'none' &&
      (c.checkRegressions.length ||
        c.introduced.some(
          (f) => SEVERITIES.indexOf(f.severity) <= SEVERITIES.indexOf(failOn) && f.confidence !== 'low',
        ))
    )
      return EXIT.GATE_FAILED;
    return EXIT.OK;
  },
};

/** Loads a stored run and checks that it belongs to the project directory the user named. */
function storedRun(ws: Workspace, projectDir: string, idOrAlias: string): RunRecord {
  const id = ws.resolveRun(idOrAlias);
  const run = ws.readJson<RunRecord>(['runs', id, 'run.json'])!;
  if (!samePath(run.root, projectDir))
    throw new RelivaroError(
      'USAGE',
      `Run ${id} belongs to ${run.root}, not ${projectDir}.`,
      'Pass --path <project> (and --workspace) for the project the run came from.',
    );
  return run;
}

function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

const reviewCmd: Command = {
  spec: {
    name: 'review',
    summary:
      'Record verified verdicts (confirmed, false positive, needs runtime, accepted risk) for findings of a run',
    usage: 'relivaro review <add|list> [--finding <ids>] [--verdict <v>] [--reason <text>] [options]',
    description: [
      'Subcommands:',
      '  add    Record a verdict for one or more findings of a run (one justification for all of them)',
      '  list   Show the recorded verdicts of a run',
      '',
      'Verdicts are stored in runs/<run>/review.json next to the run and never change the original findings.',
      'Reports re-render with the reviewed state: raw detection and reviewed conclusion side by side. Record only',
      'what was actually checked in the code; unreviewed findings stay "detected".',
    ].join('\n'),
    positionals: ['subcommand'],
    subcommands: ['add', 'list'],
    options: [
      { name: 'finding', type: 'list', value: '<ids>', description: 'add: finding id(s) of the run.' },
      {
        name: 'verdict',
        type: 'string',
        value: '<verdict>',
        choices: VERDICTS,
        description:
          'add: confirmed, false-positive, needs-runtime or accepted (an explicitly accepted risk).',
      },
      {
        name: 'reason',
        type: 'string',
        value: '<text>',
        description: 'add: short justification (required).',
      },
      {
        name: 'evidence',
        type: 'list',
        value: '<file:line>',
        description: 'add: code locations that support the verdict (project-relative).',
      },
      {
        name: 'severity',
        type: 'string',
        value: '<severity>',
        choices: SEVERITIES,
        description: 'add: severity the reviewer considers appropriate, if different.',
      },
      {
        name: 'reviewer',
        type: 'string',
        value: '<name>',
        description: 'add: who reviewed (e.g. "claude-code", a person\'s handle). Default: agent.',
      },
      { name: 'human', type: 'boolean', description: 'add: the reviewer is a person, not an AI agent.' },
      { name: 'run', type: 'string', value: '<id>', description: 'Run id or alias.', default: 'latest' },
      { name: 'path', type: 'string', value: '<dir>', description: 'Project directory (default: .).' },
      { name: 'workspace', type: 'string', value: '<dir>', description: 'Workspace directory.' },
    ],
    examples: [
      'relivaro review add --finding RLV-3f9a1c2b --verdict confirmed --reason "user input reaches the query" --evidence src/db.ts:42',
      'relivaro review add --finding RLV-1,RLV-2 --verdict false-positive --reason "test fixture, never deployed"',
      'relivaro review list --json',
    ],
  },
  async run(p, out) {
    const sub = p.positionals[0];
    const projectDir = resolve((p.opts.path as string) ?? '.');
    const ws = new Workspace(projectDir, p.opts.workspace as string | undefined);
    const run = storedRun(ws, projectDir, (p.opts.run as string) ?? 'latest');
    if (sub === 'add') {
      const file = recordReview(ws, run, {
        findingIds: (p.opts.finding as string[] | undefined) ?? [],
        verdict: String(p.opts.verdict ?? ''),
        justification: String(p.opts.reason ?? ''),
        evidence: p.opts.evidence as string[] | undefined,
        severity: p.opts.severity as string | undefined,
        reviewer: p.opts.reviewer as string | undefined,
        human: !!p.opts.human,
      });
      // Re-render the reports this run already has, so the HTML shows the reviewed state immediately.
      const formats = (['html', 'md'] as const).filter((f) =>
        existsSync(ws.path('runs', run.runId, f === 'html' ? 'report.html' : 'report.md')),
      );
      const files = formats.length ? writeReports(ws, run, [...formats]) : {};
      const summary = reviewSummary(run, { ...effectiveReview(ws, run), ...reviewIndex(run, file) });
      if (out.json)
        out.print(
          JSON.stringify(
            { runId: run.runId, review: ws.path('runs', run.runId, 'review.json'), summary, files },
            null,
            2,
          ),
        );
      else {
        out.print(
          `Recorded ${new Set(p.opts.finding as string[]).size} review(s) for run ${run.runId}: ${summary.confirmed} confirmed, ${summary.falsePositive} false positive, ${summary.needsRuntime} need runtime verification, ${summary.accepted} accepted, ${summary.unreviewed} not reviewed.`,
        );
        if (files.html) out.print(`HTML report updated: ${files.html}`);
      }
      return EXIT.OK;
    }
    if (sub === 'list') {
      const index = effectiveReview(ws, run);
      const entries = Object.values(index);
      if (out.json)
        out.print(JSON.stringify({ runId: run.runId, summary: reviewSummary(run, index), entries }, null, 2));
      else if (!entries.length) out.print(`No reviews recorded for run ${run.runId}.`);
      else
        for (const e of entries)
          out.print(
            `${e.findingId}  ${e.verdict.padEnd(14)} ${e.ruleId}  ${paint(out.color, 'gray', `${e.reviewer.name}${e.carriedFrom ? ` (run ${e.carriedFrom})` : ''}: ${e.justification}`)}`,
          );
      return EXIT.OK;
    }
    throw new RelivaroError('USAGE', `Unknown review subcommand "${sub ?? ''}".`, 'Use one of: add, list.');
  },
};

const recheckCmd: Command = {
  spec: {
    name: 'recheck',
    summary: 'Re-check findings of an earlier run against the current source before repairing them',
    usage: 'relivaro recheck [path] --finding <ids> [--run <id>]',
    description:
      'Re-runs only the rules behind the given findings and reports each one as present (same place), moved (same code, other line) or gone (fixed, or the code changed). Use it before editing code for findings taken from a report or a prompt.',
    positionals: ['path'],
    options: [
      { name: 'finding', type: 'list', value: '<ids>', description: 'Finding ids from the run (required).' },
      {
        name: 'run',
        type: 'string',
        value: '<id>',
        description: 'Run the ids came from.',
        default: 'latest',
      },
      { name: 'workspace', type: 'string', value: '<dir>', description: 'Workspace directory.' },
    ],
    examples: ['relivaro recheck . --finding RLV-3f9a1c2b,RLV-7fb00c34 --run 20261101-120000-abc123'],
  },
  async run(p, out) {
    const root = rootArg(p);
    const ws = new Workspace(root, p.opts.workspace as string | undefined);
    const run = storedRun(ws, root, (p.opts.run as string) ?? 'latest');
    const ids = [...new Set((p.opts.finding as string[] | undefined) ?? [])];
    if (!ids.length) throw new RelivaroError('USAGE', 'Name the findings to re-check with --finding <ids>.');
    const unknown = ids.filter((id) => !run.findings.some((f) => f.id === id));
    if (unknown.length)
      throw new RelivaroError(
        'NOT_FOUND',
        `Finding(s) not in run ${run.runId}: ${unknown.join(', ')}.`,
        'Use the run the ids came from (--run).',
      );
    const before = ids.map((id) => run.findings.find((f) => f.id === id)!);
    const { run: now } = await runAudit({
      root,
      command: 'recheck',
      rules: [...new Set(before.map((f) => f.ruleId))],
      noWrite: true,
      onProgress: out.progress,
    });
    clearProgress();
    const where = (f?: { location?: { file: string; line?: number } }) =>
      f?.location ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}` : undefined;
    const results = before.map((f) => {
      const cur = now.findings.find((x) => x.fingerprint === f.fingerprint);
      const status = !cur ? 'gone' : cur.location?.line !== f.location?.line ? 'moved' : 'present';
      return { id: f.id, rule: f.ruleId, status, was: where(f), now: where(cur), findingStatus: cur?.status };
    });
    if (out.json) out.print(JSON.stringify({ runId: run.runId, results }, null, 2));
    else {
      for (const r of results)
        out.print(
          `${r.id}  ${(r.status === 'gone' ? paint(out.color, 'green', 'gone') : paint(out.color, 'yellow', r.status)).padEnd(7)}  ${r.rule}  ${r.now ?? r.was ?? ''}${r.status === 'moved' ? paint(out.color, 'gray', ` (was ${r.was})`) : ''}`,
        );
      if (results.some((r) => r.status === 'gone'))
        out.print(
          paint(
            out.color,
            'gray',
            '"gone" = not produced by the current source: fixed, or the code changed (re-audit for new ids).',
          ),
        );
    }
    return EXIT.OK;
  },
};

const baselineCmd: Command = {
  spec: {
    name: 'baseline',
    summary: 'Accept current findings as a baseline so only new findings fail gates',
    usage: 'relivaro baseline [path] [--reason <text>] [--from <run-id>]',
    description: `Writes ${BASELINE_FILE} (fingerprints only, no code or secrets) to the project root. Commit it to share the baseline. Baseline findings remain visible in reports.`,
    positionals: ['path'],
    options: [
      {
        name: 'reason',
        type: 'string',
        value: '<text>',
        description: 'Justification stored with every entry.',
      },
      {
        name: 'from',
        type: 'string',
        value: '<run>',
        description: 'Use findings of this stored run instead of running a new audit.',
      },
      { name: 'workspace', type: 'string', value: '<dir>', description: 'Workspace directory.' },
      {
        name: 'output',
        type: 'string',
        value: '<file>',
        description: `Baseline file path (default: <path>/${BASELINE_FILE}).`,
      },
    ],
  },
  async run(p, out) {
    const root = rootArg(p);
    let run: RunRecord;
    if (p.opts.from) {
      const ws = new Workspace(root, p.opts.workspace as string | undefined);
      run = ws.readJson<RunRecord>(['runs', ws.resolveRun(p.opts.from as string), 'run.json'])!;
    } else
      run = (
        await runAudit({
          root,
          command: 'baseline',
          baseline: false,
          noWrite: true,
          onProgress: out.progress,
        })
      ).run;
    clearProgress();
    const b: BaselineFile = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      fingerprints: run.findings
        .filter((f) => f.status !== 'suppressed')
        .map((f) => ({
          fingerprint: f.fingerprint,
          ruleId: f.ruleId,
          file: f.location?.file,
          reason: p.opts.reason as string | undefined,
        })),
    };
    const file = resolve((p.opts.output as string) ?? join(root, BASELINE_FILE));
    atomicWrite(file, `${JSON.stringify(b, null, 2)}\n`);
    if (out.json) out.print(JSON.stringify({ file, entries: b.fingerprints.length }));
    else out.print(`Baseline with ${b.fingerprints.length} findings written to ${file}`);
    return EXIT.OK;
  },
};

// ---------------------------------------------------------------------------------------------------------------

const fixCmd: Command = {
  spec: {
    name: 'fix',
    summary: 'Plan, apply, verify and roll back deterministic fixes',
    usage: 'relivaro fix <list|plan|show|apply|rollback|history> [args] [options]',
    description: [
      'Subcommands:',
      '  list [path]                 Fixable findings in the project',
      '  plan [path]                 Generate a fix plan with diffs (no files are changed)',
      '  show [plan-id|latest]       Print a plan and its diffs',
      '  apply [plan-id|latest]      Apply a plan (requires --yes); verifies first',
      '  rollback [apply-id|latest]  Restore files from the backup of an applied fix',
      '  history                     List applied fixes',
      '',
      'Apply verifies every change statically (the targeted findings disappear and no new findings appear) and,',
      'with --verify "<command>" --allow-exec, runs the command in an isolated copy of the project before and',
      'after the change. The working tree is modified only if verification passes. Rollback refuses to overwrite',
      'files edited after the fix unless --force is given.',
    ].join('\n'),
    positionals: ['subcommand', 'arg'],
    subcommands: ['list', 'plan', 'show', 'apply', 'rollback', 'history'],
    options: [
      { name: 'finding', type: 'list', value: '<ids>', description: 'plan/apply: only these finding ids.' },
      { name: 'rule', type: 'list', value: '<ids>', description: 'plan: only findings of these rules.' },
      { name: 'fixer', type: 'list', value: '<ids>', description: 'plan: only these fixers.' },
      {
        name: 'include-review',
        type: 'boolean',
        description: 'plan: include fixers that intentionally change behaviour (marked "review").',
        default: true,
      },
      {
        name: 'online',
        type: 'boolean',
        description:
          "plan: allow fixers that need the network (gha-pin-action resolves tags to commit SHAs from the action's GitHub repository).",
      },
      { name: 'yes', type: 'boolean', short: 'y', description: 'apply: confirm modifying the working tree.' },
      {
        name: 'verify',
        type: 'string',
        value: '<command>',
        description: 'apply: command that must pass after the fix (e.g. "npm test").',
      },
      { name: 'allow-exec', type: 'boolean', description: 'apply: allow running the verification command.' },
      {
        name: 'no-isolate',
        type: 'boolean',
        description:
          'apply: run verification in the working tree (auto-rollback on failure) instead of a temporary copy.',
      },
      {
        name: 'force',
        type: 'boolean',
        description: 'rollback: restore backups even if files changed after the fix.',
      },
      {
        name: 'path',
        type: 'string',
        value: '<dir>',
        description: 'Project directory for show/apply/rollback/history (default: .).',
      },
      { name: 'workspace', type: 'string', value: '<dir>', description: 'Workspace directory.' },
    ],
    examples: [
      'relivaro fix plan',
      'relivaro fix show latest',
      'relivaro fix apply latest --yes --verify "npm test" --allow-exec',
      'relivaro fix rollback latest',
    ],
  },
  async run(p, out) {
    const sub = p.positionals[0];
    const arg = p.positionals[1];
    const on = out.color;
    const projectDir = resolve(
      (p.opts.path as string) ?? (sub === 'list' || sub === 'plan' ? (arg ?? '.') : '.'),
    );
    const ws = new Workspace(projectDir, p.opts.workspace as string | undefined);
    if (sub === 'list' || sub === 'plan') {
      const { run } = await runAudit({
        root: projectDir,
        command: `fix ${sub}`,
        noWrite: true,
        onProgress: out.progress,
      });
      clearProgress();
      let fixable = run.findings.filter((f) => f.status === 'open' && f.fixer && findFixer(f.fixer));
      const fids = p.opts.finding as string[] | undefined;
      // Finding ids come from an earlier run; say which ones the current source no longer produces.
      const stale = (fids ?? []).filter((id) => !run.findings.some((f) => f.id === id));
      const notFixable = (fids ?? []).filter(
        (id) => !stale.includes(id) && !fixable.some((f) => f.id === id),
      );
      const rules = p.opts.rule as string[] | undefined;
      const fixers = p.opts.fixer as string[] | undefined;
      if (fids?.length) fixable = fixable.filter((f) => fids.includes(f.id));
      if (rules?.length) fixable = fixable.filter((f) => rules.includes(f.ruleId));
      if (fixers?.length) fixable = fixable.filter((f) => fixers.includes(f.fixer!));
      if (p.opts['include-review'] === false)
        fixable = fixable.filter((f) => findFixer(f.fixer!)!.safety === 'safe');
      if (sub === 'list') {
        if (out.json)
          out.print(
            JSON.stringify(
              fixable.map((f) => ({
                id: f.id,
                ruleId: f.ruleId,
                fixer: f.fixer,
                safety: findFixer(f.fixer!)!.safety,
                location: f.location,
                message: f.message,
              })),
              null,
              2,
            ),
          );
        else {
          out.print(`${fixable.length} fixable finding(s):`);
          for (const f of fixable)
            out.print(
              `${findingLine(on, f)}\n         ${paint(on, 'green', `fixer: ${f.fixer} (${findFixer(f.fixer!)!.safety})`)}`,
            );
        }
        return EXIT.OK;
      }
      const notes = [
        ...stale.map((id) => `${id}: not found in the current source (already fixed or changed); re-audit`),
        ...notFixable.map((id) => `${id}: open, but no automated fixer applies; fix it manually`),
      ];
      if (!fixable.length) {
        if (out.json) out.print(JSON.stringify({ planId: null, items: [], notes }));
        else {
          out.print('Nothing to fix: no open finding has an automated fixer.');
          for (const n of notes) out.print(paint(on, 'yellow', `  ${n}`));
        }
        return EXIT.OK;
      }
      const online = !!p.opts.online;
      if (online) out.progress('resolving GitHub Action tags (git ls-remote)');
      const plan = await createPlan(
        projectDir,
        fixable,
        ws,
        online ? { resolveAction: resolveActionRef } : {},
      );
      clearProgress();
      if (out.json) out.print(JSON.stringify(notes.length ? { ...plan, notes } : plan, null, 2));
      else {
        printPlan(out, plan);
        for (const n of notes) out.print(paint(on, 'yellow', `  ${n}`));
      }
      return EXIT.OK;
    }
    if (sub === 'show') {
      const plan = loadPlan(ws, arg ?? 'latest');
      if (out.json) out.print(JSON.stringify(plan, null, 2));
      else printPlan(out, plan);
      return EXIT.OK;
    }
    if (sub === 'apply') {
      const plan = loadPlan(ws, arg ?? 'latest');
      const { config } = loadConfig(plan.root);
      const isolate = !p.opts['no-isolate'];
      const verify = p.opts.verify as string | undefined;
      let rec = await applyPlan(ws, plan, {
        only: p.opts.finding as string[] | undefined,
        yes: !!p.opts.yes,
        verifyCommand: isolate ? verify : undefined,
        allowExec: !!p.opts['allow-exec'],
        isolate,
        timeoutSeconds: config.timeouts.commandSeconds,
        onProgress: out.progress,
      });
      if (!isolate && verify) {
        if (!p.opts['allow-exec'])
          throw new RelivaroError(
            'EXEC_NOT_ALLOWED',
            'Running a verification command requires --allow-exec.',
          );
        rec = await verifyInPlace(ws, rec, verify, config.timeouts.commandSeconds);
      }
      clearProgress();
      if (out.json) out.print(JSON.stringify(rec, null, 2));
      else {
        out.print(
          paint(on, 'green', `Applied ${rec.items.length} fix(es) to ${rec.files.length} file(s).`) +
            ` Apply id: ${rec.applyId}`,
        );
        for (const f of rec.files) out.print(`  ${f.path}`);
        const v = rec.verification;
        out.print(
          `Verification: ${v.verdict}${v.command ? ` — \`${v.command.command}\` exit ${v.command.after.exitCode}${v.command.isolated ? ' (isolated copy)' : ''}${v.command.before ? `, before fix exit ${v.command.before.exitCode}` : ''}` : ''}`,
        );
        out.print(
          `  resolved: ${v.static.resolved.length}, still present: ${v.static.unresolved.length}, introduced: ${v.static.introduced.length}${v.static.unverifiable?.length ? `, not re-checkable statically: ${v.static.unverifiable.length}` : ''}`,
        );
        for (const n of v.notes) out.print(paint(on, 'gray', `  ${n}`));
        out.print(`Roll back with: relivaro fix rollback ${rec.applyId}`);
      }
      return EXIT.OK;
    }
    if (sub === 'rollback') {
      const rec = rollback(ws, arg ?? 'latest', !!p.opts.force);
      if (out.json) out.print(JSON.stringify(rec, null, 2));
      else {
        out.print(`Rolled back ${rec.applyId}: restored ${rec.files.length} file(s).`);
        if (rec.preserved?.length)
          out.print(
            `Your later edits to ${rec.preserved.join(', ')} were saved in ${ws.path('fixes', rec.applyId, 'conflicts')}.`,
          );
      }
      return EXIT.OK;
    }
    if (sub === 'history') {
      const h = history(ws);
      if (out.json) out.print(JSON.stringify(h, null, 2));
      else if (!h.length) out.print('No fixes applied yet.');
      else
        for (const r of h)
          out.print(
            `${r.applyId}  ${r.appliedAt}  ${r.items.length} fix(es), ${r.files.length} file(s), verification ${r.verification.verdict}${r.state === 'applying' ? paint(on, 'red', ', interrupted (run `relivaro fix rollback` to restore)') : r.state === 'failed' ? paint(on, 'yellow', ', write failed and was undone') : ''}${r.rolledBackAt && r.state !== 'failed' ? paint(on, 'yellow', `, rolled back ${r.rolledBackAt}`) : ''}`,
          );
      return EXIT.OK;
    }
    throw new RelivaroError(
      'USAGE',
      `Unknown fix subcommand "${sub ?? ''}".`,
      'Use one of: list, plan, show, apply, rollback, history.',
    );
  },
};

function printPlan(out: Out, plan: Awaited<ReturnType<typeof createPlan>>) {
  const on = out.color;
  out.print(
    `${paint(on, 'bold', `Fix plan ${plan.planId}`)}: ${plan.items.length} fix(es) in ${plan.files.length} file(s)`,
  );
  for (const i of plan.items)
    out.print(
      `  ${i.safety === 'safe' ? paint(on, 'green', 'safe  ') : paint(on, 'yellow', 'review')} ${i.findingId} ${i.title} — ${i.file}${i.line ? `:${i.line}` : ''}${(
        i.pins ?? []
      )
        .map((x) => paint(on, 'gray', `\n         ${x.action}@${x.ref} → ${x.sha} (${x.source})`))
        .join('')}`,
    );
  for (const s of plan.skipped) out.print(paint(on, 'gray', `  skipped ${s.findingId}: ${s.reason}`));
  for (const f of plan.files) {
    out.print('');
    for (const l of f.diff.trimEnd().split('\n'))
      out.print(
        l.startsWith('+') && !l.startsWith('+++')
          ? paint(on, 'green', l)
          : l.startsWith('-') && !l.startsWith('---')
            ? paint(on, 'red', l)
            : l.startsWith('@@')
              ? paint(on, 'cyan', l)
              : l,
      );
  }
  out.print('');
  out.print(`Apply with: relivaro fix apply ${plan.planId} --yes [--verify "<test command>" --allow-exec]`);
}

// ---------------------------------------------------------------------------------------------------------------

const benchCmd: Command = {
  spec: {
    name: 'bench',
    summary: 'Benchmark a command repeatedly and compare with a saved baseline',
    usage:
      'relivaro bench --cmd "<command>" [--name build] [--runs 10] [--warmup 1] [--save-baseline] --allow-exec',
    description:
      'Measures wall-clock time of a project command (no shell) over several runs and reports mean, median, p95 and standard deviation. Results are stored in .relivaro/bench/<name>/ and compared against baseline.json with a significance check. Use performance.budgets in the config to make `relivaro release` enforce limits.',
    positionals: ['path'],
    options: [
      { name: 'cmd', type: 'string', value: '<command>', description: 'Command to measure (required).' },
      {
        name: 'name',
        type: 'string',
        value: '<name>',
        description: 'Benchmark name (default: derived from the command).',
      },
      { name: 'runs', type: 'number', value: '<n>', description: 'Measured runs.', default: 10 },
      { name: 'warmup', type: 'number', value: '<n>', description: 'Unmeasured warm-up runs.', default: 1 },
      { name: 'save-baseline', type: 'boolean', description: 'Store this result as the new baseline.' },
      { name: 'allow-exec', type: 'boolean', description: 'Required: the command runs project code.' },
      { name: 'workspace', type: 'string', value: '<dir>', description: 'Workspace directory.' },
    ],
    examples: [
      'relivaro bench --cmd "npm run build" --name build --runs 5 --allow-exec --save-baseline',
      'relivaro bench --cmd "npm run build" --name build --runs 5 --allow-exec',
    ],
  },
  async run(p, out) {
    const root = rootArg(p);
    const cmd = p.opts.cmd as string | undefined;
    if (!cmd) throw new RelivaroError('USAGE', 'bench requires --cmd "<command>".');
    const { config } = loadConfig(root);
    const name =
      (p.opts.name as string) ??
      cmd
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 40);
    const ws = new Workspace(root, p.opts.workspace as string | undefined);
    const res = await benchCommand({
      name,
      command: cmd,
      cwd: root,
      runs: Number(p.opts.runs),
      warmup: Number(p.opts.warmup),
      allowExec: !!p.opts['allow-exec'],
      timeoutSeconds: config.timeouts.commandSeconds,
      onProgress: out.progress,
    });
    clearProgress();
    const base = loadBaseline(ws, name);
    if (base) res.comparison = compareStats(base.stats, res.stats);
    const saved = saveBench(ws, res, !!p.opts['save-baseline'] || !base);
    if (out.json) out.print(JSON.stringify({ ...res, files: saved }, null, 2));
    else {
      const s = res.stats;
      out.print(`${paint(out.color, 'bold', name)}: \`${res.command}\` × ${s.n} (warm-up ${res.warmup})`);
      out.print(
        `  mean ${s.meanMs.toFixed(1)} ms · median ${s.medianMs.toFixed(1)} · p95 ${s.p95Ms.toFixed(1)} · min ${s.minMs.toFixed(1)} · max ${s.maxMs.toFixed(1)} · σ ${s.stddevMs.toFixed(1)}`,
      );
      if (res.comparison)
        out.print(
          `  vs baseline: ${res.comparison.changePct > 0 ? '+' : ''}${res.comparison.changePct}% (${res.comparison.verdict})`,
        );
      if (saved.baseline) out.print(paint(out.color, 'gray', `  baseline saved: ${saved.baseline}`));
    }
    const budget = config.performance.budgets[name];
    if (
      budget?.maxRegressionPct !== undefined &&
      res.comparison?.significant &&
      res.comparison.changePct > budget.maxRegressionPct
    )
      return EXIT.GATE_FAILED;
    if (budget?.meanMs !== undefined && res.stats.meanMs > budget.meanMs) return EXIT.GATE_FAILED;
    if (budget?.p95Ms !== undefined && res.stats.p95Ms > budget.p95Ms) return EXIT.GATE_FAILED;
    return EXIT.OK;
  },
};

const loadCmd: Command = {
  spec: {
    name: 'load',
    summary: 'Controlled HTTP load test against a local or private-network service',
    usage:
      'relivaro load <url> [--duration 10] [--concurrency 10] [--method GET] [--header "K: V"] [--body <json>] [--name api]',
    description:
      'Sends requests with bounded concurrency for a fixed duration and reports throughput, latency percentiles, status codes and error rate. Targets must resolve to loopback/private addresses (public hosts are refused unless --allow-remote, and hard caps always apply: 64 concurrent, 120 s, 200k requests). Never point this at production.',
    positionals: ['url'],
    options: [
      {
        name: 'duration',
        type: 'number',
        value: '<sec>',
        description: 'Test duration in seconds.',
        default: 10,
      },
      {
        name: 'concurrency',
        type: 'number',
        value: '<n>',
        description: 'Concurrent connections.',
        default: 10,
      },
      { name: 'requests', type: 'number', value: '<n>', description: 'Stop after this many requests.' },
      { name: 'method', type: 'string', value: '<method>', description: 'HTTP method.', default: 'GET' },
      {
        name: 'header',
        type: 'list',
        value: '<"K: V">',
        description: 'Request header (repeatable; commas are not split for this option).',
      },
      { name: 'body', type: 'string', value: '<text>', description: 'Request body.' },
      { name: 'timeout', type: 'number', value: '<ms>', description: 'Per-request timeout.', default: 10000 },
      { name: 'name', type: 'string', value: '<name>', description: 'Result name for baselines/budgets.' },
      { name: 'save-baseline', type: 'boolean', description: 'Store this result as the new baseline.' },
      {
        name: 'allow-remote',
        type: 'boolean',
        description: 'Allow non-private targets you are authorized to test (caps still apply).',
      },
      {
        name: 'path',
        type: 'string',
        value: '<dir>',
        description: 'Project directory for storing results (default: .).',
      },
      { name: 'workspace', type: 'string', value: '<dir>', description: 'Workspace directory.' },
    ],
    examples: ['relivaro load http://localhost:3000/api/health --duration 15 --concurrency 20 --name health'],
  },
  async run(p, out) {
    const url = p.positionals[0];
    if (!url) throw new RelivaroError('USAGE', 'load requires a URL.');
    const headers: Record<string, string> = {};
    for (const h of (p.opts.header as string[] | undefined) ?? []) {
      const i = h.indexOf(':');
      if (i < 1) throw new RelivaroError('USAGE', `Invalid header "${h}" (expected "Name: value").`);
      headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    const parsed = new URL(url);
    const name =
      (p.opts.name as string) ??
      `${parsed.hostname}${parsed.pathname}`.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const res = await loadTest({
      name,
      url,
      method: String(p.opts.method).toUpperCase(),
      headers,
      body: p.opts.body as string | undefined,
      concurrency: Number(p.opts.concurrency),
      durationSec: Number(p.opts.duration),
      maxRequests: p.opts.requests as number | undefined,
      timeoutMs: Number(p.opts.timeout),
      allowRemote: !!p.opts['allow-remote'],
      onProgress: out.progress,
    });
    clearProgress();
    const projectDir = resolve((p.opts.path as string) ?? '.');
    const ws = new Workspace(projectDir, p.opts.workspace as string | undefined);
    const base = loadBaseline(ws, name);
    if (base) res.comparison = compareStats(base.stats, res.stats);
    const saved = saveBench(ws, res, !!p.opts['save-baseline'] || !base);
    if (out.json) out.print(JSON.stringify({ ...res, files: saved }, null, 2));
    else {
      const s = res.stats;
      out.print(
        `${paint(out.color, 'bold', name)}: ${res.method} ${res.url} — ${res.requests} requests in ${res.durationSec}s at concurrency ${res.concurrency}`,
      );
      out.print(
        `  throughput ${res.throughputRps} req/s · errors ${res.errors} (${(res.errorRate * 100).toFixed(2)}%) · status ${Object.entries(
          res.statusCodes,
        )
          .map(([k, v]) => `${k}:${v}`)
          .join(' ')}`,
      );
      out.print(
        `  latency mean ${s.meanMs} ms · p50 ${s.medianMs} · p90 ${s.p90Ms} · p95 ${s.p95Ms} · p99 ${s.p99Ms} · max ${s.maxMs}`,
      );
      if (res.comparison)
        out.print(
          `  vs baseline: ${res.comparison.changePct > 0 ? '+' : ''}${res.comparison.changePct}% mean latency (${res.comparison.verdict})`,
        );
      for (const l of res.limitedBy) out.print(paint(out.color, 'yellow', `  limit: ${l}`));
    }
    const { config } = loadConfig(projectDir);
    const b = config.performance.budgets[name];
    if (
      b &&
      ((b.p95Ms !== undefined && res.stats.p95Ms > b.p95Ms) ||
        (b.errorRate !== undefined && res.errorRate > b.errorRate) ||
        (b.meanMs !== undefined && res.stats.meanMs > b.meanMs))
    )
      return EXIT.GATE_FAILED;
    return EXIT.OK;
  },
};

const contractCmd: Command = {
  spec: {
    name: 'contract',
    summary: 'Validate OpenAPI specs and detect breaking API changes',
    usage: 'relivaro contract <validate|diff> <spec> [other-spec] [--base <git-ref>]',
    description:
      'validate <spec>: structural checks (versions, unresolved $refs, undeclared path parameters, duplicate operationIds, undefined security schemes).\ndiff <old> <new> | diff <spec> --base <git-ref>: classifies changes as breaking or compatible (removed endpoints/responses, new required parameters, type changes, removed response properties, narrowed enums).',
    positionals: ['subcommand', 'spec', 'other'],
    options: [
      {
        name: 'base',
        type: 'string',
        value: '<git-ref>',
        description: 'diff: compare <spec> with its version at this git ref.',
      },
    ],
    examples: [
      'relivaro contract validate openapi.yaml',
      'relivaro contract diff openapi.yaml --base origin/main',
    ],
  },
  async run(p, out) {
    const [sub, a, b] = p.positionals;
    if (!a) throw new RelivaroError('USAGE', 'A spec file is required.');
    const readSpec = (f: string) => {
      if (!existsSync(f)) throw new RelivaroError('NOT_FOUND', `Spec not found: ${f}`);
      return loadSpec(readFileSync(f, 'utf8'), f);
    };
    if (sub === 'validate') {
      const issues = validateSpec(readSpec(a));
      if (out.json) out.print(JSON.stringify({ spec: a, issues }, null, 2));
      else {
        out.print(issues.length ? `${issues.length} issue(s) in ${a}:` : `${a}: valid.`);
        for (const i of issues)
          out.print(
            `  ${i.severity === 'error' ? paint(out.color, 'red', 'error  ') : paint(out.color, 'yellow', 'warning')} ${i.path}: ${i.message}`,
          );
      }
      return issues.some((i) => i.severity === 'error') ? EXIT.GATE_FAILED : EXIT.OK;
    }
    if (sub === 'diff') {
      let oldDoc: Record<string, unknown>;
      let newDoc: Record<string, unknown>;
      if (p.opts.base) {
        const absA = resolve(a);
        const dir = absA.slice(0, Math.max(absA.lastIndexOf('/'), absA.lastIndexOf('\\')));
        const top = runGit(dir, ['rev-parse', '--show-toplevel'])?.trim();
        if (!top) throw new RelivaroError('USAGE', '--base requires the spec to be inside a git repository.');
        const rel = absA.slice(top.length + 1).replace(/\\/g, '/');
        const ref = String(p.opts.base);
        if (!/^[\w./@^~-]+$/.test(ref) || ref.startsWith('-'))
          throw new RelivaroError('USAGE', `Invalid git ref "${ref}".`);
        const text = runGit(top, ['show', `${ref}:${rel}`]);
        if (text === null) throw new RelivaroError('NOT_FOUND', `${rel} does not exist at ${ref}.`);
        oldDoc = loadSpec(text, `${ref}:${rel}`);
        newDoc = readSpec(a);
      } else {
        if (!b) throw new RelivaroError('USAGE', 'diff needs two specs or --base <git-ref>.');
        oldDoc = readSpec(a);
        newDoc = readSpec(b);
      }
      const changes = diffSpecs(oldDoc, newDoc);
      const breaking = changes.filter((c) => c.breaking);
      if (out.json)
        out.print(JSON.stringify({ breaking, compatible: changes.filter((c) => !c.breaking) }, null, 2));
      else {
        out.print(`${breaking.length} breaking, ${changes.length - breaking.length} compatible change(s).`);
        for (const c of changes)
          out.print(
            `  ${c.breaking ? paint(out.color, 'red', 'BREAKING  ') : paint(out.color, 'green', 'compatible')} ${c.location}: ${c.message}`,
          );
      }
      return breaking.length ? EXIT.GATE_FAILED : EXIT.OK;
    }
    throw new RelivaroError('USAGE', `Unknown contract subcommand "${sub ?? ''}" (use validate or diff).`);
  },
};

const rulesCmd: Command = {
  spec: {
    name: 'rules',
    summary: 'List rules or show one rule in detail',
    usage: 'relivaro rules [list|show <id>] [--category <c>]',
    positionals: ['subcommand', 'id'],
    options: [categoryOpt],
  },
  async run(p, out) {
    let [sub, id] = p.positionals;
    // `relivaro rules <id>` is accepted as a shorthand for `rules show <id>`.
    if (sub && sub !== 'list' && sub !== 'show') {
      if (!findRule(sub))
        throw new RelivaroError(
          'USAGE',
          `Unknown rules subcommand or rule "${sub}".`,
          'Use `relivaro rules list` or `relivaro rules show <rule-id>`.',
        );
      [sub, id] = ['show', sub];
    }
    if (sub === 'show') {
      const r = id ? findRule(id) : undefined;
      if (!r) throw new RelivaroError('NOT_FOUND', `Unknown rule "${id ?? ''}".`);
      if (out.json) out.print(JSON.stringify({ ...r, check: undefined, appliesTo: undefined }, null, 2));
      else {
        out.print(`${paint(out.color, 'bold', r.id)} — ${r.title}`);
        out.print(
          `${r.category} · default severity ${r.severity} · confidence ${r.confidence}${r.fixer ? ` · fixer ${r.fixer}` : ''}`,
        );
        if (r.cwe?.length || r.owasp?.length) out.print([...(r.cwe ?? []), ...(r.owasp ?? [])].join(', '));
        out.print(
          `\n${r.description}\n\nImpact: ${r.impact}\nFix: ${r.recommendation}\nVerify: ${r.verification}`,
        );
      }
      return EXIT.OK;
    }
    const cats = p.opts.category as Category[] | undefined;
    const rules = allRuleMeta().filter((r) => !cats?.length || cats.includes(r.category));
    if (out.json)
      out.print(
        JSON.stringify(
          rules.map((r) => ({
            id: r.id,
            title: r.title,
            category: r.category,
            severity: r.severity,
            confidence: r.confidence,
            cwe: r.cwe,
            owasp: r.owasp,
            fixer: r.fixer,
          })),
          null,
          2,
        ),
      );
    else
      for (const r of rules)
        out.print(
          `${r.id.padEnd(44)} ${r.severity.padEnd(8)} ${r.title}${r.fixer ? paint(out.color, 'green', ' [fix]') : ''}`,
        );
    return EXIT.OK;
  },
};

const initCmd: Command = {
  spec: {
    name: 'init',
    summary: 'Create relivaro.config.json (and optionally a GitHub Actions workflow)',
    usage: 'relivaro init [path] [--github-action] [--force]',
    positionals: ['path'],
    options: [
      {
        name: 'github-action',
        type: 'boolean',
        description: 'Also write .github/workflows/relivaro.yml (SARIF upload to code scanning).',
      },
      { name: 'force', type: 'boolean', description: 'Overwrite existing files.' },
    ],
  },
  async run(p, out) {
    const root = rootArg(p);
    const written: string[] = [];
    const cfgFile = join(root, 'relivaro.config.json');
    if (existsSync(cfgFile) && !p.opts.force)
      throw new RelivaroError('USAGE', `${cfgFile} already exists (use --force to overwrite).`);
    const d = defaultConfig();
    const cfg = {
      $schema: 'https://raw.githubusercontent.com/cihantopac/relivaro/main/schemas/config.schema.json',
      exclude: [],
      rules: {},
      failOn: 'high',
      release: d.release,
      performance: d.performance,
      env: d.env,
    };
    atomicWrite(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
    written.push(cfgFile);
    if (p.opts['github-action']) {
      const wf = join(root, '.github', 'workflows', 'relivaro.yml');
      if (existsSync(wf) && !p.opts.force)
        throw new RelivaroError('USAGE', `${wf} already exists (use --force to overwrite).`);
      atomicWrite(wf, GITHUB_WORKFLOW);
      written.push(wf);
    }
    if (out.json) out.print(JSON.stringify({ written }));
    else for (const w of written) out.print(`wrote ${w}`);
    return EXIT.OK;
  },
};

export const GITHUB_WORKFLOW = `name: Relivaro

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  relivaro:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Relivaro security & quality audit
        run: npx --yes relivaro@${VERSION} audit . --online --format sarif,md --out relivaro-report --fail-on high
      - name: Upload SARIF to code scanning
        if: always()
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: relivaro-report/report.sarif
`;

const doctorCmd: Command = {
  spec: {
    name: 'doctor',
    summary: 'Check that Relivaro and optional toolchains work in this environment',
    usage: 'relivaro doctor',
    options: [],
  },
  async run(_p, out) {
    const checks: { name: string; ok: boolean; detail: string; required: boolean }[] = [];
    const major = Number(process.versions.node.split('.')[0]);
    checks.push({
      name: 'Node.js',
      ok: major >= 22,
      detail: `${process.version} (requires >= 22)`,
      required: true,
    });
    for (const lang of ['javascript', 'typescript', 'tsx', 'php', 'python'] as const) {
      try {
        const t = await parse(
          lang,
          lang === 'php' ? '<?php echo 1;' : lang === 'python' ? 'x = 1' : 'const x = 1;',
        );
        checks.push({
          name: `parser:${lang}`,
          ok: !!t && !t.rootNode.hasError,
          detail: 'loaded',
          required: true,
        });
        t?.delete();
      } catch (e) {
        checks.push({ name: `parser:${lang}`, ok: false, detail: (e as Error).message, required: true });
      }
    }
    for (const a of grammarAssets())
      checks.push({ name: `asset:${a.name}`, ok: existsSync(a.path), detail: a.path, required: true });
    const tools = [
      'git',
      'npm',
      'pnpm',
      'yarn',
      'php',
      'composer',
      'python3',
      'pytest',
      'go',
      'cargo',
      'flutter',
      'dart',
    ];
    for (const t of tools) {
      const w = whichSync(t);
      checks.push({
        name: t,
        ok: !!w,
        detail: w ?? 'not found (only needed for --allow-exec checks of that ecosystem)',
        required: false,
      });
    }
    const failed = checks.filter((c) => c.required && !c.ok);
    if (out.json) out.print(JSON.stringify({ version: VERSION, checks, ok: !failed.length }, null, 2));
    else {
      out.print(`Relivaro ${VERSION} on ${process.platform}/${process.arch}`);
      for (const c of checks)
        out.print(
          `  ${c.ok ? paint(out.color, 'green', '✔') : c.required ? paint(out.color, 'red', '✖') : paint(out.color, 'gray', '-')} ${c.name.padEnd(28)} ${paint(out.color, 'gray', c.detail)}`,
        );
      out.print(
        failed.length
          ? paint(out.color, 'red', `${failed.length} required check(s) failed.`)
          : paint(out.color, 'green', 'All required checks passed.'),
      );
    }
    return failed.length ? EXIT.RUNTIME : EXIT.OK;
  },
};

export const COMMANDS: Command[] = [
  analysis(
    'audit',
    'Complete engineering audit (security, supply chain, reliability, performance, quality, testing)',
    "Runs every rule category. With --allow-exec it also runs the project's type check and tests; with --online it checks dependencies against OSV.dev.",
    [...CATEGORIES],
    ['typecheck', 'test'],
  ),
  analysis(
    'security',
    'Security and supply-chain analysis',
    'Injection, XSS, SSRF, path traversal, deserialization, crypto, auth/session, CORS, mass assignment, secrets, CI/CD and container hardening, dependency risks (OWASP Top 10:2025, API Security Top 10:2023, OpenSSF).',
    ['security', 'supply-chain'],
    [],
  ),
  analysis(
    'performance',
    'Performance and scalability anti-patterns',
    'N+1 queries, rows loaded only to count, unbounded queries, blocking I/O in handlers, catastrophic regex backtracking, missing indexes. Static findings are "suspected"; use `relivaro bench` and `relivaro load` for measurements.',
    ['performance'],
    [],
  ),
  analysis(
    'reliability',
    'Reliability and resilience analysis',
    'Timeouts, error handling, idempotency, race conditions, migrations, retries, graceful shutdown, health checks and monitoring.',
    ['reliability'],
    [],
  ),
  analysis(
    'quality',
    'Code quality analysis',
    'Debug leftovers, complexity, disabled type checking; with --allow-exec the type checker and linter.',
    ['quality'],
    ['typecheck', 'lint'],
  ),
  analysis(
    'test',
    'Test discovery, execution, coverage and untested-risk ranking',
    'Finds test frameworks and suites, runs them with --allow-exec (parsed pass/fail counts), reads existing coverage reports and ranks untested high-risk code.',
    ['testing', 'quality'],
    ['test'],
  ),
  analysis(
    'release',
    'Production-readiness assessment with explicit gates',
    'Runs all analyses plus build, tests, type check and lint (with --allow-exec), dependency vulnerabilities (with --online) and performance budgets, then reports blockers, warnings, passed and unverified gates. Exit code 1 when not ready.',
    [...CATEGORIES],
    ['build', 'test', 'typecheck', 'lint'],
    [
      {
        name: 'strict',
        type: 'boolean',
        description: 'Also fail (exit 1) when critical gates are unverified.',
      },
    ],
    true,
  ),
  discoverCmd,
  fixCmd,
  reportCmd,
  compareCmd,
  reviewCmd,
  recheckCmd,
  baselineCmd,
  benchCmd,
  loadCmd,
  contractCmd,
  rulesCmd,
  initCmd,
  doctorCmd,
];

export function fixerCatalog(): string {
  return FIXERS.map((f) => `| \`${f.id}\` | ${f.safety} | ${f.title} | ${f.description} |`).join('\n');
}
