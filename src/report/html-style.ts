/** Stylesheet of the HTML report: design tokens for light and dark themes, layout, charts and print. */
export const REPORT_CSS = String.raw`
:root{
  --font:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --bg:#f5f6f8;--surface:#ffffff;--surface-2:#f0f2f5;--line:#e1e4ea;--line-strong:#c9ced8;
  --text:#121620;--muted:#566070;--faint:#7c8595;
  --brand:#BRAND_LIGHT;--on-brand:#fff;--brand-ink:#BRAND_INK_LIGHT;--brand-soft:#BRAND_SOFT_LIGHT;
  --pass:#17784a;--pass-bg:#e5f4ec;--warn:#9a5b00;--warn-bg:#fbf0dc;--block:#c0262d;--block-bg:#fbe6e6;
  --unv:#5a5f9e;--unv-bg:#ecedf8;--na:#7c8595;--na-bg:#eef0f3;
  --critical:#a3122c;--high:#d1451b;--medium:#b77c00;--low:#2f6fc9;--info:#6f7a8c;
  --code-bg:#f3f4f7;--hl:#fff3c4;
  --shadow:0 1px 2px rgba(16,22,32,.05),0 2px 8px rgba(16,22,32,.04);
  --radius:12px;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0d1016;--surface:#151922;--surface-2:#1b202b;--line:#262c39;--line-strong:#363e4f;
  --text:#e8ebf1;--muted:#a1a9b8;--faint:#7d8697;
  --brand:#BRAND_DARK;--on-brand:#0d1016;--brand-ink:#BRAND_INK_DARK;--brand-soft:#BRAND_SOFT_DARK;
  --pass:#4cc488;--pass-bg:#11291e;--warn:#f0b54a;--warn-bg:#2d2312;--block:#ff6b6e;--block-bg:#321619;
  --unv:#a3a8f0;--unv-bg:#1d1f36;--na:#8a93a3;--na-bg:#1c2029;
  --critical:#ff5c7a;--high:#ff8a5c;--medium:#f2c14e;--low:#6aa8ff;--info:#9aa5b8;
  --code-bg:#10141c;--hl:#3a3315;--shadow:none;color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#0d1016;--surface:#151922;--surface-2:#1b202b;--line:#262c39;--line-strong:#363e4f;
  --text:#e8ebf1;--muted:#a1a9b8;--faint:#7d8697;
  --brand:#BRAND_DARK;--on-brand:#0d1016;--brand-ink:#BRAND_INK_DARK;--brand-soft:#BRAND_SOFT_DARK;
  --pass:#4cc488;--pass-bg:#11291e;--warn:#f0b54a;--warn-bg:#2d2312;--block:#ff6b6e;--block-bg:#321619;
  --unv:#a3a8f0;--unv-bg:#1d1f36;--na:#8a93a3;--na-bg:#1c2029;
  --critical:#ff5c7a;--high:#ff8a5c;--medium:#f2c14e;--low:#6aa8ff;--info:#9aa5b8;
  --code-bg:#10141c;--hl:#3a3315;--shadow:none;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:72px}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--font);-webkit-font-smoothing:antialiased}
a{color:var(--brand-ink)}
:focus-visible{outline:2px solid var(--brand);outline-offset:2px;border-radius:6px}
.skip{position:absolute;left:-999px;top:8px;background:var(--surface);padding:8px 12px;border-radius:8px;z-index:10}
.skip:focus{left:8px}
.wrap{max-width:1240px;margin:0 auto;padding:0 20px}
code,pre,.mono{font-family:var(--mono)}
code{font-size:12px;background:var(--code-bg);padding:1px 5px;border-radius:5px;word-break:break-word}
h1,h2,h3{margin:0;letter-spacing:-.01em}
h2{font-size:17px}h3{font-size:14px}
.muted{color:var(--muted)}.faint{color:var(--faint)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}

/* header */
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:saturate(1.4) blur(10px);border-bottom:1px solid var(--line)}
.top-in{display:flex;align-items:center;gap:20px;height:60px}
.brand{flex:none;color:var(--text);font-weight:700;font-size:17px;letter-spacing:-.015em}
.tabs{display:flex;gap:2px;overflow-x:auto;scrollbar-width:none;flex:1}
.tabs a{color:var(--muted);text-decoration:none;padding:6px 10px;border-radius:8px;font-weight:500;white-space:nowrap}
.tabs a:hover{color:var(--text);background:var(--surface-2)}
.tools{display:flex;gap:8px;align-items:center;flex:none}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:9px;padding:2px;background:var(--surface)}
.seg button{border:0;background:none;color:var(--muted);font:600 12px/1 var(--font);padding:6px 9px;border-radius:7px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--brand);color:var(--on-brand)}
.icon-btn{border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:9px;width:32px;height:30px;display:grid;place-items:center;cursor:pointer}
.icon-btn:hover{color:var(--text)}

/* page head */
.head{padding:26px 0 8px;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px}
.head h1{font-size:26px;font-weight:700}
.eyebrow{font:600 11px/1 var(--font);text-transform:uppercase;letter-spacing:.09em;color:var(--brand-ink);margin-bottom:8px}
.meta{display:flex;flex-wrap:wrap;gap:6px 18px;color:var(--muted);font-size:12.5px}
.meta b{color:var(--text);font-weight:600}

/* cards */
section{margin:18px 0}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow);padding:18px}
.card-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:14px}
.hint{color:var(--muted);font-size:12.5px;margin:4px 0 0;max-width:80ch}
.grid{display:grid;gap:14px}
.g-hero{grid-template-columns:minmax(300px,5fr) 7fr}
.g-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.g-2{grid-template-columns:repeat(2,minmax(0,1fr))}
@media (max-width:980px){.g-hero,.g-3,.g-2{grid-template-columns:1fr}}

/* hero */
.hero{display:flex;gap:22px;align-items:center}
.ring{flex:none;position:relative;width:132px;height:132px}
.ring svg{transform:rotate(-90deg);width:100%;height:100%}
.ring .val{position:absolute;inset:0;display:grid;place-content:center;text-align:center}
.ring .val b{font-size:34px;line-height:1;font-weight:700;letter-spacing:-.02em}
.ring .val span{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.status-name{font-size:22px;font-weight:700;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.tally{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
.pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:12px;font-weight:600;white-space:nowrap;border:1px solid transparent}
.st-pass{color:var(--pass);background:var(--pass-bg)}
.st-warn{color:var(--warn);background:var(--warn-bg)}
.st-block{color:var(--block);background:var(--block-bg)}
.st-unverified{color:var(--unv);background:var(--unv-bg);border:1px dashed currentColor}
.st-na{color:var(--na);background:var(--na-bg)}
.c-pass{color:var(--pass)}.c-warn{color:var(--warn)}.c-block{color:var(--block)}.c-unverified{color:var(--unv)}.c-na{color:var(--na)}

/* KPIs */
.kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media (max-width:560px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{border:1px solid var(--line);border-radius:10px;padding:12px 14px;background:var(--surface)}
.kpi .k{font-size:12px;color:var(--muted)}
.kpi .v{font-size:24px;font-weight:700;letter-spacing:-.02em;line-height:1.25;font-variant-numeric:tabular-nums}
.kpi .s{font-size:11.5px;color:var(--faint)}

/* flow */
.flow{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;align-items:stretch}
.step{position:relative;padding:14px 16px 14px 18px;border:1px solid var(--line);background:var(--surface);min-height:84px}
.step:first-child{border-radius:var(--radius) 0 0 var(--radius)}
.step:last-child{border-radius:0 var(--radius) var(--radius) 0}
.step+.step{border-left:0}
.step:not(:last-child)::after{content:"";position:absolute;right:-9px;top:50%;width:16px;height:16px;transform:translateY(-50%) rotate(45deg);background:inherit;border-top:1px solid var(--line);border-right:1px solid var(--line);z-index:1}
.step .n{font:600 11px/1 var(--mono);color:var(--faint)}
.step .t{font-weight:700;margin:6px 0 2px;display:flex;align-items:center;gap:6px}
.step .v{font-size:12.5px;color:var(--muted)}
.step .bar{position:absolute;left:0;top:0;bottom:0;width:3px}
.step:first-child .bar{border-radius:var(--radius) 0 0 var(--radius)}
.step.s-todo{background:repeating-linear-gradient(135deg,var(--surface),var(--surface) 8px,var(--surface-2) 8px,var(--surface-2) 16px)}
@media (max-width:820px){.flow{grid-template-columns:1fr}.step,.step:first-child,.step:last-child{border-radius:0;border-left:1px solid var(--line)}.step:first-child{border-radius:var(--radius) var(--radius) 0 0}.step:last-child{border-radius:0 0 var(--radius) var(--radius)}.step+.step{border-top:0}.step:not(:last-child)::after{display:none}}

/* charts */
.donut-wrap{display:flex;align-items:center;gap:18px}
.legend{list-style:none;margin:0;padding:0;flex:1;min-width:0}
.legend li{display:flex;align-items:center;gap:8px;padding:3px 0}
.legend button{all:unset;cursor:pointer;display:flex;align-items:center;gap:8px;width:100%;border-radius:6px;padding:2px 4px}
.legend button:hover{background:var(--surface-2)}
.legend .sw{width:10px;height:10px;border-radius:3px;flex:none}
.legend .lbl{flex:1}
.legend .num{font-variant-numeric:tabular-nums;font-weight:600}
.bars{display:flex;flex-direction:column;gap:9px}
.barrow{display:grid;grid-template-columns:minmax(90px,140px) 1fr 38px;gap:10px;align-items:center;cursor:pointer;border-radius:6px;padding:1px 2px}
.barrow:hover{background:var(--surface-2)}
.barrow .lbl{font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.barrow .num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;font-size:12.5px}
.track{height:10px;background:var(--surface-2);border-radius:5px;overflow:hidden;display:flex}
.track span{height:100%;display:block}
.hot .barrow{grid-template-columns:minmax(120px,42%) 1fr 38px}
.hot .lbl{font-family:var(--mono);font-size:11.5px;direction:rtl;text-align:left}
.empty{color:var(--muted);font-size:13px;padding:14px;border:1px dashed var(--line-strong);border-radius:10px;text-align:center}

/* gates */
.gates{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
.gate{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:6px;border:1px solid var(--line);border-left-width:4px;border-radius:10px;padding:11px 12px;background:var(--surface);cursor:pointer}
.gate:hover{border-color:var(--line-strong)}
.gate[aria-pressed="true"]{outline:2px solid var(--brand);outline-offset:1px}
.gate.b-pass{border-left-color:var(--pass)}.gate.b-warn{border-left-color:var(--warn)}.gate.b-block{border-left-color:var(--block)}
.gate.b-unverified{border-left-color:var(--unv);border-style:dashed;border-left-style:solid}.gate.b-na{border-left-color:var(--line-strong);opacity:.75}
.gate .gt{font-weight:600;font-size:13px;line-height:1.35}
.gate .gd{font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.gate .gm{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.basis{font-size:11px;color:var(--faint);border:1px solid var(--line);border-radius:999px;padding:0 7px}

/* compare & perf */
.deltas{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.delta{border:1px solid var(--line);border-radius:10px;padding:10px 12px}
.delta b{font-size:22px;font-variant-numeric:tabular-nums}
.mini{list-style:none;padding:0;margin:10px 0 0;font-size:12.5px}
.mini li{display:flex;gap:8px;padding:4px 0;border-top:1px solid var(--line);align-items:baseline}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.tbl{overflow-x:auto}

/* findings */
.filters{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
.search{flex:1 1 260px;display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--surface);border-radius:9px;padding:0 10px}
.search input{flex:1;border:0;background:none;color:var(--text);font:inherit;padding:8px 0;min-width:0}
.search input:focus{outline:none}
.search:focus-within{border-color:var(--brand)}
select,.chk{border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:9px;padding:7px 9px;font:inherit;font-size:13px}
.chk{display:inline-flex;gap:6px;align-items:center;cursor:pointer}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:999px;padding:4px 10px;font:600 12px/1.2 var(--font);cursor:pointer;display:inline-flex;gap:6px;align-items:center}
.chip .dot{width:8px;height:8px;border-radius:50%}
.chip[aria-pressed="true"]{color:var(--text);border-color:var(--text)}
.count{font-size:12.5px;color:var(--muted);margin:2px 0 10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.flist{display:flex;flex-direction:column;gap:8px}
details.f{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
details.f[open]{border-color:var(--line-strong)}
details.f>summary{list-style:none;cursor:pointer;padding:11px 14px;display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;align-items:center}
details.f>summary::-webkit-details-marker{display:none}
details.f>summary:hover{background:var(--surface-2)}
.sev{display:inline-flex;align-items:center;gap:6px;font:700 11px/1 var(--font);text-transform:uppercase;letter-spacing:.05em;padding:4px 8px;border-radius:6px;min-width:76px}
.f .ttl{font-weight:600;min-width:0}
.f .loc{grid-column:2/4;font-family:var(--mono);font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.f .side{display:flex;gap:6px;align-items:center;color:var(--faint);font-size:12px}
.f .body{padding:4px 16px 16px;border-top:1px solid var(--line)}
.f .msg{margin:12px 0}
.snip{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;overflow:auto;font:12px/1.55 var(--mono);margin:8px 0}
.snip .ln{display:grid;grid-template-columns:52px 1fr;white-space:pre}
.snip .no{color:var(--faint);text-align:right;padding-right:12px;user-select:none;border-right:1px solid var(--line)}
.snip .tx{padding-left:12px;padding-right:12px}
.snip .ln.at{background:var(--hl)}
.snip pre{margin:0;padding:10px 12px;white-space:pre-wrap}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-top:12px}
.kv h4{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.kv p{margin:0}
.facts{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.cmd{display:flex;gap:8px;align-items:center;margin-top:12px;background:var(--brand-soft);border-radius:8px;padding:8px 10px}
.cmd code{background:none;flex:1;padding:0}
.btn{border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:8px;padding:5px 10px;font:600 12px/1.2 var(--font);cursor:pointer}
.btn:hover{border-color:var(--line-strong)}
.more{display:flex;justify-content:center;margin-top:10px}

/* project */
dl.pj{display:grid;grid-template-columns:140px 1fr;gap:8px 14px;margin:0}
dl.pj dt{color:var(--muted)}dl.pj dd{margin:0;min-width:0;overflow-wrap:anywhere}
ul.limits{margin:0;padding:0;list-style:none}
ul.limits li{padding:8px 0 8px 26px;border-top:1px solid var(--line);position:relative}
ul.limits li:first-child{border-top:0}
ul.limits li::before{content:"";position:absolute;left:4px;top:13px;width:10px;height:10px;border-radius:50%;border:2px dashed var(--unv)}
.gap-file{font-family:var(--mono);font-size:12px}
footer{padding:28px 0 40px;color:var(--faint);font-size:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
@media (max-width:640px){.wrap{padding:0 14px}.top-in{gap:10px;justify-content:space-between}.tabs{display:none}.hero{gap:16px;align-items:flex-start}.hero .ring{width:92px;height:92px}.hero .ring .val b{font-size:26px}.status-name{font-size:19px}dl.pj{grid-template-columns:1fr}dl.pj dt{margin-top:6px}.deltas{grid-template-columns:1fr 1fr 1fr}.f .side{display:none}details.f>summary{grid-template-columns:auto 1fr}}
@media print{.top,.filters,.more,.tools,.skip{display:none!important}body{background:#fff}.card{box-shadow:none}details.f{break-inside:avoid}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
`;
