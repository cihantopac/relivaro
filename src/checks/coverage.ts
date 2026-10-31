import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type Finding, SEVERITY_RANK } from '../core/types.js';
import type { FileSet } from '../fs/files.js';
import type { ProjectProfile } from '../intel/discover.js';

export interface CoverageReport {
  file: string;
  format: 'lcov' | 'clover' | 'cobertura' | 'istanbul-summary' | 'istanbul-final';
  generatedAt: string;
  /** True when a source file changed after the report was generated. */
  stale: boolean;
  lines: { covered: number; total: number; pct: number };
  files: Map<string, { covered: number; total: number }>;
}

const CANDIDATES = [
  'coverage/lcov.info',
  'coverage/coverage-summary.json',
  'coverage/coverage-final.json',
  'coverage/clover.xml',
  'coverage/cobertura-coverage.xml',
  'coverage.xml',
  'build/logs/clover.xml',
  'build/coverage/clover.xml',
  'clover.xml',
  'cobertura.xml',
  'coverage/coverage.xml',
];

function norm(root: string, unit: string, p: string): string {
  let x = p.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/');
  if (x.startsWith(`${r}/`)) x = x.slice(r.length + 1);
  else if (unit !== '.' && !x.startsWith(`${unit}/`)) x = `${unit}/${x.replace(/^\.\//, '')}`;
  return x.replace(/^\.\//, '');
}

function parseLcov(text: string, root: string, unit: string): Map<string, { covered: number; total: number }> {
  const out = new Map<string, { covered: number; total: number }>();
  let cur = '';
  let lf = 0;
  let lh = 0;
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith('SF:')) {
      cur = norm(root, unit, l.slice(3));
      lf = 0;
      lh = 0;
    } else if (l.startsWith('LF:')) lf = Number(l.slice(3));
    else if (l.startsWith('LH:')) lh = Number(l.slice(3));
    else if (l === 'end_of_record' && cur) out.set(cur, { covered: lh, total: lf });
  }
  return out;
}

function parseClover(text: string, root: string, unit: string): Map<string, { covered: number; total: number }> {
  const out = new Map<string, { covered: number; total: number }>();
  for (const m of text.matchAll(/<file\s+[^>]*?(?:name|path)="([^"]+)"[^>]*>([\s\S]*?)<\/file>/g)) {
    const metrics = /<metrics\s[^>]*?statements="(\d+)"[^>]*?coveredstatements="(\d+)"/.exec(m[2]!);
    if (metrics) out.set(norm(root, unit, m[1]!), { total: Number(metrics[1]), covered: Number(metrics[2]) });
  }
  return out;
}

function parseCobertura(text: string, root: string, unit: string): Map<string, { covered: number; total: number }> {
  const out = new Map<string, { covered: number; total: number }>();
  const source = /<source>([^<]+)<\/source>/.exec(text)?.[1]?.trim();
  for (const m of text.matchAll(/<class\s[^>]*?filename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
    const lines = [...m[2]!.matchAll(/<line\s[^>]*?hits="(\d+)"/g)];
    const file = norm(root, unit, source && !m[1]!.startsWith('/') ? `${source}/${m[1]}` : m[1]!);
    const prev = out.get(file) ?? { covered: 0, total: 0 };
    out.set(file, { total: prev.total + lines.length, covered: prev.covered + lines.filter((l) => Number(l[1]) > 0).length });
  }
  return out;
}

function parseIstanbul(text: string, root: string, unit: string, summary: boolean): Map<string, { covered: number; total: number }> {
  const out = new Map<string, { covered: number; total: number }>();
  const j = JSON.parse(text) as Record<string, any>;
  for (const [file, v] of Object.entries(j)) {
    if (file === 'total') continue;
    if (summary) out.set(norm(root, unit, file), { covered: v.lines?.covered ?? 0, total: v.lines?.total ?? 0 });
    else {
      const counts = Object.values((v.s ?? {}) as Record<string, number>);
      out.set(norm(root, unit, file), { covered: counts.filter((c) => c > 0).length, total: counts.length });
    }
  }
  return out;
}

/** Reads coverage reports the project already produced. Relivaro does not generate coverage itself. */
export function readCoverage(files: FileSet, profile: ProjectProfile): CoverageReport[] {
  const reports: CoverageReport[] = [];
  const newestSource = Math.max(0, ...files.files.filter((f) => f.kind === 'source' && !f.isTest).slice(0, 5000).map((f) => {
    try {
      return statSync(join(files.root, f.path)).mtimeMs;
    } catch {
      return 0;
    }
  }));
  for (const u of profile.units) {
    for (const c of CANDIDATES) {
      const rel = u.path === '.' ? c : `${u.path}/${c}`;
      const abs = join(files.root, rel);
      if (!existsSync(abs)) continue;
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(abs);
        if (st.size > 64 * 1024 * 1024) continue;
      } catch {
        continue;
      }
      const text = readFileSync(abs, 'utf8');
      let format: CoverageReport['format'];
      let map: Map<string, { covered: number; total: number }>;
      try {
        if (c.endsWith('lcov.info')) [format, map] = ['lcov', parseLcov(text, files.root, u.path)];
        else if (c.endsWith('coverage-summary.json')) [format, map] = ['istanbul-summary', parseIstanbul(text, files.root, u.path, true)];
        else if (c.endsWith('coverage-final.json')) [format, map] = ['istanbul-final', parseIstanbul(text, files.root, u.path, false)];
        else if (/<coverage[^>]*line-rate=/.test(text)) [format, map] = ['cobertura', parseCobertura(text, files.root, u.path)];
        else [format, map] = ['clover', parseClover(text, files.root, u.path)];
      } catch {
        continue;
      }
      if (!map.size) continue;
      let covered = 0;
      let total = 0;
      for (const v of map.values()) {
        covered += v.covered;
        total += v.total;
      }
      reports.push({ file: rel, format, generatedAt: new Date(st.mtimeMs).toISOString(), stale: newestSource > st.mtimeMs, lines: { covered, total, pct: total ? Math.round((covered / total) * 1000) / 10 : 0 }, files: map });
      break;
    }
  }
  return reports;
}

export interface TestGap {
  file: string;
  risk: number;
  reasons: string[];
  coveragePct?: number;
}

/**
 * Ranks source files that appear untested by risk. "Untested" = no test file references the module (by import
 * path, file stem or class name) and, if a coverage report exists, the file has no covered lines. This list is the
 * input for test generation by the Claude Code plugin; it is a heuristic and labelled as such.
 */
export function testGaps(files: FileSet, findings: Finding[], complexity: Map<string, number>, coverage: CoverageReport[]): TestGap[] {
  const tests = files.files.filter((f) => f.isTest && f.kind === 'source');
  if (!tests.length && !coverage.length) {
    // Without any tests every file is a gap; rank all.
  }
  const testText = tests.slice(0, 3000).map((t) => files.read(t.path) ?? '').join('\n');
  const covered = new Map<string, number>();
  for (const r of coverage) for (const [f, v] of r.files) covered.set(f, v.total ? (v.covered / v.total) * 100 : 0);
  const gaps: TestGap[] = [];
  for (const f of files.files) {
    if (f.isTest || f.kind !== 'source' || !f.language) continue;
    if (/(?:^|\/)(?:config|migrations?|database\/(?:seeders|factories)|routes|types?|resources\/lang|public|scripts?)\/|\.d\.ts$|(?:^|\/)(?:index|main)\.[cm]?[jt]sx?$|\.config\.[cm]?[jt]s$/.test(f.path)) continue;
    const stem = f.path.split('/').pop()!.replace(/\.[^.]+$/, '');
    if (stem.length < 3) continue;
    const referenced = new RegExp(`[/'"\\\\]${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[cm]?[jt]sx?)?['"]|\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(testText);
    const pct = covered.get(f.path);
    if ((pct !== undefined && pct > 0) || (pct === undefined && referenced)) continue;
    const fileFindings = findings.filter((x) => x.location?.file === f.path && x.status === 'open');
    const reasons: string[] = [];
    let risk = 0;
    const sev = fileFindings.reduce((s, x) => s + SEVERITY_RANK[x.severity], 0);
    if (sev) {
      risk += sev * 2;
      reasons.push(`${fileFindings.length} open finding(s)`);
    }
    const cc = complexity.get(f.path) ?? 0;
    if (cc > 10) {
      risk += Math.min(cc / 5, 10);
      reasons.push(`max complexity ${cc}`);
    }
    if (/(?:controller|service|handler|route|api|action|job|middleware|policy|repository|model|payment|auth|billing|checkout|order|webhook)/i.test(f.path)) {
      risk += 3;
      reasons.push('business/request-handling code');
    }
    if (f.size > 8000) {
      risk += 1;
      reasons.push(`${Math.round(f.size / 1024)} KB`);
    }
    if (risk <= 0) continue;
    gaps.push({ file: f.path, risk: Math.round(risk * 10) / 10, reasons, coveragePct: pct });
  }
  return gaps.sort((a, b) => b.risk - a.risk || a.file.localeCompare(b.file)).slice(0, 25);
}
