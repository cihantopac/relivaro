import { readCoverage, type TestGap, testGaps } from './checks/coverage.js';
import { type CheckKind, type CheckResult, planChecks, runChecks } from './checks/exec.js';
import { loadConfig, type RelivaroConfig } from './core/config.js';
import { RelivaroError } from './core/errors.js';
import {
  CATEGORIES,
  type Category,
  compareFindings,
  type Finding,
  SEVERITIES,
  type Severity,
  severityAtLeast,
} from './core/types.js';
import { VERSION } from './core/version.js';
import { Workspace } from './core/workspace.js';
import { queryOsv } from './deps/osv.js';
import { FileSet } from './fs/files.js';
import { discover, type ProjectProfile } from './intel/discover.js';
import { assessRelease, type ReleaseAssessment } from './release/readiness.js';
import { analyze, FindingBuilder } from './rules/engine.js';
import { RULES } from './rules/index.js';
import type { ProjectContext } from './rules/types.js';

export const SCHEMA_VERSION = 1;

export interface AuditOptions {
  root: string;
  command: string;
  categories?: Category[];
  rules?: string[];
  online?: boolean;
  allowExec?: boolean;
  checks?: CheckKind[];
  configPath?: string;
  workspace?: string;
  baseline?: string | false;
  release?: boolean;
  useGit?: boolean;
  /** Do not write anything to disk. */
  noWrite?: boolean;
  onProgress?: (msg: string) => void;
  fetchImpl?: typeof fetch;
}

export interface Summary {
  total: number;
  open: number;
  suppressed: number;
  baseline: number;
  bySeverity: Record<Severity, number>;
  byCategory: Record<Category, number>;
}

export interface RunRecord {
  schemaVersion: number;
  tool: { name: 'relivaro'; version: string };
  runId: string;
  command: string;
  startedAt: string;
  durationMs: number;
  root: string;
  options: {
    categories: Category[];
    online: boolean;
    allowExec: boolean;
    checks: CheckKind[];
    configFile?: string;
    baseline?: string;
  };
  profile: ProfileSummary;
  findings: Finding[];
  summary: Summary;
  checks: CheckResult[];
  coverage: {
    file: string;
    format: string;
    generatedAt: string;
    stale: boolean;
    pct: number;
    covered: number;
    total: number;
  }[];
  testGaps: TestGap[];
  metrics: {
    files: number;
    bytes: number;
    linesOfCode: number;
    parsedFiles: number;
    functions: number;
    rulesRun: number;
    analysisMs: number;
    dependencies: number;
    osvQueried?: number;
    filesSkipped: Record<string, number>;
  };
  limitations: string[];
  errors: {
    parse: { file: string; message: string }[];
    rules: { rule: string; file?: string; message: string }[];
    network: string[];
  };
  release?: ReleaseAssessment;
}

export type ProfileSummary = Omit<ProjectProfile, 'manifests' | 'lockfiles'> & {
  manifests: {
    file: string;
    ecosystem: string;
    name?: string;
    dependencies: number;
    devDependencies: number;
    error?: string;
  }[];
  lockfiles: { file: string; ecosystem: string; packages: number; error?: string }[];
};

export function summarize(findings: Finding[]): Summary {
  const s: Summary = {
    total: findings.length,
    open: 0,
    suppressed: 0,
    baseline: 0,
    bySeverity: Object.fromEntries(SEVERITIES.map((x) => [x, 0])) as Record<Severity, number>,
    byCategory: Object.fromEntries(CATEGORIES.map((x) => [x, 0])) as Record<Category, number>,
  };
  for (const f of findings) {
    if (f.status === 'suppressed') s.suppressed++;
    else if (f.status === 'baseline') s.baseline++;
    else {
      s.open++;
      s.bySeverity[f.severity]++;
      s.byCategory[f.category]++;
    }
  }
  return s;
}

export interface BaselineFile {
  schemaVersion: number;
  createdAt: string;
  fingerprints: { fingerprint: string; ruleId: string; file?: string; reason?: string }[];
}

export const BASELINE_FILE = 'relivaro-baseline.json';

function summarizeProfile(p: ProjectProfile): ProfileSummary {
  return {
    ...p,
    manifests: p.manifests.map((m) => ({
      file: m.file,
      ecosystem: m.ecosystem,
      name: m.name,
      dependencies: m.deps.filter((d) => !d.dev).length,
      devDependencies: m.deps.filter((d) => d.dev).length,
      error: m.error,
    })),
    lockfiles: p.lockfiles.map((l) => ({
      file: l.file,
      ecosystem: l.ecosystem,
      packages: l.packages.length,
      error: l.error,
    })),
  };
}

export async function runAudit(
  opts: AuditOptions,
): Promise<{ run: RunRecord; config: RelivaroConfig; workspace: Workspace }> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const { config, path: configFile } = loadConfig(opts.root, opts.configPath);
  const progress = opts.onProgress ?? (() => {});
  progress('indexing files');
  const files = new FileSet(opts.root, {
    include: config.include,
    exclude: config.exclude,
    maxFileSizeKb: config.maxFileSizeKb,
    useGit: opts.useGit,
  });
  progress(`discovering project (${files.files.length} files)`);
  const profile = discover(files);
  const ctx: ProjectContext = { files, profile, config };
  const workspace = new Workspace(files.root, opts.workspace);
  const categories = opts.categories?.length ? opts.categories : [...CATEGORIES];
  const builder = new FindingBuilder(ctx);
  progress('analysing');
  const analysis = await analyze(ctx, RULES, { categories, rules: opts.rules }, builder);

  const limitations: string[] = [];
  const networkErrors: string[] = [];
  let osvQueried: number | undefined;
  const wantsSupplyChain = categories.includes('supply-chain');
  if (wantsSupplyChain) {
    if (opts.online) {
      progress('querying OSV.dev for known vulnerabilities');
      const osv = await queryOsv(profile.lockfiles, {
        cacheFile: opts.noWrite ? undefined : workspace.path('cache', 'osv.json'),
        fetchImpl: opts.fetchImpl,
        onProgress: progress,
      });
      osvQueried = osv.queried;
      networkErrors.push(...osv.errors);
      const { OSV_RULE } = await import('./deps/osv.js');
      for (const h of osv.hits) builder.add(OSV_RULE, h);
      if (osv.errors.length)
        limitations.push(
          `Known-vulnerability lookup was incomplete (${osv.errors.length} network error(s)); dependency risk is partially unverified.`,
        );
      if (!profile.lockfiles.length)
        limitations.push(
          'No lockfiles found: known vulnerabilities could not be checked against resolved versions.',
        );
    } else if (profile.lockfiles.length) {
      limitations.push(
        'Known vulnerabilities in dependencies were not checked (offline mode). Re-run with --online to query OSV.dev.',
      );
    }
  }

  let checks: CheckResult[] = [];
  const checkKinds = opts.checks ?? [];
  if (checkKinds.length) {
    const planned = planChecks(files, profile, config, checkKinds);
    const exec = await runChecks(planned, {
      allowExec: !!opts.allowExec,
      timeoutSeconds: config.timeouts.commandSeconds,
      root: files.root,
      onProgress: progress,
    });
    checks = exec.results;
    for (const h of exec.hits) builder.add(h.rule, h.hit, h.provenance);
    if (!opts.allowExec && planned.length)
      limitations.push(
        `${planned.length} build/test/type-check command(s) were not executed (they run project code and require --allow-exec).`,
      );
    for (const c of checks)
      if (c.status === 'skipped' && opts.allowExec)
        limitations.push(`${c.kind} for \`${c.unit}\` was skipped: ${c.reason}.`);
    if (!planned.length) limitations.push(`No ${checkKinds.join('/')} commands were detected.`);
  }

  // Baseline: known findings accepted earlier are reported but do not fail gates.
  let baselineFile: string | undefined;
  if (opts.baseline !== false) {
    const path = typeof opts.baseline === 'string' ? opts.baseline : BASELINE_FILE;
    const raw = files.readAny(path);
    if (raw) {
      try {
        const b = JSON.parse(raw) as BaselineFile;
        const set = new Set(b.fingerprints.map((f) => f.fingerprint));
        for (const f of builder.findings)
          if (f.status === 'open' && set.has(f.fingerprint)) {
            f.status = 'baseline';
            f.suppression = {
              kind: 'baseline',
              reason: b.fingerprints.find((x) => x.fingerprint === f.fingerprint)?.reason,
            };
          }
        baselineFile = path;
      } catch {
        throw new RelivaroError('CONFIG_INVALID', `${path} is not a valid Relivaro baseline file.`);
      }
    }
  }

  const coverageReports = readCoverage(files, profile);
  const findings = builder.findings.sort(compareFindings);
  const gaps =
    categories.includes('testing') || categories.includes('quality')
      ? testGaps(files, findings, analysis.complexity, coverageReports)
      : [];

  if (analysis.ruleErrors.length)
    limitations.push(
      `${analysis.ruleErrors.length} internal rule error(s) occurred (see errors.rules in report.json); results for those rules are incomplete.`,
    );
  if (analysis.parseErrors.length)
    limitations.push(
      `${analysis.parseErrors.length} file(s) could not be parsed and were analysed only by text rules.`,
    );
  if (files.skipped.tooLarge)
    limitations.push(
      `${files.skipped.tooLarge} file(s) larger than ${config.maxFileSizeKb} KB were skipped.`,
    );
  if (files.skipped.sensitive)
    limitations.push(
      `${files.skipped.sensitive} untracked sensitive file(s) (e.g. .env) were intentionally not read.`,
    );
  const astLangs = new Set(['JavaScript', 'TypeScript', 'PHP', 'Python']);
  const otherLangs = profile.languages.filter(
    (l) =>
      !astLangs.has(l.name) &&
      [
        'Go',
        'Ruby',
        'Java',
        'Kotlin',
        'Swift',
        'Dart',
        'Rust',
        'C#',
        'Objective-C',
        'Scala',
        'Elixir',
      ].includes(l.name) &&
      l.files >= 5,
  );
  if (otherLangs.length)
    limitations.push(
      `Source-level rules do not cover ${otherLangs.map((l) => `${l.name} (${l.files} files)`).join(', ')}; these parts were checked for configuration, dependencies and secrets only.`,
    );
  for (const c of coverageReports)
    if (c.stale)
      limitations.push(
        `Coverage report ${c.file} is older than the newest source change; coverage numbers may be outdated.`,
      );
  if (!files.gitRepo)
    limitations.push(
      'Not a git repository (or git unavailable): .gitignore was approximated and tracked-file checks were skipped.',
    );

  const run: RunRecord = {
    schemaVersion: SCHEMA_VERSION,
    tool: { name: 'relivaro', version: VERSION },
    runId: workspace.newRunId(),
    command: opts.command,
    startedAt,
    durationMs: 0,
    root: files.root,
    options: {
      categories,
      online: !!opts.online,
      allowExec: !!opts.allowExec,
      checks: checkKinds,
      configFile,
      baseline: baselineFile,
    },
    profile: summarizeProfile(profile),
    findings,
    summary: summarize(findings),
    checks,
    coverage: coverageReports.map((c) => ({
      file: c.file,
      format: c.format,
      generatedAt: c.generatedAt,
      stale: c.stale,
      pct: c.lines.pct,
      covered: c.lines.covered,
      total: c.lines.total,
    })),
    testGaps: gaps,
    metrics: {
      files: files.files.length,
      bytes: profile.stats.bytes,
      linesOfCode: profile.languages.reduce((s, l) => s + l.lines, 0),
      parsedFiles: analysis.filesParsed,
      functions: analysis.functions,
      rulesRun: analysis.rulesRun.length,
      analysisMs: analysis.durationMs,
      dependencies: profile.lockfiles.reduce((s, l) => s + l.packages.length, 0),
      osvQueried,
      filesSkipped: { ...files.skipped },
    },
    limitations: [...new Set(limitations)],
    errors: {
      parse: analysis.parseErrors.slice(0, 50),
      rules: analysis.ruleErrors.slice(0, 50),
      network: networkErrors.slice(0, 20),
    },
  };
  if (opts.release) run.release = assessRelease(run, config);
  run.durationMs = Math.round(performance.now() - started);
  return { run, config, workspace };
}

export function gateFailed(run: RunRecord, failOn: Severity | 'none'): boolean {
  if (failOn === 'none') return false;
  return run.findings.some(
    (f) => f.status === 'open' && severityAtLeast(f.severity, failOn) && f.confidence !== 'low',
  );
}
