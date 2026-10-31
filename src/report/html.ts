import type { RunRecord } from '../audit.js';

/**
 * Self-contained interactive HTML report. All repository-derived text is inserted via `textContent` from a JSON
 * payload (with `<` escaped), and a strict CSP forbids any network access, so analysed content cannot inject markup
 * or scripts into the report.
 */
export function toHtml(run: RunRecord): string {
  const payload = JSON.stringify({
    run: { ...run, root: run.root },
  })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const title = `Relivaro — ${run.profile.name}`.replace(
    /[<>&"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--text:#1b1d21;--muted:#5d6370;--line:#e3e4e8;--accent:#2f5bd3;--critical:#b3132b;--high:#d9480f;--medium:#b07d00;--low:#2f7d4f;--info:#61708a;--code:#f1f2f5;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#121417;--panel:#1a1d22;--text:#e7e9ee;--muted:#9aa2b1;--line:#2b3038;--accent:#7aa2ff;--critical:#ff6b81;--high:#ff922b;--medium:#ffd43b;--low:#69db7c;--info:#a5b4cc;--code:#22262d;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{padding:24px 16px 8px;max-width:1200px;margin:0 auto}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.muted{color:var(--muted)}main{max-width:1200px;margin:0 auto;padding:0 16px 48px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px}.card b{display:block;font-size:22px}
.sev-critical{color:var(--critical)}.sev-high{color:var(--high)}.sev-medium{color:var(--medium)}.sev-low{color:var(--low)}.sev-info{color:var(--info)}
.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid currentColor;white-space:nowrap}
.release{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:10px}
.status{font-size:20px;font-weight:700}.status.not-ready{color:var(--critical)}.status.needs-verification{color:var(--medium)}.status.ready-with-warnings{color:var(--high)}.status.ready{color:var(--low)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.filters select,.filters input{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:6px 8px;font:inherit}
.filters input{flex:1;min-width:180px}
details.finding{background:var(--panel);border:1px solid var(--line);border-radius:10px;margin:8px 0}
details.finding summary{cursor:pointer;padding:10px 12px;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;list-style:none}
details.finding summary::-webkit-details-marker{display:none}
.finding .body{padding:0 12px 12px;border-top:1px solid var(--line)}
pre{background:var(--code);border-radius:8px;padding:10px;overflow:auto;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}
code{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
dl{display:grid;grid-template-columns:120px 1fr;gap:4px 12px;margin:10px 0}dt{color:var(--muted)}dd{margin:0}
ul{padding-left:20px}.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
@media (max-width:600px){dl{grid-template-columns:1fr}th:nth-child(3),td:nth-child(3){display:none}}
</style>
</head>
<body>
<header><h1 id="title"></h1><div class="muted" id="meta"></div></header>
<main>
<section id="release"></section>
<section><div class="cards" id="cards"></div></section>
<section class="grid2"><div class="panel"><h2 style="margin-top:0">Project</h2><dl id="profile"></dl></div><div class="panel"><h2 style="margin-top:0">Limitations &amp; unverified areas</h2><ul id="limits"></ul></div></section>
<section id="checks"></section>
<section><h2>Findings</h2>
<div class="filters"><select id="fsev"><option value="">All severities</option></select><select id="fcat"><option value="">All categories</option></select><select id="fstatus"><option value="open">Open</option><option value="">All statuses</option><option value="suppressed">Suppressed</option><option value="baseline">Baseline</option></select><input id="fq" type="search" placeholder="Filter by text, file or rule"></div>
<div id="count" class="muted"></div><div id="findings"></div></section>
<section id="gaps"></section>
</main>
<script type="application/json" id="data">${payload}</script>
<script>
(function(){
var D=JSON.parse(document.getElementById('data').textContent).run;
function el(t,a,c){var e=document.createElement(t);if(a)for(var k in a){if(k==='text')e.textContent=a[k];else if(k==='cls')e.className=a[k];else e.setAttribute(k,a[k]);}if(c)c.forEach(function(x){if(x)e.appendChild(typeof x==='string'?document.createTextNode(x):x)});return e;}
var SEV=['critical','high','medium','low','info'];
document.getElementById('title').textContent='Relivaro report — '+D.profile.name;
document.getElementById('meta').textContent='relivaro '+D.command+' · '+D.runId+' · '+D.startedAt+' · Relivaro '+D.tool.version+' · '+(D.durationMs/1000).toFixed(1)+'s';
if(D.release){var R=D.release,box=el('div',{cls:'release'});box.appendChild(el('div',{cls:'status '+R.status,text:'Release readiness: '+R.status.replace(/-/g,' ').toUpperCase()+' · score '+R.score+'/100'+(R.scoreCapped?' (capped by blockers)':'')}));
var t=el('table');t.appendChild(el('tr',null,[el('th',{text:'Gate'}),el('th',{text:'Status'}),el('th',{text:'Detail'})]));
var icon={block:'⛔ blocker',warn:'⚠️ warning',pass:'✅ passed',unverified:'❔ unverified','n/a':'➖ n/a'};
R.gates.forEach(function(g){t.appendChild(el('tr',null,[el('td',{text:g.title}),el('td',{text:icon[g.status]}),el('td',{text:g.detail})]))});box.appendChild(el('h2',{text:'Gates'}));box.appendChild(t);box.appendChild(el('p',{cls:'muted',text:R.disclaimer}));document.getElementById('release').appendChild(box);}
var S=D.summary,cards=document.getElementById('cards');
cards.appendChild(el('div',{cls:'card'},[el('b',{text:String(S.open)}),'open findings']));
SEV.forEach(function(s){cards.appendChild(el('div',{cls:'card'},[el('b',{cls:'sev-'+s,text:String(S.bySeverity[s])}),s]))});
cards.appendChild(el('div',{cls:'card'},[el('b',{text:String(D.metrics.files)}),'files analysed']));
var P=D.profile,dl=document.getElementById('profile');
function row(k,v){if(!v)return;dl.appendChild(el('dt',{text:k}));dl.appendChild(el('dd',{text:v}));}
function uniq(a){return a.filter(function(x,i){return a.indexOf(x)===i})}
function tech(k){return uniq(P.technologies.filter(function(t){return t.kind===k}).map(function(t){return t.name})).join(', ')}
row('Languages',P.languages.slice(0,8).map(function(l){return l.name+' ('+l.files+')'}).join(', '));
row('Units',P.units.map(function(u){return u.path+' — '+(u.frameworks.join('/')||u.kind)}).join('; '));
row('Data',tech('database'));row('ORM',tech('orm'));row('Queues',tech('queue'));row('Cache',tech('cache'));row('Auth',tech('auth'));row('Observability',tech('observability'));row('Payments',tech('payments'));
row('Tests',P.tests.testFiles+' test files / '+P.tests.sourceFiles+' source files'+(P.tests.frameworks.length?' ('+P.tests.frameworks.join(', ')+')':''));
row('CI/CD',uniq(P.ci.map(function(c){return c.system})).join(', ')||'none');row('Deploy',P.deploy.map(function(d){return d.kind}).join(', '));
row('API',P.api.routes+' route definitions');row('Env vars',P.envVars.length+' read by code, '+P.envVars.filter(function(v){return v.required&&!v.documented}).length+' required but undocumented');
var lim=document.getElementById('limits');(D.limitations.length?D.limitations:['None reported.']).forEach(function(l){lim.appendChild(el('li',{text:l}))});
if(D.checks.length){var cs=document.getElementById('checks');cs.appendChild(el('h2',{text:'Executed checks'}));var ct=el('table');ct.appendChild(el('tr',null,[el('th',{text:'Check'}),el('th',{text:'Result'}),el('th',{text:'Command'})]));
D.checks.forEach(function(c){ct.appendChild(el('tr',null,[el('td',{text:c.kind+' · '+c.unit}),el('td',{text:c.status+(c.tests?' ('+c.tests.passed+' passed, '+c.tests.failed+' failed)':'')+(c.reason?' — '+c.reason:'')}),el('td',null,[el('code',{text:c.command})])]))});cs.appendChild(ct);}
var fsev=document.getElementById('fsev'),fcat=document.getElementById('fcat'),fst=document.getElementById('fstatus'),fq=document.getElementById('fq');
SEV.forEach(function(s){fsev.appendChild(el('option',{value:s,text:s}))});uniq(D.findings.map(function(f){return f.category})).forEach(function(c){fcat.appendChild(el('option',{value:c,text:c}))});
function render(){var box=document.getElementById('findings');box.textContent='';var q=fq.value.toLowerCase();var list=D.findings.filter(function(f){return(!fsev.value||f.severity===fsev.value)&&(!fcat.value||f.category===fcat.value)&&(!fst.value||f.status===fst.value)&&(!q||(f.title+' '+f.message+' '+f.ruleId+' '+(f.location?f.location.file:'')).toLowerCase().indexOf(q)>=0)});
document.getElementById('count').textContent=list.length+' finding(s)';
list.slice(0,1000).forEach(function(f){var d=el('details',{cls:'finding'});var where=f.location?f.location.file+(f.location.line?':'+f.location.line:''):'';
d.appendChild(el('summary',null,[el('span',{cls:'badge sev-'+f.severity,text:f.severity}),el('strong',{text:f.title}),el('code',{text:where}),el('span',{cls:'muted',text:f.id+(f.status!=='open'?' · '+f.status:'')})]));
var b=el('div',{cls:'body'});b.appendChild(el('p',{text:f.message}));if(f.evidence&&f.evidence.snippet)b.appendChild(el('pre',{text:f.evidence.snippet}));if(f.evidence&&f.evidence.output)b.appendChild(el('pre',{text:f.evidence.output}));
var dd=el('dl');function r2(k,v){if(v){dd.appendChild(el('dt',{text:k}));dd.appendChild(el('dd',{text:v}))}}
r2('Rule',f.ruleId);r2('Confidence',f.confidence+' · '+f.provenance);r2('Category',f.category);r2('Standards',[].concat(f.cwe||[],f.owasp||[]).join(', '));r2('Impact',f.impact);r2('Fix',f.recommendation+(f.fixer?' (automated fix: relivaro fix plan --finding '+f.id+')':''));r2('Verify',f.verification);
if(f.suppression)r2('Suppressed',f.suppression.kind+(f.suppression.reason?': '+f.suppression.reason:''));b.appendChild(dd);d.appendChild(b);box.appendChild(d)});}
[fsev,fcat,fst].forEach(function(x){x.addEventListener('change',render)});fq.addEventListener('input',render);render();
if(D.testGaps.length){var g=document.getElementById('gaps');g.appendChild(el('h2',{text:'Untested high-risk code (heuristic)'}));var ul=el('ul');D.testGaps.slice(0,25).forEach(function(x){ul.appendChild(el('li',null,[el('code',{text:x.file}),' — risk '+x.risk+': '+x.reasons.join(', ')]))});g.appendChild(ul);}
})();
</script>
</body>
</html>
`;
}
