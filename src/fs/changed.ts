import { RelivaroError } from '../core/errors.js';
import { runGit } from './files.js';

/** Decodes a C-quoted git path (`"a\tb"`, octal UTF-8 bytes) back to the file name. */
function unquote(p: string): string {
  if (!p.startsWith('"') || !p.endsWith('"')) return p;
  const bytes: number[] = [];
  const body = p.slice(1, -1);
  const esc: Record<string, number> = { t: 9, n: 10, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== '\\') {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
      continue;
    }
    const oct = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += 3;
    } else {
      const n = body[i + 1] ?? '';
      bytes.push(esc[n] ?? n.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Lines changed in the working tree since `ref`, per file relative to `root`: a set of new-side line numbers, or
 * `'all'` for a new, renamed, copied or untracked file (binary files included). Deleted files are absent.
 * The file list comes from `git diff --name-status -z` (no quoting, no prefixes); line numbers come from the hunk
 * headers of a `--unified=0` diff with fixed `a/`/`b/` prefixes, whatever the user's git config says.
 * A missing git repository or an unknown ref is a usage error: `--since` never falls back to a full report.
 */
export function changedLines(root: string, ref: string): Map<string, Set<number> | 'all'> {
  if (!ref || ref.startsWith('-') || /[\s\0]/.test(ref))
    throw new RelivaroError('USAGE', `--since needs a git ref such as main or HEAD~3, got "${ref}".`);
  if (runGit(root, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true')
    throw new RelivaroError(
      'USAGE',
      '--since needs a git repository (and git); this directory is not one, or git is not available.',
    );
  if (runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === null)
    throw new RelivaroError('USAGE', `--since: unknown git ref "${ref}".`);
  const common = ['-M', '--relative', '--no-color', '--no-ext-diff', ref, '--'];
  const status = runGit(root, ['-c', 'core.quotePath=false', 'diff', '--name-status', '-z', ...common]);
  const diff = runGit(root, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    ...common,
  ]);
  if (status === null || diff === null)
    throw new RelivaroError('USAGE', `--since: git diff against "${ref}" failed.`);

  const out = new Map<string, Set<number> | 'all'>();
  const tok = status.split('\0');
  for (let i = 0; i + 1 < tok.length; ) {
    const st = tok[i]!;
    if (/^[RC]/.test(st)) {
      out.set(tok[i + 2]!, 'all');
      i += 3;
    } else {
      const path = tok[i + 1]!;
      if (st.startsWith('A')) out.set(path, 'all');
      else if (!st.startsWith('D')) out.set(path, new Set());
      i += 2;
    }
  }

  // Hunk headers: `+++ b/<path>` only counts inside a file header (before its first `@@`), so an added content line
  // that starts with `++ ` is never mistaken for a header.
  let file: string | null = null;
  let inHeader = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
      file = null;
    } else if (inHeader && line.startsWith('+++ ')) {
      const raw = unquote(line.slice(4).replace(/\t$/, ''));
      file = raw === '/dev/null' ? null : raw.replace(/^b\//, '');
    } else if (line.startsWith('@@')) {
      inHeader = false;
      const set = file ? out.get(file) : undefined;
      if (!(set instanceof Set)) continue;
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < count; i++) set.add(start + i);
    }
  }
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '';
  for (const p of untracked.split('\0')) if (p) out.set(p, 'all');
  return out;
}
