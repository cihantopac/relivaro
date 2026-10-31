/**
 * Client-side renderer of the HTML report. It reads the JSON payload and builds the page with DOM APIs only:
 * every repository-derived string is assigned through `textContent` / `setAttribute`, never parsed as markup.
 * Written as plain ES2017 without template literals so it can live in a string constant.
 */
export const REPORT_JS = String.raw`(function () {
'use strict';
var P = JSON.parse(document.getElementById('data').textContent);
var D = P.run, X = P.extra || {}, I = P.i18n;
var SEV = ['critical', 'high', 'medium', 'low', 'info'];
var CATS = ['security', 'supply-chain', 'reliability', 'performance', 'quality', 'testing', 'release'];
var SEV_W = { critical: 16, high: 8, medium: 4, low: 2, info: 1 };
var NS = 'http://www.w3.org/2000/svg';
var store = {
  get: function (k) { try { return window.localStorage.getItem('relivaro.' + k); } catch (e) { return null; } },
  set: function (k, v) { try { window.localStorage.setItem('relivaro.' + k, v); } catch (e) { /* storage unavailable */ } }
};
var lang = store.get('lang');
if (lang !== 'en' && lang !== 'tr') {
  var prefs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
  lang = /^tr\b/i.test(prefs[0] || '') ? 'tr' : 'en';
}
var theme = store.get('theme');
if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);

function t(k, v) {
  var s = (I[lang] && I[lang][k]) || I.en[k] || k;
  if (v) for (var n in v) s = s.split('{' + n + '}').join(String(v[n]));
  return s;
}
function el(tag, o, kids) {
  var e = document.createElement(tag);
  if (o) for (var k in o) {
    var v = o[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k === 'cls') e.className = v;
    else if (k === 'on') for (var ev in v) e.addEventListener(ev, v[ev]);
    else if (k === 'style') for (var sp in v) e.style.setProperty(sp, v[sp]);
    else e.setAttribute(k, v === true ? '' : v);
  }
  add(e, kids);
  return e;
}
function add(e, kids) {
  if (!kids) return e;
  for (var i = 0; i < kids.length; i++) {
    var c = kids[i];
    if (c === null || c === undefined || c === false) continue;
    e.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return e;
}
function s(tag, o, kids) {
  var e = document.createElementNS(NS, tag);
  if (o) for (var k in o) if (o[k] !== undefined && o[k] !== null) e.setAttribute(k, o[k]);
  return add(e, kids);
}
/* Text with backtick-quoted spans rendered as code (used for Relivaro's own strings only). */
function md(text) {
  var parts = String(text).split(String.fromCharCode(96)), f = document.createDocumentFragment();
  parts.forEach(function (p, i) { if (p) f.appendChild(i % 2 ? el('code', { text: p }) : document.createTextNode(p)); });
  return f;
}
function num(n) { return Number(n || 0).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US'); }
function dur(ms) {
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
  return Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s';
}
function when(iso) {
  try { return new Date(iso).toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch (e) { return iso; }
}
function uniq(a) { return a.filter(function (x, i) { return x && a.indexOf(x) === i; }); }
var VAR_ALIAS = { unverified: 'unv', 'n/a': 'na' };
function cssVar(name) { return 'var(--' + (VAR_ALIAS[name] || name) + ')'; }
function stKey(st) { return st === 'n/a' ? 'na' : st; }

/* Status glyphs: drawn shapes, so status never relies on colour alone. */
function glyph(st, size) {
  var z = size || 14, o = { width: z, height: z, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (st === 'pass') return s('svg', o, [s('circle', { cx: 8, cy: 8, r: 6.2 }), s('path', { d: 'M5.2 8.2l2 2 3.8-4' })]);
  if (st === 'warn') return s('svg', o, [s('path', { d: 'M8 2.2l6 10.6H2z' }), s('path', { d: 'M8 6.6v2.6M8 11.1v.1' })]);
  if (st === 'block') return s('svg', o, [s('path', { d: 'M5.4 1.8h5.2l3.6 3.6v5.2l-3.6 3.6H5.4l-3.6-3.6V5.4z' }), s('path', { d: 'M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4' })]);
  if (st === 'unverified') return s('svg', o, [s('circle', { cx: 8, cy: 8, r: 6.2, 'stroke-dasharray': '2.4 2' }), s('path', { d: 'M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.3v.1' })]);
  return s('svg', o, [s('path', { d: 'M4.5 8h7' })]);
}
var searchIcon = function () { return s('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'aria-hidden': 'true' }, [s('circle', { cx: 7, cy: 7, r: 4.8 }), s('path', { d: 'M10.6 10.6L14 14' })]); };

var open = D.findings.filter(function (f) { return f.status === 'open'; });
var R = D.release;
var state = { q: '', sev: {}, cat: '', status: 'open', fixable: false, sort: 'severity', gate: null, limit: 50, opened: {} };

function card(title, hint, kids, extraHead) {
  return el('div', { cls: 'card' }, [
    el('div', { cls: 'card-h' }, [el('div', null, [el('h2', { text: title }), hint ? el('p', { cls: 'hint' }, [md(hint)]) : null]), extraHead || null]),
  ].concat(kids));
}
function section(id, kids) { return el('section', { id: id }, kids); }

/* ---------- header ---------- */
function renderChrome() {
  document.documentElement.lang = lang;
  var nav = document.getElementById('nav');
  nav.textContent = '';
  [['overview', 'nav.overview'], ['gates', 'nav.gates'], ['findings', 'nav.findings'], ['verification', 'nav.checks'], ['project', 'nav.project']].forEach(function (x) {
    if (x[0] === 'gates' && !R) return;
    nav.appendChild(el('a', { href: '#' + x[0], text: t(x[1]) }));
  });
  var seg = document.getElementById('lang');
  seg.setAttribute('aria-label', 'Language / Dil');
  Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang)); });
  var tb = document.getElementById('theme');
  tb.setAttribute('aria-label', t('theme.toggle'));
  tb.setAttribute('title', t('theme.toggle'));
  document.getElementById('skip').textContent = t('skip');
  var foot = document.getElementById('foot-text');
  foot.textContent = t('footer', { v: D.tool.version });
}

/* ---------- overview ---------- */
function ring(score, color) {
  var r = 56, c = 2 * Math.PI * r, frac = Math.max(0, Math.min(1, score / 100));
  return s('svg', { width: 132, height: 132, viewBox: '0 0 132 132', 'aria-hidden': 'true' }, [
    s('circle', { cx: 66, cy: 66, r: r, fill: 'none', stroke: cssVar('surface-2'), 'stroke-width': 12 }),
    s('circle', { cx: 66, cy: 66, r: r, fill: 'none', stroke: color, 'stroke-width': 12, 'stroke-linecap': 'round', 'stroke-dasharray': (c * frac).toFixed(1) + ' ' + c.toFixed(1) })
  ]);
}
var STATUS_TONE = { ready: 'pass', 'ready-with-warnings': 'warn', 'needs-verification': 'unverified', 'not-ready': 'block' };

function hero() {
  if (R) {
    var tone = STATUS_TONE[R.status] || 'na';
    var tally = R.tally || {};
    var chips = el('div', { cls: 'tally' });
    ['block', 'warn', 'unverified', 'pass', 'n/a'].forEach(function (k) {
      if (tally[k] === undefined) return;
      chips.appendChild(el('span', { cls: 'pill st-' + stKey(k) }, [glyph(k, 12), num(tally[k]) + ' ' + t('gate.' + k)]));
    });
    return el('div', { cls: 'card hero' }, [
      el('div', { cls: 'ring' }, [ring(R.score, cssVar(tone)), el('div', { cls: 'val' }, [el('b', { text: String(R.score) }), el('span', { text: t('hero.score') })])]),
      el('div', null, [
        el('div', { cls: 'eyebrow', text: t('hero.release') }),
        el('div', { cls: 'status-name c-' + tone }, [glyph(tone, 20), t('status.' + R.status)]),
        el('p', { cls: 'hint', text: t('status.desc.' + R.status) + (R.scoreCapped ? ' ' + t('hero.capped') + '.' : '') }),
        chips
      ])
    ]);
  }
  var worst = SEV.filter(function (x) { return D.summary.bySeverity[x]; })[0];
  var segs = SEV.map(function (x) { return { v: D.summary.bySeverity[x], c: cssVar(x) }; });
  return el('div', { cls: 'card hero' }, [
    el('div', { cls: 'ring' }, [donut(segs, 132, 12), el('div', { cls: 'val' }, [el('b', { text: num(open.length) }), el('span', { text: t('nav.findings') })])]),
    el('div', null, [
      el('div', { cls: 'eyebrow', text: t('hero.audit') }),
      el('div', { cls: 'status-name' + (worst ? '' : ' c-pass') }, [open.length ? t('hero.auditOpen', { n: num(open.length) }) : t('hero.auditClean')]),
      el('p', { cls: 'hint' }, [md(t('hero.auditHint'))])
    ])
  ]);
}

function kpis() {
  var urgent = D.summary.bySeverity.critical + D.summary.bySeverity.high;
  var fixable = open.filter(function (f) { return f.fixer; }).length;
  var ran = D.checks.filter(function (c) { return c.status !== 'skipped'; });
  var passed = ran.filter(function (c) { return c.status === 'passed'; }).length;
  function k(label, value, sub, tone) {
    return el('div', { cls: 'kpi' }, [el('div', { cls: 'k', text: label }), el('div', { cls: 'v' + (tone ? ' c-' + tone : ''), text: value }), sub ? el('div', { cls: 's', text: sub }) : null]);
  }
  return el('div', { cls: 'kpis' }, [
    k(t('kpi.open'), num(open.length), D.summary.suppressed ? D.summary.suppressed + ' ' + t('findings.status.suppressed').toLowerCase() : null),
    k(t('kpi.urgent'), num(urgent), null, urgent ? 'block' : 'pass'),
    k(t('kpi.fixable'), num(fixable)),
    k(t('kpi.files'), num(D.metrics.files), t('kpi.loc', { n: num(D.metrics.linesOfCode) })),
    k(t('kpi.checks'), ran.length ? passed + '/' + ran.length : '—', ran.length ? null : t('kpi.checksNone'), ran.length ? (passed === ran.length ? 'pass' : 'block') : 'unverified'),
    k(t('kpi.time'), dur(D.metrics.analysisMs), t('kpi.rules') + ': ' + num(D.metrics.rulesRun))
  ]);
}

function flow() {
  var ran = D.checks.filter(function (c) { return c.status !== 'skipped'; });
  var passed = ran.filter(function (c) { return c.status === 'passed'; }).length;
  var withEvidence = open.filter(function (f) { return f.evidence && (f.evidence.snippet || f.evidence.output || f.evidence.facts); }).length;
  var fixable = open.filter(function (f) { return f.fixer; }).length;
  var fx = X.fixes;
  var steps = [
    { t: 'flow.audit', v: t('flow.audit.v', { files: num(D.metrics.files), rules: num(D.metrics.rulesRun) }), st: 'pass' },
    { t: 'flow.evidence', v: t('flow.evidence.v', { n: num(withEvidence) }), st: 'pass' },
    { t: 'flow.fix', v: t('flow.fix.v', { n: num(fixable) }) + (fx && fx.applied ? ' · ' + fx.applied + ' ✓' : ''), st: fixable ? 'warn' : 'pass' },
    { t: 'flow.verify', v: ran.length ? t('flow.verify.v', { p: passed, t: ran.length }) : t('flow.verify.none'), st: ran.length ? (passed === ran.length ? 'pass' : 'block') : 'unverified' },
    { t: 'flow.release', v: R ? t('status.' + R.status) : t('flow.release.none'), st: R ? STATUS_TONE[R.status] : 'na' }
  ];
  return el('div', { cls: 'flow', role: 'list', 'aria-label': t('flow.title') }, steps.map(function (x, i) {
    return el('div', { cls: 'step' + (x.st === 'unverified' || x.st === 'na' ? ' s-todo' : ''), role: 'listitem' }, [
      el('span', { cls: 'bar', style: { background: cssVar(stKey(x.st)) } }),
      el('div', { cls: 'n', text: '0' + (i + 1) }),
      el('div', { cls: 't' }, [el('span', { cls: 'c-' + stKey(x.st) }, [glyph(x.st, 14)]), t(x.t)]),
      el('div', { cls: 'v', text: x.v })
    ]);
  }));
}

function donut(segs, size, width) {
  var r = (size - width) / 2, c = 2 * Math.PI * r, total = segs.reduce(function (a, x) { return a + x.v; }, 0), off = 0;
  var kids = [s('circle', { cx: size / 2, cy: size / 2, r: r, fill: 'none', stroke: cssVar('surface-2'), 'stroke-width': width })];
  if (total) segs.forEach(function (x) {
    if (!x.v) return;
    var len = (x.v / total) * c;
    kids.push(s('circle', { cx: size / 2, cy: size / 2, r: r, fill: 'none', stroke: x.c, 'stroke-width': width, 'stroke-dasharray': Math.max(len - 1.5, 0.5).toFixed(2) + ' ' + c.toFixed(2), 'stroke-dashoffset': (-off).toFixed(2) }));
    off += len;
  });
  return s('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size, 'aria-hidden': 'true', style: 'transform:rotate(-90deg)' }, kids);
}

function focusFindings() { var f = document.getElementById('findings'); if (f) f.scrollIntoView(); }

function charts() {
  var bySev = D.summary.bySeverity;
  var sevCard;
  if (!open.length) sevCard = card(t('chart.severity'), null, [el('div', { cls: 'empty', text: t('chart.empty') })]);
  else {
    var legend = el('ul', { cls: 'legend' });
    SEV.forEach(function (x) {
      legend.appendChild(el('li', null, [el('button', { type: 'button', on: { click: function () { state.sev = {}; state.sev[x] = true; state.limit = 50; renderFindingsSection(); focusFindings(); } } }, [
        el('span', { cls: 'sw', style: { background: cssVar(x) } }), el('span', { cls: 'lbl', text: t('sev.' + x) }), el('span', { cls: 'num', text: num(bySev[x]) })
      ])]));
    });
    var d = el('div', { cls: 'ring', style: { width: '120px', height: '120px' } }, [donut(SEV.map(function (x) { return { v: bySev[x], c: cssVar(x) }; }), 120, 16), el('div', { cls: 'val' }, [el('b', { text: num(open.length), style: { 'font-size': '26px' } })])]);
    sevCard = card(t('chart.severity'), null, [el('div', { cls: 'donut-wrap' }, [d, legend])]);
  }
  var cats = CATS.map(function (c) {
    var fs = open.filter(function (f) { return f.category === c; });
    return { c: c, n: fs.length, by: SEV.map(function (x) { return fs.filter(function (f) { return f.severity === x; }).length; }) };
  }).filter(function (x) { return x.n; }).sort(function (a, b) { return b.n - a.n; });
  var maxC = Math.max.apply(null, cats.map(function (x) { return x.n; }).concat([1]));
  var catCard = card(t('chart.category'), null, [cats.length ? el('div', { cls: 'bars' }, cats.map(function (x) {
    return el('div', { cls: 'barrow', role: 'button', tabindex: '0', on: { click: function () { state.cat = x.c; state.limit = 50; renderFindingsSection(); focusFindings(); }, keydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); } } } }, [
      el('span', { cls: 'lbl', text: t('cat.' + x.c) }),
      el('div', { cls: 'track', style: { width: (x.n / maxC * 100).toFixed(1) + '%' } }, x.by.map(function (v, i) { return v ? el('span', { style: { width: (v / x.n * 100).toFixed(2) + '%', background: cssVar(SEV[i]) } }) : null; })),
      el('span', { cls: 'num', text: num(x.n) })
    ]);
  })) : el('div', { cls: 'empty', text: t('chart.empty') })]);
  var files = {};
  open.forEach(function (f) { if (!f.location) return; var k = f.location.file; files[k] = files[k] || { n: 0, w: 0 }; files[k].n++; files[k].w += SEV_W[f.severity]; });
  var hot = Object.keys(files).map(function (k) { return { f: k, n: files[k].n, w: files[k].w }; }).sort(function (a, b) { return b.w - a.w || b.n - a.n; }).slice(0, 7);
  var maxW = Math.max.apply(null, hot.map(function (x) { return x.w; }).concat([1]));
  var hotCard = card(t('chart.hotspots'), null, [hot.length ? el('div', { cls: 'bars hot' }, hot.map(function (x) {
    return el('div', { cls: 'barrow', role: 'button', tabindex: '0', title: x.f, on: { click: function () { state.q = x.f; state.limit = 50; renderFindingsSection(); focusFindings(); }, keydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); } } } }, [
      el('span', { cls: 'lbl' }, [el('bdi', { text: x.f })]),
      el('div', { cls: 'track' }, [el('span', { style: { width: (x.w / maxW * 100).toFixed(1) + '%', background: cssVar('brand') } })]),
      el('span', { cls: 'num', text: num(x.n) })
    ]);
  })) : el('div', { cls: 'empty', text: t('chart.empty') })]);
  return el('div', { cls: 'grid g-3' }, [sevCard, catCard, hotCard]);
}

/* ---------- gates ---------- */
function gates() {
  if (!R) return null;
  var grid = el('div', { cls: 'gates' });
  var ORDER = ['block', 'warn', 'unverified', 'pass', 'n/a'];
  R.gates.slice().sort(function (a, b) { return ORDER.indexOf(a.status) - ORDER.indexOf(b.status); }).forEach(function (g) {
    var title = I[lang]['gt.' + g.id] && lang !== 'en' ? t('gt.' + g.id) : g.title;
    var n = g.findings ? g.findings.length : 0;
    grid.appendChild(el('button', {
      type: 'button', cls: 'gate b-' + stKey(g.status), 'aria-pressed': String(state.gate === g.id), title: g.detail,
      on: { click: function () { state.gate = state.gate === g.id ? null : g.id; state.status = 'all'; state.limit = 50; renderGates(); renderFindingsSection(); if (state.gate && n) focusFindings(); } }
    }, [
      el('div', { cls: 'gm' }, [el('span', { cls: 'pill st-' + stKey(g.status) }, [glyph(g.status, 12), t('gate.' + g.status)]), g.basis && g.status !== 'n/a' ? el('span', { cls: 'basis', text: t('basis.' + g.basis) }) : null]),
      el('div', { cls: 'gt', text: title }),
      el('div', { cls: 'gd' }, [md(g.detail)]),
      n ? el('div', { cls: 'faint', style: { 'font-size': '11.5px' }, text: t('gates.findings', { n: n }) }) : null
    ]));
  });
  return card(t('gates.title'), t('gates.hint'), [grid]);
}
function renderGates() { var host = document.getElementById('gates'); if (!host) return; host.textContent = ''; var g = gates(); if (g) host.appendChild(g); }

/* ---------- compare + perf ---------- */
function compare() {
  var C = X.comparison;
  if (!C) return card(t('compare.title'), null, [el('div', { cls: 'empty', text: t('compare.none') })]);
  var kids = [el('div', { cls: 'deltas' }, [
    el('div', { cls: 'delta' }, [el('b', { cls: C.introduced ? 'c-block' : '', text: '+' + num(C.introduced) }), el('div', { cls: 'muted', text: t('compare.introduced') })]),
    el('div', { cls: 'delta' }, [el('b', { cls: C.resolved ? 'c-pass' : '', text: '−' + num(C.resolved) }), el('div', { cls: 'muted', text: t('compare.resolved') })]),
    el('div', { cls: 'delta' }, [el('b', { text: num(C.persisting) }), el('div', { cls: 'muted', text: t('compare.persisting') })])
  ])];
  if (C.releaseChange) kids.push(el('p', { cls: 'hint' }, [t('compare.release') + ': ' + t('status.' + C.releaseChange.from) + ' (' + C.releaseChange.scoreFrom + ') → ' + t('status.' + C.releaseChange.to) + ' (' + C.releaseChange.scoreTo + ')']));
  var list = el('ul', { cls: 'mini' });
  (C.introducedTop || []).forEach(function (f) { list.appendChild(el('li', null, [el('span', { cls: 'pill st-block', text: '+' }), el('span', { cls: 'sev', style: { color: cssVar(f.severity), 'min-width': '0', padding: '0' }, text: t('sev.' + f.severity) }), el('span', { text: f.title }), el('code', { text: f.file || '' })])); });
  (C.resolvedTop || []).forEach(function (f) { list.appendChild(el('li', null, [el('span', { cls: 'pill st-pass', text: '−' }), el('span', { cls: 'sev', style: { color: cssVar(f.severity), 'min-width': '0', padding: '0' }, text: t('sev.' + f.severity) }), el('span', { text: f.title }), el('code', { text: f.file || '' })])); });
  if (list.childNodes.length) kids.push(list);
  return card(t('compare.title'), t('compare.base', { id: C.base.runId }) + ' · ' + when(C.base.startedAt), kids);
}
function perf() {
  var B = X.bench || [];
  if (!B.length) return card(t('perf.title'), null, [el('div', { cls: 'empty' }, [md(t('perf.none'))])]);
  var tb = el('table', null, [el('thead', null, [el('tr', null, [el('th', { text: t('perf.name') }), el('th', { cls: 'num', text: t('perf.mean') }), el('th', { cls: 'num', text: t('perf.p95') }), el('th', { cls: 'num', text: t('perf.errors') }), el('th', { text: t('perf.measured') })])])]);
  var body = el('tbody');
  B.forEach(function (b) {
    body.appendChild(el('tr', null, [el('td', null, [el('code', { text: b.name }), ' ', el('span', { cls: 'basis', text: b.kind })]), el('td', { cls: 'num', text: b.stats.meanMs.toFixed(1) + ' ms' }), el('td', { cls: 'num', text: b.stats.p95Ms.toFixed(1) + ' ms' }), el('td', { cls: 'num', text: b.kind === 'http' ? ((b.stats.errorRate || 0) * 100).toFixed(2) + '%' : '—' }), el('td', { cls: 'muted', text: when(b.measuredAt) })]));
  });
  tb.appendChild(body);
  return card(t('perf.title'), null, [el('div', { cls: 'tbl' }, [tb])]);
}

/* ---------- findings ---------- */
function matches(f) {
  if (state.gate) { var g = R && R.gates.filter(function (x) { return x.id === state.gate; })[0]; if (!g || !g.findings || g.findings.indexOf(f.id) < 0) return false; }
  if (state.status !== 'all' && f.status !== state.status) return false;
  var sevOn = Object.keys(state.sev).filter(function (k) { return state.sev[k]; });
  if (sevOn.length && sevOn.indexOf(f.severity) < 0) return false;
  if (state.cat && f.category !== state.cat) return false;
  if (state.fixable && !f.fixer) return false;
  if (state.q) {
    var hay = (f.title + ' ' + f.message + ' ' + f.ruleId + ' ' + f.id + ' ' + (f.location ? f.location.file : '')).toLowerCase();
    if (hay.indexOf(state.q.toLowerCase()) < 0) return false;
  }
  return true;
}
function sorted(list) {
  var by = state.sort;
  return list.slice().sort(function (a, b) {
    var fa = a.location ? a.location.file : '', fb = b.location ? b.location.file : '';
    if (by === 'file') return fa.localeCompare(fb) || ((a.location && a.location.line) || 0) - ((b.location && b.location.line) || 0);
    if (by === 'rule') return a.ruleId.localeCompare(b.ruleId) || fa.localeCompare(fb);
    return SEV.indexOf(a.severity) - SEV.indexOf(b.severity) || fa.localeCompare(fb);
  });
}
function snippet(text, line) {
  var box = el('div', { cls: 'snip', role: 'region', 'aria-label': t('finding.evidence'), tabindex: '0' });
  var lines = String(text).split('\n');
  var numbered = lines.every(function (l) { return /^\s*\d+ \| /.test(l) || l === ''; });
  if (!numbered) { box.appendChild(el('pre', { text: text })); return box; }
  lines.forEach(function (l) {
    if (!l) return;
    var m = /^\s*(\d+) \| ?(.*)$/.exec(l);
    box.appendChild(el('div', { cls: 'ln' + (line && Number(m[1]) === line ? ' at' : '') }, [el('span', { cls: 'no', text: m[1] }), el('span', { cls: 'tx', text: m[2] })]));
  });
  return box;
}
function findingBody(f) {
  var b = el('div', { cls: 'body' });
  b.appendChild(el('p', { cls: 'msg', text: f.message }));
  var ev = f.evidence || {};
  if (ev.snippet) b.appendChild(snippet(ev.snippet, f.location && f.location.line));
  if (ev.facts) {
    var facts = el('div', { cls: 'facts' });
    Object.keys(ev.facts).forEach(function (k) { facts.appendChild(el('code', { text: k + ': ' + ev.facts[k] })); });
    b.appendChild(facts);
  }
  if (ev.output) { b.appendChild(el('h4', { cls: 'muted', style: { margin: '10px 0 0', 'font-size': '11px' }, text: t('finding.output') })); b.appendChild(el('div', { cls: 'snip' }, [el('pre', { text: (ev.command ? '$ ' + ev.command + '\n' : '') + ev.output })])); }
  function kv(k, v, mono) { return v ? el('div', null, [el('h4', { text: t(k) }), el('p', mono ? { cls: 'mono', style: { 'font-size': '12px' }, text: v } : { text: v })]) : null; }
  b.appendChild(el('div', { cls: 'kv' }, [
    kv('finding.impact', f.impact),
    kv('finding.fix', f.recommendation),
    kv('finding.verify', f.verification),
    kv('finding.standards', [].concat(f.cwe || [], f.owasp || []).join(' · ')),
    kv('finding.rule', f.ruleId + ' · ' + f.id, true),
    kv('finding.confidence', t('conf.' + f.confidence) + ' · ' + (I.en['prov.' + f.provenance] ? t('prov.' + f.provenance) : f.provenance)),
    f.suppression ? kv('finding.suppressed', f.suppression.kind + (f.suppression.reason ? ': ' + f.suppression.reason : '')) : null
  ]));
  if (f.fixer) {
    var cmd = 'relivaro fix plan --finding ' + f.id;
    var btn = el('button', { type: 'button', cls: 'btn', text: t('finding.copy') });
    btn.addEventListener('click', function () {
      var done = function () { btn.textContent = t('finding.copied'); setTimeout(function () { btn.textContent = t('finding.copy'); }, 1400); };
      try { navigator.clipboard.writeText(cmd).then(done, function () {}); } catch (e) { /* clipboard unavailable */ }
    });
    b.appendChild(el('div', { cls: 'cmd' }, [el('span', { cls: 'muted', style: { 'font-size': '12px', 'font-weight': '600' }, text: t('finding.autofix') }), el('code', { text: cmd }), btn]));
  }
  return b;
}
function findingRow(f) {
  var where = f.location ? f.location.file + (f.location.line ? ':' + f.location.line : '') : '';
  var d = el('details', { cls: 'f' });
  if (state.opened[f.id]) d.open = true;
  var sevStyle = { color: cssVar(f.severity), background: 'color-mix(in srgb, ' + cssVar(f.severity) + ' 13%, transparent)' };
  d.appendChild(el('summary', null, [
    el('span', { cls: 'sev', style: sevStyle }, [t('sev.' + f.severity)]),
    el('span', { cls: 'ttl', text: f.title }),
    el('span', { cls: 'side' }, [el('span', { text: t('cat.' + f.category) }), f.fixer ? el('span', { cls: 'pill st-pass', text: t('finding.fixable') }) : null, f.status !== 'open' ? el('span', { cls: 'pill st-na', text: t('findings.status.' + f.status) }) : null]),
    where ? el('span', { cls: 'loc', title: where }, [el('bdi', { text: where })]) : null
  ]));
  var filled = false;
  d.addEventListener('toggle', function () {
    state.opened[f.id] = d.open;
    if (d.open && !filled) { d.appendChild(findingBody(f)); filled = true; }
  });
  if (d.open) { d.appendChild(findingBody(f)); filled = true; }
  return d;
}
function renderFindingsList() {
  var host = document.getElementById('flist'), cnt = document.getElementById('fcount');
  host.textContent = ''; cnt.textContent = '';
  var list = sorted(D.findings.filter(matches));
  cnt.appendChild(el('span', { text: t('findings.count', { n: num(list.length), t: num(D.findings.length) }) }));
  if (state.gate) {
    var g = R.gates.filter(function (x) { return x.id === state.gate; })[0];
    cnt.appendChild(el('span', { cls: 'chip', 'aria-pressed': 'true' }, [t('findings.gate', { g: lang !== 'en' && I[lang]['gt.' + g.id] ? t('gt.' + g.id) : g.title }), el('button', { type: 'button', cls: 'btn', style: { padding: '1px 6px' }, text: t('findings.clear'), on: { click: function () { state.gate = null; state.status = 'open'; renderGates(); renderFindingsSection(); } } })]));
  }
  if (!list.length) { host.appendChild(el('div', { cls: 'empty', text: t('findings.empty') })); return; }
  list.slice(0, state.limit).forEach(function (f) { host.appendChild(findingRow(f)); });
  var more = document.getElementById('fmore');
  more.textContent = '';
  if (list.length > state.limit) more.appendChild(el('button', { type: 'button', cls: 'btn', text: t('findings.more', { n: num(Math.min(50, list.length - state.limit)) }), on: { click: function () { state.limit += 50; renderFindingsList(); } } }));
}
function findingsSection() {
  var q = el('input', { type: 'search', id: 'fq', placeholder: t('findings.search'), 'aria-label': t('findings.search'), value: state.q });
  q.value = state.q;
  q.addEventListener('input', function () { state.q = q.value; state.limit = 50; renderFindingsList(); });
  var chips = el('div', { cls: 'chips', role: 'group', 'aria-label': t('chart.severity') });
  SEV.forEach(function (x) {
    var n = D.findings.filter(function (f) { return f.severity === x && (state.status === 'all' || f.status === state.status); }).length;
    chips.appendChild(el('button', { type: 'button', cls: 'chip', 'aria-pressed': String(!!state.sev[x]), on: { click: function () { state.sev[x] = !state.sev[x]; state.limit = 50; this.setAttribute('aria-pressed', String(!!state.sev[x])); renderFindingsList(); } } }, [el('span', { cls: 'dot', style: { background: cssVar(x) } }), t('sev.' + x) + ' ' + n]));
  });
  var cat = el('select', { 'aria-label': t('chart.category') }, [el('option', { value: '', text: t('findings.allCats') })].concat(CATS.filter(function (c) { return D.findings.some(function (f) { return f.category === c; }); }).map(function (c) { return el('option', { value: c, text: t('cat.' + c) }); })));
  cat.value = state.cat;
  cat.addEventListener('change', function () { state.cat = cat.value; state.limit = 50; renderFindingsList(); });
  var st = el('select', { 'aria-label': t('findings.status.all') }, ['open', 'all', 'suppressed', 'baseline'].map(function (v) { return el('option', { value: v, text: t('findings.status.' + v) }); }));
  st.value = state.status;
  st.addEventListener('change', function () { state.status = st.value; state.limit = 50; renderFindingsSection(); });
  var fx = el('input', { type: 'checkbox' });
  fx.checked = state.fixable;
  fx.addEventListener('change', function () { state.fixable = fx.checked; state.limit = 50; renderFindingsList(); });
  var so = el('select', { 'aria-label': t('findings.sort') }, ['severity', 'file', 'rule'].map(function (v) { return el('option', { value: v, text: t('findings.sort') + ': ' + t('findings.sort.' + v) }); }));
  so.value = state.sort;
  so.addEventListener('change', function () { state.sort = so.value; renderFindingsList(); });
  return card(t('findings.title'), null, [
    el('div', { cls: 'filters' }, [el('label', { cls: 'search' }, [searchIcon(), q]), cat, st, so, el('label', { cls: 'chk' }, [fx, t('findings.fixable')])]),
    el('div', { cls: 'filters' }, [chips]),
    el('div', { id: 'fcount', cls: 'count', 'aria-live': 'polite' }),
    el('div', { id: 'flist', cls: 'flist' }),
    el('div', { id: 'fmore', cls: 'more' })
  ]);
}
function renderFindingsSection() {
  var host = document.getElementById('findings');
  host.textContent = '';
  host.appendChild(findingsSection());
  renderFindingsList();
}

/* ---------- verification ---------- */
function checks() {
  var kids = [];
  if (!D.checks.length || D.checks.every(function (c) { return c.status === 'skipped'; })) kids.push(el('div', { cls: 'empty', text: t('checks.none') }));
  if (D.checks.length) {
    var tb = el('table', null, [el('thead', null, [el('tr', null, [el('th', { text: t('checks.kind') }), el('th', { text: t('checks.result') }), el('th', { text: t('checks.tests') }), el('th', { cls: 'num', text: t('checks.duration') }), el('th', { text: t('checks.command') })])])]);
    var body = el('tbody');
    D.checks.forEach(function (c) {
      var tone = c.status === 'passed' ? 'pass' : c.status === 'skipped' ? 'unverified' : 'block';
      var tests = null;
      if (c.tests && c.tests.total) {
        var T = c.tests, tot = Math.max(T.total, T.passed + T.failed + T.skipped, 1);
        tests = el('div', null, [
          el('div', { cls: 'track', style: { width: '140px' } }, [el('span', { style: { width: (T.passed / tot * 100) + '%', background: cssVar('pass') } }), el('span', { style: { width: (T.failed / tot * 100) + '%', background: cssVar('block') } }), el('span', { style: { width: (T.skipped / tot * 100) + '%', background: cssVar('na') } })]),
          el('div', { cls: 'faint', style: { 'font-size': '11.5px' }, text: t('checks.testsLine', { p: num(T.passed), f: num(T.failed), s: num(T.skipped) }) })
        ]);
      }
      body.appendChild(el('tr', null, [
        el('td', null, [el('b', { text: t('check.' + c.kind) }), el('div', { cls: 'faint mono', style: { 'font-size': '11.5px' }, text: c.unit })]),
        el('td', null, [el('span', { cls: 'pill st-' + tone }, [glyph(tone, 12), t('checks.' + c.status)]), c.reason ? el('div', { cls: 'faint', style: { 'font-size': '11.5px', 'margin-top': '4px' }, text: c.reason }) : null]),
        el('td', null, [tests || el('span', { cls: 'faint', text: c.diagnostics ? String(c.diagnostics) : '—' })]),
        el('td', { cls: 'num', text: c.status === 'skipped' ? '—' : dur(c.durationMs) }),
        el('td', null, [el('code', { text: c.command })])
      ]));
    });
    tb.appendChild(body);
    kids.push(el('div', { cls: 'tbl' }, [tb]));
  }
  (D.coverage || []).forEach(function (c) {
    kids.push(el('div', { style: { 'margin-top': '14px' } }, [
      el('div', { cls: 'count' }, [el('b', { text: t('coverage.title') + ': ' + c.pct + '%' }), el('code', { text: c.file }), c.stale ? el('span', { cls: 'pill st-warn', text: t('coverage.stale') }) : null]),
      el('div', { cls: 'track' }, [el('span', { style: { width: c.pct + '%', background: cssVar('pass') } })])
    ]));
  });
  return card(t('checks.title'), t('checks.hint'), kids);
}
function gaps() {
  if (!D.testGaps || !D.testGaps.length) return null;
  var top = D.testGaps.slice(0, 10), max = Math.max.apply(null, top.map(function (g) { return g.risk; }).concat([1]));
  return card(t('gaps.title'), t('gaps.hint'), [el('div', { cls: 'bars hot' }, top.map(function (g) {
    return el('div', { cls: 'barrow', title: g.reasons.join(', ') }, [
      el('span', { cls: 'lbl' }, [el('bdi', { text: g.file })]),
      el('div', { cls: 'track' }, [el('span', { style: { width: (g.risk / max * 100).toFixed(1) + '%', background: cssVar('warn') } })]),
      el('span', { cls: 'num', text: String(g.risk) })
    ]);
  }))]);
}

/* ---------- project ---------- */
function project() {
  var Pf = D.profile, dl = el('dl', { cls: 'pj' });
  function row(k, v) { if (!v) return; dl.appendChild(el('dt', { text: t(k) })); dl.appendChild(el('dd', { text: v })); }
  function tech(kinds) { return uniq(Pf.technologies.filter(function (x) { return kinds.indexOf(x.kind) >= 0; }).map(function (x) { return x.name; })).join(', '); }
  row('project.languages', Pf.languages.slice(0, 8).map(function (l) { return l.name + ' (' + l.files + ')'; }).join(', '));
  row('project.units', Pf.units.slice(0, 12).map(function (u) { return u.path + ' — ' + (u.frameworks.join(', ') || u.kind); }).join(' · '));
  row('project.data', tech(['database', 'orm', 'cache', 'queue']));
  row('project.tests', t('project.testsV', { t: num(Pf.tests.testFiles), s: num(Pf.tests.sourceFiles) }) + (Pf.tests.frameworks.length ? ' (' + Pf.tests.frameworks.join(', ') + ')' : ''));
  row('project.ci', uniq(Pf.ci.map(function (c) { return c.system; })).join(', ') || t('project.none'));
  row('project.deploy', uniq(Pf.deploy.map(function (d) { return d.kind; })).join(', '));
  if (Pf.api && Pf.api.routes) row('project.api', t('project.apiV', { n: num(Pf.api.routes) }));
  if (Pf.envVars.length) row('project.env', t('project.envV', { n: Pf.envVars.length, u: Pf.envVars.filter(function (v) { return v.required && !v.documented; }).length }));
  var lim = el('ul', { cls: 'limits' });
  (D.limitations.length ? D.limitations : [t('limits.none')]).forEach(function (l) { lim.appendChild(el('li', null, [md(l)])); });
  return el('div', { cls: 'grid g-2' }, [card(t('project.title'), null, [dl]), card(t('limits.title'), t('disclaimer'), [lim])]);
}

/* ---------- page ---------- */
function render() {
  renderChrome();
  var app = document.getElementById('app');
  app.textContent = '';
  var P2 = D.profile;
  app.appendChild(el('div', { cls: 'head', id: 'overview' }, [
    el('div', null, [el('div', { cls: 'eyebrow', lang: 'en', text: 'relivaro ' + D.command }), el('h1', { text: P2.name })]),
    el('div', { cls: 'meta' }, [
      el('span', null, [t('meta.run') + ' ', el('b', { cls: 'mono', text: D.runId })]),
      el('span', null, [t('meta.started') + ' ', el('b', { text: when(D.startedAt) })]),
      el('span', null, [t('meta.duration') + ' ', el('b', { text: dur(D.durationMs) })]),
      el('span', null, [t('meta.version') + ' ', el('b', { text: D.tool.version })])
    ])
  ]));
  app.appendChild(section('summary', [el('div', { cls: 'grid g-hero' }, [hero(), kpis()])]));
  app.appendChild(section('flow', [flow()]));
  app.appendChild(section('charts', [charts()]));
  if (R) app.appendChild(section('gates', []));
  app.appendChild(section('findings', []));
  app.appendChild(section('verification', [checks()]));
  var g = gaps();
  app.appendChild(section('trends', [el('div', { cls: 'grid g-2' }, [compare(), perf()])]));
  if (g) app.appendChild(section('gaps', [g]));
  app.appendChild(section('project', [project()]));
  renderGates();
  renderFindingsSection();
}

Array.prototype.forEach.call(document.querySelectorAll('#lang button'), function (b) {
  b.addEventListener('click', function () { lang = b.getAttribute('data-lang'); store.set('lang', lang); render(); });
});
document.getElementById('theme').addEventListener('click', function () {
  var cur = document.documentElement.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  var next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  store.set('theme', next);
});
render();
})();`;
