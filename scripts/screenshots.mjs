#!/usr/bin/env node
// Captures the README screenshots from real Relivaro HTML reports (dev only; uses the Playwright devDependency and
// its Chromium: `npx playwright install chromium`). Every image is an unedited capture of the report passed in.
//   node scripts/screenshots.mjs <overview-report.html> <findings-report.html> [outDir=assets/screenshots]
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [, , overview, findings, out = 'assets/screenshots'] = process.argv;
if (!overview || !findings || !existsSync(overview) || !existsSync(findings)) {
  console.error('Usage: node scripts/screenshots.mjs <overview-report.html> <findings-report.html> [outDir]');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();

async function shot(
  name,
  report,
  { lang = 'en', theme = 'light', width = 1280, height = 820, prepare } = {},
) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
    colorScheme: theme,
    locale: lang === 'tr' ? 'tr-TR' : 'en-US',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const url = pathToFileURL(resolve(report)).href;
  await page.goto(url);
  await page.evaluate(
    ([l]) => {
      localStorage.setItem('relivaro.lang', l);
      localStorage.setItem('relivaro.theme', 'system');
    },
    [lang],
  );
  await page.goto(url);
  await page.addStyleTag({ content: 'html{scroll-behavior:auto!important}' });
  if (prepare) await prepare(page);
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  await ctx.close();
  if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
  console.log(`${file} ${(statSync(file).size / 1024).toFixed(0)} KB`);
}

/** Findings explorer: the first finding expanded, three selected (the selection bar appears at the bottom). */
const select = async (page) => {
  const boxes = page.locator('#flist .fsel');
  for (const i of [0, 1, 3]) await boxes.nth(i).check();
  const first = page.locator('#flist details.f').first();
  await first.evaluate((d) => {
    d.open = true;
  });
  await page.locator('#fcount').evaluate((d) => d.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -(document.querySelector('.top').offsetHeight + 12)));
};
const prompt = async (page) => {
  await page.locator('.ff-box .btn.primary').click();
  await page.locator('#prompt[open]').waitFor();
};
const scrollTo = (id) => async (page) => {
  await page.locator(id).evaluate((d) => d.scrollIntoView({ block: 'start' }));
  await page.evaluate(() => window.scrollBy(0, -(document.querySelector('.top').offsetHeight + 12)));
};
const actions = scrollTo('#actions');

for (const theme of ['light', 'dark']) {
  await shot(`report-overview-${theme}`, overview, { theme });
  await shot(`report-actions-${theme}`, findings, { theme, prepare: actions });
  await shot(`report-findings-${theme}`, findings, { theme, prepare: select });
  await shot(`report-prompt-${theme}`, findings, { theme, prepare: prompt });
}
await shot('report-mobile-tr-dark', findings, {
  lang: 'tr',
  theme: 'dark',
  width: 390,
  height: 844,
  prepare: actions,
});
await shot('report-gates-light', overview, { prepare: scrollTo('#gates') });
await browser.close();
