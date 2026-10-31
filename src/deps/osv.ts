import { existsSync, readFileSync, statSync } from 'node:fs';
import { RelivaroError } from '../core/errors.js';
import type { Severity } from '../core/types.js';
import { atomicWrite } from '../core/workspace.js';
import { registerExternalRule } from '../rules/index.js';
import type { Hit } from '../rules/types.js';
import type { LockfileInfo, ResolvedPackage } from './lockfiles.js';

/**
 * Known-vulnerability lookup against OSV.dev (https://osv.dev), the open vulnerability database aggregating
 * GitHub Advisories, PyPA, Go, RustSec, Packagist (FriendsOfPHP) and others.
 *
 * Only runs with `--online`. Data sent: ecosystem, package name and version of each resolved dependency — no source
 * code, no file paths. Responses are cached for 24 hours in the workspace.
 */

export const OSV_RULE = registerExternalRule({
  id: 'sc/known-vulnerability',
  title: 'Dependency with a known vulnerability',
  category: 'supply-chain',
  severity: 'high',
  confidence: 'high',
  cwe: ['CWE-1395'],
  owasp: ['A03:2025 Software Supply Chain Failures'],
  description: 'A resolved dependency version is affected by a published advisory in OSV.dev.',
  impact:
    'Known vulnerabilities have public details and often public exploits; whether this one is exploitable depends on how the package is used.',
  recommendation:
    "Upgrade to a fixed version (listed in the finding), or apply the advisory's mitigation. If the vulnerable code path is provably unreachable, document the exception with a suppression reason.",
  verification:
    'Re-run `relivaro security --online`; the advisory no longer matches the resolved version in the lockfile.',
  references: ['https://osv.dev'],
});

const API = 'https://api.osv.dev/v1';
const BATCH = 500;

export interface OsvVuln {
  id: string;
  summary?: string;
  aliases?: string[];
  severity?: { type: string; score: string }[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
  affected?: {
    package?: { name?: string; ecosystem?: string };
    ranges?: { type: string; events: Record<string, string>[] }[];
    versions?: string[];
    ecosystem_specific?: { severity?: string };
  }[];
  withdrawn?: string;
}

export interface OsvResult {
  queried: number;
  vulnerable: number;
  hits: Hit[];
  errors: string[];
}

type FetchLike = typeof fetch;

async function postJson(fetchImpl: FetchLike, url: string, body: unknown): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'relivaro' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new RelivaroError('NETWORK_FAILED', `OSV ${url} returned HTTP ${res.status}`);
  return res.json();
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': 'relivaro' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new RelivaroError('NETWORK_FAILED', `OSV ${url} returned HTTP ${res.status}`);
  return res.json();
}

/** CVSS v3.x base score from a vector string (FIRST specification). */
export function cvss3Score(vector: string): number | undefined {
  const m = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((p) => p.split(':') as [string, string]),
  );
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[m.AV as 'N'];
  const AC = { L: 0.77, H: 0.44 }[m.AC as 'L'];
  const UI = { N: 0.85, R: 0.62 }[m.UI as 'N'];
  const changed = m.S === 'C';
  const PR = changed ? { N: 0.85, L: 0.68, H: 0.5 }[m.PR as 'N'] : { N: 0.85, L: 0.62, H: 0.27 }[m.PR as 'N'];
  const cia = (x: string) => ({ H: 0.56, L: 0.22, N: 0 })[x as 'H'];
  const C = cia(m.C!);
  const I = cia(m.I!);
  const A = cia(m.A!);
  if ([AV, AC, UI, PR, C, I, A].some((x) => x === undefined)) return undefined;
  const iss = 1 - (1 - C!) * (1 - I!) * (1 - A!);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  const exploit = 8.22 * AV! * AC! * PR! * UI!;
  if (impact <= 0) return 0;
  const raw = changed ? Math.min(1.08 * (impact + exploit), 10) : Math.min(impact + exploit, 10);
  return Math.ceil(raw * 10) / 10;
}

export function severityOf(v: OsvVuln): Severity {
  const label = (
    v.database_specific?.severity ??
    v.affected?.[0]?.ecosystem_specific?.severity ??
    ''
  ).toUpperCase();
  if (label === 'CRITICAL') return 'critical';
  if (label === 'HIGH') return 'high';
  if (label === 'MODERATE' || label === 'MEDIUM') return 'medium';
  if (label === 'LOW') return 'low';
  for (const s of v.severity ?? []) {
    if (!/^CVSS_V3/.test(s.type)) continue;
    const score = cvss3Score(s.score);
    if (score === undefined) continue;
    return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'info';
  }
  return 'medium';
}

export function fixedVersions(v: OsvVuln, pkg: string): string[] {
  const out = new Set<string>();
  for (const a of v.affected ?? []) {
    if (a.package?.name && a.package.name.toLowerCase() !== pkg.toLowerCase()) continue;
    for (const r of a.ranges ?? []) for (const e of r.events) if (e.fixed) out.add(e.fixed);
  }
  return [...out];
}

export async function queryOsv(
  lockfiles: LockfileInfo[],
  opts: { cacheFile?: string; fetchImpl?: FetchLike; onProgress?: (m: string) => void } = {},
): Promise<OsvResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const unique = new Map<string, { pkg: ResolvedPackage; files: Set<string> }>();
  for (const l of lockfiles)
    for (const p of l.packages) {
      if (!/^(?:npm|Packagist|PyPI|Go|crates\.io|RubyGems|Pub|Maven)$/.test(p.ecosystem)) continue;
      const key = `${p.ecosystem}\u0000${p.name}\u0000${p.version}`;
      const e = unique.get(key) ?? { pkg: p, files: new Set<string>() };
      e.files.add(l.file);
      unique.set(key, e);
    }
  const entries = [...unique.values()];
  const result: OsvResult = { queried: entries.length, vulnerable: 0, hits: [], errors: [] };
  if (!entries.length) return result;

  let cache: Record<string, { at: number; vuln: OsvVuln }> = {};
  if (opts.cacheFile && existsSync(opts.cacheFile)) {
    try {
      if (Date.now() - statSync(opts.cacheFile).mtimeMs < 24 * 3600_000)
        cache = JSON.parse(readFileSync(opts.cacheFile, 'utf8'));
    } catch {
      cache = {};
    }
  }

  const idsPer: string[][] = new Array(entries.length).fill(null).map(() => []);
  for (let i = 0; i < entries.length; i += BATCH) {
    const slice = entries.slice(i, i + BATCH);
    opts.onProgress?.(`OSV: querying ${i + slice.length}/${entries.length} packages`);
    const body = {
      queries: slice.map((e) => ({
        package: { name: e.pkg.name, ecosystem: e.pkg.ecosystem },
        version: e.pkg.version.replace(/^v(?=\d)/, e.pkg.ecosystem === 'Go' ? 'v' : ''),
      })),
    };
    try {
      const res = (await postJson(fetchImpl, `${API}/querybatch`, body)) as {
        results?: { vulns?: { id: string }[] }[];
      };
      (res.results ?? []).forEach((r, j) => {
        idsPer[i + j] = (r.vulns ?? []).map((v) => v.id);
      });
    } catch (e) {
      result.errors.push((e as Error).message);
      return result;
    }
  }

  const allIds = [...new Set(idsPer.flat())];
  const details = new Map<string, OsvVuln>();
  const todo = allIds.filter((id) => {
    const c = cache[id];
    if (c) details.set(id, c.vuln);
    return !c;
  });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, todo.length) }, async () => {
      while (next < todo.length) {
        const id = todo[next++]!;
        try {
          const v = (await getJson(fetchImpl, `${API}/vulns/${encodeURIComponent(id)}`)) as OsvVuln;
          details.set(id, v);
          cache[id] = { at: Date.now(), vuln: v };
        } catch (e) {
          result.errors.push(`${id}: ${(e as Error).message}`);
        }
      }
    }),
  );
  if (opts.cacheFile && todo.length) {
    try {
      atomicWrite(opts.cacheFile, JSON.stringify(cache));
    } catch {
      /* cache is best-effort */
    }
  }

  entries.forEach((e, i) => {
    const ids = idsPer[i] ?? [];
    const vulns = ids.map((id) => details.get(id)).filter((v): v is OsvVuln => !!v && !v.withdrawn);
    if (!vulns.length) return;
    result.vulnerable++;
    for (const v of vulns) {
      let severity = severityOf(v);
      const fixed = fixedVersions(v, e.pkg.name);
      const aliases = (v.aliases ?? []).filter((a) => a.startsWith('CVE-')).slice(0, 2);
      const dev = e.pkg.dev === true;
      if (dev && severity !== 'info')
        severity = severity === 'critical' ? 'high' : severity === 'high' ? 'medium' : 'low';
      const file = [...e.files][0]!;
      result.hits.push({
        file,
        message: `${e.pkg.name}@${e.pkg.version}${dev ? ' (dev)' : ''}: ${v.id}${aliases.length ? ` (${aliases.join(', ')})` : ''} — ${(v.summary ?? 'see advisory').slice(0, 140)}.${fixed.length ? ` Fixed in ${fixed.slice(0, 3).join(', ')}.` : ' No fixed version published.'}`,
        severity,
        anchor: `${e.pkg.ecosystem}:${e.pkg.name}@${e.pkg.version}:${v.id}`,
        facts: {
          package: e.pkg.name,
          version: e.pkg.version,
          ecosystem: e.pkg.ecosystem,
          advisory: v.id,
          fixed: fixed.join(', ') || null,
          dev,
        },
      });
    }
  });
  return result;
}
