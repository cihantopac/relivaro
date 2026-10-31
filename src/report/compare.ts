import type { RunRecord } from '../audit.js';
import { compareFindings, type Finding } from '../core/types.js';

export interface RunComparison {
  base: { runId: string; startedAt: string; open: number };
  head: { runId: string; startedAt: string; open: number };
  introduced: Finding[];
  resolved: Finding[];
  persisting: number;
  checkRegressions: string[];
  checkImprovements: string[];
  releaseChange?: { from: string; to: string; scoreFrom: number; scoreTo: number };
}

/** Compares two runs by finding fingerprint (stable across line shifts) and by executed check outcomes. */
export function compareRuns(base: RunRecord, head: RunRecord): RunComparison {
  const openB = base.findings.filter((f) => f.status === 'open');
  const openH = head.findings.filter((f) => f.status === 'open');
  const fb = new Set(openB.map((f) => f.fingerprint));
  const fh = new Set(openH.map((f) => f.fingerprint));
  const introduced = openH.filter((f) => !fb.has(f.fingerprint)).sort(compareFindings);
  // A finding only counts as resolved if its category was analysed in the head run.
  const resolved = openB.filter((f) => !fh.has(f.fingerprint) && head.options.categories.includes(f.category)).sort(compareFindings);
  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const c of head.checks) {
    const prev = base.checks.find((x) => x.kind === c.kind && x.unit === c.unit);
    if (!prev || prev.status === 'skipped' || c.status === 'skipped') continue;
    if (prev.status === 'passed' && c.status !== 'passed') regressions.push(`${c.kind} (${c.unit}) passed before and is now ${c.status}`);
    if (prev.status !== 'passed' && c.status === 'passed') improvements.push(`${c.kind} (${c.unit}) now passes`);
    if (prev.tests && c.tests && c.tests.failed > prev.tests.failed) regressions.push(`${c.kind} (${c.unit}) failing tests ${prev.tests.failed} → ${c.tests.failed}`);
    if (c.durationMs > prev.durationMs * 1.5 && c.durationMs - prev.durationMs > 5000) regressions.push(`${c.kind} (${c.unit}) duration ${(prev.durationMs / 1000).toFixed(1)}s → ${(c.durationMs / 1000).toFixed(1)}s`);
  }
  const out: RunComparison = {
    base: { runId: base.runId, startedAt: base.startedAt, open: openB.length },
    head: { runId: head.runId, startedAt: head.startedAt, open: openH.length },
    introduced,
    resolved,
    persisting: openH.filter((f) => fb.has(f.fingerprint)).length,
    checkRegressions: regressions,
    checkImprovements: improvements,
  };
  if (base.release && head.release) out.releaseChange = { from: base.release.status, to: head.release.status, scoreFrom: base.release.score, scoreTo: head.release.score };
  return out;
}
