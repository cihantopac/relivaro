import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
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

/**
 * The source text of the reported lines, taken from the finding's numbered snippet (`  12 | code`); undefined when
 * snippets are off or the reported line is not in it.
 */
function regionText(snippet: string | undefined, start: number, end: number): string | undefined {
  if (!snippet) return undefined;
  const picked: string[] = [];
  for (const l of snippet.split('\n')) {
    const m = /^\s*(\d+) \| (.*)$/.exec(l);
    if (m && Number(m[1]) >= start && Number(m[1]) <= end) picked.push(m[2]!);
  }
  return picked.length ? picked.join('\n') : undefined;
}

/** A remote URL without user name, password or token (`https://user:tok@host/x` → `https://host/x`). */
export function credentialFreeUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}

/** sha256 of every rule id with its default severity, so two runs with different rule sets are distinguishable. */
export function rulesetHash(): string {
  const text = allRuleMeta()
    .map((r) => `${r.id}:${r.severity}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(text).digest('hex');
}

function baseUri(root: string): string {
  if (isAbsolute(root)) {
    const href = pathToFileURL(root).href;
    return href.endsWith('/') ? href : `${href}/`;
  }
  return `file:///${encodeURI(root.replace(/^\/+|\/+$/g, ''))}/`;
}

export function toSarif(run: RunRecord, opts: { exitCode?: number } = {}): object {
  const exitCode = opts.exitCode ?? (run.partial ? 4 : 0);
  const vcs = run.profile.vcs;
  const used = new Set(run.findings.map((f) => f.ruleId));
  const rules = allRuleMeta().filter((r) => used.has(r.id));
  const index = new Map(rules.map((r, i) => [r.id, i]));
  // Code scanning requires a location on every result; project-level findings point at the main manifest.
  const fallbackUri =
    run.profile.manifests.find((m) => !m.file.includes('/'))?.file ?? run.profile.docs.readme ?? '.gitignore';
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
            properties: { rulesetHash: rulesetHash() },
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
        originalUriBaseIds: { '%SRCROOT%': { uri: baseUri(run.root) } },
        ...(vcs
          ? {
              versionControlProvenance: [
                {
                  ...(vcs.repositoryUri ? { repositoryUri: vcs.repositoryUri } : {}),
                  revisionId: vcs.revisionId,
                  ...(vcs.branch ? { branch: vcs.branch } : {}),
                },
              ],
            }
          : {}),
        invocations: [
          {
            exitCode,
            // A usage error or a partial run did not complete the analysis it was asked for.
            executionSuccessful: exitCode !== 2 && !run.partial,
            startTimeUtc: run.startedAt,
            endTimeUtc: new Date(Date.parse(run.startedAt) + run.durationMs).toISOString(),
          },
        ],
        results: run.findings
          .filter((f) => f.status !== 'baseline')
          .map((f) => result(f, index.get(f.ruleId), fallbackUri)),
      },
    ],
  };
}

function result(f: Finding, ruleIndex: number | undefined, fallbackUri: string): object {
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
  const factPath = typeof f.evidence.facts?.path === 'string' ? f.evidence.facts.path : undefined;
  const loc = f.location ?? { file: factPath ?? fallbackUri, line: 1 };
  const region: Record<string, unknown> = {};
  if (loc.line) region.startLine = loc.line;
  if (loc.column) region.startColumn = loc.column;
  if (loc.endLine && loc.endLine >= (loc.line ?? 0)) region.endLine = loc.endLine;
  const snippet = loc.line ? regionText(f.evidence.snippet, loc.line, loc.endLine ?? loc.line) : undefined;
  if (snippet !== undefined) region.snippet = { text: snippet };
  r.locations = [
    {
      physicalLocation: {
        artifactLocation: { uri: encodeURI(loc.file), uriBaseId: '%SRCROOT%' },
        ...(Object.keys(region).length ? { region } : {}),
      },
    },
  ];
  if (f.status === 'suppressed')
    r.suppressions = [{ kind: 'inSource', justification: f.suppression?.reason ?? '' }];
  else if (f.accepted)
    r.suppressions = [
      { kind: 'inSource', status: 'accepted', justification: `Accepted in code: ${f.accepted.reason}` },
    ];
  return r;
}
