import { readCoverage, type TestGap, testGaps } from './checks/coverage.js';
import { type CheckKind, type CheckResult, planChecks, runChecks } from './checks/exec.js';
import { loadConfig, type RelivaroConfig } from './core/config.js';
import { RelivaroError } from './core/errors.js';
import { Budget, DEFAULT_PARSE_TIMEOUT_MS, type RunBudget, type StopReason } from './core/limits.js';
import type { ProgressEvent, ProgressStage } from './core/progress.js';
import { redact } from './core/secrets.js';
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
import { queryOsv, uniquePackageCount } from './deps/osv.js';
import { changedLines } from './fs/changed.js';
import { classify, FileSet, runGit } from './fs/files.js';
import { discover, type ProjectProfile } from './intel/discover.js';
import { assessRelease, type ReleaseAssessment } from './release/readiness.js';
import { credentialFreeUrl } from './report/sarif.js';
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
  /** Without git, skip files matched by `.gitignore` (default true). */
  respectGitignore?: boolean;
  /** Without git, treat listed files as tracked so sensitive files are reported by path. */
  assumeTracked?: boolean;
  /** Show only findings on lines changed since this git ref (the whole tree is still analysed). */
  since?: string;
  /** OSV cache file (shared; a read-only file is used without being written). Default: the workspace cache. */
  osvCache?: string;
  /** HTTPS mirror of the OSV API (`--osv-api`); used only with `online`. */
  osvApi?: string;
  /** Answer known-vulnerability lookups from the OSV cache only, without network access. */
  offlineOsv?: boolean;
  /** Replaces the absolute root in every output (run record, messages, snippets, limitations). */
  rootLabel?: string;
  /** Source lines per finding snippet (default 3); 0 drops snippets. */
  snippetLines?: number;
  /** Use only defaults or `configPath`, never the audited repository's config file. */
  ignoreRepoConfig?: boolean;
  /** Honour `relivaro-ignore*` / `relivaro-accept*` comments in the audited code. Default true. */
  inlineSuppressions?: boolean;
  /** Do not write anything to disk. */
  noWrite?: boolean;
  onProgress?: (msg: string) => void;
  /** Structured stage and file-count events (`--progress ndjson`). */
  onEvent?: (e: ProgressEvent) => void;
  /** Run limits; they override the config's `limits`. A reached limit makes the run partial. */
  limits?: Partial<RunBudget>;
  /** Aborted by SIGTERM/SIGINT: the run returns what it has, marked partial. */
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface Summary {
  total: number;
  open: number;
  suppressed: number;
  baseline: number;
  /** Open findings accepted as a risk (inline `relivaro-accept`); included in `open`. */
  accepted?: number;
  bySeverity: Record<Severity, number>;
  byCategory: Record<Category, number>;
}

/** JSON Schema of the run record; the version policy is in docs/REPORT.md. */
export const RUN_SCHEMA_URL =
  'https://raw.githubusercontent.com/cihantopac/relivaro/main/schemas/run.schema.json';

export interface RunRecord {
  /** Absent in records written before 1.5.0. */
  $schema?: string;
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
    /** Unique resolved packages (`ecosystem/name@version`), the same unit as `osvQueried`. */
    dependencies: number;
    /** Raw lockfile entries summed over all lockfiles (a package locked twice counts twice). */
    dependencyEntries?: number;
    osvQueried?: number;
    filesSkipped: Record<string, number>;
    /** Per category: rules run and distinct files they looked at (absent in records before 1.5.0). */
    coverage?: Partial<Record<Category, { rules: number; files: number }>>;
  };
  limitations: string[];
  errors: {
    parse: { file: string; message: string }[];
    rules: { rule: string; file?: string; message: string }[];
    network: string[];
  };
  release?: ReleaseAssessment;
  /** `--since <ref>`: only findings on lines changed since `ref` are listed; `files` changed files. */
  since?: { ref: string; files: number };
  /** Set when the run stopped early; its findings and gates cover only part of the project. */
  partial?: { reason: StopReason; at: string };
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
    accepted: 0,
    bySeverity: Object.fromEntries(SEVERITIES.map((x) => [x, 0])) as Record<Severity, number>,
    byCategory: Object.fromEntries(CATEGORIES.map((x) => [x, 0])) as Record<Category, number>,
  };
  for (const f of findings) {
    if (f.status === 'suppressed') s.suppressed++;
    else if (f.status === 'baseline') s.baseline++;
    else {
      s.open++;
      if (f.accepted) s.accepted = (s.accepted ?? 0) + 1;
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

/** One limitation per manifest or lockfile that failed to parse, so its dependencies never look clean. */
export function parseErrorLimitations(profile: {
  manifests: { file: string; error?: string }[];
  lockfiles: { file: string; error?: string }[];
}): string[] {
  const clip = (raw: string) => {
    // Parser messages may carry a multi-line source excerpt; the first line names the problem.
    const e = raw.split('\n', 1)[0]!.trim().replace(/:$/, '');
    return redact(e.length > 160 ? `${e.slice(0, 157)}...` : e);
  };
  return [
    ...profile.lockfiles
      .filter((l) => l.error)
      .map(
        (l) =>
          `Lockfile \`${l.file}\` could not be parsed (${clip(l.error!)}); its dependencies were not analysed.`,
      ),
    ...profile.manifests
      .filter((m) => m.error)
      .map(
        (m) =>
          `Manifest \`${m.file}\` could not be parsed (${clip(m.error!)}); its dependencies were not analysed.`,
      ),
  ];
}

export async function runAudit(
  opts: AuditOptions,
): Promise<{ run: RunRecord; config: RelivaroConfig; workspace: Workspace }> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const { config, path: configFile } = loadConfig(opts.root, opts.configPath, {
    ignoreRepoConfig: opts.ignoreRepoConfig,
  });
  const progress = opts.onProgress ?? (() => {});
  const emit = opts.onEvent ?? (() => {});
  const stage = (s: ProgressStage, state: 'start' | 'end') =>
    emit({ type: 'stage', stage: s, state, elapsedMs: Math.round(performance.now() - started) });
  progress('indexing files');
  stage('index', 'start');
  const files = new FileSet(opts.root, {
    include: config.include,
    exclude: config.exclude,
    maxFileSizeKb: config.maxFileSizeKb,
    maxLockfileSizeKb: config.maxLockfileSizeKb,
    useGit: opts.useGit,
    respectGitignore: opts.respectGitignore,
    assumeTracked: opts.assumeTracked,
  });
  stage('index', 'end');
  progress(`discovering project (${files.files.length} files)`);
  // Resolved before the analysis so a bad ref or a missing repository fails fast (usage error, exit 2).
  const changed = opts.since !== undefined ? changedLines(files.root, opts.since) : undefined;
  stage('discover', 'start');
  const profile = discover(files);
  if (files.gitRepo) {
    const revisionId = runGit(files.root, ['rev-parse', 'HEAD'])?.trim();
    if (revisionId && /^[0-9a-f]{7,64}$/.test(revisionId)) {
      const branch = runGit(files.root, ['rev-parse', '--abbrev-ref', 'HEAD'])?.trim();
      const remote = runGit(files.root, ['remote', 'get-url', 'origin'])?.trim();
      profile.vcs = {
        revisionId,
        ...(branch && branch !== 'HEAD' ? { branch } : {}),
        ...(remote ? { repositoryUri: credentialFreeUrl(remote) } : {}),
      };
    }
  }
  stage('discover', 'end');
  const ctx: ProjectContext = { files, profile, config };
  const workspace = new Workspace(files.root, opts.workspace);
  const categories = opts.categories?.length ? opts.categories : [...CATEGORIES];
  const builder = new FindingBuilder(ctx, {
    inlineSuppressions: opts.inlineSuppressions,
    snippetLines: opts.snippetLines,
  });
  const limits: RunBudget = {
    maxDurationMs: config.limits.maxDuration !== undefined ? config.limits.maxDuration * 1000 : undefined,
    maxFiles: config.limits.maxFiles,
    maxBytes: config.limits.maxBytes,
    parseTimeoutMs: DEFAULT_PARSE_TIMEOUT_MS,
    ...Object.fromEntries(Object.entries(opts.limits ?? {}).filter(([, v]) => v !== undefined)),
  };
  // The duration budget counts from the start of the run, not of the analysis.
  const budget = new Budget(limits, () => performance.now() - started);
  progress('analysing');
  stage('analyse', 'start');
  const analysis = await analyze(
    ctx,
    RULES,
    {
      categories,
      rules: opts.rules,
      onFiles: (done, total) => emit({ type: 'files', done, total }),
      budget,
      signal: opts.signal,
      parseTimeoutMs: limits.parseTimeoutMs,
    },
    builder,
  );
  stage('analyse', 'end');
  let stopped: StopReason | undefined = analysis.stopped;
  const stopNow = () => {
    stopped ??= opts.signal?.aborted ? 'signal' : budget.exceeded() === 'duration' ? 'duration' : undefined;
    return stopped !== undefined;
  };

  const limitations: string[] = [];
  const networkErrors: string[] = [];
  let osvQueried: number | undefined;
  const wantsSupplyChain = categories.includes('supply-chain');
  if (wantsSupplyChain) {
    limitations.push(...parseErrorLimitations(profile));
    if ((opts.online || opts.offlineOsv) && !stopNow()) {
      progress(
        opts.offlineOsv
          ? 'looking up known vulnerabilities in the OSV cache'
          : 'querying OSV.dev for known vulnerabilities',
      );
      stage('osv', 'start');
      const osv = await queryOsv(profile.lockfiles, {
        cacheFile: opts.osvCache ?? (opts.noWrite ? undefined : workspace.path('cache', 'osv.json')),
        readOnlyCache: opts.noWrite,
        fetchImpl: opts.fetchImpl,
        onProgress: progress,
        apiBase: opts.osvApi,
        offline: opts.offlineOsv,
      });
      stage('osv', 'end');
      if (osv.unverified)
        limitations.push(
          `Known vulnerabilities were looked up in the OSV cache only (--offline-osv); ${osv.unverified} package(s) without a fresh cache entry are unverified.`,
        );
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
    } else if (!opts.online && profile.lockfiles.length) {
      limitations.push(
        `Known vulnerabilities in ${uniquePackageCount(profile.lockfiles)} locked package(s) were not checked (offline). --online sends only ecosystem, package name and version to OSV.dev — no source code.`,
      );
    }
  }

  let checks: CheckResult[] = [];
  const checkKinds = opts.checks ?? [];
  if (checkKinds.length && !stopNow()) {
    stage('checks', 'start');
    const planned = planChecks(files, profile, config, checkKinds);
    const exec = await runChecks(planned, {
      allowExec: !!opts.allowExec,
      timeoutSeconds: config.timeouts.commandSeconds,
      root: files.root,
      onProgress: progress,
    });
    stage('checks', 'end');
    checks = exec.results;
    for (const h of exec.hits) builder.add(h.rule, h.hit, h.provenance);
    if (!opts.allowExec && planned.length)
      limitations.push(
        `${planned.length} build/test/type-check command(s) were not executed (they run project code and require --allow-exec).`,
      );
    for (const c of checks)
      if (c.status === 'skipped' && opts.allowExec)
        limitations.push(`${c.kind} for \`${c.unit}\` was skipped: ${c.reason}.`);
    if (!planned.length) limitations.push(noCommandsLimitation(checkKinds, profile.workspaceRoot));
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
  let findings = builder.findings.sort(compareFindings);
  // --since: the whole tree was analysed (so cross-file taint stays right); only findings on changed lines are shown.
  let since: RunRecord['since'];
  if (changed) {
    const keep = findings.filter((f) => {
      const c = f.location ? changed.get(f.location.file) : undefined;
      if (!c) return false;
      if (c === 'all' || f.location!.line === undefined) return true;
      const end = Math.max(f.location!.line, f.location!.endLine ?? f.location!.line);
      for (let l = f.location!.line; l <= end; l++) if (c.has(l)) return true;
      return false;
    });
    limitations.push(
      `Only findings on lines changed since \`${opts.since}\` are shown (${findings.length - keep.length} findings outside them were hidden).`,
    );
    since = { ref: opts.since!, files: changed.size };
    findings = keep;
  }
  const gaps =
    categories.includes('testing') || categories.includes('quality')
      ? testGaps(files, findings, analysis.complexity, coverageReports)
      : [];

  const internalErrors = analysis.ruleErrors.filter((e) => e.rule !== 'relivaro-accept');
  const invalidAccepts = analysis.ruleErrors.length - internalErrors.length;
  if (internalErrors.length)
    limitations.push(
      `${internalErrors.length} internal rule error(s) occurred (see errors.rules in report.json); results for those rules are incomplete.`,
    );
  if (invalidAccepts)
    limitations.push(
      `${invalidAccepts} \`relivaro-accept\` comment(s) had no rule id or no reason and accepted nothing (see errors.rules in report.json).`,
    );
  if (opts.inlineSuppressions === false)
    limitations.push(
      'Inline relivaro-ignore/relivaro-accept comments in the audited code were not honoured (--no-inline-suppressions).',
    );
  if (analysis.parseErrors.length)
    limitations.push(
      `${analysis.parseErrors.length} file(s) could not be parsed and were analysed only by text rules.`,
    );
  const bigLockfiles = files.skippedPaths.tooLarge.filter((p) => classify(p).kind === 'lockfile');
  for (const p of bigLockfiles)
    limitations.push(
      `Lockfile \`${p}\` (${((files.skippedSizes.get(p) ?? 0) / 1024 / 1024).toFixed(1)} MB) exceeds maxLockfileSizeKb; its dependencies were not analysed.`,
    );
  const bigFiles = files.skippedPaths.tooLarge.filter((p) => !bigLockfiles.includes(p));
  if (bigFiles.length)
    limitations.push(
      `${bigFiles.length} file(s) larger than ${config.maxFileSizeKb} KB were skipped (${bigFiles
        .slice(0, 5)
        .map((p) => `\`${p}\``)
        .join(', ')}${bigFiles.length > 5 ? ', …' : ''}).`,
    );
  if (files.skipped.gitignored)
    limitations.push(
      `${files.walkLimits.gitignoredCapped ? 'At least ' : ''}${files.skipped.gitignored} file(s) ignored by .gitignore were not analysed (top entries: ${files.skippedPaths.gitignored
        .slice(0, 5)
        .join(
          ', ',
        )}${files.skippedPaths.gitignored.length > 5 ? ', …' : ''}); use --no-gitignore to include them.`,
    );
  if (files.walkLimits.truncated)
    limitations.push(
      'The file walk stopped at its limit of 200000 files; the rest of the tree was not listed or analysed.',
    );
  if (files.skipped.reports)
    limitations.push(
      `${files.skipped.reports} generated report file(s) from Relivaro, Jourilo or Searvex were not analysed.`,
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
    $schema: RUN_SCHEMA_URL,
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
      dependencies: uniquePackageCount(profile.lockfiles),
      dependencyEntries: profile.lockfiles.reduce((s, l) => s + l.packages.length, 0),
      osvQueried,
      filesSkipped: { ...files.skipped },
      coverage: analysis.coverage,
    },
    limitations: [
      ...(stopped
        ? [
            `The run stopped early (${stopped}); results cover ${analysis.filesAnalysed} of ${analysis.filesTotal} files and are incomplete.`,
          ]
        : []),
      ...new Set(limitations),
    ],
    ...(stopped ? { partial: { reason: stopped, at: new Date().toISOString() } } : {}),
    ...(since ? { since } : {}),
    errors: {
      parse: analysis.parseErrors.slice(0, 50),
      rules: analysis.ruleErrors.slice(0, 50),
      network: networkErrors.slice(0, 20),
    },
  };
  const labelled = opts.rootLabel ? relabelRoot(run, [files.realRoot, files.root], opts.rootLabel) : run;
  if (opts.release) labelled.release = assessRelease(labelled, config);
  labelled.durationMs = Math.round(performance.now() - started);
  return { run: labelled, config, workspace };
}

const CHECK_SCRIPT: Record<CheckKind, RegExp> = {
  build: /^build(?::|$)/,
  test: /^test(?::|$)/,
  typecheck: /^(?:typecheck|type-check|check-types|types|tsc)(?::|$)/,
  lint: /^lint(?::|$)/,
};

/** "No build/test commands were detected", naming the workspace root's scripts when a package is audited alone. */
export function noCommandsLimitation(kinds: CheckKind[], ws: ProjectProfile['workspaceRoot']): string {
  const defined = ws ? ws.scripts.filter((n) => kinds.some((k) => CHECK_SCRIPT[k].test(n))).sort() : [];
  if (!ws || !defined.length) return `No ${kinds.join('/')} commands were detected.`;
  const up = ws.rel
    .split('/')
    .map(() => '..')
    .join('/');
  return `No ${kinds.join('/')} commands were detected in the audited directory; the workspace root (\`${up}\`) defines: ${defined.join(', ')}. Run the audit from the workspace root to include them.`;
}

/**
 * Rewrites every occurrence of the absolute root paths (longest first) in all strings of the record, including
 * finding messages, snippets, limitations and errors, to `label`; `root` itself becomes the label.
 */
export function relabelRoot(run: RunRecord, roots: string[], label: string): RunRecord {
  let json = JSON.stringify(run);
  for (const r of [...new Set(roots)].sort((a, b) => b.length - a.length)) {
    const needle = JSON.stringify(r).slice(1, -1);
    if (needle) json = json.split(needle).join(JSON.stringify(label).slice(1, -1));
  }
  const out = JSON.parse(json) as RunRecord;
  out.root = label;
  out.profile.root = label;
  return out;
}

export function gateFailed(run: RunRecord, failOn: Severity | 'none'): boolean {
  if (failOn === 'none') return false;
  return run.findings.some(
    (f) =>
      f.status === 'open' && !f.accepted && severityAtLeast(f.severity, failOn) && f.confidence !== 'low',
  );
}
