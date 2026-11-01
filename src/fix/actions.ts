import { execFile } from 'node:child_process';
import { RelivaroError } from '../core/errors.js';
import { gitArgs, gitEnv } from '../fs/files.js';

/** A GitHub Action reference resolved to the commit it points to, and where that answer came from. */
export interface ActionPin {
  action: string;
  ref: string;
  sha: string;
  source: string;
}

const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

/**
 * Resolves `owner/repo[/path]@ref` to a full commit SHA by asking the action's own GitHub repository over HTTPS
 * (`git ls-remote`). Tags win over branches; annotated tags are peeled to their commit. Nothing is cached or guessed:
 * if the repository does not answer with exactly that ref, resolution fails and no pin is proposed.
 */
export function resolveActionRef(action: string, ref: string, timeoutMs = 20_000): Promise<ActionPin> {
  const repo = action.split('/').slice(0, 2).join('/');
  if (!REPO.test(repo) || !REF.test(ref) || ref.includes('..'))
    return Promise.reject(new RelivaroError('USAGE', `Not a resolvable action reference: ${action}@${ref}`));
  const url = `https://github.com/${repo}.git`;
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // Explicit patterns: a bare `<ref>` pattern does not return the peeled `^{}` line of an annotated tag, whose
      // own SHA is a tag object, not a commit.
      gitArgs(['ls-remote', '--', url, `refs/tags/${ref}`, `refs/tags/${ref}^{}`, `refs/heads/${ref}`]),
      { env: gitEnv(), timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err)
          return reject(
            new RelivaroError('NETWORK_FAILED', `Could not query ${url}: ${err.message.split('\n')[0]}`),
          );
        const sha = commitFor(stdout, ref);
        if (!sha)
          return reject(new RelivaroError('NOT_FOUND', `${url} has no tag or branch named "${ref}".`));
        resolve({ action, ref, sha, source: `git ls-remote ${url}` });
      },
    );
  });
}

/**
 * Picks the commit a ref names from `git ls-remote` output: the peeled commit of an annotated tag, else the
 * lightweight tag, else the branch (the order `git rev-parse` uses).
 */
export function commitFor(lsRemote: string, ref: string): string | undefined {
  const refs = new Map<string, string>();
  for (const line of lsRemote.split('\n')) {
    const [sha, name] = line.trim().split(/\s+/);
    if (sha && name && /^[0-9a-f]{40}$/.test(sha)) refs.set(name, sha);
  }
  if (refs.has(`refs/tags/${ref}`)) return refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/tags/${ref}`);
  return refs.get(`refs/heads/${ref}`);
}
