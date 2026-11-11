import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ancestorDockerignore, findWorkspaceRoot } from '../../src/fs/ancestors.js';
import { FileSet } from '../../src/fs/files.js';
import { discover } from '../../src/intel/discover.js';

const dirs: string[] = [];
function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rlv-anc-'));
  dirs.push(root);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PNPM_TREE = {
  'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
  'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
  'package.json': JSON.stringify({ name: 'mono', private: true, scripts: { test: 'vitest' } }),
  'packages/preflight/package.json': JSON.stringify({ name: 'preflight', version: '1.0.0' }),
  'packages/preflight/src/index.ts': 'export const x = 1;\n',
};

describe('findWorkspaceRoot', () => {
  it('finds a pnpm workspace root whose globs include the audit root', () => {
    const root = tree(PNPM_TREE);
    const ws = findWorkspaceRoot(join(root, 'packages/preflight'));
    expect(ws).not.toBeNull();
    expect(ws).toMatchObject({
      rel: 'packages/preflight',
      lockfiles: ['pnpm-lock.yaml'],
      scripts: { test: 'vitest' },
      packageManager: 'pnpm',
    });
  });

  it('finds an npm/yarn workspace root from package.json#workspaces', () => {
    const root = tree({
      'package.json': JSON.stringify({ workspaces: ['apps/*'] }),
      'apps/web/package.json': '{}',
    });
    expect(findWorkspaceRoot(join(root, 'apps/web'))?.rel).toBe('apps/web');
  });

  it('ignores an ancestor whose globs do not include the audit root', () => {
    const root = tree({
      'package.json': JSON.stringify({ workspaces: ['libs/*'] }),
      'apps/web/package.json': '{}',
    });
    expect(findWorkspaceRoot(join(root, 'apps/web'))).toBeNull();
  });

  it('ignores an ancestor package.json without workspaces', () => {
    const root = tree({
      'package.json': JSON.stringify({ name: 'work', scripts: { test: 'x' } }),
      'package-lock.json': '{}',
      'repo/package.json': '{}',
    });
    expect(findWorkspaceRoot(join(root, 'repo'))).toBeNull();
  });

  it('a workspace glob matches the package directory itself, not a directory below it', () => {
    const root = tree(PNPM_TREE);
    expect(findWorkspaceRoot(join(root, 'packages/preflight/src'))).toBeNull();
    expect(findWorkspaceRoot(join(root, 'packages/preflight'))?.rel).toBe('packages/preflight');
  });

  it('stops at maxDepth (default 6)', () => {
    const deep = 'a/b/c/d/e/f/g';
    const root = tree({
      'package.json': JSON.stringify({ workspaces: ['a/**'] }),
      [`${deep}/package.json`]: '{}',
    });
    expect(findWorkspaceRoot(join(root, deep))).toBeNull();
    expect(findWorkspaceRoot(join(root, deep), { maxDepth: 7 })?.rel).toBe(deep);
    expect(findWorkspaceRoot(join(root, 'a/b/c/d/e/f'))?.rel).toBe('a/b/c/d/e/f');
  });
});

describe('ancestorDockerignore', () => {
  it('returns the nearest .dockerignore up to stopAt and never above it', () => {
    const root = tree({
      '.dockerignore': '.git\n',
      'mono/.dockerignore': '.env*\n',
      'mono/apps/web/Dockerfile': 'FROM node:22\n',
    });
    const mono = join(root, 'mono');
    const web = join(mono, 'apps/web');
    // Real paths with the platform separator (macOS tmp is a symlink; Windows uses backslashes).
    expect(ancestorDockerignore(web, mono)).toBe(join(realpathSync.native(mono), '.dockerignore'));
    rmSync(join(mono, '.dockerignore'));
    expect(ancestorDockerignore(web, mono)).toBeNull();
    expect(ancestorDockerignore(web, root)).toBe(join(realpathSync.native(root), '.dockerignore'));
  });
});

describe('discover workspace root', () => {
  it('discover sets workspaceRoot for a package audited alone', () => {
    const root = tree(PNPM_TREE);
    const profile = discover(new FileSet(join(root, 'packages/preflight'), { useGit: false }));
    // Only script names leave the ancestor: their commands are content from outside the audit root.
    expect(profile.workspaceRoot).toEqual({
      rel: 'packages/preflight',
      lockfiles: ['pnpm-lock.yaml'],
      scripts: ['test'],
      packageManager: 'pnpm',
    });
    expect(JSON.stringify(profile.workspaceRoot)).not.toContain(root);
  });

  it('a workspace root audited itself has no workspaceRoot', () => {
    const root = tree(PNPM_TREE);
    expect(discover(new FileSet(root, { useGit: false })).workspaceRoot).toBeUndefined();
  });
});
