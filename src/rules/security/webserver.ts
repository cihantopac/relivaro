import type { ProjectFile } from '../../core/types.js';
import { cspOf, type HeaderDirective, headerDirectives, serverOf } from '../../intel/webserver.js';
import { OWASP } from '../helpers.js';
import type { Hit, ProjectContext, ProjectRule } from '../types.js';

// ---------------------------------------------------------------------------------------------------------------
// Response security headers set by web server configuration (Caddy, nginx, static host `_headers`)

interface ServerHeaders {
  files: ProjectFile[];
  headers: HeaderDirective[];
  /** At least one config serves files itself; a config that only reverse-proxies leaves headers to the app. */
  servesFiles: boolean;
}

/** `default.conf` / `site.conf` are generic names: count them only when they read like nginx. */
const NGINX_LIKE = /^\s*(?:server|http|location\b[^{]*)\s*\{|^\s*add_header\s/m;
const SERVES_FILES = /^\s*(?:file_server\b|root\s|try_files\s|alias\s)/m;

const cache = new WeakMap<ProjectContext, ServerHeaders>();

function serverHeaders(ctx: ProjectContext): ServerHeaders {
  let s = cache.get(ctx);
  if (!s) {
    const texts = ctx.files.files
      .filter((f) => f.kind === 'webserver')
      .map((f) => ({ f, text: ctx.files.read(f.path) ?? '' }))
      .filter(({ f, text }) => serverOf(f.path) !== 'nginx' || NGINX_LIKE.test(text));
    s = {
      files: texts.map((t) => t.f),
      headers: texts.flatMap(({ f, text }) => headerDirectives(f.path, text)),
      servesFiles: texts.some(
        ({ f, text }) => serverOf(f.path) === 'static-headers' || SERVES_FILES.test(text),
      ),
    };
    cache.set(ctx, s);
  }
  return s;
}

const named = (s: ServerHeaders, name: string) =>
  s.headers.filter((h) => h.name.toLowerCase() === name.toLowerCase());

/** A project-level hit anchored at the first web server file. */
function atConfig(s: ServerHeaders, message: string): Hit[] {
  const file = s.files[0]!.path;
  return [
    { file, line: 1, message, anchor: file, facts: { configs: s.files.map((f) => f.path).join(', ') } },
  ];
}

// A CSP `<meta>` tag in served HTML or in the page templates/components that produce it (JSX uses `httpEquiv`).
const META_CSP = /<meta\s[^>]*http-?equiv\s*=\s*\{?\s*["']?content-security-policy["']?/i;
const PAGE_FILE = /\.(?:html?|[jt]sx|astro|vue|svelte)$/i;

const webMissingCsp: ProjectRule = {
  kind: 'project',
  id: 'sec/web-missing-csp',
  title: 'Web server sets no Content-Security-Policy',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  cwe: ['CWE-1021', 'CWE-79'],
  owasp: [OWASP.A02],
  description:
    'The project serves its site through Caddy, nginx or a `_headers` file, but none of them sets a `Content-Security-Policy` header and no served HTML page declares one in a `<meta http-equiv>` tag.',
  impact:
    'Without a CSP, any injected script runs with the full privileges of the page, so a single XSS or compromised third-party script can read data and act as the user.',
  recommendation:
    "Set a policy at the server, starting from `default-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'` and adding only the sources the site needs. For a static export, allow inline scripts by their hashes instead of `'unsafe-inline'`.",
  verification:
    '`curl -sI https://<host>/` shows a `Content-Security-Policy` header and the browser console reports no violations on the main pages.',
  check(ctx) {
    const s = serverHeaders(ctx);
    if (!s.servesFiles || named(s, 'Content-Security-Policy').length) return [];
    for (const f of ctx.files.files)
      if (!f.isTest && PAGE_FILE.test(f.path) && META_CSP.test(ctx.files.read(f.path) ?? '')) return [];
    return atConfig(s, 'No `Content-Security-Policy` header is set in the web server configuration.');
  },
};

const webCspUnsafeInline: ProjectRule = {
  kind: 'project',
  id: 'sec/web-csp-unsafe-inline',
  title: "Content-Security-Policy allows 'unsafe-inline' scripts",
  category: 'security',
  severity: 'low',
  confidence: 'high',
  cwe: ['CWE-79'],
  owasp: [OWASP.A02],
  description:
    "The effective `script-src` of a Content-Security-Policy set by the web server (falling back to `default-src`) contains `'unsafe-inline'` without any nonce or hash source.",
  impact:
    'Inline script injection, the most common XSS payload, is allowed, so the policy no longer stops the attacks it exists for.',
  recommendation:
    "Remove `'unsafe-inline'` from `script-src`. Move inline scripts to files, or allow them by hash (`'sha256-…'`); a static export can compute the hashes at build time. Server-rendered pages can use a per-request nonce.",
  verification:
    "The served policy has no `'unsafe-inline'` in its effective `script-src`, and the pages still work with the browser console free of CSP violations.",
  check(ctx) {
    const out: Hit[] = [];
    for (const h of named(serverHeaders(ctx), 'Content-Security-Policy')) {
      const csp = cspOf(h.value);
      const scriptSrc = (csp.get('script-src') ?? csp.get('default-src') ?? []).map((x) => x.toLowerCase());
      if (!scriptSrc.includes("'unsafe-inline'")) continue;
      if (scriptSrc.some((x) => /^'(?:nonce-|sha256-|sha384-|sha512-)/.test(x))) continue;
      out.push({
        file: h.file,
        line: h.line,
        message: `The Content-Security-Policy in \`${h.file}\` allows \`'unsafe-inline'\` scripts.`,
      });
    }
    return out;
  },
};

const webMissingFrameProtection: ProjectRule = {
  kind: 'project',
  id: 'sec/web-missing-frame-protection',
  title: 'Web server sets no clickjacking protection',
  category: 'security',
  severity: 'low',
  confidence: 'medium',
  cwe: ['CWE-1021'],
  owasp: [OWASP.A02],
  description:
    'The web server configuration sets neither a CSP `frame-ancestors` directive nor an `X-Frame-Options` header, so any site may embed these pages in a frame. A `<meta>` CSP cannot set `frame-ancestors`.',
  impact:
    'An attacker can frame the site under a decoy page and trick users into clicking its controls (clickjacking).',
  recommendation:
    "Add `frame-ancestors 'none'` (or `'self'`) to the Content-Security-Policy; keep `X-Frame-Options: DENY` for older browsers.",
  verification:
    '`curl -sI https://<host>/` shows `frame-ancestors` in the CSP or an `X-Frame-Options` header.',
  check(ctx) {
    const s = serverHeaders(ctx);
    if (!s.servesFiles || named(s, 'X-Frame-Options').length) return [];
    if (named(s, 'Content-Security-Policy').some((h) => cspOf(h.value).has('frame-ancestors'))) return [];
    return atConfig(s, 'No `frame-ancestors` CSP directive or `X-Frame-Options` header is set.');
  },
};

const webMissingHsts: ProjectRule = {
  kind: 'project',
  id: 'sec/web-missing-hsts',
  title: 'Web server sets no Strict-Transport-Security',
  category: 'security',
  severity: 'low',
  confidence: 'low',
  cwe: ['CWE-319'],
  owasp: [OWASP.A02],
  description:
    'The web server configuration does not set a `Strict-Transport-Security` header. It may still be set in front of the server, by a CDN or tunnel such as Cloudflare, which Relivaro cannot see.',
  impact:
    'Browsers will try plain HTTP first on new visits, where a network attacker can downgrade or intercept the connection.',
  recommendation:
    'Set `Strict-Transport-Security: max-age=63072000` once the site serves HTTPS only. Add `includeSubDomains` only when every subdomain serves HTTPS.',
  verification:
    '`curl -sI https://<host>/` shows a `Strict-Transport-Security` header with a long `max-age`.',
  check(ctx) {
    const s = serverHeaders(ctx);
    if (!s.servesFiles || named(s, 'Strict-Transport-Security').length) return [];
    return atConfig(
      s,
      'No `Strict-Transport-Security` header is set in the web server configuration (it may be set at a CDN or tunnel, e.g. Cloudflare).',
    );
  },
};

const webHstsIncludeSubdomains: ProjectRule = {
  kind: 'project',
  id: 'sec/web-hsts-include-subdomains',
  title: 'HSTS includeSubDomains applies to every subdomain',
  category: 'security',
  severity: 'info',
  confidence: 'medium',
  cwe: ['CWE-319'],
  owasp: [OWASP.A02],
  description:
    'A `Strict-Transport-Security` header uses `includeSubDomains`. This is not a defect: it tells browsers to use HTTPS for every subdomain of the host, including mail, legacy or internal hosts.',
  impact:
    'A subdomain that does not serve valid HTTPS becomes unreachable in browsers for the whole `max-age`.',
  recommendation:
    'Confirm that every subdomain serves HTTPS with a valid certificate before keeping `includeSubDomains`; otherwise drop it.',
  verification: 'Every DNS name under the host answers over HTTPS with a valid certificate.',
  check(ctx) {
    return named(serverHeaders(ctx), 'Strict-Transport-Security')
      .filter((h) => /\bincludesubdomains\b/i.test(h.value))
      .map((h) => ({
        file: h.file,
        line: h.line,
        message: `HSTS in \`${h.file}\` uses \`includeSubDomains\`: confirm every subdomain serves HTTPS.`,
      }));
  },
};

export const webServerRules: ProjectRule[] = [
  webMissingCsp,
  webCspUnsafeInline,
  webMissingFrameProtection,
  webMissingHsts,
  webHstsIncludeSubdomains,
];
