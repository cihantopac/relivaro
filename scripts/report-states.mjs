#!/usr/bin/env node
// Renders HTML reports in Chromium across widths, themes and languages and fails on page errors, horizontal overflow,
// raw i18n keys or lost state (dev only; uses the Playwright devDependency: `npx playwright install chromium`).
//   node scripts/report-states.mjs <report.html> [more reports...]
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const reports = process.argv.slice(2);
if (!reports.length || reports.some((r) => !existsSync(r))) {
  console.error('Usage: node scripts/report-states.mjs <report.html> [more reports...]');
  process.exit(2);
}
const browser = await chromium.launch();
const problems = [];

for (const report of reports) {
  const url = pathToFileURL(resolve(report)).href;
  for (const width of [1280, 360]) {
    for (const theme of ['light', 'dark']) {
      for (const lang of ['en', 'tr']) {
        const tag = `${report} @${width} ${theme} ${lang}`;
        const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: theme });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e)));
        await page.goto(url);
        await page.evaluate((l) => localStorage.setItem('relivaro.lang', l), lang);
        await page.goto(url);
        const check = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          title: document.querySelector('.hero-title')?.textContent?.trim() ?? '',
          // An untranslated key renders as its dotted name, e.g. "hero.not-ready".
          rawKeys: (
            document.body.innerText.match(
              /\b(?:hero|cta|ff|stat|kpi|gates|gg|findings|finding|sel|pr|checks|more)\.[a-z][\w.-]*/g,
            ) ?? []
          ).filter((k) => !/\.(?:ts|js|json|yml|yaml|md|py|php|tsx|jsx)$/.test(k)),
        }));
        if (errors.length) problems.push(`${tag}: page error ${errors.join('; ')}`);
        if (check.overflow > 0) problems.push(`${tag}: horizontal overflow ${check.overflow}px`);
        if (!check.title) problems.push(`${tag}: empty headline`);
        if (check.rawKeys.length)
          problems.push(`${tag}: raw i18n keys ${[...new Set(check.rawKeys)].join(', ')}`);

        // Selection and open rows survive a language and theme switch.
        const rows = page.locator('#flist details.f');
        if (width === 1280 && (await rows.count()) >= 2) {
          await page.locator('#flist .fsel').nth(0).check();
          await page.locator('#flist .fsel').nth(1).check();
          await rows.nth(0).evaluate((d) => {
            d.open = true;
          });
          await page.locator(`#lang button[data-lang="${lang === 'en' ? 'tr' : 'en'}"]`).click();
          await page.locator('#theme button[data-theme-mode="dark"]').click();
          const after = await page.evaluate(() => ({
            selected: document.querySelectorAll('#flist .fsel:checked').length,
            open: document.querySelectorAll('#flist details.f[open]').length,
            bar: !document.getElementById('actionbar').hidden,
          }));
          if (after.selected !== 2 || after.open !== 1 || !after.bar)
            problems.push(`${tag}: state lost ${JSON.stringify(after)}`);
        }
        await ctx.close();
      }
    }
  }
  console.log(`checked ${report}`);
}
await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('all report states OK');
