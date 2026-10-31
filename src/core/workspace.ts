import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RelivaroError } from './errors.js';

/**
 * `.relivaro/` holds run records, reports, fix backups and benchmark baselines. It contains a `.gitignore` with
 * `*`, so it never pollutes the analysed repository's git status. `--workspace <dir>` relocates it entirely (used
 * for read-only audits of repositories you do not want to touch at all).
 */
export class Workspace {
  readonly dir: string;

  constructor(projectRoot: string, override?: string) {
    this.dir = override ? resolve(override) : join(resolve(projectRoot), '.relivaro');
  }

  ensure(): void {
    mkdirSync(this.dir, { recursive: true });
    const gi = join(this.dir, '.gitignore');
    if (!existsSync(gi)) writeFileSync(gi, '# Relivaro run data — never commit.\n*\n');
  }

  path(...parts: string[]): string {
    for (const p of parts) if (p.includes('..') || /^[\\/]/.test(p)) throw new RelivaroError('PATH_OUTSIDE_ROOT', `Invalid workspace path segment: ${p}`);
    return join(this.dir, ...parts);
  }

  newRunId(prefix = ''): string {
    const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
    return `${prefix}${ts}-${randomBytes(3).toString('hex')}`;
  }

  writeJson(rel: string[], data: unknown): string {
    this.ensure();
    const file = this.path(...rel);
    atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
    return file;
  }

  writeText(rel: string[], text: string): string {
    this.ensure();
    const file = this.path(...rel);
    atomicWrite(file, text);
    return file;
  }

  readJson<T>(rel: string[]): T | undefined {
    const file = this.path(...rel);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T;
    } catch {
      throw new RelivaroError('CONFIG_INVALID', `Corrupt workspace file: ${file}`);
    }
  }

  /** Run ids sorted oldest → newest. */
  listRuns(): string[] {
    const dir = this.path('runs');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((d) => existsSync(join(dir, d, 'run.json')))
      .sort((a, b) => statSync(join(dir, a, 'run.json')).mtimeMs - statSync(join(dir, b, 'run.json')).mtimeMs || a.localeCompare(b));
  }

  resolveRun(idOrAlias: string): string {
    const runs = this.listRuns();
    if (!runs.length) throw new RelivaroError('NOT_FOUND', `No runs in ${this.dir}`, 'Run `relivaro audit` first.');
    if (idOrAlias === 'latest' || idOrAlias === 'last') return runs[runs.length - 1]!;
    if (idOrAlias === 'previous' || idOrAlias === 'prev') {
      if (runs.length < 2) throw new RelivaroError('NOT_FOUND', 'There is no previous run.');
      return runs[runs.length - 2]!;
    }
    const matches = runs.filter((r) => r === idOrAlias || r.startsWith(idOrAlias) || r.endsWith(idOrAlias));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new RelivaroError('USAGE', `Run id "${idOrAlias}" is ambiguous: ${matches.join(', ')}`);
    throw new RelivaroError('NOT_FOUND', `Run not found: ${idOrAlias}`);
  }
}

export function atomicWrite(file: string, content: string | Uint8Array): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}
