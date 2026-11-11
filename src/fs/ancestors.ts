import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { matchesAny } from '../core/glob.js';

/**
 * The only file names Relivaro reads above the audit root. They describe the workspace a package belongs to
 * (workspace globs, lockfiles, scripts) and the build context's `.dockerignore`; nothing else outside the audit
 * root is ever read. Every other read goes through `FileSet`.
 */
export const ANCESTOR_META: readonly string[] = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  '.dockerignore',
];

const LOCKFILES = [
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'npm-shrinkwrap.json',
];
const MANAGER: Record<string, WorkspaceRoot['packageManager']> = {
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
};

export interface WorkspaceRoot {
  /** Absolute path of the ancestor. Never stored in a report or profile. */
  dir: string;
  /** The audit root relative to `dir`, POSIX, e.g. `packages/preflight`. */
  rel: string;
  /** Lockfile names present in `dir`. */
  lockfiles: string[];
  /** `dir/package.json` scripts, `{}` when absent. */
  scripts: Record<string, string>;
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
}

function readMeta(dir: string, name: string): string | null {
  if (!ANCESTOR_META.includes(name)) throw new Error(`not an ancestor metadata file: ${name}`);
  try {
    const p = join(dir, name);
    if (!lstatSync(p).isFile()) return null;
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function hasMeta(dir: string, name: string): boolean {
  if (!ANCESTOR_META.includes(name)) return false;
  try {
    return lstatSync(join(dir, name)).isFile();
  } catch {
    return false;
  }
}

function realOrResolved(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}

function workspaceGlobs(dir: string): string[] {
  const globs: string[] = [];
  const pnpm = readMeta(dir, 'pnpm-workspace.yaml');
  if (pnpm !== null) {
    try {
      const doc = parseYaml(pnpm) as { packages?: unknown };
      if (Array.isArray(doc?.packages))
        for (const g of doc.packages) if (typeof g === 'string') globs.push(g);
    } catch {
      /* malformed: no globs */
    }
  }
  const pkg = readMeta(dir, 'package.json');
  if (pkg !== null) {
    try {
      const json = JSON.parse(pkg) as { workspaces?: unknown };
      const ws = json.workspaces;
      const list = Array.isArray(ws) ? ws : (ws as { packages?: unknown } | undefined)?.packages;
      if (Array.isArray(list)) for (const g of list) if (typeof g === 'string') globs.push(g);
    } catch {
      /* malformed */
    }
  }
  return globs
    .map((g) => g.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((g) => g && !g.startsWith('!'));
}

function scriptsOf(dir: string): Record<string, string> {
  const pkg = readMeta(dir, 'package.json');
  if (pkg === null) return {};
  try {
    const s = (JSON.parse(pkg) as { scripts?: unknown }).scripts;
    if (!s || typeof s !== 'object') return {};
    return Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === 'string')) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

/**
 * The nearest ancestor (at most `maxDepth` levels up, default 6) whose workspace globs (`pnpm-workspace.yaml`
 * `packages`, or `package.json` `workspaces`) include the audit root. An ancestor that merely has a
 * `package.json` (an archive unpacked under `/work`, the home directory) is not a workspace root.
 */
export function findWorkspaceRoot(auditRoot: string, opts: { maxDepth?: number } = {}): WorkspaceRoot | null {
  const start = realOrResolved(auditRoot);
  const maxDepth = opts.maxDepth ?? 6;
  let dir = start;
  for (let depth = 1; depth <= maxDepth; depth++) {
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    const globs = workspaceGlobs(dir);
    if (!globs.length) continue;
    const rel = relative(dir, start).split(sep).join('/');
    if (!(globs.includes(rel) || matchesAny(rel, globs))) continue;
    const lockfiles = LOCKFILES.filter((n) => hasMeta(dir, n));
    const out: WorkspaceRoot = { dir, rel, lockfiles, scripts: scriptsOf(dir) };
    const manager = lockfiles.map((n) => MANAGER[n]).find(Boolean);
    if (manager) out.packageManager = manager;
    return out;
  }
  return null;
}

/**
 * Absolute path of the nearest `.dockerignore` strictly above `auditRoot`, up to and including `stopAt`.
 * Returns null when `stopAt` is not an ancestor of the audit root or no file is found.
 */
export function ancestorDockerignore(auditRoot: string, stopAt: string): string | null {
  const start = realOrResolved(auditRoot);
  const stop = realOrResolved(stopAt);
  const r = relative(stop, start);
  if (!r || r.startsWith('..') || resolve(stop, r) !== start) return null;
  let dir = start;
  while (dir !== stop) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
    if (hasMeta(dir, '.dockerignore')) return join(dir, '.dockerignore');
  }
  return null;
}
