/**
 * Decisions behind the HTML report's headline: which status sentence to show, which findings the primary action
 * selects, and which root causes to fix first. Pure functions without DOM access, shipped inside the report and
 * unit-tested exactly as shipped. Written as plain ES2017 without template literals so it can live in a string constant.
 */
export const MODEL_JS = String.raw`var RelivaroModel = (function () {
'use strict';
var SEV = ['critical', 'high', 'medium', 'low', 'info'];

/* Verification state: reviewed verdicts, findings observed by running a tool, or a scanner candidate. */
function vstate(f, review) {
  var r = review && review[f.id];
  if (r) return r.verdict;
  if (f.accepted) return 'accepted';
  return f.provenance === 'executed' || f.provenance === 'measured' ? 'confirmed' : 'detected';
}
function actionable(f, review) {
  var v = vstate(f, review);
  return f.status === 'open' && v !== 'false-positive' && v !== 'accepted';
}
function bySeverity(a, b) { return SEV.indexOf(a.severity) - SEV.indexOf(b.severity); }

/* The three most severe root causes (rules) among open findings not reviewed as false positives or accepted risks. */
function priorities(open, review) {
  var groups = {}, order = [];
  open.forEach(function (f) {
    if (!actionable(f, review)) return;
    if (!groups[f.ruleId]) { groups[f.ruleId] = []; order.push(f.ruleId); }
    groups[f.ruleId].push(f);
  });
  return order.map(function (r) {
    var g = groups[r].slice().sort(bySeverity);
    return { rule: r, list: g, worst: SEV.indexOf(g[0].severity) };
  }).sort(function (a, b) { return a.worst - b.worst || b.list.length - a.list.length || a.rule.localeCompare(b.rule); }).slice(0, 3);
}

/*
 * Headline of the report. The primary action always matches what the sentence counts: for blockers it selects the
 * findings behind the blocking gates, and when no such finding is left it sends the reader to the gates instead.
 */
function hero(run, review) {
  var R = run.release;
  var open = run.findings.filter(function (f) { return f.status === 'open'; });
  if (!R) return open.length
    ? { kind: 'audit-open', count: open.length, action: 'fixfirst', ids: [] }
    : { kind: 'audit-clean', count: 0, action: null, ids: [] };
  var tally = R.tally || {};
  if (R.status === 'not-ready') {
    var wanted = {};
    R.gates.forEach(function (g) { if (g.status === 'block') (g.findings || []).forEach(function (id) { wanted[id] = true; }); });
    var ids = run.findings.filter(function (f) { return wanted[f.id] && actionable(f, review); })
      .map(function (f, i) { return { f: f, i: i }; })
      .sort(function (a, b) { return bySeverity(a.f, b.f) || a.i - b.i; })
      .map(function (x) { return x.f.id; });
    return { kind: 'not-ready', count: tally.block || 0, action: ids.length ? 'prompt' : 'gates', ids: ids };
  }
  if (R.status === 'ready-with-warnings') return { kind: R.status, count: tally.warn || 0, action: 'gates', ids: [] };
  if (R.status === 'needs-verification') return { kind: R.status, count: tally.unverified || 0, action: 'gates', ids: [] };
  return { kind: 'ready', count: 0, action: 'findings', ids: [] };
}

return { vstate: vstate, priorities: priorities, hero: hero };
})();`;
