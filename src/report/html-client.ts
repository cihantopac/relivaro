/**
 * Client-side renderer of the HTML report. It reads the JSON payload and builds the page with DOM APIs only:
 * every repository-derived string is assigned through `textContent` / `setAttribute`, never parsed as markup.
 * Written as plain ES2017 without template literals so it can live in a string constant.
 *
 * Layout: a centered headline, a band of four numbers, then sections as wide bands. Long explanations sit in
 * disclosures; colour is reserved for actions (accent) and small severity/status marks.
 */
export const REPORT_JS = String.raw`(function () {
'use strict';
var P = JSON.parse(document.getElementById('data').textContent);
var D = P.run, X = P.extra || {}, I = P.i18n;
var REV = P.review || {}, REM = P.rem || {}, REMTXT = P.remText || {};
var REM_KINDS = ['deterministic', 'agent', 'manual'];
var VSTATES = ['detected', 'confirmed', 'false-positive', 'needs-runtime', 'accepted'];
var SEV = ['critical', 'high', 'medium', 'low', 'info'];
var CATS = ['security', 'supply-chain', 'reliability', 'performance', 'quality', 'testing', 'release'];
var GATE_ORDER = ['block', 'warn', 'unverified', 'pass', 'n/a'];
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
if (theme !== 'light' && theme !== 'dark') theme = 'system';
function applyTheme() {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}
applyTheme();

function t(k, v) {
  var s = (I[lang] && I[lang][k]) || I.en[k] || k;
  if (v) for (var n in v) s = s.split('{' + n + '}').join(String(v[n]));
  return s;
}
/* Count-aware string: the ".one" variant when the count is 1. */
function tn(k, n, v) { return t(n === 1 && I.en[k + '.one'] ? k + '.one' : k, v); }
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
/* Text with backtick-quoted spans rendered as code and **spans** as bold; every part is a text node, never markup. */
function md(text) {
  var parts = String(text).split(String.fromCharCode(96)), f = document.createDocumentFragment();
  parts.forEach(function (p, i) {
    if (!p) return;
    if (i % 2) { f.appendChild(el('code', { text: p })); return; }
    p.split('**').forEach(function (q, j) { if (q) f.appendChild(j % 2 ? el('b', { text: q }) : document.createTextNode(q)); });
  });
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
function stKey(st) { return st === 'n/a' ? 'na' : st; }
function where(f) { return f.location ? f.location.file + (f.location.line ? ':' + f.location.line : '') : ''; }

/* Status glyphs: drawn shapes, so status never relies on colour alone. */
function glyph(st, size) {
  var z = size || 14, o = { width: z, height: z, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (st === 'pass') return s('svg', o, [s('circle', { cx: 8, cy: 8, r: 6.2 }), s('path', { d: 'M5.2 8.2l2 2 3.8-4' })]);
  if (st === 'warn') return s('svg', o, [s('path', { d: 'M8 2.2l6 10.6H2z' }), s('path', { d: 'M8 6.6v2.6M8 11.1v.1' })]);
  if (st === 'block') return s('svg', o, [s('path', { d: 'M5.4 1.8h5.2l3.6 3.6v5.2l-3.6 3.6H5.4l-3.6-3.6V5.4z' }), s('path', { d: 'M5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4' })]);
  if (st === 'unverified') return s('svg', o, [s('circle', { cx: 8, cy: 8, r: 6.2, 'stroke-dasharray': '2.4 2' }), s('path', { d: 'M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1M8 11.3v.1' })]);
  return s('svg', o, [s('path', { d: 'M4.5 8h7' })]);
}
function stGlyph(st, size) { return el('span', { cls: 'glyph c-' + stKey(st) }, [glyph(st, size)]); }
var searchIcon = function () { return s('svg', { width: 15, height: 15, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'aria-hidden': 'true' }, [s('circle', { cx: 7, cy: 7, r: 4.8 }), s('path', { d: 'M10.6 10.6L14 14' })]); };
function dot(cls) { return el('span', { cls: 'dot d-' + cls, 'aria-hidden': 'true' }); }

var open = D.findings.filter(function (f) { return f.status === 'open'; });
var R = D.release;
var TONE = { 'not-ready': 'block', 'ready-with-warnings': 'warn', 'needs-verification': 'unverified', ready: 'pass' };
var state = { q: '', sev: {}, cat: '', status: 'open', fixable: false, sort: 'severity', gate: null, limit: 50, opened: {}, sel: {}, rem: '', vs: '', group: false, fOpen: false, gOpen: {} };

function vstate(f) { return RelivaroModel.vstate(f, REV); }
function remOf(f) { return REM[f.id] || { kind: 'agent', reason: 'code' }; }
function remTag(k) { return el('span', { cls: 'tag', text: t('rem.' + k) }); }
function vsTag(v) {
  var mark = v === 'confirmed' ? dot('block') : v === 'needs-runtime' ? dot('warn') : null;
  return el('span', { cls: 'tag' + (v === 'detected' ? ' dash' : v === 'false-positive' ? ' strike' : '') }, [mark, t('vs.' + v)]);
}
function selectedList() { return D.findings.filter(function (f) { return state.sel[f.id]; }); }
function scrollToId(id) { var e = document.getElementById(id); if (e) e.scrollIntoView(); }

/* Clipboard with fallbacks: file:// pages may not expose the async clipboard API. */
function copyText(text, area, done) {
  function fallback() {
    var ok = false;
    try {
      var ta = area;
      if (!ta) { ta = el('textarea', { style: { position: 'fixed', opacity: '0' } }); ta.value = text; document.body.appendChild(ta); }
      ta.focus(); ta.select();
      ok = document.execCommand && document.execCommand('copy');
      if (!area) document.body.removeChild(ta);
    } catch (e) { ok = false; }
    done(!!ok);
  }
  try {
    if (navigator.clipboard && window.isSecureContext !== false) navigator.clipboard.writeText(text).then(function () { done(true); }, fallback);
    else fallback();
  } catch (e) { fallback(); }
}

/* A disclosure; with a key, its open state survives re-rendering (language switch, filtering). */
function more(label, kids, key) {
  var d = el('details', { cls: 'more' }, [el('summary', { text: label }), el('div', { cls: 'more-body' }, kids)]);
  if (key && state.gOpen[key]) d.open = true;
  if (key) d.addEventListener('toggle', function () { state.gOpen[key] = d.open; });
  return d;
}
function band(id, title, sub, kids) {
  return el('section', { id: id, cls: 'band' }, [
    el('div', { cls: 'band-h' }, [el('div', null, [el('h2', { cls: 'band-title', text: title }), sub ? el('p', { cls: 'band-sub' }, [md(sub)]) : null])])
  ].concat(kids));
}
function panel(title, kids) { return el('div', { cls: 'panel' }, [title ? el('h3', { text: title }) : null].concat(kids)); }

/* ---------- header ---------- */
function renderChrome() {
  document.documentElement.lang = lang;
  var nav = document.getElementById('nav');
  nav.textContent = '';
  [['overview', t('nav.overview')], ['actions', t('nav.actions')], R ? ['gates', t('nav.gates')] : null, ['findings', t('nav.findings')], ['verification', t('nav.checks')], ['project', t('nav.project')]].forEach(function (x) {
    if (x) nav.appendChild(el('a', { href: '#' + x[0], text: x[1] }));
  });
  var seg = document.getElementById('lang');
  seg.setAttribute('aria-label', 'Language / Dil');
  Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === lang)); });
  var tg = document.getElementById('theme');
  tg.setAttribute('aria-label', t('theme.label'));
  Array.prototype.forEach.call(tg.querySelectorAll('button'), function (b) {
    var m = b.getAttribute('data-theme-mode');
    b.setAttribute('aria-pressed', String(m === theme));
    b.setAttribute('aria-label', t('theme.' + m));
    b.setAttribute('title', t('theme.label') + ': ' + t('theme.' + m));
  });
  document.getElementById('skip').textContent = t('skip');
  document.getElementById('foot-text').textContent = t('footer', { v: D.tool.version });
}

/* ---------- headline ---------- */
function selectIds(ids) {
  state.sel = {};
  ids.forEach(function (id) { state.sel[id] = true; });
  renderFindingsList();
  renderActionBar();
}
function hero() {
  var h = RelivaroModel.hero(D, REV);
  var meta = el('div', { cls: 'hero-meta' });
  [D.profile.name, el('span', { cls: 'mono', text: D.runId }), when(D.startedAt), dur(D.durationMs), 'Relivaro ' + D.tool.version].forEach(function (x, i) {
    if (i) meta.appendChild(el('span', { cls: 'sep', 'aria-hidden': 'true', text: '·' }));
    meta.appendChild(typeof x === 'string' ? el('span', { text: x }) : x);
  });
  var title = h.kind === 'audit-open' ? tn('hero.audit-open', h.count, { n: num(h.count) }) : t('hero.' + h.kind);
  var sub = h.kind === 'audit-open' || h.kind === 'audit-clean' ? t('hero.audit.sub')
    : h.kind === 'ready' ? t('hero.ready.sub') : tn('hero.' + h.kind + '.sub', h.count, { n: num(h.count) });
  var cta = el('div', { cls: 'hero-cta' });
  var go = {
    prompt: [t('cta.prompt'), function () { selectIds(h.ids); openPrompt(); }],
    gates: [t('cta.gates'), function () { scrollToId('gates'); }],
    findings: [t('cta.findings'), function () { scrollToId('findings'); }],
    fixfirst: [t('cta.fixfirst'), function () { scrollToId('actions'); }]
  }[h.action];
  if (go) cta.appendChild(el('button', { type: 'button', cls: 'btn pri lg', text: go[0], on: { click: go[1] } }));
  if (R && h.action !== 'gates') cta.appendChild(el('button', { type: 'button', cls: 'link', text: t('cta.allGates'), on: { click: function () { scrollToId('gates'); } } }));
  return el('section', { id: 'overview', cls: 'hero' }, [
    meta,
    el('h1', { cls: 'hero-title' }, [R ? stGlyph(TONE[R.status] || 'na', 34) : null, el('span', { text: title })]),
    el('p', { cls: 'hero-sub' }, [md(sub)]),
    cta.childNodes.length ? cta : null
  ]);
}

function stat(label, value, sub, mark) {
  return el('div', { cls: 'stat' }, [el('b', null, [mark || null, value]), el('span', { text: label }), sub ? el('span', { cls: 's', text: sub }) : null]);
}
function stats() {
  var urgent = D.summary.bySeverity.critical + D.summary.bySeverity.high;
  var fixable = open.filter(function (f) { return f.fixer; }).length;
  var ran = D.checks.filter(function (c) { return c.status !== 'skipped'; });
  var passed = ran.filter(function (c) { return c.status === 'passed'; }).length;
  var accepted = open.filter(function (f) { return vstate(f) === 'accepted'; }).length;
  var openSub = [accepted ? t('kpi.accepted', { n: num(accepted) }) : null, D.summary.suppressed ? t('kpi.suppressed', { n: num(D.summary.suppressed) }) : null].filter(Boolean).join(' · ') || null;
  var files = stat(t('kpi.files'), num(D.metrics.files), t('kpi.loc', { n: num(D.metrics.linesOfCode) }));
  var checks = stat(t('kpi.checks'), ran.length ? passed + '/' + ran.length : '—', ran.length ? null : t('kpi.checksNone'));
  var main;
  if (R) {
    var applicable = R.gates.filter(function (g) { return g.status !== 'n/a'; });
    var crit = D.summary.bySeverity.critical;
    main = [
      stat(t('stat.score'), String(R.score), R.scoreCapped ? t('hero.capped') : null),
      stat(t('kpi.open'), num(open.length), openSub),
      stat(t('stat.critical'), num(crit), null, crit ? dot('critical') : null),
      stat(t('stat.gates'), num(R.tally.pass || 0) + '/' + num(applicable.length))
    ];
  } else main = [stat(t('kpi.open'), num(open.length), openSub), stat(t('kpi.urgent'), num(urgent), null, urgent ? dot('critical') : null), files, checks];
  var reviewed = open.filter(function (f) { return REV[f.id]; }).length;
  var conf = open.filter(function (f) { return REV[f.id] && REV[f.id].verdict === 'confirmed'; }).length;
  var fp = open.filter(function (f) { return REV[f.id] && REV[f.id].verdict === 'false-positive'; }).length;
  var extra = [
    stat(t('kpi.fixable'), num(fixable)),
    stat(t('kpi.reviewed'), open.length ? num(reviewed) + '/' + num(open.length) : '—', t('kpi.reviewedSub', { c: num(conf), f: num(fp) }))
  ].concat(R ? [stat(t('kpi.urgent'), num(urgent)), files, checks] : []);
  return el('section', { id: 'summary' }, [
    el('div', { cls: 'stats' }, main),
    el('div', { cls: 'stats-more' }, [more(t('more.numbers'), [el('div', { cls: 'stats stats-' + extra.length }, extra)], 'numbers')])
  ]);
}

/* ---------- fix first ---------- */
function showRule(rule) {
  state.q = rule; state.status = 'open'; state.sev = {}; state.cat = ''; state.rem = ''; state.vs = ''; state.gate = null; state.limit = 50;
  renderGates(); renderFindingsSection(); scrollToId('findings');
}
function filterRem(k) { state.rem = k; state.status = 'open'; state.limit = 50; renderFindingsSection(); scrollToId('findings'); }
function fixFirst() {
  var top = RelivaroModel.priorities(open, REV);
  var kids = [];
  if (!top.length) kids.push(el('div', { cls: 'empty', text: t('ff.none') }));
  else {
    kids.push(el('div', { cls: 'list' }, top.map(function (g) {
      var f = g.list[0], sev = SEV[g.worst];
      return el('div', { cls: 'row' }, [
        dot(sev),
        el('button', { type: 'button', cls: 'row-btn t', title: t('ff.show'), on: { click: function () { showRule(g.rule); } } }, [el('span', { cls: 'sr', text: t('sev.' + sev) + ': ' }), md(f.title)]),
        el('span', { cls: 'side' }, [remTag(remOf(f).kind)]),
        el('span', { cls: 'p' }, [el('bdi', { text: where(f) || g.rule }), g.list.length > 1 ? ' ' + t('ff.more', { n: num(g.list.length - 1) }) : null])
      ]);
    })));
  }
  var all = [].concat.apply([], top.map(function (g) { return g.list; }));
  var sum = el('div', { cls: 'remsum' }, REM_KINDS.map(function (k) {
    var n = open.filter(function (f) { return remOf(f).kind === k; }).length;
    return el('button', { type: 'button', disabled: n ? null : true, on: { click: function () { filterRem(k); } } }, [t('rem.' + k), el('b', { text: num(n) })]);
  }));
  var reviewed = open.filter(function (f) { return REV[f.id]; }).length;
  var how = more(t('more.how'), [el('div', { cls: 'prose' }, [
    el('p', null, [md(t('rem.deterministic.d'))]), el('p', null, [md(t('rem.agent.d'))]), el('p', null, [md(t('rem.manual.d'))]),
    el('ol', null, [el('li', null, [md(t('ac.step1'))]), el('li', null, [md(t('ac.step2'))]), el('li', null, [md(t('ac.step3'))])]),
    el('p', { style: { 'margin-top': '10px' } }, [md(reviewed ? t('ac.reviewed', { r: num(reviewed), n: num(open.length) }) : t('ac.unreviewed'))])
  ])], 'how');
  kids.push(el('div', { cls: 'band-foot' }, [
    all.length ? el('button', { type: 'button', cls: 'btn pri', text: t('ff.prompt', { n: num(all.length) }), on: { click: function () { selectIds(all.map(function (f) { return f.id; })); openPrompt(); } } }) : null,
    open.length ? sum : null
  ]));
  if (open.length) kids.push(el('div', { style: { 'margin-top': '16px' } }, [how]));
  return band('actions', t('ff.title'), top.length ? t('ff.sub') : null, kids);
}

/* ---------- run flow ---------- */
function flow() {
  var ran = D.checks.filter(function (c) { return c.status !== 'skipped'; });
  var passed = ran.filter(function (c) { return c.status === 'passed'; }).length;
  var withEvidence = open.filter(function (f) { return f.evidence && (f.evidence.snippet || f.evidence.output || f.evidence.facts); }).length;
  var fixable = open.filter(function (f) { return f.fixer; }).length;
  var fx = X.fixes;
  var steps = [
    [t('flow.audit'), t('flow.audit.v', { files: num(D.metrics.files), rules: num(D.metrics.rulesRun) }), 'pass'],
    [t('flow.evidence'), t('flow.evidence.v', { n: num(withEvidence) }), 'pass'],
    [t('flow.fix'), t('flow.fix.v', { n: num(fixable) }) + (fx && fx.applied ? ' · ' + fx.applied + ' ✓' : ''), fixable ? 'warn' : 'pass'],
    [t('flow.verify'), ran.length ? t('flow.verify.v', { p: passed, t: ran.length }) : t('flow.verify.none'), ran.length ? (passed === ran.length ? 'pass' : 'block') : 'unverified'],
    [t('flow.release'), R ? t('hero.' + R.status) : t('flow.release.none'), R ? TONE[R.status] : 'na']
  ];
  return band('flow', t('flow.title'), null, [el('ol', { cls: 'flow' }, steps.map(function (x) {
    return el('li', { cls: x[2] === 'unverified' || x[2] === 'na' ? 'todo' : null }, [
      el('span', { cls: 'knot' }, [stGlyph(x[2], 15)]),
      el('div', { cls: 'ft', text: x[0] }),
      el('div', { cls: 'fv', text: x[1] })
    ]);
  }))]);
}

/* ---------- breakdown ---------- */
function charts() {
  var bySev = D.summary.bySeverity;
  if (!open.length) return band('charts', t('chart.title'), null, [el('div', { cls: 'empty', text: t('chart.empty') })]);
  var bar = el('div', { cls: 'sevbar', 'aria-hidden': 'true' }, SEV.map(function (x) { return bySev[x] ? el('span', { cls: 'd-' + x, style: { width: (bySev[x] / open.length * 100).toFixed(2) + '%' } }) : null; }));
  var sevList = el('ul', { cls: 'sevlist' }, SEV.map(function (x) {
    return el('li', null, [el('button', { type: 'button', on: { click: function () { state.sev = {}; state.sev[x] = true; state.limit = 50; renderFindingsSection(); scrollToId('findings'); } } }, [dot(x), el('span', { text: t('sev.' + x) }), el('b', { text: num(bySev[x]) })])]);
  }));
  var cats = CATS.map(function (c) { return { c: c, n: open.filter(function (f) { return f.category === c; }).length }; })
    .filter(function (x) { return x.n; }).sort(function (a, b) { return b.n - a.n; });
  var maxC = Math.max.apply(null, cats.map(function (x) { return x.n; }).concat([1]));
  var catBars = el('div', { cls: 'bars' }, cats.map(function (x) {
    return el('button', { type: 'button', cls: 'barrow', on: { click: function () { state.cat = x.c; state.limit = 50; renderFindingsSection(); scrollToId('findings'); } } }, [
      el('span', { cls: 'lbl', text: t('cat.' + x.c) }),
      el('span', { cls: 'track' }, [el('span', { style: { width: (x.n / maxC * 100).toFixed(1) + '%' } })]),
      el('span', { cls: 'num', text: num(x.n) })
    ]);
  }));
  var files = {};
  open.forEach(function (f) { if (!f.location) return; var k = f.location.file; files[k] = files[k] || { n: 0, w: 0 }; files[k].n++; files[k].w += SEV_W[f.severity]; });
  var hot = Object.keys(files).map(function (k) { return { f: k, n: files[k].n, w: files[k].w }; }).sort(function (a, b) { return b.w - a.w || b.n - a.n; }).slice(0, 6);
  var maxW = Math.max.apply(null, hot.map(function (x) { return x.w; }).concat([1]));
  var hotBars = hot.length ? el('div', { cls: 'bars hot' }, hot.map(function (x) {
    return el('button', { type: 'button', cls: 'barrow', title: x.f, on: { click: function () { state.q = x.f; state.limit = 50; renderFindingsSection(); scrollToId('findings'); } } }, [
      el('span', { cls: 'lbl' }, [el('bdi', { text: x.f })]),
      el('span', { cls: 'track' }, [el('span', { style: { width: (x.w / maxW * 100).toFixed(1) + '%' } })]),
      el('span', { cls: 'num', text: num(x.n) })
    ]);
  })) : el('div', { cls: 'empty', text: t('chart.empty') });
  return band('charts', t('chart.title'), null, [el('div', { cls: 'grid g-3' }, [
    panel(t('chart.severity'), [bar, sevList]), panel(t('chart.category'), [catBars]), panel(t('chart.hotspots'), [hotBars])
  ])]);
}

/* ---------- gates ---------- */
function gateTitle(g) { return I[lang]['gt.' + g.id] && lang !== 'en' ? t('gt.' + g.id) : g.title; }
function gates() {
  if (!R) return null;
  var applicable = R.gates.filter(function (g) { return g.status !== 'n/a'; });
  var groups = GATE_ORDER.map(function (st) {
    var list = R.gates.filter(function (g) { return g.status === st; });
    if (!list.length) return null;
    var rows = el('div', { cls: 'list' }, list.map(function (g) {
      var n = g.findings ? g.findings.length : 0;
      return el('button', {
        type: 'button', cls: 'gate', 'aria-pressed': String(state.gate === g.id), title: g.detail,
        on: { click: function () { state.gate = state.gate === g.id ? null : g.id; state.status = 'all'; state.limit = 50; renderGates(); renderFindingsSection(); if (state.gate && n) scrollToId('findings'); } }
      }, [
        stGlyph(g.status, 16),
        el('span', { cls: 'gt', text: gateTitle(g) }),
        el('span', { cls: 'gside' }, [
          n ? el('span', { cls: 'faint', style: { 'font-size': '12.5px' }, text: tn('gates.findings', n, { n: num(n) }) }) : null,
          g.basis && g.status !== 'n/a' ? el('span', { cls: 'tag' + (g.basis === 'not-run' ? ' dash' : ''), text: t('basis.' + g.basis) }) : null
        ]),
        el('span', { cls: 'gd' }, [md(g.detail)])
      ]);
    }));
    if (st === 'pass' || st === 'n/a') return el('div', { cls: 'ggroup' }, [more(t('gg.' + st) + ' · ' + num(list.length), [rows], 'gates-' + st)]);
    return el('div', { cls: 'ggroup' }, [el('h3', null, [stGlyph(st, 14), t('gg.' + st), el('span', { cls: 'faint', text: num(list.length) })]), rows]);
  });
  return band('gates', t('gates.title'), t('gates.sub', { p: num(R.tally.pass || 0), t: num(applicable.length) }), groups.concat([
    el('div', { style: { 'margin-top': '18px' } }, [more(t('more.gates'), [el('p', { cls: 'prose' }, [md(t('gates.hint'))])], 'gates-hint')])
  ]));
}
function renderGates() {
  var host = document.getElementById('gates');
  if (host && R) host.parentNode.replaceChild(gates(), host);
}

/* ---------- findings ---------- */
function matches(f) {
  if (state.gate) { var g = R && R.gates.filter(function (x) { return x.id === state.gate; })[0]; if (!g || !g.findings || g.findings.indexOf(f.id) < 0) return false; }
  if (state.status !== 'all' && f.status !== state.status) return false;
  var sevOn = Object.keys(state.sev).filter(function (k) { return state.sev[k]; });
  if (sevOn.length && sevOn.indexOf(f.severity) < 0) return false;
  if (state.cat && f.category !== state.cat) return false;
  if (state.fixable && !f.fixer) return false;
  if (state.rem && remOf(f).kind !== state.rem) return false;
  if (state.vs && vstate(f) !== state.vs) return false;
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
function output(ev) { return el('div', { cls: 'snip', role: 'region', 'aria-label': t('finding.output'), tabindex: '0' }, [el('pre', { text: (ev.command ? '$ ' + ev.command + '\n' : '') + ev.output })]); }
function findingBody(f) {
  var b = el('div', { cls: 'body' });
  var r = REV[f.id], rm = remOf(f), v = vstate(f), ev = f.evidence || {};
  b.appendChild(el('p', { cls: 'vline' }, [vsTag(v), el('span', { text: r ? r.justification : f.accepted ? t('finding.acceptedInCode', { r: f.accepted.reason }) : v === 'confirmed' ? t('finding.observed') : t('finding.notReviewed') })]));
  b.appendChild(el('p', { cls: 'msg' }, [md(f.message)]));
  if (ev.snippet) b.appendChild(snippet(ev.snippet, f.location && f.location.line));
  else if (ev.output) b.appendChild(output(ev));
  var three = [[t('finding.impact'), f.impact], [t('finding.fix'), f.recommendation], [t('finding.verify'), f.verification]].filter(function (x) { return x[1]; });
  if (three.length) b.appendChild(el('div', { cls: 'facts3' }, three.map(function (x) { return el('div', null, [el('h4', { text: x[0] }), el('p', null, [md(x[1])])]); })));
  if (rm.kind === 'deterministic') {
    var cmd = 'relivaro fix plan --finding ' + f.id + (rm.online ? ' --online' : '');
    var cmdCode = el('code', { text: cmd });
    var btn = el('button', { type: 'button', cls: 'btn sm', text: t('finding.copy') });
    btn.addEventListener('click', function () {
      copyText(cmd, null, function (ok) {
        btn.textContent = ok ? t('finding.copied') : t('finding.copyFail');
        if (!ok) { var rg = document.createRange(); rg.selectNodeContents(cmdCode); var sl = window.getSelection(); sl.removeAllRanges(); sl.addRange(rg); }
        setTimeout(function () { btn.textContent = t('finding.copy'); }, 1800);
      });
    });
    b.appendChild(el('div', { cls: 'cmd' }, [el('span', { cls: 'muted', style: { 'font-size': '12.5px', 'font-weight': '600' }, text: t('finding.autofix') + (rm.safety === 'review' ? ' · ' + t('finding.reviewDiff') : '') }), cmdCode, btn]));
  }
  function kv(label, val, mono) { return val ? el('div', null, [el('h4', { text: label }), mono ? el('p', { cls: 'mono', style: { 'font-size': '12.5px' }, text: val }) : el('p', null, [typeof val === 'string' ? md(val) : val])]) : null; }
  var details = el('div', { cls: 'kv' }, [
    kv(t('finding.remediation'), el('span', null, [remTag(rm.kind), ' ', t('rem.reason.' + rm.reason)])),
    kv(t('finding.standards'), [].concat(f.cwe || [], f.owasp || []).join(' · ')),
    kv(t('finding.rule'), f.ruleId + ' · ' + f.id, true),
    kv(t('finding.confidence'), t('conf.' + f.confidence) + ' · ' + (I.en['prov.' + f.provenance] ? t('prov.' + f.provenance) : f.provenance)),
    r ? kv(t('vs.label'), t('finding.reviewBy', { kind: t('reviewer.' + r.reviewer.kind), name: r.reviewer.name, when: when(r.reviewedAt) }) + (r.carriedFrom ? ' · ' + t('finding.carried', { run: r.carriedFrom }) : '') + (r.severity ? ' · ' + t('finding.reviewSeverity', { s: t('sev.' + r.severity) }) : '')) : null,
    r && r.evidence && r.evidence.length ? kv(t('finding.evidence'), el('span', { cls: 'facts' }, r.evidence.map(function (e) { return el('code', { text: e.file + (e.line ? ':' + e.line : '') }); }))) : null,
    ev.facts ? kv(t('finding.facts'), el('span', { cls: 'facts' }, Object.keys(ev.facts).map(function (k) { return el('code', { text: k + ': ' + ev.facts[k] }); }))) : null,
    f.suppression ? kv(t('finding.suppressed'), f.suppression.kind + (f.suppression.reason ? ': ' + f.suppression.reason : '')) : null
  ]);
  var dkids = [details];
  if (ev.snippet && ev.output) dkids.push(el('div', { style: { 'margin-top': '14px' } }, [el('h4', { cls: 'muted', style: { margin: '0 0 6px', 'font-size': '12px' }, text: t('finding.output') }), output(ev)]));
  b.appendChild(more(t('more.details'), dkids));
  return b;
}
function findingRow(f) {
  var loc = where(f);
  var row = el('div', { cls: 'frow' + (state.sel[f.id] ? ' is-sel' : '') });
  var cb = el('input', { type: 'checkbox', cls: 'fsel', 'aria-label': t('sel.row', { id: f.id, title: f.title }) });
  cb.checked = !!state.sel[f.id];
  cb.addEventListener('change', function () { setSel([f], cb.checked); row.className = 'frow' + (cb.checked ? ' is-sel' : ''); });
  row.appendChild(el('label', { cls: 'fsel-wrap', title: t('sel.row', { id: f.id, title: '' }) }, [cb]));
  var d = el('details', { cls: 'f' });
  if (state.opened[f.id]) d.open = true;
  d.appendChild(el('summary', null, [
    dot(f.severity),
    el('span', { cls: 'ttl' }, [el('span', { cls: 'sr', text: t('sev.' + f.severity) + ': ' }), md(f.title)]),
    el('span', { cls: 'side' }, [vstate(f) !== 'detected' ? vsTag(vstate(f)) : null, remTag(remOf(f).kind), f.status !== 'open' ? el('span', { cls: 'tag', text: t('findings.status.' + f.status) }) : null]),
    loc ? el('span', { cls: 'loc', title: loc }, [el('bdi', { text: loc })]) : null
  ]));
  var filled = false;
  d.addEventListener('toggle', function () {
    state.opened[f.id] = d.open;
    if (d.open && !filled) { d.appendChild(findingBody(f)); filled = true; }
  });
  if (d.open) { d.appendChild(findingBody(f)); filled = true; }
  row.appendChild(d);
  return row;
}
function setSel(list, on) {
  list.forEach(function (f) { if (on) state.sel[f.id] = true; else delete state.sel[f.id]; });
  (state.groupBoxes || []).forEach(function (g) {
    var all = g.list.every(function (f) { return state.sel[f.id]; }), some = g.list.some(function (f) { return state.sel[f.id]; });
    g.cb.checked = all; g.cb.indeterminate = some && !all;
  });
  renderActionBar();
}
function groupHead(rule, list) {
  var all = list.every(function (f) { return state.sel[f.id]; }), some = list.some(function (f) { return state.sel[f.id]; });
  var cb = el('input', { type: 'checkbox', cls: 'fsel', 'aria-label': t('sel.group', { n: list.length, rule: rule }) });
  cb.checked = all; cb.indeterminate = some && !all;
  cb.addEventListener('change', function () { setSel(list, cb.checked); renderFindingsList(); var again = document.querySelector('[data-group="' + rule.replace(/[^\w\/-]/g, '') + '"]'); if (again) again.focus(); });
  cb.setAttribute('data-group', rule.replace(/[^\w\/-]/g, ''));
  state.groupBoxes.push({ cb: cb, list: list });
  return el('div', { cls: 'ghead' }, [
    el('label', { cls: 'fsel-wrap' }, [cb]),
    el('div', { cls: 'gtitle' }, [dot(list[0].severity), el('b', null, [md(list[0].title)]), el('code', { text: rule })]),
    el('span', { cls: 'side' }, uniq(list.map(function (f) { return remOf(f).kind; })).map(remTag).concat([el('span', { cls: 'faint', style: { 'font-size': '12.5px' }, text: t('group.count', { n: num(list.length) }) })]))
  ]);
}
function renderFindingsList() {
  var host = document.getElementById('flist'), cnt = document.getElementById('fcount');
  if (!host) return;
  host.textContent = ''; cnt.textContent = '';
  var list = sorted(D.findings.filter(matches));
  cnt.appendChild(el('span', { text: t('findings.count', { n: num(list.length), t: num(D.findings.length) }) }));
  if (state.gate) {
    var g = R.gates.filter(function (x) { return x.id === state.gate; })[0];
    cnt.appendChild(el('span', { cls: 'chip', 'aria-pressed': 'true' }, [t('findings.gate', { g: gateTitle(g) }), el('button', { type: 'button', cls: 'link plain', style: { 'font-size': '12.5px' }, text: t('findings.clear'), on: { click: function () { state.gate = null; state.status = 'open'; renderGates(); renderFindingsSection(); } } })]));
  }
  var moreHost = document.getElementById('fmore');
  moreHost.textContent = '';
  state.visible = list;
  state.groupBoxes = [];
  host.hidden = !list.length;
  if (!list.length) { moreHost.appendChild(el('div', { cls: 'empty', style: { width: '100%' }, text: t('findings.empty') })); return; }
  if (state.group) {
    var groups = {}, order = [];
    list.forEach(function (f) { if (!groups[f.ruleId]) { groups[f.ruleId] = []; order.push(f.ruleId); } groups[f.ruleId].push(f); });
    var shown = 0;
    order.forEach(function (rule) {
      if (shown >= state.limit) return;
      var gl = groups[rule], box = el('div', { cls: 'group' }, [groupHead(rule, gl)]);
      gl.slice(0, Math.max(state.limit - shown, 1)).forEach(function (f) { box.appendChild(findingRow(f)); });
      shown += gl.length;
      host.appendChild(box);
    });
  } else list.slice(0, state.limit).forEach(function (f) { host.appendChild(findingRow(f)); });
  if (list.length > state.limit) moreHost.appendChild(el('button', { type: 'button', cls: 'btn', text: t('findings.more', { n: num(Math.min(50, list.length - state.limit)) }), on: { click: function () { state.limit += 50; renderFindingsList(); } } }));
}
function findingsSection() {
  var q = el('input', { type: 'search', id: 'fq', placeholder: t('findings.search'), 'aria-label': t('findings.search') });
  q.value = state.q;
  q.addEventListener('input', function () { state.q = q.value; state.limit = 50; renderFindingsList(); });
  var chips = el('div', { cls: 'chips', role: 'group', 'aria-label': t('chart.severity') });
  SEV.forEach(function (x) {
    var n = D.findings.filter(function (f) { return f.severity === x && (state.status === 'all' || f.status === state.status); }).length;
    chips.appendChild(el('button', { type: 'button', cls: 'chip', 'aria-pressed': String(!!state.sev[x]), on: { click: function () { state.sev[x] = !state.sev[x]; state.limit = 50; this.setAttribute('aria-pressed', String(!!state.sev[x])); renderFindingsList(); } } }, [dot(x), t('sev.' + x) + ' ' + num(n)]));
  });
  var cat = el('select', { 'aria-label': t('findings.category') }, [el('option', { value: '', text: t('findings.allCats') })].concat(CATS.filter(function (c) { return D.findings.some(function (f) { return f.category === c; }); }).map(function (c) { return el('option', { value: c, text: t('cat.' + c) }); })));
  cat.value = state.cat;
  cat.addEventListener('change', function () { state.cat = cat.value; state.limit = 50; renderFindingsList(); });
  var st = el('select', { 'aria-label': t('findings.status') }, ['open', 'all', 'suppressed', 'baseline'].map(function (v) { return el('option', { value: v, text: t('findings.status.' + v) }); }));
  st.value = state.status;
  st.addEventListener('change', function () { state.status = st.value; state.limit = 50; renderFindingsSection(); });
  var fx = el('input', { type: 'checkbox' });
  fx.checked = state.fixable;
  fx.addEventListener('change', function () { state.fixable = fx.checked; state.limit = 50; renderFindingsList(); });
  var so = el('select', { 'aria-label': t('findings.sort') }, ['severity', 'file', 'rule'].map(function (v) { return el('option', { value: v, text: t('findings.sort') + ': ' + t('findings.sort.' + v) }); }));
  so.value = state.sort;
  so.addEventListener('change', function () { state.sort = so.value; renderFindingsList(); });
  var pool = D.findings.filter(function (f) { return state.status === 'all' || f.status === state.status; });
  function toggleChips(label, keys, cur, count, text, set) {
    return el('div', { cls: 'chips', role: 'group', 'aria-label': label }, keys.map(function (k) {
      var n = pool.filter(function (f) { return count(f) === k; }).length;
      return el('button', { type: 'button', cls: 'chip', 'aria-pressed': String(cur === k), disabled: n || cur === k ? null : true, on: { click: function () { set(cur === k ? '' : k); state.limit = 50; renderFindingsSection(); } } }, [text(k) + ' ' + num(n)]);
    }));
  }
  var remChips = toggleChips(t('finding.remediation'), REM_KINDS, state.rem, function (f) { return remOf(f).kind; }, function (k) { return t('rem.' + k); }, function (v) { state.rem = v; });
  var vsChips = toggleChips(t('vs.label'), VSTATES, state.vs, vstate, function (k) { return t('vs.' + k); }, function (v) { state.vs = v; });
  var active = (state.cat ? 1 : 0) + (state.status !== 'open' ? 1 : 0) + (state.fixable ? 1 : 0) + (state.rem ? 1 : 0) + (state.vs ? 1 : 0);
  var filters = el('details', { cls: 'more' }, [
    el('summary', { text: t('more.filters') + (active ? ' · ' + active : '') }),
    el('div', { cls: 'fpanel' }, [
      el('div', { cls: 'fline' }, [cat, st, so, el('label', { cls: 'chk' }, [fx, t('findings.fixable')])]),
      el('div', { cls: 'fline' }, [el('span', { cls: 'flabel', text: t('finding.remediation') }), remChips]),
      el('div', { cls: 'fline' }, [el('span', { cls: 'flabel', text: t('vs.label') }), vsChips])
    ])
  ]);
  if (state.fOpen) filters.open = true;
  filters.addEventListener('toggle', function () { state.fOpen = filters.open; });
  var bySev = el('select', { 'aria-label': t('sel.severity') }, [el('option', { value: '', text: t('sel.severity') })].concat(SEV.map(function (x) { return el('option', { value: x, text: t('sev.' + x) }); })));
  bySev.addEventListener('change', function () {
    var v = bySev.value; if (!v) return;
    setSel((state.visible || []).filter(function (f) { return f.severity === v; }), true);
    bySev.value = ''; renderFindingsList();
  });
  var grp = el('input', { type: 'checkbox' });
  grp.checked = state.group;
  grp.addEventListener('change', function () { state.group = grp.checked; renderFindingsList(); });
  var selRow = el('div', { cls: 'selrow', role: 'group', 'aria-label': t('sel.label') }, [
    el('button', { type: 'button', cls: 'link', text: t('sel.visible'), on: { click: function () { setSel(state.visible || [], true); renderFindingsList(); } } }),
    bySev,
    el('button', { type: 'button', cls: 'link', text: t('sel.clear'), on: { click: function () { state.sel = {}; renderActionBar(); renderFindingsList(); } } }),
    el('label', { cls: 'chk' }, [grp, t('group.toggle')])
  ]);
  return band('findings', t('findings.title'), t('findings.sub'), [
    el('div', { cls: 'ftools' }, [el('label', { cls: 'search' }, [searchIcon(), q]), chips]),
    filters,
    selRow,
    el('div', { id: 'fcount', cls: 'count', 'aria-live': 'polite' }),
    el('div', { id: 'flist', cls: 'flist' }),
    el('div', { id: 'fmore', cls: 'more-row' })
  ]);
}
function renderFindingsSection() {
  var host = document.getElementById('findings');
  if (!host) return;
  host.parentNode.replaceChild(findingsSection(), host);
  renderFindingsList();
}

/* ---------- selection bar + prompt sheet ---------- */
function renderActionBar() {
  var bar = document.getElementById('actionbar');
  var list = selectedList();
  bar.textContent = '';
  bar.hidden = !list.length;
  document.body.classList.toggle('has-bar', !!list.length);
  bar.setAttribute('aria-label', t('sel.label'));
  if (!list.length) return;
  var c = { deterministic: 0, agent: 0, manual: 0, none: 0 };
  list.forEach(function (f) { c[remOf(f).kind]++; });
  var hidden = list.filter(function (f) { return (state.visible || []).indexOf(f) < 0; }).length;
  var mix = REM_KINDS.concat(['none']).filter(function (k) { return c[k]; }).map(function (k) { return t('rem.' + k) + ' ' + num(c[k]); });
  if (hidden) mix.push(t('sel.hidden', { n: num(hidden) }));
  bar.appendChild(el('div', { cls: 'ab-in' }, [
    el('div', { cls: 'ab-txt' }, [el('b', { text: t('sel.count', { n: num(list.length) }) }), el('span', { cls: 'x', text: mix.join(' · ') })]),
    el('div', { cls: 'ab-btns' }, [
      el('button', { type: 'button', cls: 'ghost', text: t('sel.clear'), on: { click: function () { state.sel = {}; renderActionBar(); renderFindingsList(); } } }),
      el('button', { type: 'button', cls: 'btn pri', text: t('ab.generate'), on: { click: openPrompt } })
    ])
  ]));
}
function nonce() {
  var a = new Uint8Array(8);
  try { window.crypto.getRandomValues(a); } catch (e) { for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); }
  return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
}
function openPrompt() {
  var list = sorted(selectedList());
  if (!list.length) return;
  var text = RelivaroPrompt.build({
    project: D.profile.name, runId: D.runId, command: D.command, startedAt: D.startedAt, version: D.tool.version, root: D.root,
    lang: lang, nonce: nonce(), remText: REMTXT,
    findings: list.map(function (f) { return { finding: f, rem: remOf(f), review: REV[f.id] }; })
  });
  var dlg = document.getElementById('prompt');
  dlg.textContent = '';
  var status = el('p', { cls: 'pr-status', role: 'status', 'aria-live': 'polite' });
  var area = el('textarea', { id: 'prompt-text', spellcheck: 'false', 'aria-label': t('pr.label') });
  area.value = text;
  var textBox = more(t('pr.showText'), [el('label', { 'for': 'prompt-text', cls: 'sr', text: t('pr.label') }), area]);
  var file = 'relivaro-fix-' + String(D.runId).replace(/[^\w.-]/g, '') + '.md';
  function close() { if (dlg.close) dlg.close(); else dlg.removeAttribute('open'); }
  var rows = list.slice(0, 6).map(function (f) {
    var loc = where(f);
    return el('div', null, [dot(f.severity), el('span', { cls: 't' }, [el('span', { cls: 'sr', text: t('sev.' + f.severity) + ': ' }), md(f.title)]), el('span', { cls: 'p', title: loc }, [el('bdi', { text: loc })])]);
  });
  if (list.length > 6) rows.push(el('div', { cls: 'muted' }, [el('span'), el('span', { text: t('pr.more', { n: num(list.length - 6) }) }), el('span')]));
  var copyBtn = el('button', { type: 'button', cls: 'btn pri', text: t('pr.copy'), on: { click: function () {
    copyText(area.value, textBox.open ? area : null, function (ok) {
      status.textContent = ok ? t('pr.copied') : t('pr.copyBlocked');
      if (!ok) { textBox.open = true; area.focus(); area.select(); }
    });
  } } });
  dlg.appendChild(el('div', { cls: 'pr' }, [
    el('div', { cls: 'pr-h' }, [
      el('div', null, [el('h2', { id: 'prompt-title', text: t('pr.title') }), el('p', { text: t('sel.count', { n: num(list.length) }) + ' · ' + t('pr.paste') })]),
      el('button', { type: 'button', cls: 'icon-btn', 'aria-label': t('pr.close'), text: '×', on: { click: close } })
    ]),
    el('div', { cls: 'pr-list' }, rows),
    el('p', { cls: 'pr-steps' }, [el('b', { text: t('pr.steps') }), ' ' + t('pr.stepsList')]),
    el('div', { cls: 'pr-more' }, [textBox, more(t('pr.limits'), [el('div', { cls: 'prose' }, [el('p', null, [md(t('pr.where'))]), el('p', null, [md(t('pr.static'))])])])]),
    el('div', { cls: 'pr-btns' }, [
      status,
      el('button', { type: 'button', cls: 'btn', text: t('pr.download'), on: { click: function () {
        var url = URL.createObjectURL(new Blob([area.value], { type: 'text/markdown;charset=utf-8' }));
        var a = el('a', { href: url, download: file });
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        status.textContent = t('pr.downloaded', { f: file });
      } } }),
      copyBtn
    ])
  ]));
  dlg.setAttribute('aria-labelledby', 'prompt-title');
  if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
  copyBtn.focus();
}

/* ---------- checks ---------- */
function checks() {
  var kids = [];
  var none = !D.checks.length || D.checks.every(function (c) { return c.status === 'skipped'; });
  if (!D.checks.length) kids.push(el('div', { cls: 'empty' }, [md(t('checks.none'))]));
  if (D.checks.length) {
    var tb = el('table', null, [el('thead', null, [el('tr', null, [el('th', { text: t('checks.kind') }), el('th', { text: t('checks.result') }), el('th', { text: t('checks.tests') }), el('th', { cls: 'num', text: t('checks.duration') }), el('th', { text: t('checks.command') })])])]);
    var body = el('tbody');
    D.checks.forEach(function (c) {
      var tone = c.status === 'passed' ? 'pass' : c.status === 'skipped' ? 'unverified' : 'block';
      var tests = null;
      if (c.tests && c.tests.total) {
        var T = c.tests, tot = Math.max(T.total, T.passed + T.failed + T.skipped, 1);
        tests = el('div', null, [
          el('div', { cls: 'track', style: { width: '140px' } }, [el('span', { cls: 'line-pass', style: { width: (T.passed / tot * 100) + '%' } }), el('span', { cls: 'line-block', style: { width: (T.failed / tot * 100) + '%' } }), el('span', { cls: 'line-na', style: { width: (T.skipped / tot * 100) + '%' } })]),
          el('div', { cls: 'faint', style: { 'font-size': '12px', 'margin-top': '4px' }, text: t('checks.testsLine', { p: num(T.passed), f: num(T.failed), s: num(T.skipped) }) })
        ]);
      }
      body.appendChild(el('tr', null, [
        el('td', null, [el('b', { text: t('check.' + c.kind) }), c.unit && c.unit !== '.' ? el('div', { cls: 'faint mono', style: { 'font-size': '12px' }, text: c.unit }) : null]),
        el('td', null, [el('span', { cls: 'sev' }, [stGlyph(tone, 14), t('checks.' + c.status)]), c.reason ? el('div', { cls: 'faint', style: { 'font-size': '12px', 'margin-top': '4px' }, text: c.reason }) : null]),
        el('td', null, [tests || el('span', { cls: 'faint', text: c.diagnostics ? String(c.diagnostics) : '—' })]),
        el('td', { cls: 'num', text: c.status === 'skipped' ? '—' : dur(c.durationMs) }),
        el('td', null, [el('code', { text: c.command })])
      ]));
    });
    tb.appendChild(body);
    kids.push(el('div', { cls: 'panel', style: { padding: '6px 8px' } }, [el('div', { cls: 'tbl' }, [tb])]));
  }
  (D.coverage || []).forEach(function (c) {
    kids.push(el('div', { cls: 'panel', style: { 'margin-top': '14px' } }, [
      el('div', { cls: 'count', style: { margin: '0 0 10px' } }, [el('b', { style: { color: 'var(--text)' }, text: t('coverage.title') + ': ' + c.pct + '%' }), el('code', { text: c.file }), c.stale ? el('span', { cls: 'tag dash', text: t('coverage.stale') }) : null]),
      el('div', { cls: 'track' }, [el('span', { cls: 'line-pass', style: { width: c.pct + '%' } })])
    ]));
  });
  return band('verification', t('checks.title'), none ? t('checks.none') : t('checks.sub'), kids);
}

/* ---------- since last run, performance, test gaps ---------- */
function compare() {
  var C = X.comparison;
  if (!C) return panel(t('compare.title'), [el('div', { cls: 'empty', text: t('compare.none') })]);
  var kids = [el('p', { cls: 'faint', style: { margin: '-8px 0 14px', 'font-size': '12.5px' }, text: t('compare.base', { id: C.base.runId }) + ' · ' + when(C.base.startedAt) }), el('div', { cls: 'deltas' }, [
    el('div', { cls: 'delta' }, [el('b', { text: '+' + num(C.introduced) }), el('div', { cls: 'muted', text: t('compare.introduced') })]),
    el('div', { cls: 'delta' }, [el('b', { text: '−' + num(C.resolved) }), el('div', { cls: 'muted', text: t('compare.resolved') })]),
    el('div', { cls: 'delta' }, [el('b', { text: num(C.persisting) }), el('div', { cls: 'muted', text: t('compare.persisting') })])
  ])];
  if (C.releaseChange) kids.push(el('p', { cls: 'muted', style: { 'font-size': '13.5px', margin: '14px 0 0' } }, [t('compare.release') + ': ' + t('hero.' + C.releaseChange.from) + ' (' + C.releaseChange.scoreFrom + ') → ' + t('hero.' + C.releaseChange.to) + ' (' + C.releaseChange.scoreTo + ')']));
  var list = el('ul', { cls: 'mini' });
  [['+', C.introducedTop || []], ['−', C.resolvedTop || []]].forEach(function (x) {
    x[1].forEach(function (f) { list.appendChild(el('li', null, [el('b', { text: x[0] }), dot(f.severity), el('span', { text: f.title }), f.file ? el('code', { text: f.file }) : null])); });
  });
  if (list.childNodes.length) kids.push(list);
  return panel(t('compare.title'), kids);
}
function perf() {
  var B = X.bench || [];
  if (!B.length) return panel(t('perf.title'), [el('div', { cls: 'empty' }, [md(t('perf.none'))])]);
  var tb = el('table', null, [el('thead', null, [el('tr', null, [el('th', { text: t('perf.name') }), el('th', { cls: 'num', text: t('perf.mean') }), el('th', { cls: 'num', text: t('perf.p95') }), el('th', { cls: 'num', text: t('perf.errors') }), el('th', { text: t('perf.measured') })])])]);
  var body = el('tbody');
  B.forEach(function (b) {
    body.appendChild(el('tr', null, [el('td', null, [el('code', { text: b.name }), ' ', el('span', { cls: 'tag', text: b.kind })]), el('td', { cls: 'num', text: b.stats.meanMs.toFixed(1) + ' ms' }), el('td', { cls: 'num', text: b.stats.p95Ms.toFixed(1) + ' ms' }), el('td', { cls: 'num', text: b.kind === 'http' ? ((b.stats.errorRate || 0) * 100).toFixed(2) + '%' : '—' }), el('td', { cls: 'muted', text: when(b.measuredAt) })]));
  });
  tb.appendChild(body);
  return panel(t('perf.title'), [el('div', { cls: 'tbl' }, [tb])]);
}
function gaps() {
  if (!D.testGaps || !D.testGaps.length) return null;
  var top = D.testGaps.slice(0, 8), max = Math.max.apply(null, top.map(function (g) { return g.risk; }).concat([1]));
  return band('gaps', t('gaps.title'), t('gaps.sub'), [el('div', { cls: 'panel' }, [el('div', { cls: 'bars hot' }, top.map(function (g) {
    return el('div', { cls: 'barrow', style: { cursor: 'default' }, title: g.reasons.join(', ') }, [
      el('span', { cls: 'lbl' }, [el('bdi', { text: g.file })]),
      el('span', { cls: 'track' }, [el('span', { style: { width: (g.risk / max * 100).toFixed(1) + '%' } })]),
      el('span', { cls: 'num', text: String(g.risk) })
    ]);
  }))])]);
}

/* ---------- project ---------- */
function project() {
  var Pf = D.profile, dl = el('dl', { cls: 'pj' });
  function row(k, v) { if (!v) return; dl.appendChild(el('dt', { text: k })); dl.appendChild(el('dd', { text: v })); }
  function tech(kinds) { return uniq(Pf.technologies.filter(function (x) { return kinds.indexOf(x.kind) >= 0; }).map(function (x) { return x.name; })).join(', '); }
  row(t('project.languages'), Pf.languages.slice(0, 8).map(function (l) { return l.name + ' (' + l.files + ')'; }).join(', '));
  row(t('project.units'), Pf.units.slice(0, 12).map(function (u) { return u.path + ' — ' + (u.frameworks.join(', ') || u.kind); }).join(' · '));
  row(t('project.data'), tech(['database', 'orm', 'cache', 'queue']));
  row(t('project.tests'), t('project.testsV', { t: num(Pf.tests.testFiles), s: num(Pf.tests.sourceFiles) }) + (Pf.tests.frameworks.length ? ' (' + Pf.tests.frameworks.join(', ') + ')' : ''));
  row(t('project.ci'), uniq(Pf.ci.map(function (c) { return c.system; })).join(', ') || t('project.none'));
  row(t('project.deploy'), uniq(Pf.deploy.map(function (d) { return d.kind; })).join(', '));
  if (Pf.api && Pf.api.routes) row(t('project.api'), t('project.apiV', { n: num(Pf.api.routes) }));
  if (Pf.envVars.length) row(t('project.env'), t('project.envV', { n: Pf.envVars.length, u: Pf.envVars.filter(function (v) { return v.required && !v.documented; }).length }));
  var all = D.limitations.length ? D.limitations : [t('limits.none')];
  function limits(items) { return el('ul', { cls: 'limits' }, items.map(function (l) { return el('li', null, [md(l)]); })); }
  var lim = [limits(all.slice(0, 3))];
  if (all.length > 3) lim.push(el('div', { style: { 'margin-top': '10px' } }, [more(t('limits.more', { n: num(all.length - 3) }), [limits(all.slice(3))], 'limits')]));
  lim.push(el('p', { cls: 'faint', style: { 'font-size': '12.5px', margin: '16px 0 0' }, text: t('disclaimer') }));
  return el('section', { id: 'project', cls: 'band' }, [el('div', { cls: 'grid g-2' }, [
    el('div', null, [el('h2', { cls: 'band-title', style: { 'margin-bottom': '18px' }, text: t('project.title') }), el('div', { cls: 'panel' }, [dl])]),
    el('div', null, [el('h2', { cls: 'band-title', style: { 'margin-bottom': '18px' }, text: t('limits.title') }), el('div', { cls: 'panel' }, lim)])
  ])]);
}

/* ---------- page ---------- */
function render() {
  renderChrome();
  var app = document.getElementById('app');
  app.textContent = '';
  app.appendChild(hero());
  app.appendChild(stats());
  app.appendChild(fixFirst());
  app.appendChild(flow());
  app.appendChild(charts());
  if (R) app.appendChild(gates());
  app.appendChild(el('section', { id: 'findings' }));
  app.appendChild(checks());
  app.appendChild(el('section', { id: 'trends', cls: 'band' }, [el('div', { cls: 'grid g-2' }, [compare(), perf()])]));
  var g = gaps();
  if (g) app.appendChild(g);
  app.appendChild(project());
  renderFindingsSection();
  renderActionBar();
}

Array.prototype.forEach.call(document.querySelectorAll('#lang button'), function (b) {
  b.addEventListener('click', function () { lang = b.getAttribute('data-lang'); store.set('lang', lang); render(); });
});
Array.prototype.forEach.call(document.querySelectorAll('#theme button'), function (b) {
  b.addEventListener('click', function () { theme = b.getAttribute('data-theme-mode'); store.set('theme', theme); applyTheme(); renderChrome(); });
});
render();
})();`;
