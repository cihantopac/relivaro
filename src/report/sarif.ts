import type { RunRecord } from '../audit.js';
import type { Finding, Severity } from '../core/types.js';
import { allRuleMeta } from '../rules/index.js';

/** SARIF 2.1.0 output for GitHub code scanning and other CI integrations. */

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'note',
  info: 'note',
};
const SECURITY_SEVERITY: Record<Severity, string> = {
  critical: '9.5',
  high: '8.0',
  medium: '5.5',
  low: '3.0',
  info: '0.0',
};

export function toSarif(run: RunRecord): object {
  const used = new Set(run.findings.map((f) => f.ruleId));
  const rules = allRuleMeta().filter((r) => used.has(r.id));
  const index = new Map(rules.map((r, i) => [r.id, i]));
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Relivaro',
            version: run.tool.version,
            semanticVersion: run.tool.version,
            informationUri: 'https://github.com/cihantopac/relivaro',
            rules: rules.map((r) => ({
              id: r.id,
              name: r.id.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) =>
                c ? c.toUpperCase() : '',
              ),
              shortDescription: { text: r.title },
              fullDescription: { text: r.description },
              help: {
                text: `${r.recommendation}\n\nVerification: ${r.verification}`,
                markdown: `**Impact:** ${r.impact}\n\n**Fix:** ${r.recommendation}\n\n**Verify:** ${r.verification}`,
              },
              defaultConfiguration: { level: LEVEL[r.severity] },
              properties: {
                tags: [
                  r.category,
                  ...(r.cwe ?? []).map((c) => `external/cwe/${c.toLowerCase()}`),
                  ...(r.tags ?? []),
                ],
                precision: r.confidence === 'high' ? 'high' : r.confidence === 'medium' ? 'medium' : 'low',
                ...(r.category === 'security' || r.category === 'supply-chain'
                  ? { 'security-severity': SECURITY_SEVERITY[r.severity] }
                  : {}),
              },
            })),
          },
        },
        automationDetails: { id: `relivaro/${run.command}/` },
        invocations: [{ executionSuccessful: true, startTimeUtc: run.startedAt }],
        results: run.findings
          .filter((f) => f.status !== 'baseline')
          .map((f) => result(f, index.get(f.ruleId))),
      },
    ],
  };
}

function result(f: Finding, ruleIndex: number | undefined): object {
  const r: Record<string, unknown> = {
    ruleId: f.ruleId,
    level: LEVEL[f.severity],
    message: { text: `${f.message} ${f.recommendation}`.trim() },
    partialFingerprints: { 'relivaro/v1': f.fingerprint },
    properties: {
      severity: f.severity,
      confidence: f.confidence,
      category: f.category,
      provenance: f.provenance,
      findingId: f.id,
    },
  };
  if (ruleIndex !== undefined) r.ruleIndex = ruleIndex;
  if (f.location) {
    const region: Record<string, number> = {};
    if (f.location.line) region.startLine = f.location.line;
    if (f.location.column) region.startColumn = f.location.column;
    if (f.location.endLine && f.location.endLine >= (f.location.line ?? 0))
      region.endLine = f.location.endLine;
    r.locations = [
      {
        physicalLocation: {
          artifactLocation: { uri: encodeURI(f.location.file), uriBaseId: '%SRCROOT%' },
          ...(Object.keys(region).length ? { region } : {}),
        },
      },
    ];
  }
  if (f.status === 'suppressed')
    r.suppressions = [{ kind: 'inSource', justification: f.suppression?.reason ?? '' }];
  return r;
}
