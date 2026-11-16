import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MODEL_JS } from '../../src/report/html-model.js';

interface Hero {
  kind: string;
  count: number;
  action: string | null;
  ids: string[];
}
interface Model {
  hero: (run: unknown, review: unknown) => Hero;
  priorities: (open: unknown[], review: unknown) => { rule: string; list: { id: string }[]; worst: number }[];
  vstate: (f: unknown, review: unknown) => string;
}

/** Loads the shipped decision model exactly as the HTML report runs it. */
const load = (): Model => runInNewContext(`${MODEL_JS}; RelivaroModel`, {});
// Plain JSON round trip: the VM returns objects from another realm, which toEqual compares by prototype.
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const f = (id: string, severity: string, ruleId = 'sec/x', extra: Record<string, unknown> = {}) => ({
  id,
  ruleId,
  severity,
  status: 'open',
  provenance: 'static',
  ...extra,
});

const release = (status: string, gates: { status: string; findings?: string[] }[]) => {
  const tally: Record<string, number> = { pass: 0, warn: 0, block: 0, unverified: 0, 'n/a': 0 };
  for (const g of gates) tally[g.status] = (tally[g.status] ?? 0) + 1;
  return { status, score: 50, tally, gates: gates.map((g, i) => ({ id: `g${i}`, title: `g${i}`, ...g })) };
};

describe('report decision model', () => {
  it('hero: not-ready with gate findings selects the blocking findings, minus reviewed-away ones', () => {
    const run = {
      findings: [
        f('A', 'medium'),
        f('B', 'critical'),
        f('C', 'high'),
        f('D', 'high', 'sec/x', { accepted: { reason: 'ok' } }),
        f('E', 'low'),
      ],
      release: release('not-ready', [
        { status: 'block', findings: ['A', 'B', 'C', 'D'] },
        { status: 'block', findings: ['B'] },
        { status: 'warn', findings: ['E'] },
        { status: 'pass' },
      ]),
    };
    const review = { C: { verdict: 'false-positive' } };
    expect(plain(load().hero(run, review))).toEqual({
      kind: 'not-ready',
      count: 2,
      action: 'prompt',
      ids: ['B', 'A'],
    });
  });

  it('hero: blockers without findings send the reader to the gates', () => {
    const run = {
      findings: [f('A', 'low')],
      release: release('not-ready', [{ status: 'block', findings: [] }]),
    };
    expect(plain(load().hero(run, {}))).toEqual({ kind: 'not-ready', count: 1, action: 'gates', ids: [] });
  });

  it('hero: blockers only reviewed away send the reader to the gates', () => {
    const run = {
      findings: [f('A', 'high')],
      release: release('not-ready', [{ status: 'block', findings: ['A'] }]),
    };
    const h = load().hero(run, { A: { verdict: 'false-positive' } });
    expect(h.action).toBe('gates');
    expect(plain(h.ids)).toEqual([]);
  });

  it('hero: ready-with-warnings counts warnings', () => {
    const run = {
      findings: [],
      release: release('ready-with-warnings', [{ status: 'warn' }, { status: 'warn' }, { status: 'pass' }]),
    };
    expect(plain(load().hero(run, {}))).toEqual({
      kind: 'ready-with-warnings',
      count: 2,
      action: 'gates',
      ids: [],
    });
  });

  it('hero: ready-with-warnings also counts gates that did not run', () => {
    const run = {
      findings: [],
      release: release('ready-with-warnings', [{ status: 'unverified' }, { status: 'pass' }]),
    };
    expect(plain(load().hero(run, {}))).toEqual({
      kind: 'ready-with-warnings',
      count: 1,
      action: 'gates',
      ids: [],
    });
  });

  it('hero: needs-verification counts gates that did not run', () => {
    const run = {
      findings: [],
      release: release('needs-verification', [
        { status: 'unverified' },
        { status: 'warn' },
        { status: 'pass' },
      ]),
    };
    expect(plain(load().hero(run, {}))).toEqual({
      kind: 'needs-verification',
      count: 1,
      action: 'gates',
      ids: [],
    });
  });

  it('hero: ready points to the findings', () => {
    const run = { findings: [], release: release('ready', [{ status: 'pass' }]) };
    expect(plain(load().hero(run, {}))).toEqual({ kind: 'ready', count: 0, action: 'findings', ids: [] });
  });

  it('hero: audit runs count open findings', () => {
    const m = load();
    const run = {
      findings: [f('A', 'low'), f('B', 'high'), f('C', 'low', 'sec/x', { status: 'suppressed' })],
    };
    expect(plain(m.hero(run, {}))).toEqual({ kind: 'audit-open', count: 2, action: 'fixfirst', ids: [] });
    expect(plain(m.hero({ findings: [] }, {}))).toEqual({
      kind: 'audit-clean',
      count: 0,
      action: null,
      ids: [],
    });
  });

  it('priorities: top three root causes, most severe first, then larger groups, then rule id', () => {
    const open = [
      f('1', 'low', 'r/low'),
      f('2', 'high', 'r/b'),
      f('3', 'high', 'r/a'),
      f('4', 'high', 'r/a'),
      f('5', 'critical', 'r/crit'),
      f('6', 'high', 'r/c'),
      f('7', 'critical', 'r/fp'),
    ];
    const p = load().priorities(open, { '7': { verdict: 'false-positive' } });
    expect(p.map((g) => g.rule)).toEqual(['r/crit', 'r/a', 'r/b']);
    expect(p[1]!.list.map((x) => x.id)).toEqual(['3', '4']);
  });

  it('vstate: review verdict, accepted in code, executed evidence, otherwise detected', () => {
    const m = load();
    expect(m.vstate(f('A', 'low'), { A: { verdict: 'needs-runtime' } })).toBe('needs-runtime');
    expect(m.vstate(f('A', 'low', 'x', { accepted: { reason: 'r' } }), {})).toBe('accepted');
    expect(m.vstate(f('A', 'low', 'x', { provenance: 'executed' }), {})).toBe('confirmed');
    expect(m.vstate(f('A', 'low'), {})).toBe('detected');
  });
});

describe('report stylesheet colour rule', () => {
  it('teal comes only from the accent tokens, in the light, dark and forced-dark blocks', async () => {
    const { REPORT_CSS } = await import('../../src/report/html-style.js');
    expect(REPORT_CSS.match(/--accent:/g)?.length).toBe(3);
    expect(REPORT_CSS.match(/#BRAND_LIGHT\b/g)?.length).toBe(1);
    expect(REPORT_CSS.match(/#BRAND_DARK\b/g)?.length).toBe(2);
    expect(REPORT_CSS).not.toMatch(/#0b7285|#3fb6c9/i);
  });

  it('severity and status colours fill nothing larger than a dot or a thin line', async () => {
    const { REPORT_CSS } = await import('../../src/report/html-style.js');
    const rules = REPORT_CSS.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*\}/g) ?? [];
    const filled = rules.filter((r) =>
      /background(?:-color)?:\s*var\(--(?:crit|high|med|low|info|ok|warn|block|unv)\)/.test(r),
    );
    for (const r of filled)
      expect(r.split('{')[0]!.trim(), r).toMatch(
        /^(?:\.dot|\.d-[\w-]+|\.line-[\w-]+)(?:,\s*\.(?:dot|d-[\w-]+|line-[\w-]+))*$/,
      );
  });
});

describe('report client', () => {
  it('uses only i18n keys that exist, and every key is used', async () => {
    const { REPORT_JS } = await import('../../src/report/html-client.js');
    const { I18N } = await import('../../src/report/html-i18n.js');
    const keys = new Set(Object.keys(I18N.en));
    const used = new Set([...REPORT_JS.matchAll(/\bt[n]?\('([\w.\-/]+)'\s*[,)]/g)].map((m) => m[1]!));
    for (const k of used) expect(keys.has(k), k).toBe(true);
    // Keys built at runtime from a prefix (t('sev.' + x)) count as used when their prefix is.
    const prefixes = [...REPORT_JS.matchAll(/\bt[n]?\('([\w.\-/]+\.)' \+/g)].map((m) => m[1]!);
    const unused = [...keys].filter(
      (k) => !used.has(k) && !k.endsWith('.one') && !prefixes.some((p) => k.startsWith(p)),
    );
    expect(unused).toEqual([]);
  });

  it('takes the headline decision from the shared model', async () => {
    const { REPORT_JS } = await import('../../src/report/html-client.js');
    expect(REPORT_JS).toContain('RelivaroModel.hero(D, REV)');
    expect(REPORT_JS).not.toContain('sevStyle');
  });
});

describe('report review fixes', () => {
  it('controls reset with all:unset get a visible focus ring', async () => {
    const { REPORT_CSS } = await import('../../src/report/html-style.js');
    for (const sel of [
      '.link',
      '.row-btn',
      '.remsum button',
      '.barrow',
      '.sevlist button',
      '.gate',
      '.ab-btns .ghost',
    ]) {
      const unsetAt = REPORT_CSS.indexOf(`${sel}{all:unset`);
      const focus = REPORT_CSS.search(
        new RegExp(`${sel.replace(/[.*]/g, '\\$&')}:focus-visible[^{]*\\{[^}]*outline:2px`),
      );
      expect(unsetAt, sel).toBeGreaterThanOrEqual(0);
      expect(focus, sel).toBeGreaterThan(unsetAt);
    }
  });

  it('counted labels use the singular form for one', async () => {
    const { REPORT_JS } = await import('../../src/report/html-client.js');
    const { I18N } = await import('../../src/report/html-i18n.js');
    for (const k of ['group.count', 'sel.group']) {
      expect(REPORT_JS).toContain(`tn('${k}'`);
      expect(Object.keys(I18N.en)).toContain(`${k}.one`);
    }
  });
});
