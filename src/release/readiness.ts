import type { RunRecord } from '../audit.js';
import type { RelivaroConfig } from '../core/config.js';
import { type Finding, severityAtLeast } from '../core/types.js';
import { isTestPath } from '../fs/files.js';

export type GateStatus = 'pass' | 'warn' | 'block' | 'unverified' | 'n/a';

/** What a gate's status rests on, so a static "pass" is never mistaken for an executed or measured one. */
export type GateBasis = 'executed' | 'measured' | 'advisory-db' | 'static' | 'not-run';

export interface Gate {
  id: string;
  title: string;
  status: GateStatus;
  detail: string;
  findings?: string[];
  basis?: GateBasis;
}

export interface BenchSnapshot {
  name: string;
  kind: 'command' | 'http';
  stats: { meanMs: number; p95Ms: number; p99Ms?: number; errorRate?: number };
  measuredAt: string;
}

export interface ReleaseAssessment {
  status: 'ready' | 'ready-with-warnings' | 'needs-verification' | 'not-ready';
  score: number;
  /** The score is capped while blockers exist so a high number never hides a blocker. */
  scoreCapped: boolean;
  gates: Gate[];
  blockers: string[];
  warnings: string[];
  unverified: string[];
  passed: string[];
  tally: Record<GateStatus, number>;
  disclaimer: string;
}

/** "apps/web: " for a sub-project, nothing for the project root. */
const unitPrefix = (unit: string) => (unit === '.' ? '' : `${unit}: `);
/** Open findings that can block a release: an accepted risk (`relivaro-accept`) is shown but does not block. */
const open = (run: RunRecord) => run.findings.filter((f) => f.status === 'open' && !f.accepted);
const ids = (fs: Finding[]) => fs.map((f) => f.id);

function checkGate(
  run: RunRecord,
  kind: 'build' | 'test' | 'typecheck' | 'lint',
  title: string,
  failStatus: GateStatus,
): Gate {
  const cs = run.checks.filter((c) => c.kind === kind);
  const id = kind === 'test' ? 'tests' : kind;
  if (!run.options.checks.includes(kind))
    return {
      id,
      title,
      status: 'unverified',
      detail: `Not executed (run \`relivaro release --allow-exec\` to execute ${kind}).`,
    };
  if (!cs.length)
    return {
      id,
      title,
      status: kind === 'test' ? 'unverified' : 'n/a',
      detail: `No ${kind} command detected.`,
    };
  const failed = cs.filter((c) => c.status === 'failed' || c.status === 'error' || c.status === 'timeout');
  const skipped = cs.filter((c) => c.status === 'skipped');
  if (failed.length)
    return {
      id,
      title,
      status: failStatus,
      detail: failed
        .map(
          (c) =>
            `${unitPrefix(c.unit)}\`${c.command}\` ${c.status}${c.tests ? ` (${c.tests.failed}/${c.tests.total} tests failed)` : c.diagnostics ? ` (${c.diagnostics} errors)` : ''}`,
        )
        .join('; '),
      findings: ids(open(run).filter((f) => f.ruleId.startsWith('exec/'))),
    };
  if (skipped.length === cs.length)
    return {
      id,
      title,
      status: 'unverified',
      detail: skipped.map((c) => `${unitPrefix(c.unit)}${c.reason}`).join('; '),
    };
  const passed = cs.filter((c) => c.status === 'passed');
  const detail = passed
    .map(
      (c) =>
        `${unitPrefix(c.unit)}\`${c.command}\` passed in ${(c.durationMs / 1000).toFixed(1)}s${c.tests ? ` (${c.tests.passed} passed${c.tests.skipped ? `, ${c.tests.skipped} skipped` : ''})` : ''}`,
    )
    .join('; ');
  return {
    id,
    title,
    status: skipped.length ? 'warn' : 'pass',
    detail: skipped.length
      ? `${detail}; not run: ${skipped.map((c) => `${c.unit} (${c.reason})`).join(', ')}`
      : detail,
  };
}

export function assessRelease(
  run: RunRecord,
  config: RelivaroConfig,
  bench: BenchSnapshot[] = [],
): ReleaseAssessment {
  const gates: Gate[] = [];
  const all = open(run);
  const confident = (f: Finding) => f.confidence !== 'low';

  gates.push(checkGate(run, 'build', 'Build succeeds', 'block'));
  const testGate = checkGate(run, 'test', 'Automated tests pass', 'block');
  if (run.profile.tests.testFiles === 0) {
    testGate.status = config.release.requireTests ? 'block' : 'warn';
    testGate.detail = 'No automated test files were found.';
  }
  gates.push(testGate);
  const focused = all.filter((f) => f.ruleId === 'test/focused-test');
  if (focused.length)
    gates.push({
      id: 'focused-tests',
      title: 'No focused tests',
      status: 'block',
      detail: `${focused.length} focused test(s) (.only) make CI skip the rest of the suite.`,
      findings: ids(focused),
    });
  gates.push(checkGate(run, 'typecheck', 'Type checking passes', 'warn'));
  gates.push(checkGate(run, 'lint', 'Lint passes', 'warn'));

  const secrets = all.filter(
    (f) =>
      (f.ruleId === 'sec/hardcoded-secret' || f.ruleId === 'sec/env-file-committed') &&
      confident(f) &&
      severityAtLeast(f.severity, 'medium'),
  );
  gates.push(
    secrets.length
      ? {
          id: 'secrets',
          title: 'No exposed secrets',
          status: 'block',
          detail: `${secrets.length} credential exposure(s).`,
          findings: ids(secrets),
        }
      : {
          id: 'secrets',
          title: 'No exposed secrets',
          status: 'pass',
          detail: 'No secrets detected in analysed files.',
        },
  );

  const sec = all.filter(
    (f) =>
      (f.category === 'security' || f.category === 'supply-chain') &&
      f.ruleId !== 'sec/hardcoded-secret' &&
      f.ruleId !== 'sec/env-file-committed' &&
      f.ruleId !== 'sc/known-vulnerability',
  );
  const secBlock = sec.filter((f) => severityAtLeast(f.severity, config.release.blockOn) && confident(f));
  const secWarn = sec.filter(
    (f) => !secBlock.includes(f) && severityAtLeast(f.severity, 'medium') && confident(f),
  );
  gates.push(
    secBlock.length
      ? {
          id: 'security',
          title: 'No unresolved high-risk security findings',
          status: 'block',
          detail: `${secBlock.length} finding(s) at or above ${config.release.blockOn}: ${summarizeRules(secBlock)}.`,
          findings: ids(secBlock),
        }
      : secWarn.length
        ? {
            id: 'security',
            title: 'No unresolved high-risk security findings',
            status: 'warn',
            detail: `${secWarn.length} medium finding(s): ${summarizeRules(secWarn)}.`,
            findings: ids(secWarn),
          }
        : {
            id: 'security',
            title: 'No unresolved high-risk security findings',
            status: 'pass',
            detail: 'No security findings at medium or above with medium/high confidence.',
          },
  );

  const vulns = all.filter((f) => f.ruleId === 'sc/known-vulnerability');
  const depGateAt = gates.length;
  if (!run.options.online)
    gates.push({
      id: 'dependencies',
      title: 'No known-vulnerable dependencies',
      status: run.profile.lockfiles.length ? 'unverified' : 'n/a',
      detail: run.profile.lockfiles.length
        ? 'Not checked (offline). --online sends only ecosystem, package name and version to OSV.dev — no source code.'
        : 'No lockfiles to check.',
    });
  else if (run.errors.network.length)
    gates.push({
      id: 'dependencies',
      title: 'No known-vulnerable dependencies',
      status: 'unverified',
      detail: `OSV lookup failed: ${run.errors.network[0]}`,
    });
  else {
    const vb = vulns.filter((f) => severityAtLeast(f.severity, config.release.blockOn));
    gates.push(
      vb.length
        ? {
            id: 'dependencies',
            title: 'No known-vulnerable dependencies',
            status: 'block',
            detail: `${vb.length} advisories at or above ${config.release.blockOn} (of ${vulns.length} total).`,
            findings: ids(vb),
          }
        : vulns.length
          ? {
              id: 'dependencies',
              title: 'No known-vulnerable dependencies',
              status: 'warn',
              detail: `${vulns.length} lower-severity advisories.`,
              findings: ids(vulns),
            }
          : {
              id: 'dependencies',
              title: 'No known-vulnerable dependencies',
              status: 'pass',
              detail: `${run.metrics.osvQueried ?? 0} resolved packages checked against OSV.dev; no advisories.`,
            },
    );
  }

  // A lockfile or manifest that failed to parse leaves dependency risk unverified, but never hides a blocker.
  const unparsed = [...run.profile.lockfiles, ...run.profile.manifests]
    .filter((x) => x.error)
    .map((x) => x.file);
  const dep = gates[depGateAt];
  if (unparsed.length && dep) {
    const note = `Could not parse ${unparsed.join(', ')}; dependency risk is unverified.`;
    if (dep.status === 'block') dep.detail = `${dep.detail} ${note}`;
    else gates[depGateAt] = { ...dep, status: 'unverified', detail: note };
  }

  const lock = all.filter((f) =>
    /^sc\/(?:missing-lockfile|lockfile-out-of-sync|multiple-lockfiles|non-registry-dependency|unpinned-dependency)$/.test(
      f.ruleId,
    ),
  );
  gates.push(
    lock.length
      ? {
          id: 'reproducible-builds',
          title: 'Reproducible dependency installs',
          status: 'warn',
          detail: summarizeRules(lock),
          findings: ids(lock),
        }
      : {
          id: 'reproducible-builds',
          title: 'Reproducible dependency installs',
          status: 'pass',
          detail: `${run.profile.lockfiles.length} lockfile(s), consistent with manifests.`,
        },
  );

  const ci = run.profile.ci;
  if (!ci.length)
    gates.push({
      id: 'ci',
      title: 'CI runs tests on every change',
      status: config.release.requireCi ? 'warn' : 'n/a',
      detail: 'No CI configuration found.',
    });
  else {
    const runsTests = ci.some((c) => c.runsTests);
    const ciFindings = all.filter((f) => /^sec\/gha-/.test(f.ruleId) && severityAtLeast(f.severity, 'high'));
    gates.push({
      id: 'ci',
      title: 'CI runs tests on every change',
      status: ciFindings.length ? 'block' : runsTests ? 'pass' : 'warn',
      detail: ciFindings.length
        ? `CI workflow vulnerabilities: ${summarizeRules(ciFindings)}.`
        : runsTests
          ? `${ci
              .map((c) => c.system)
              .filter((v, i, a) => a.indexOf(v) === i)
              .join(', ')} configured and runs tests.`
          : 'CI is configured but no test step was detected.',
      findings: ciFindings.length ? ids(ciFindings) : undefined,
    });
  }

  const reliability = all.filter((f) => f.category === 'reliability' && confident(f));
  const relBlock = reliability.filter((f) => severityAtLeast(f.severity, 'high'));
  const migrations = reliability.filter((f) => /migration/.test(f.ruleId));
  gates.push(
    relBlock.length
      ? {
          id: 'reliability',
          title: 'No high-risk reliability defects',
          status: 'block',
          detail: summarizeRules(relBlock),
          findings: ids(relBlock),
        }
      : reliability.filter((f) => severityAtLeast(f.severity, 'medium') && !migrations.includes(f)).length
        ? {
            id: 'reliability',
            title: 'No high-risk reliability defects',
            status: 'warn',
            detail: summarizeRules(
              reliability.filter((f) => severityAtLeast(f.severity, 'medium') && !migrations.includes(f)),
            ),
            findings: ids(
              reliability.filter((f) => severityAtLeast(f.severity, 'medium') && !migrations.includes(f)),
            ),
          }
        : {
            id: 'reliability',
            title: 'No high-risk reliability defects',
            status: 'pass',
            detail: 'No medium or higher reliability findings.',
          },
  );
  gates.push(
    migrations.length
      ? {
          id: 'migrations',
          title: 'Database migrations are safe to deploy and roll back',
          status: 'warn',
          detail: `${migrations.length} destructive/irreversible migration step(s); verify backups and expand/contract sequencing.`,
          findings: ids(migrations),
        }
      : {
          id: 'migrations',
          title: 'Database migrations are safe to deploy and roll back',
          status: run.profile.migrations.length ? 'pass' : 'n/a',
          detail: run.profile.migrations.length
            ? `${run.profile.migrations.length} migration file(s) analysed; no destructive steps detected.`
            : 'No migrations found.',
        },
  );

  const undocumented = run.profile.envVars.filter(
    (v) => v.required && !v.documented && !config.env.optional.includes(v.name),
  );
  gates.push(
    undocumented.length
      ? {
          id: 'configuration',
          title: 'Required environment variables are documented',
          status: 'warn',
          detail: `${undocumented.length} required variable(s) are read without a default but not documented in an env template/README: ${undocumented
            .slice(0, 15)
            .map((v) => v.name)
            .join(', ')}${undocumented.length > 15 ? ', …' : ''}.`,
        }
      : {
          id: 'configuration',
          title: 'Required environment variables are documented',
          status: run.profile.envVars.length ? 'pass' : 'n/a',
          detail: run.profile.envVars.length
            ? `${run.profile.envVars.length} environment variable(s) detected; all required ones documented.`
            : 'No environment variables read by the code.',
        },
  );

  const eol = all.filter((f) => f.ruleId === 'sc/end-of-life-runtime');
  gates.push(
    eol.length
      ? {
          id: 'runtime-support',
          title: 'Supported runtimes and frameworks',
          status: 'warn',
          detail: eol
            .map((f) => f.message)
            .slice(0, 4)
            .join(' '),
          findings: ids(eol),
        }
      : {
          id: 'runtime-support',
          title: 'Supported runtimes and frameworks',
          status: 'pass',
          detail: 'No end-of-life runtime or framework versions detected.',
        },
  );

  const ops = all.filter((f) =>
    /^rel\/(?:no-health-check|no-error-monitoring|no-graceful-shutdown)$/.test(f.ruleId),
  );
  const deployable = run.profile.units.some(
    (u) =>
      (u.path === '.' || !isTestPath(`${u.path}/`)) &&
      ['web-backend', 'fullstack', 'mobile'].includes(u.kind),
  );
  gates.push(
    ops.length
      ? {
          id: 'operability',
          title: 'Operational readiness (health checks, monitoring, shutdown)',
          status: 'warn',
          detail: summarizeRules(ops),
          findings: ids(ops),
        }
      : {
          id: 'operability',
          title: 'Operational readiness (health checks, monitoring, shutdown)',
          status: deployable ? 'pass' : 'n/a',
          detail: deployable
            ? 'Health checks, error monitoring and shutdown handling detected where applicable.'
            : 'No deployable service detected.',
        },
  );

  const budgets = Object.entries(config.performance.budgets);
  if (!budgets.length)
    gates.push({
      id: 'performance',
      title: 'Performance budgets met',
      status: 'unverified',
      detail:
        'No performance budgets configured (performance.budgets) — see `relivaro bench` / `relivaro load`.',
    });
  else {
    const failures: string[] = [];
    const missing: string[] = [];
    for (const [name, b] of budgets) {
      const snap = bench.find((s) => s.name === name);
      if (!snap) {
        missing.push(name);
        continue;
      }
      if (b.meanMs !== undefined && snap.stats.meanMs > b.meanMs)
        failures.push(`${name}: mean ${snap.stats.meanMs.toFixed(1)}ms > ${b.meanMs}ms`);
      if (b.p95Ms !== undefined && snap.stats.p95Ms > b.p95Ms)
        failures.push(`${name}: p95 ${snap.stats.p95Ms.toFixed(1)}ms > ${b.p95Ms}ms`);
      if (b.p99Ms !== undefined && snap.stats.p99Ms !== undefined && snap.stats.p99Ms > b.p99Ms)
        failures.push(`${name}: p99 ${snap.stats.p99Ms.toFixed(1)}ms > ${b.p99Ms}ms`);
      if (b.errorRate !== undefined && (snap.stats.errorRate ?? 0) > b.errorRate)
        failures.push(
          `${name}: error rate ${((snap.stats.errorRate ?? 0) * 100).toFixed(2)}% > ${(b.errorRate * 100).toFixed(2)}%`,
        );
    }
    gates.push({
      id: 'performance',
      title: 'Performance budgets met',
      status: failures.length ? 'block' : missing.length ? 'unverified' : 'pass',
      detail: failures.length
        ? failures.join('; ')
        : missing.length
          ? `No measurement for: ${missing.join(', ')}.`
          : `${budgets.length} budget(s) met by the latest measurements.`,
    });
  }

  if (config.release.minCoverage !== undefined) {
    const cov = run.coverage[0];
    gates.push(
      !cov
        ? {
            id: 'coverage',
            title: `Line coverage ≥ ${config.release.minCoverage}%`,
            status: 'unverified',
            detail: 'No coverage report found (lcov/clover/cobertura).',
          }
        : {
            id: 'coverage',
            title: `Line coverage ≥ ${config.release.minCoverage}%`,
            status: cov.pct >= config.release.minCoverage ? (cov.stale ? 'warn' : 'pass') : 'block',
            detail: `${cov.pct}% in ${cov.file}${cov.stale ? ' (report older than latest source change)' : ''}.`,
          },
    );
  }

  const d = run.profile.docs;
  const docIssues = [
    !d.readme && 'no README',
    d.readme && d.readmeBytes < 400 && 'README is very short',
    !d.license && 'no LICENSE file',
  ].filter(Boolean) as string[];
  gates.push({
    id: 'documentation',
    title: 'Installation and usage documentation',
    status: docIssues.length ? 'warn' : 'pass',
    detail: docIssues.length
      ? docIssues.join(', ')
      : `README (${Math.round(d.readmeBytes / 1024)} KB)${d.license ? ', LICENSE' : ''}${d.changelog ? ', CHANGELOG' : ''}${d.security ? ', SECURITY policy' : ''}.`,
  });

  // A partial run never looks clean: it adds an unverified gate and caps the verdict at needs-verification.
  if (run.partial)
    gates.unshift({
      id: 'complete',
      title: 'The analysis covered the whole project',
      status: 'unverified',
      detail: `The run stopped early (${run.partial.reason}); findings and gates cover only part of the project.`,
    });
  for (const g of gates) g.basis = gateBasis(run, g, bench);
  const blockers = gates.filter((g) => g.status === 'block');
  const warnings = gates.filter((g) => g.status === 'warn');
  const unverified = gates.filter((g) => g.status === 'unverified');
  const passed = gates.filter((g) => g.status === 'pass');
  let score = 100 - blockers.length * 20 - warnings.length * 5 - unverified.length * 3;
  const sevPenalty = all
    .filter(confident)
    .reduce((s, f) => s + ({ critical: 6, high: 3, medium: 1, low: 0.2, info: 0 } as const)[f.severity], 0);
  score -= Math.min(sevPenalty, 30);
  score = Math.max(0, Math.round(score));
  const scoreCapped = blockers.length > 0 && score > 40;
  if (blockers.length) score = Math.min(score, 40);
  const critUnverified =
    !!run.partial || gates.some((g) => (g.id === 'build' || g.id === 'tests') && g.status === 'unverified');
  const status: ReleaseAssessment['status'] = blockers.length
    ? 'not-ready'
    : critUnverified
      ? 'needs-verification'
      : warnings.length || unverified.length
        ? 'ready-with-warnings'
        : 'ready';
  const tally = { pass: 0, warn: 0, block: 0, unverified: 0, 'n/a': 0 } as Record<GateStatus, number>;
  for (const g of gates) tally[g.status]++;
  return {
    status,
    score,
    scoreCapped,
    gates,
    blockers: blockers.map((g) => `${g.title}: ${g.detail}`),
    warnings: warnings.map((g) => `${g.title}: ${g.detail}`),
    unverified: unverified.map((g) => `${g.title}: ${g.detail}`),
    passed: passed.map((g) => g.title),
    tally,
    disclaimer:
      'This assessment is based on automated checks and their stated limitations. Passing it does not prove the software is free of vulnerabilities or defects.',
  };
}

function gateBasis(run: RunRecord, g: Gate, bench: BenchSnapshot[]): GateBasis {
  if (g.status === 'unverified' && g.id !== 'tests') return 'not-run';
  const kind = ({ build: 'build', tests: 'test', typecheck: 'typecheck', lint: 'lint' } as const)[
    g.id as 'build'
  ];
  if (kind)
    return run.checks.some((c) => c.kind === kind && c.status !== 'skipped')
      ? 'executed'
      : g.status === 'unverified'
        ? 'not-run'
        : 'static';
  if (g.id === 'dependencies') return g.status === 'n/a' ? 'static' : 'advisory-db';
  if (g.id === 'performance') return bench.length ? 'measured' : 'not-run';
  if (g.id === 'coverage') return 'measured';
  return 'static';
}

/** One-line gate count, e.g. "9 passed · 2 warnings · 3 unverified · 0 blockers". */
export function releaseTally(r: ReleaseAssessment): string {
  const t = r.tally ?? {
    pass: r.passed.length,
    warn: r.warnings.length,
    block: r.blockers.length,
    unverified: r.unverified.length,
    'n/a': 0,
  };
  return `${t.pass} passed · ${t.warn} warning${t.warn === 1 ? '' : 's'} · ${t.unverified} unverified · ${t.block} blocker${t.block === 1 ? '' : 's'}`;
}

function summarizeRules(fs: Finding[]): string {
  const counts = new Map<string, number>();
  for (const f of fs) counts.set(f.title, (counts.get(f.title) ?? 0) + 1);
  return [...counts.entries()].map(([t, n]) => `${t} ×${n}`).join(', ');
}
