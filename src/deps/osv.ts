import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { RelivaroError } from '../core/errors.js';
import { assertNotLockedDown } from '../core/lockdown.js';
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
 * code, no file paths. Each response is cached for 24 hours from when it was fetched (workspace or `--osv-cache`).
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
  /** Offline mode: packages whose advisories could not be answered from a fresh cache entry. */
  unverified: number;
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

/** One key per resolved package: the unit of both `metrics.dependencies` and the OSV query count. */
export function packageKey(p: { ecosystem: string; name: string; version: string }): string {
  return `${p.ecosystem}\u0000${p.name}\u0000${p.version}`;
}

/** Number of unique `ecosystem/name@version` across lockfiles. */
export function uniquePackageCount(lockfiles: LockfileInfo[]): number {
  return new Set(lockfiles.flatMap((l) => l.packages.map(packageKey))).size;
}

const TTL_MS = 24 * 3600_000;

/** The OSV API base for `--osv-api`: HTTPS only, without a trailing slash. */
export function osvApiBase(url: string | undefined): string {
  if (!url) return API;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new RelivaroError('USAGE', `--osv-api must be an https:// URL, got "${url}".`);
  }
  if (u.protocol !== 'https:')
    throw new RelivaroError('USAGE', `--osv-api must be an https:// URL, got "${url}".`);
  return u.href.replace(/\/+$/, '');
}

interface OsvCache {
  version: 2;
  /** Per package (`ecosystem\0name\0version`): the advisory ids OSV returned and when. */
  packages: Record<string, { at: number; ids: string[] }>;
  /** Per advisory id: its details and when they were fetched. */
  vulns: Record<string, { at: number; vuln: OsvVuln }>;
}

function readCache(file: string | undefined): OsvCache {
  const empty: OsvCache = { version: 2, packages: {}, vulns: {} };
  if (!file || !existsSync(file)) return empty;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (raw.version === 2)
      return {
        version: 2,
        packages: (raw.packages ?? {}) as OsvCache['packages'],
        vulns: (raw.vulns ?? {}) as OsvCache['vulns'],
      };
    // 1.4 and earlier: advisory details keyed by id.
    return { ...empty, vulns: raw as OsvCache['vulns'] };
  } catch {
    return empty;
  }
}

/** True when the cache file may be written: it does not exist yet, or it is writable by this process. */
function cacheWritable(file: string): boolean {
  try {
    if (!existsSync(file)) return true;
    accessSync(file, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function queryOsv(
  lockfiles: LockfileInfo[],
  opts: {
    cacheFile?: string;
    fetchImpl?: FetchLike;
    onProgress?: (m: string) => void;
    /** `--osv-api`: an HTTPS mirror of the OSV API. */
    apiBase?: string;
    /** `--offline-osv`: answer only from the cache; nothing is sent. */
    offline?: boolean;
    /** Use the cache file but never write it (e.g. `--no-write`). */
    readOnlyCache?: boolean;
  } = {},
): Promise<OsvResult> {
  if (!opts.offline) assertNotLockedDown('network access (OSV.dev)');
  const api = osvApiBase(opts.apiBase);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const unique = new Map<string, { pkg: ResolvedPackage; files: Set<string> }>();
  for (const l of lockfiles)
    for (const p of l.packages) {
      if (!/^(?:npm|Packagist|PyPI|Go|crates\.io|RubyGems|Pub|Maven)$/.test(p.ecosystem)) continue;
      const key = packageKey(p);
      const e = unique.get(key) ?? { pkg: p, files: new Set<string>() };
      e.files.add(l.file);
      unique.set(key, e);
    }
  const entries = [...unique.values()];
  const result: OsvResult = { queried: entries.length, vulnerable: 0, hits: [], errors: [], unverified: 0 };
  if (!entries.length) return result;

  const now = Date.now();
  const fresh = (at: number | undefined) => at !== undefined && now - at < TTL_MS;
  const cache = readCache(opts.cacheFile);
  let cacheChanged = false;

  // Advisory ids per package: from a fresh cache entry, otherwise from a batch query (never in offline mode).
  const idsPer: (string[] | null)[] = entries.map((e) => {
    const c = cache.packages[packageKey(e.pkg)];
    return c && fresh(c.at) ? c.ids : null;
  });
  const missing = entries.map((_e, i) => i).filter((i) => idsPer[i] === null);
  if (!opts.offline)
    for (let b = 0; b < missing.length; b += BATCH) {
      const slice = missing.slice(b, b + BATCH);
      opts.onProgress?.(`OSV: querying ${b + slice.length}/${missing.length} packages`);
      const body = {
        queries: slice.map((i) => {
          const pkg = entries[i]!.pkg;
          return {
            package: { name: pkg.name, ecosystem: pkg.ecosystem },
            version: pkg.version.replace(/^v(?=\d)/, pkg.ecosystem === 'Go' ? 'v' : ''),
          };
        }),
      };
      try {
        const res = (await postJson(fetchImpl, `${api}/querybatch`, body)) as {
          results?: { vulns?: { id: string }[] }[];
        };
        slice.forEach((i, j) => {
          const ids = (res.results?.[j]?.vulns ?? []).map((v) => v.id);
          idsPer[i] = ids;
          cache.packages[packageKey(entries[i]!.pkg)] = { at: now, ids };
          cacheChanged = true;
        });
      } catch (e) {
        result.errors.push((e as Error).message);
        return result;
      }
    }

  const allIds = [...new Set(idsPer.flatMap((ids) => ids ?? []))];
  const details = new Map<string, OsvVuln>();
  const todo = allIds.filter((id) => {
    const c = cache.vulns[id];
    if (c && fresh(c.at)) details.set(id, c.vuln);
    return !details.has(id);
  });
  let next = 0;
  if (!opts.offline)
    await Promise.all(
      Array.from({ length: Math.min(8, todo.length) }, async () => {
        while (next < todo.length) {
          const id = todo[next++]!;
          try {
            const v = (await getJson(fetchImpl, `${api}/vulns/${encodeURIComponent(id)}`)) as OsvVuln;
            details.set(id, v);
            cache.vulns[id] = { at: now, vuln: v };
            cacheChanged = true;
          } catch (e) {
            result.errors.push(`${id}: ${(e as Error).message}`);
          }
        }
      }),
    );
  // In offline mode a package is unverified when its ids, or the details of one of its advisories, are not cached.
  if (opts.offline)
    result.unverified = idsPer.filter((ids) => ids === null || ids.some((id) => !details.has(id))).length;
  // A read-only (shared) cache is used but never written.
  if (opts.cacheFile && cacheChanged && !opts.readOnlyCache && cacheWritable(opts.cacheFile)) {
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
