/**
 * Response headers set by web server configuration: Caddy (`Caddyfile`, `*.caddy`), nginx (`add_header`) and static
 * host `_headers` files (Netlify, Cloudflare Pages). Line-oriented and tolerant: anything it does not understand is
 * skipped, never guessed. Header removals (`-Name` in Caddy) are ignored.
 */
export interface HeaderDirective {
  file: string;
  line: number;
  name: string;
  value: string;
  server: 'caddy' | 'nginx' | 'static-headers';
}

export function serverOf(file: string): HeaderDirective['server'] {
  const b = file.split('/').pop()!;
  if (/^Caddyfile(?:\.[\w-]+)?$/.test(b) || b.endsWith('.caddy')) return 'caddy';
  if (b === '_headers') return 'static-headers';
  return 'nginx';
}

export function headerDirectives(file: string, text: string): HeaderDirective[] {
  const server = serverOf(file);
  const lines = text.split(/\r?\n/);
  if (server === 'nginx') return nginx(file, lines);
  if (server === 'static-headers') return staticHeaders(file, lines);
  return caddy(file, lines);
}

/** CSP directives by lower-cased name, with their sources in order. */
export function cspOf(value: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources);
  }
  return out;
}

function nginx(file: string, lines: string[]): HeaderDirective[] {
  const out: HeaderDirective[] = [];
  lines.forEach((raw, i) => {
    const m = /^\s*add_header\s+("[^"]+"|'[^']+'|[^\s;]+)\s+("[^"]*"|'[^']*'|[^\s;]+)/.exec(raw);
    if (m) out.push({ file, line: i + 1, name: unquote(m[1]!), value: unquote(m[2]!), server: 'nginx' });
  });
  return out;
}

function staticHeaders(file: string, lines: string[]): HeaderDirective[] {
  const out: HeaderDirective[] = [];
  lines.forEach((raw, i) => {
    const m = /^\s+([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(raw);
    if (m && !raw.trim().startsWith('#'))
      out.push({ file, line: i + 1, name: m[1]!, value: m[2]!, server: 'static-headers' });
  });
  return out;
}

const CADDY_NAME = /^[+>?]?([A-Za-z][\w-]*)$/;

function caddy(file: string, lines: string[]): HeaderDirective[] {
  const out: HeaderDirective[] = [];
  // Adds `name value` (value may be a backtick string continuing on later lines); returns the last line consumed.
  const add = (name: string, rest: string, i: number): number => {
    const m = CADDY_NAME.exec(name);
    if (!m || !rest) return i;
    let value = rest;
    let end = i;
    if (value.startsWith('`') && !/^`[^`]*`/.test(value)) {
      // An unterminated backtick ends at the closing `}` of its block instead of swallowing the rest of the file.
      while (end + 1 < lines.length && !value.slice(1).includes('`') && lines[end + 1]!.trim() !== '}')
        value += `\n${lines[++end]}`;
    }
    out.push({ file, line: i + 1, name: m[1]!, value: unquote(value.trim()), server: 'caddy' });
    return end;
  };
  let depth = 0; // brace depth inside a `header { … }` block; 0 = outside
  let matcherDepth = 0; // brace depth inside a named matcher block `@name { … }`, whose `header` lines are conditions
  for (let i = 0; i < lines.length; i++) {
    const t = stripComment(lines[i]!).trim();
    if (!t) continue;
    if (matcherDepth > 0) {
      if (t === '}') matcherDepth--;
      else if (t.endsWith('{')) matcherDepth++;
      continue;
    }
    if (depth === 0 && /^@[\w-]+\s*\{$/.test(t)) {
      matcherDepth = 1;
      continue;
    }
    if (depth > 0) {
      if (t === '}') {
        depth--;
        continue;
      }
      if (t.endsWith('{')) {
        depth++;
        continue;
      }
      const [name, ...rest] = t.split(/\s+/);
      i = add(name!, rest.join(' '), i);
      continue;
    }
    const tokens = t.split(/\s+/);
    if (tokens[0] !== 'header') continue;
    let k = 1;
    if (tokens[k] && /^[/@*]/.test(tokens[k]!)) k++; // request matcher
    if (tokens[k] === '{') {
      depth = 1;
      continue;
    }
    if (tokens[k]) i = add(tokens[k]!, tokens.slice(k + 1).join(' '), i);
  }
  return out;
}

/** Drops a `#` comment that starts outside quotes (Caddyfile comments need whitespace or line start before `#`). */
function stripComment(line: string): string {
  let q = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === q) q = '';
    } else if (c === '"' || c === '`') q = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function unquote(v: string): string {
  const s = v.replace(/;$/, '');
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'" || s[0] === '`') && s.endsWith(s[0]!))
    return s.slice(1, -1);
  return s;
}
