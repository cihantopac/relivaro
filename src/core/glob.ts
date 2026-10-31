/**
 * Minimal glob matcher (`**`, `*`, `?`, `{a,b}`, character classes) for include/exclude configuration.
 * Paths are POSIX and relative to the project root. A pattern without `/` matches at any depth.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let pattern = glob.trim().replace(/^\.\//, '');
  const anchored = pattern.includes('/') && !pattern.startsWith('**/');
  if (pattern.endsWith('/')) pattern += '**';
  let re = '';
  let inGroup = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slashAfter = pattern[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      inGroup++;
      re += '(?:';
    } else if (c === '}' && inGroup) {
      inGroup--;
      re += ')';
    } else if (c === ',' && inGroup) re += '|';
    else if (c === '[') {
      const end = pattern.indexOf(']', i);
      if (end > i) {
        re += `[${pattern
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`;
        i = end;
      } else re += '\\[';
    } else re += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  const out = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}(?:/.*)?$`);
  cache.set(glob, out);
  return out;
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(path));
}
