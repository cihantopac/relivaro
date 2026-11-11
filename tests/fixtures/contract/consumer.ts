// Type-checked by `npm run typecheck`: a consumer of the published package resolves `relivaro` through package.json
// "exports"/"types" to plugin/dist/api.d.ts, and this file must compile against it.
import {
  type AuditOptions,
  assessRelease,
  compareRuns,
  type Finding,
  type RunRecord,
  runAudit,
  toSarif,
} from 'relivaro';

export async function consume(root: string): Promise<string[]> {
  const opts: AuditOptions = { root, command: 'audit', noWrite: true, rootLabel: 'repo', snippetLines: 0 };
  const { run } = await runAudit(opts);
  const high: Finding[] = run.findings.filter((f) => f.severity === 'high' || f.severity === 'critical');
  const sarif = toSarif(run, { exitCode: 0 });
  const diff = compareRuns(run, run);
  const release = assessRelease(run);
  const r: RunRecord = run;
  return [
    r.runId,
    String(sarif.version),
    String(diff.introduced.length),
    release.status,
    ...high.map((f) => f.id),
  ];
}
