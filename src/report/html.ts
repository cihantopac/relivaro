import type { RunRecord } from '../audit.js';
import type { BenchSnapshot } from '../release/readiness.js';
import type { ReviewEntry } from '../review/review.js';
import { BRAND, FAVICON_SVG, LOGO } from './brand.js';
import type { RunComparison } from './compare.js';
import { REPORT_JS } from './html-client.js';
import { I18N } from './html-i18n.js';
import { PROMPT_JS } from './html-prompt.js';
import { REPORT_CSS } from './html-style.js';
import { REMEDIATION_TEXT, remediationOf } from './remediation.js';

/** Optional context shown next to a run: reviews, the previous run, measured benchmarks and fix history. */
export interface HtmlExtras {
  /** Recorded review verdicts by finding id (see review/review.ts). */
  review?: Record<string, ReviewEntry>;
  comparison?: RunComparison;
  bench?: BenchSnapshot[];
  fixes?: { applied: number; verified: number; rolledBack: number };
}

/** Light / dark / system switch; labels and the pressed state are set by the client in the active language. */
const THEME_ICONS = {
  light:
    '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>',
  dark: '<path d="M13.6 9.8A5.8 5.8 0 0 1 6.2 2.4a5.8 5.8 0 1 0 7.4 7.4z"/>',
  system: '<rect x="1.8" y="2.6" width="12.4" height="8.6" rx="1.4"/><path d="M5.6 14h4.8M8 11.2V14"/>',
};
const THEME_BUTTONS = Object.entries(THEME_ICONS)
  .map(
    ([mode, icon]) =>
      `<button type="button" data-theme-mode="${mode}"><svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></button>`,
  )
  .join('');

const topFindings = (fs: RunComparison['introduced']) =>
  fs.slice(0, 8).map((f) => ({ title: f.title, severity: f.severity, file: f.location?.file }));

/**
 * Self-contained interactive HTML report (English and Turkish; light, dark or system theme). All repository-derived text is
 * inserted via `textContent` from a JSON payload (with `<` escaped), and a strict CSP forbids any network access, so
 * analysed content cannot inject markup or scripts into the report.
 */
export function toHtml(run: RunRecord, extras: HtmlExtras = {}): string {
  const c = extras.comparison;
  const review = extras.review ?? {};
  const rem = Object.fromEntries(run.findings.map((f) => [f.id, remediationOf(f, review[f.id])]));
  const payload = JSON.stringify({
    run,
    review,
    rem,
    remText: REMEDIATION_TEXT,
    extra: {
      comparison: c && {
        base: c.base,
        introduced: c.introduced.length,
        resolved: c.resolved.length,
        persisting: c.persisting,
        releaseChange: c.releaseChange,
        introducedTop: topFindings(c.introduced),
        resolvedTop: topFindings(c.resolved),
      },
      bench: extras.bench?.length ? extras.bench : undefined,
      fixes: extras.fixes,
    },
    i18n: I18N,
  })
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const title = `Relivaro — ${run.profile.name}`.replace(
    /[<>&"]/g,
    (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch]!,
  );
  const css = REPORT_CSS.replace(/#BRAND_LIGHT/g, `#${BRAND.light.brand}`)
    .replace(/#BRAND_INK_LIGHT/g, `#${BRAND.light.ink}`)
    .replace(/#BRAND_SOFT_LIGHT/g, `#${BRAND.light.soft}`)
    .replace(/#BRAND_DARK/g, `#${BRAND.dark.brand}`)
    .replace(/#BRAND_INK_DARK/g, `#${BRAND.dark.ink}`)
    .replace(/#BRAND_SOFT_DARK/g, `#${BRAND.dark.soft}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="generator" content="Relivaro ${run.tool.version.replace(/[^\w.+-]/g, '')}">
<title>${title}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">
<style>${css}</style>
</head>
<body>
<a class="skip" id="skip" href="#findings">Skip to findings</a>
<header class="top"><div class="wrap top-in">
<span class="brand"><svg viewBox="${LOGO.viewBox}" role="img" aria-label="Relivaro"><path class="cairn" fill-rule="evenodd" d="${LOGO.cairn}"/><path fill-rule="evenodd" d="${LOGO.wordmark}"/></svg></span>
<nav class="tabs" id="nav" aria-label="Sections"></nav>
<div class="tools">
<div class="seg" id="lang" role="group"><button type="button" data-lang="en" lang="en">EN</button><button type="button" data-lang="tr" lang="tr">TR</button></div>
<div class="seg seg-icons" id="theme" role="group">${THEME_BUTTONS}</div>
</div>
</div></header>
<main class="wrap" id="app"><noscript><p>This report needs JavaScript to render. The same results are in report.md and report.json next to this file.</p></noscript></main>
<footer class="wrap"><span id="foot-text"></span></footer>
<div id="actionbar" class="actionbar" role="region" aria-label="Selection" hidden></div>
<dialog id="prompt" class="pdlg"></dialog>
<script type="application/json" id="data">${payload}</script>
<script>${PROMPT_JS}</script>
<script>${REPORT_JS}</script>
</body>
</html>
`;
}
