#!/usr/bin/env node
// Renders the GitHub social preview (1280×640) and the link preview (1200×630) from a real Relivaro HTML report
// (dev only; uses the Playwright devDependency and its Chromium: `npx playwright install chromium`).
// The report part of the image is an unedited capture of the report passed in.
//   node scripts/social-preview.mjs <report.html> [outDir=assets/brand]
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [, , report, out = 'assets/brand'] = process.argv;
if (!report || !existsSync(report)) {
  console.error('Usage: node scripts/social-preview.mjs <report.html> [outDir]');
  process.exit(2);
}
const browser = await chromium.launch();

// 1. The report's first screen, light theme, English, at a width where the desktop layout still applies.
const cap = await browser.newContext({
  viewport: { width: 820, height: 760 },
  deviceScaleFactor: 2,
  colorScheme: 'light',
});
const rp = await cap.newPage();
const url = pathToFileURL(resolve(report)).href;
await rp.goto(url);
await rp.evaluate(() => {
  localStorage.setItem('relivaro.lang', 'en');
  localStorage.setItem('relivaro.theme', 'system');
});
await rp.goto(url);
const shot = (await rp.screenshot({ type: 'png' })).toString('base64');
await cap.close();

// 2. The card: brand on the left, the report in a window frame bleeding off the right and bottom edges.
const logo = readFileSync('assets/brand/primary-color.svg', 'utf8').replace(/<\?xml[^>]*>/, '');
const page = (w, h) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:${w}px;height:${h}px;overflow:hidden;background:#f6f4f0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Segoe UI",Helvetica,Arial,sans-serif;color:#121620;position:relative}
.glow{position:absolute;right:-120px;top:-160px;width:760px;height:760px;border-radius:50%;background:radial-gradient(closest-side,rgba(11,114,133,.10),rgba(11,114,133,0))}
.left{position:absolute;left:84px;top:0;bottom:0;width:${w >= 1280 ? 560 : 520}px;display:flex;flex-direction:column;justify-content:center}
.logo svg{height:44px;width:auto;display:block}
h1{font-size:${w >= 1280 ? 54 : 50}px;line-height:1.04;letter-spacing:-.035em;font-weight:750;margin-top:44px}
h1 span{color:#0b7285;display:block}
.rule{width:44px;height:3px;border-radius:2px;background:#0b7285;margin:30px 0 26px}
p{font-size:21px;line-height:1.45;color:#5b5650;max-width:430px}
.chips{display:flex;gap:10px;margin-top:30px}
.chip{font-size:15.5px;font-weight:600;color:#085765;background:#e2f1f4;border-radius:999px;padding:8px 16px}
.win{position:absolute;left:${w >= 1280 ? 668 : 628}px;top:86px;width:700px;height:640px;border-radius:16px;background:#fff;box-shadow:0 30px 80px rgba(18,22,32,.14),0 0 0 1px rgba(18,22,32,.06);overflow:hidden}
.bar{height:34px;background:#efece7;display:flex;gap:8px;align-items:center;padding:0 14px}
.bar i{width:11px;height:11px;border-radius:50%;background:#d0c9c0;display:block}
.win img{display:block;width:656px;height:auto}
</style></head><body>
<div class="glow"></div>
<div class="left">
  <div class="logo">${logo}</div>
  <h1>Verify the code.<span>Ship with confidence.</span></h1>
  <div class="rule"></div>
  <p>Open-source code auditor for security, reliability and release readiness.</p>
  <div class="chips"><span class="chip">CLI</span><span class="chip">Claude Code plugin</span><span class="chip">Offline</span></div>
</div>
<div class="win"><div class="bar"><i></i><i></i><i></i></div><img src="data:image/png;base64,${shot}" alt=""></div>
</body></html>`;

for (const [name, w, h] of [
  ['github-social-preview.png', 1280, 640],
  ['og-image.png', 1200, 630],
]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(page(w, h), { waitUntil: 'load' });
  const file = join(out, name);
  await p.screenshot({ path: file, type: 'png' });
  await ctx.close();
  console.log(`${file} ${(statSync(file).size / 1024).toFixed(0)} KB`);
}
await browser.close();
