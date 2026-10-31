import type { RunRecord } from '../audit.js';
import { type Finding, SEVERITIES } from '../core/types.js';

const ICON: Record<string, string> = { block: '⛔', warn: '⚠️', pass: '✅', unverified: '❔', 'n/a': '➖' };

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function loc(f: Finding): string {
  if (!f.location) return '—';
  return `\`${f.location.file}${f.location.line ? `:${f.location.line}` : ''}\``;
}

export function toMarkdown(run: RunRecord, opts: { maxFindings?: number } = {}): string {
  const max = opts.maxFindings ?? 200;
  const p = run.profile;
  const s = run.summary;
  const L: string[] = [];
  L.push(`# Relivaro report — ${p.name}`);
  L.push('');
  L.push(`Run \`${run.runId}\` · \`relivaro ${run.command}\` · Relivaro ${run.tool.version} · ${run.startedAt} · ${(run.durationMs / 1000).toFixed(1)}s`);
  L.push('');
  if (run.release) {
    const r = run.release;
    L.push(`## Release readiness: **${r.status.toUpperCase().replace(/-/g, ' ')}** (score ${r.score}/100${r.scoreCapped ? ', capped by blockers' : ''})`);
    L.push('');
    L.push('| Gate | Status | Detail |');
    L.push('| --- | --- | --- |');
    for (const g of r.gates) L.push(`| ${esc(g.title)} | ${ICON[g.status]} ${g.status} | ${esc(g.detail)} |`);
    L.push('');
    L.push(`> ${r.disclaimer}`);
    L.push('');
  }
  L.push('## Summary');
  L.push('');
  L.push(`**${s.open} open findings** (${SEVERITIES.map((x) => `${s.bySeverity[x]} ${x}`).join(', ')})${s.suppressed ? ` · ${s.suppressed} suppressed` : ''}${s.baseline ? ` · ${s.baseline} in baseline` : ''}.`);
  L.push('');
  L.push(`Analysed ${run.metrics.files} files (${run.metrics.linesOfCode.toLocaleString('en-US')} lines, ${run.metrics.parsedFiles} parsed to syntax trees) with ${run.metrics.rulesRun} rules in ${(run.metrics.analysisMs / 1000).toFixed(1)}s.`);
  L.push('');
  L.push('## Project');
  L.push('');
  L.push(`- **Languages:** ${p.languages.slice(0, 8).map((l) => `${l.name} (${l.files} files)`).join(', ') || '—'}`);
  L.push(`- **Units:** ${p.units.map((u) => `\`${u.path}\` ${u.frameworks.join('/') || u.kind}`).join(', ')}${p.monorepo ? ' (monorepo)' : ''}`);
  const tech = (k: string) => [...new Set(p.technologies.filter((t) => t.kind === k).map((t) => t.name))].join(', ');
  for (const [label, kind] of [['Data', 'database'], ['ORM', 'orm'], ['Queues', 'queue'], ['Cache', 'cache'], ['Auth', 'auth'], ['Observability', 'observability'], ['Payments', 'payments'], ['Integrations', 'integration']] as const) {
    const t = tech(kind);
    if (t) L.push(`- **${label}:** ${t}`);
  }
  L.push(`- **Tests:** ${p.tests.testFiles} test files / ${p.tests.sourceFiles} source files${p.tests.frameworks.length ? ` (${p.tests.frameworks.join(', ')})` : ''}`);
  L.push(`- **CI/CD:** ${[...new Set(p.ci.map((c) => c.system))].join(', ') || 'none'}${p.deploy.length ? ` · deploy: ${p.deploy.map((d) => d.kind).join(', ')}` : ''}${p.containers.dockerfiles.length ? ` · ${p.containers.dockerfiles.length} Dockerfile(s)` : ''}`);
  L.push(`- **API surface:** ${p.api.routes} route definitions${p.api.specs.length ? ` · specs: ${p.api.specs.join(', ')}` : ''}`);
  L.push('');
  if (run.checks.length) {
    L.push('## Executed checks');
    L.push('');
    L.push('| Check | Unit | Command | Result | Time |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const c of run.checks) L.push(`| ${c.kind} | \`${c.unit}\` | \`${esc(c.command)}\` | ${c.status}${c.tests ? ` (${c.tests.passed}✓ ${c.tests.failed}✗ ${c.tests.skipped}↷)` : ''}${c.reason ? ` — ${esc(c.reason)}` : ''} | ${(c.durationMs / 1000).toFixed(1)}s |`);
    L.push('');
  }
  const openF = run.findings.filter((f) => f.status === 'open');
  L.push(`## Findings (${openF.length})`);
  L.push('');
  if (!openF.length) L.push('No open findings.');
  for (const f of openF.slice(0, max)) {
    L.push(`### ${f.severity.toUpperCase()} · ${esc(f.title)} — ${loc(f)}`);
    L.push('');
    L.push(`\`${f.id}\` · rule \`${f.ruleId}\` · confidence ${f.confidence} · ${f.provenance}${f.cwe?.length ? ` · ${f.cwe.join(', ')}` : ''}${f.owasp?.length ? ` · ${f.owasp.join('; ')}` : ''}`);
    L.push('');
    L.push(f.message);
    L.push('');
    if (f.evidence.snippet) {
      L.push('```');
      L.push(f.evidence.snippet);
      L.push('```');
      L.push('');
    }
    if (f.evidence.command) L.push(`Command: \`${f.evidence.command}\``);
    L.push(`- **Impact:** ${f.impact}`);
    L.push(`- **Fix:** ${f.recommendation}${f.fixer ? ` (automated fix available: \`relivaro fix plan --finding ${f.id}\`)` : ''}`);
    L.push(`- **Verify:** ${f.verification}`);
    L.push('');
  }
  if (openF.length > max) L.push(`… ${openF.length - max} more findings in report.json.`);
  if (run.testGaps.length) {
    L.push('## Untested high-risk code (heuristic)');
    L.push('');
    for (const g of run.testGaps.slice(0, 15)) L.push(`- \`${g.file}\` — risk ${g.risk}: ${g.reasons.join(', ')}`);
    L.push('');
  }
  if (run.coverage.length) {
    L.push('## Coverage (existing reports)');
    L.push('');
    for (const c of run.coverage) L.push(`- \`${c.file}\` (${c.format}): ${c.pct}% lines (${c.covered}/${c.total}), generated ${c.generatedAt}${c.stale ? ' — **stale**' : ''}`);
    L.push('');
  }
  if (run.limitations.length) {
    L.push('## Limitations and unverified areas');
    L.push('');
    for (const l of run.limitations) L.push(`- ${l}`);
    L.push('');
  }
  return `${L.join('\n')}\n`;
}
