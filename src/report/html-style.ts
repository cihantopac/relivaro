/**
 * Stylesheet of the HTML report. Colour follows a 60-30-10 rule on the Relivaro (Cairn) palette: paper and ink
 * surfaces (60), stone neutrals for text, lines and tags (30), teal only for actions, focus and selection (10).
 * Severity and status colours appear only as small marks: dots, thin lines and glyphs.
 */
export const REPORT_CSS = String.raw`
:root{
  --font:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
  --radius:16px;--radius-s:10px;
  --bg:#f6f4f0;--surface:#ffffff;--sunk:#efece7;--line:#e4dfd8;--line-strong:#d0c9c0;
  --text:#121620;--muted:#6b6157;--faint:#8c8278;
  --accent:#BRAND_LIGHT;--accent-ink:#BRAND_INK_LIGHT;--accent-soft:#BRAND_SOFT_LIGHT;--on-accent:#ffffff;
  --crit:#c0283f;--high:#c2571a;--med:#a87a12;--low:#5d7fa8;--info:#8c8278;
  --ok:#2f8a5b;--warn:#a87a12;--block:#c0283f;--unv:#6b6fb0;--na:#a0968c;
  --hl:#fbf1cf;--shadow:0 1px 2px rgba(18,22,32,.04),0 8px 24px rgba(18,22,32,.05);
  --pill:#121620;--on-pill:#f6f4f0;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#0e1113;--surface:#161a1c;--sunk:#1d2224;--line:#272d30;--line-strong:#363d41;
  --text:#f2f0ec;--muted:#a69c92;--faint:#857c73;
  --accent:#BRAND_DARK;--accent-ink:#BRAND_INK_DARK;--accent-soft:#BRAND_SOFT_DARK;--on-accent:#0e1113;
  --crit:#ff5f78;--high:#ff9160;--med:#e9bd52;--low:#8fb2db;--info:#a69c92;
  --ok:#5cc893;--warn:#e9bd52;--block:#ff5f78;--unv:#a9aaf0;--na:#857c73;
  --hl:#2f2a17;--shadow:none;--pill:#f2f0ec;--on-pill:#0e1113;color-scheme:dark}}
:root[data-theme="dark"]{
  --bg:#0e1113;--surface:#161a1c;--sunk:#1d2224;--line:#272d30;--line-strong:#363d41;
  --text:#f2f0ec;--muted:#a69c92;--faint:#857c73;
  --accent:#BRAND_DARK;--accent-ink:#BRAND_INK_DARK;--accent-soft:#BRAND_SOFT_DARK;--on-accent:#0e1113;
  --crit:#ff5f78;--high:#ff9160;--med:#e9bd52;--low:#8fb2db;--info:#a69c92;
  --ok:#5cc893;--warn:#e9bd52;--block:#ff5f78;--unv:#a9aaf0;--na:#857c73;
  --hl:#2f2a17;--shadow:none;--pill:#f2f0ec;--on-pill:#0e1113;color-scheme:dark}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scroll-padding-top:72px}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--font);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility}
a{color:var(--accent-ink);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.skip{position:absolute;left:-999px;top:8px;background:var(--surface);padding:8px 12px;border-radius:8px;z-index:10}
.skip:focus{left:8px}
.wrap{max-width:1120px;margin:0 auto;padding:0 32px}
code,pre,.mono{font-family:var(--mono)}
code{font-size:.85em;background:var(--sunk);padding:1px 6px;border-radius:6px;word-break:break-word}
h1,h2,h3,h4{margin:0;font-weight:650}
.muted{color:var(--muted)}.faint{color:var(--faint)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
bdi{unicode-bidi:isolate}

/* top bar */
.top{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:saturate(1.6) blur(16px);-webkit-backdrop-filter:saturate(1.6) blur(16px);border-bottom:1px solid var(--line)}
.top-in{display:flex;align-items:center;gap:28px;min-height:56px}
.brand{flex:none;display:flex;color:var(--text)}.brand svg{display:block;height:19px;width:auto;fill:currentColor}.brand .cairn{fill:var(--accent)}
.tabs{display:flex;gap:22px;overflow-x:auto;scrollbar-width:none;flex:1}
.tabs a{color:var(--muted);font-size:13px;white-space:nowrap;padding:4px 0}
.tabs a:hover{color:var(--text);text-decoration:none}
.tools{display:flex;gap:10px;align-items:center;flex:none}
.seg{display:inline-flex;gap:2px;border-radius:9px;padding:2px;background:var(--sunk)}
.seg button{border:0;background:none;color:var(--muted);font:600 12px/1 var(--font);padding:6px 9px;border-radius:7px;cursor:pointer}
.seg button:hover{color:var(--text)}
.seg button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.seg-icons button{display:grid;place-items:center;padding:5px 7px}

/* buttons, tags, marks */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--line-strong);background:var(--surface);color:var(--text);border-radius:999px;padding:8px 16px;font:600 13.5px/1.2 var(--font);cursor:pointer;white-space:nowrap;text-decoration:none}
.btn:hover{border-color:var(--accent);color:var(--accent-ink);text-decoration:none}
.btn.pri{background:var(--accent);border-color:var(--accent);color:var(--on-accent)}
.btn.pri:hover{filter:brightness(1.08);color:var(--on-accent)}
.btn.lg{padding:12px 22px;font-size:15px}
.btn.sm{padding:5px 12px;font-size:12.5px}
.btn[disabled]{opacity:.45;cursor:default;pointer-events:none}
.link{all:unset;cursor:pointer;color:var(--accent-ink);font-weight:600;font-size:14px;border-radius:4px}
.link:hover{text-decoration:underline;text-underline-offset:3px}
.link::after{content:" \203A"}
.link.plain::after{content:none}
.icon-btn{border:0;background:var(--sunk);color:var(--muted);border-radius:999px;width:32px;height:32px;display:grid;place-items:center;cursor:pointer;font-size:18px;line-height:1}
.icon-btn:hover{color:var(--text)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;background:var(--na)}
.d-critical{background:var(--crit)}.d-high{background:var(--high)}.d-medium{background:var(--med)}.d-low{background:var(--low)}.d-info{background:var(--info)}
.d-pass{background:var(--ok)}.d-warn{background:var(--warn)}.d-block{background:var(--block)}.d-unverified{background:var(--unv)}.d-na{background:var(--na)}
.line-pass{background:var(--ok)}.line-block{background:var(--block)}.line-na{background:var(--na)}
.tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:1.4;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px;white-space:nowrap;background:var(--surface)}
.tag.dash{border-style:dashed}
.tag.strike{text-decoration:line-through}
.sev{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--muted);white-space:nowrap}
.c-pass{color:var(--ok)}.c-warn{color:var(--warn)}.c-block{color:var(--block)}.c-unverified{color:var(--unv)}.c-na{color:var(--na)}
.glyph{display:inline-flex;flex:none}

/* disclosures */
details.more>summary{list-style:none;cursor:pointer;color:var(--accent-ink);font-weight:600;font-size:13.5px;display:inline-flex;align-items:center;gap:6px;border-radius:6px;padding:2px 0}
details.more>summary::-webkit-details-marker{display:none}
details.more>summary::after{content:"";width:7px;height:7px;border-right:1.6px solid currentColor;border-bottom:1.6px solid currentColor;transform:rotate(45deg) translateY(-2px);transition:transform .15s}
details.more[open]>summary::after{transform:rotate(225deg) translate(-2px,0)}
details.more>summary:hover{text-decoration:underline;text-underline-offset:3px}
details.more>.more-body{margin-top:14px}
.prose{color:var(--muted);font-size:14px;max-width:70ch}
.prose p{margin:0 0 8px}.prose ol,.prose ul{margin:0;padding-left:20px}.prose li{margin:4px 0}

/* hero */
.hero{text-align:center;padding:72px 0 56px}
.hero-meta{font-size:13px;color:var(--muted);display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.hero-meta .sep{color:var(--line-strong)}
.hero-title{font-size:56px;line-height:1.05;letter-spacing:-.04em;font-weight:700;margin:14px auto 14px;max-width:16ch;display:flex;align-items:center;justify-content:center;gap:14px}
.hero-sub{font-size:21px;line-height:1.4;color:var(--muted);letter-spacing:-.01em;margin:0}
.hero-sub b{color:var(--text);font-weight:600}
.hero-cta{display:flex;justify-content:center;gap:22px;align-items:center;margin-top:30px;flex-wrap:wrap}

/* stats band */
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
.stat{padding:24px 26px;border-left:1px solid var(--line);min-width:0}
.stat:first-child{border-left:0}
.stat b{display:flex;align-items:center;gap:10px;font-size:36px;line-height:1.1;letter-spacing:-.03em;font-weight:650;font-variant-numeric:tabular-nums}
.stat span{font-size:13px;color:var(--muted)}
.stat .s{display:block;font-size:12px;color:var(--faint);margin-top:2px}
.stats-more{text-align:center;margin-top:16px}
.stats-more .stats{margin-top:14px;text-align:left;box-shadow:none}
.stats-more .stat b{font-size:24px}

/* bands */
.band{padding:72px 0 0}
.band-h{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:22px;flex-wrap:wrap}
.band-title{font-size:32px;line-height:1.15;letter-spacing:-.03em;font-weight:700}
.band-sub{color:var(--muted);margin:6px 0 0;font-size:16px}
.band-foot{display:flex;align-items:center;gap:18px;flex-wrap:wrap;margin-top:18px}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:22px 24px;box-shadow:var(--shadow);min-width:0}
.panel h3{font-size:14px;color:var(--muted);font-weight:600;margin-bottom:14px}
.grid{display:grid;gap:16px}
.g-3{grid-template-columns:repeat(3,minmax(0,1fr))}
.g-2{grid-template-columns:repeat(2,minmax(0,1fr))}
.empty{color:var(--muted);font-size:14px;padding:22px;border:1px dashed var(--line-strong);border-radius:var(--radius-s);text-align:center}

/* list rows */
.list{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
.row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 16px;align-items:center;padding:16px 22px;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row .t{font-weight:600;letter-spacing:-.005em;min-width:0}
.row .p{grid-column:2;font:12.5px/1.4 var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.row .side{display:flex;gap:8px;align-items:center;grid-row:1/3;grid-column:3}
.row-btn{all:unset;cursor:pointer;border-radius:4px}
.row-btn:hover{color:var(--accent-ink)}
.remsum{display:flex;gap:6px 18px;flex-wrap:wrap;font-size:13.5px;color:var(--muted)}
.remsum button{all:unset;cursor:pointer;border-radius:4px}
.remsum button b{color:var(--text);font-weight:650;margin-left:4px;font-variant-numeric:tabular-nums}
.remsum button:hover{color:var(--accent-ink)}
.remsum button[disabled]{opacity:.5;cursor:default}

/* run flow */
.flow{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(5,minmax(0,1fr));position:relative}
.flow li{position:relative;padding:26px 12px 0 0;min-width:0}
.flow li::before{content:"";position:absolute;left:0;right:0;top:9px;height:2px;background:var(--line-strong)}
.flow li.todo::before{background:none;border-top:2px dashed var(--line-strong);height:0}
.flow .knot{position:absolute;left:0;top:2px;width:16px;height:16px;border-radius:50%;background:var(--bg);display:grid;place-items:center}
.flow .ft{font-weight:650;font-size:14px}
.flow .fv{font-size:13px;color:var(--muted)}

/* charts */
.bars{display:flex;flex-direction:column;gap:10px}
.barrow{all:unset;box-sizing:border-box;display:grid;grid-template-columns:minmax(80px,130px) 1fr 34px;gap:12px;align-items:center;cursor:pointer;border-radius:6px;padding:2px}
.barrow:hover .lbl{color:var(--accent-ink)}
.barrow .lbl{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.barrow .num{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;font-size:13px}
.track{height:6px;background:var(--sunk);border-radius:3px;overflow:hidden;display:flex}
.track span{height:100%;display:block;background:var(--line-strong)}
.track span.acc{background:var(--accent)}
.hot .barrow{grid-template-columns:minmax(110px,46%) 1fr 34px}
.hot .lbl{font-family:var(--mono);font-size:12px;direction:rtl;text-align:left}
.sevlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
.sevlist button{all:unset;box-sizing:border-box;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center;width:100%;padding:6px 4px;border-radius:6px;cursor:pointer;font-size:14px}
.sevlist button:hover{background:var(--sunk)}
.sevlist b{font-variant-numeric:tabular-nums;font-weight:650}
.sevbar{display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--sunk);margin-bottom:14px;gap:2px}
.sevbar span{display:block;height:100%}

/* gates */
.ggroup+.ggroup{margin-top:22px}
.ggroup h3{font-size:13px;color:var(--muted);font-weight:600;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.gate{all:unset;box-sizing:border-box;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:2px 14px;align-items:center;width:100%;padding:15px 22px;border-top:1px solid var(--line);cursor:pointer}
.gate:first-child{border-top:0}
.gate:hover{background:var(--sunk)}
.gate[aria-pressed="true"]{background:var(--accent-soft);box-shadow:inset 3px 0 0 var(--accent)}
.gate .gt{font-weight:600;min-width:0}
.gate .gd{grid-column:2;font-size:13px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.gate .gside{grid-column:3;grid-row:1/3;display:flex;gap:8px;align-items:center}

/* tables */
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:12px 16px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
th{font-size:12px;color:var(--muted);font-weight:600}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.deltas{display:grid;grid-template-columns:repeat(3,1fr);gap:0}
.delta{padding:4px 18px;border-left:1px solid var(--line)}.delta:first-child{border-left:0;padding-left:0}
.delta b{font-size:28px;letter-spacing:-.02em;font-variant-numeric:tabular-nums;font-weight:650}
.mini{list-style:none;padding:0;margin:16px 0 0;font-size:13.5px}
.mini li{display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line);align-items:center;min-width:0}
.mini li span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* findings */
.ftools{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px}
.search{flex:1 1 280px;display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:0 14px;color:var(--muted)}
.search input{flex:1;border:0;background:none;color:var(--text);font:inherit;font-size:14px;padding:9px 0;min-width:0}
.search input:focus{outline:none}
.search:focus-within{border-color:var(--accent)}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{border:1px solid var(--line);background:var(--surface);color:var(--muted);border-radius:999px;padding:5px 12px;font:600 12.5px/1.2 var(--font);cursor:pointer;display:inline-flex;gap:7px;align-items:center}
.chip:hover{color:var(--text)}
.chip[aria-pressed="true"]{color:var(--accent-ink);border-color:var(--accent);background:var(--accent-soft)}
.chip[disabled]{opacity:.4;cursor:default}
.fpanel{display:flex;flex-direction:column;gap:12px;padding:16px 18px;margin-top:10px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius-s)}
.fline{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.flabel{font-size:12.5px;color:var(--muted);font-weight:600;min-width:96px}
select{border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:999px;padding:6px 12px;font:inherit;font-size:13px}
.chk{display:inline-flex;gap:7px;align-items:center;cursor:pointer;font-size:13px;color:var(--muted)}
.selrow{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;margin:14px 0 6px;font-size:13px}
.selrow .link::after{content:none}
.selrow select{padding:4px 10px;font-size:12.5px}
.count{font-size:13px;color:var(--muted);margin:6px 0 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.flist{display:flex;flex-direction:column;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow)}
.frow{display:grid;grid-template-columns:44px minmax(0,1fr);align-items:start;border-top:1px solid var(--line)}
.flist>.frow:first-child,.flist>.group:first-child{border-top:0}
.frow.is-sel{background:color-mix(in srgb,var(--accent-soft) 55%,transparent)}
.fsel-wrap{display:flex;justify-content:flex-end;padding:19px 0 0 16px;cursor:pointer}
.fsel{width:16px;height:16px;accent-color:var(--accent);cursor:pointer;margin:0}
details.f>summary{list-style:none;cursor:pointer;padding:15px 22px 15px 14px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:3px 12px;align-items:center}
details.f>summary::-webkit-details-marker{display:none}
details.f>summary:hover .ttl{color:var(--accent-ink)}
.f .ttl{font-weight:600;min-width:0}
.f .loc{grid-column:2;font:12.5px/1.4 var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.f .side{grid-column:3;grid-row:1/3;display:flex;gap:6px;align-items:center}
.f .body{padding:2px 22px 22px 14px}
.vline{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:13.5px;color:var(--muted);margin:0 0 12px}
.vline b{color:var(--text);font-weight:600}
.f .msg{margin:0 0 14px;max-width:80ch}
.snip{background:var(--sunk);border-radius:var(--radius-s);overflow:auto;font:12.5px/1.7 var(--mono);margin:0 0 16px;padding:8px 0}
.snip .ln{display:grid;grid-template-columns:52px 1fr;white-space:pre}
.snip .no{color:var(--faint);text-align:right;padding-right:16px;user-select:none}
.snip .tx{padding-right:16px}
.snip .ln.at{background:var(--hl)}
.snip pre{margin:0;padding:4px 16px;white-space:pre-wrap}
.facts3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:4px 0 16px}
.facts3 h4,.kv h4{margin:0 0 4px;font-size:12px;color:var(--muted);font-weight:600}
.facts3 p,.kv p{margin:0;font-size:14px}
.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px 20px}
.facts{display:flex;flex-wrap:wrap;gap:6px}
.cmd{display:flex;gap:10px;align-items:center;margin:0 0 14px;background:var(--sunk);border-radius:var(--radius-s);padding:8px 8px 8px 14px}
.cmd code{background:none;flex:1;padding:0;font-size:12.5px}
.more-row{display:flex;justify-content:center;margin-top:16px}
.group{border-top:1px solid var(--line)}
.ghead{display:grid;grid-template-columns:44px minmax(0,1fr) auto;align-items:center;gap:12px;padding:14px 22px 14px 0;background:var(--sunk)}
.ghead .fsel-wrap{padding-top:0}
.gtitle{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;min-width:0}
.ghead .side{display:flex;gap:6px;align-items:center}

/* floating selection bar */
.actionbar{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:6;width:min(760px,calc(100vw - 24px));background:var(--pill);color:var(--on-pill);border-radius:999px;box-shadow:0 16px 40px rgba(0,0,0,.28)}
.ab-in{display:flex;gap:14px;align-items:center;padding:8px 8px 8px 24px}
.ab-txt{display:flex;gap:12px;align-items:baseline;flex:1;min-width:0;overflow:hidden;white-space:nowrap}
.ab-txt .x{color:color-mix(in srgb,var(--on-pill) 62%,transparent);font-size:13px;overflow:hidden;text-overflow:ellipsis}
.ab-btns{display:flex;gap:6px;align-items:center;flex:none}
.ab-btns .ghost{all:unset;cursor:pointer;color:color-mix(in srgb,var(--on-pill) 70%,transparent);font-weight:600;font-size:13.5px;padding:8px 12px;border-radius:999px}
.ab-btns .ghost:hover{color:var(--on-pill)}
body.has-bar footer{padding-bottom:120px}

/* fix-prompt sheet */
.pdlg{border:0;border-radius:22px;padding:0;width:min(640px,calc(100vw - 24px));max-height:calc(100vh - 32px);background:var(--surface);color:var(--text);box-shadow:0 30px 90px rgba(0,0,0,.35);overflow:auto}
.pdlg::backdrop{background:rgba(14,17,19,.5);backdrop-filter:blur(4px)}
.pr{display:flex;flex-direction:column;padding:28px 30px 26px}
.pr-h{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.pr-h h2{font-size:24px;letter-spacing:-.02em;font-weight:700}
.pr-h p{margin:4px 0 0;color:var(--muted);font-size:14px}
.pr-list{margin:20px 0 14px;border:1px solid var(--line);border-radius:14px;overflow:hidden}
.pr-list div{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:11px 16px;border-top:1px solid var(--line);font-size:14px}
.pr-list div:first-child{border-top:0}
.pr-list .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pr-list .p{font:12px var(--mono);color:var(--muted);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.pr-steps{font-size:13.5px;color:var(--muted);margin:0 0 16px}
.pr-steps b{color:var(--text);font-weight:600}
.pr-more{border-top:1px solid var(--line);padding-top:14px;display:flex;flex-direction:column;gap:10px}
.pr textarea{width:100%;min-height:min(46vh,440px);resize:vertical;font:12px/1.55 var(--mono);color:var(--text);background:var(--sunk);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.pr textarea:focus{outline:2px solid var(--accent);outline-offset:1px}
.pr-btns{display:flex;gap:10px;justify-content:flex-end;align-items:center;margin-top:22px;flex-wrap:wrap}
.pr-status{margin:0 auto 0 0;font-size:13px;color:var(--muted);min-height:1.2em}

/* project */
dl.pj{display:grid;grid-template-columns:150px 1fr;gap:10px 16px;margin:0;font-size:14px}
dl.pj dt{color:var(--muted)}dl.pj dd{margin:0;min-width:0;overflow-wrap:anywhere}
ul.limits{margin:0;padding:0;list-style:none;font-size:14px}
ul.limits li{padding:10px 0 10px 24px;border-top:1px solid var(--line);position:relative}
ul.limits li:first-child{border-top:0;padding-top:0}
ul.limits li::before{content:"";position:absolute;left:2px;top:17px;width:9px;height:9px;border-radius:50%;border:1.6px dashed var(--unv)}
ul.limits li:first-child::before{top:7px}
.gap-file{font-family:var(--mono);font-size:12px}
footer{padding:64px 0 48px;color:var(--faint);font-size:12.5px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:center}

@media (max-width:900px){.g-3,.g-2{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}.stat:nth-child(3){border-left:0}.stat:nth-child(n+3){border-top:1px solid var(--line)}.flow{grid-template-columns:1fr;gap:14px}.flow li{padding:0 0 0 28px}.flow li::before{left:7px;right:auto;top:18px;bottom:-14px;width:2px;height:auto}.flow li.todo::before{border-top:0;border-left:2px dashed var(--line-strong);width:0}.flow li:last-child::before{display:none}.flow .knot{top:1px}.facts3{grid-template-columns:1fr;gap:12px}}
@media (max-width:640px){
  html{scroll-padding-top:100px}
  body{font-size:14.5px}
  .wrap{padding:0 16px}
  .top-in{gap:6px 12px;justify-content:space-between;flex-wrap:wrap;padding-top:8px}
  .tabs{order:3;flex:1 0 100%;gap:16px;padding-bottom:8px}
  .hero{padding:44px 0 36px}.hero-title{font-size:38px;gap:10px}.hero-sub{font-size:17px}
  .stat{padding:16px 18px}.stat b{font-size:28px}
  .band{padding-top:52px}.band-title{font-size:26px}.band-sub{font-size:15px}
  .row,.gate{padding:14px 16px;grid-template-columns:auto minmax(0,1fr)}
  .row .side,.gate .gside{grid-column:2;grid-row:auto;flex-wrap:wrap}
  .frow{grid-template-columns:36px minmax(0,1fr)}.fsel-wrap{padding-left:12px}
  details.f>summary{grid-template-columns:auto minmax(0,1fr);padding-right:14px}
  .f .side{grid-column:2;grid-row:auto;flex-wrap:wrap}
  .f .body{padding:2px 14px 18px 10px}
  .ghead{grid-template-columns:36px minmax(0,1fr);padding-right:14px}.ghead .side{grid-column:2}
  .panel{padding:18px}
  dl.pj{grid-template-columns:1fr}dl.pj dt{margin-top:6px}
  .actionbar{bottom:12px;border-radius:20px}.ab-in{padding:10px 10px 10px 18px}.ab-txt .x{display:none}
  .pr{padding:22px 18px}.pr textarea{min-height:220px}.pr-list .p{display:none}
}
@media print{.top,.ftools,.fpanel,.selrow,.more-row,.tools,.skip,.actionbar,.fsel-wrap,.hero-cta{display:none!important}body{background:#fff}.panel,.list,.flist,.stats{box-shadow:none}details.f{break-inside:avoid}.band{padding-top:32px}}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}details.more>summary::after{transition:none}}
`;
