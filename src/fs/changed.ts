import { RelivaroError } from '../core/errors.js';
import { runGit } from './files.js';

/**
 * Lines changed in the working tree since `ref`, per file relative to `root`: a set of new-side line numbers, or
 * `'all'` for a new, renamed or untracked file. Deleted files are absent. Uses `git diff --unified=0 -M --relative`.
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
  const diff = runGit(root, [
    '-c',
    'core.quotePath=false',
    'diff',
    '--unified=0',
    '-M',
    '--relative',
    '--no-color',
    '--no-ext-diff',
    ref,
    '--',
  ]);
  if (diff === null) throw new RelivaroError('USAGE', `--since: git diff against "${ref}" failed.`);
  const out = new Map<string, Set<number> | 'all'>();
  let file: string | null = null;
  let whole = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      file = null;
      whole = false;
    } else if (
      line.startsWith('new file mode') ||
      line.startsWith('rename to ') ||
      line.startsWith('copy to ')
    )
      whole = true;
    else if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file) out.set(file, whole ? 'all' : (out.get(file) ?? new Set()));
    } else if (line.startsWith('@@') && file) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      const set = out.get(file);
      if (!m || set === 'all' || !set) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < count; i++) set.add(start + i);
    }
  }
  // A rename without content changes has no `+++` line: take the target from `rename to`.
  for (const m of diff.matchAll(/^rename to (.+)$/gm)) out.set(m[1]!, 'all');
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z']) ?? '';
  for (const p of untracked.split('\0')) if (p) out.set(p, 'all');
  return out;
}
