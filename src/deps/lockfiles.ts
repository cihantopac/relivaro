import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';
import type { Ecosystem } from './manifests.js';

/** A resolved (installed) package version from a lockfile. */
export interface ResolvedPackage {
  name: string;
  version: string;
  ecosystem: Ecosystem;
  dev?: boolean;
  /** The lockfile records an install script for this package (npm). */
  hasInstallScript?: boolean;
  /** Resolved from somewhere other than the public registry. */
  nonRegistry?: string;
}

export interface LockfileInfo {
  file: string;
  ecosystem: Ecosystem;
  packages: ResolvedPackage[];
  /** Direct dependency names recorded in the lockfile root (when the format records them). */
  rootDeps?: Set<string>;
  error?: string;
}

function npmLock(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'npm', packages: [] };
  try {
    const j = JSON.parse(text) as { packages?: Record<string, any>; dependencies?: Record<string, any> };
    if (j.packages) {
      const root = j.packages[''] ?? {};
      info.rootDeps = new Set([
        ...Object.keys(root.dependencies ?? {}),
        ...Object.keys(root.devDependencies ?? {}),
        ...Object.keys(root.optionalDependencies ?? {}),
      ]);
      for (const [path, p] of Object.entries(j.packages)) {
        if (!path || p.link) continue;
        const name = p.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (!p.version || !name) continue;
        const resolved: string = p.resolved ?? '';
        const nonRegistry =
          resolved && !/^https:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\//.test(resolved)
            ? resolved.replace(/\/\/[^@/]+@/, '//')
            : undefined;
        info.packages.push({
          name,
          version: p.version,
          ecosystem: 'npm',
          dev: !!p.dev,
          hasInstallScript: !!p.hasInstallScript,
          nonRegistry,
        });
      }
    } else if (j.dependencies) {
      const visit = (deps: Record<string, any>) => {
        for (const [name, p] of Object.entries(deps)) {
          if (p.version) info.packages.push({ name, version: p.version, ecosystem: 'npm', dev: !!p.dev });
          if (p.dependencies) visit(p.dependencies);
        }
      };
      visit(j.dependencies);
      info.rootDeps = new Set(Object.keys(j.dependencies));
    }
  } catch (e) {
    info.error = (e as Error).message;
  }
  return info;
}

function pnpmLock(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'npm', packages: [] };
  try {
    const y = (parseYaml(text, { maxAliasCount: -1 }) ?? {}) as Record<string, any>;
    const root = new Set<string>();
    const importers = y.importers ?? { '.': y };
    for (const imp of Object.values(importers) as any[])
      for (const f of ['dependencies', 'devDependencies', 'optionalDependencies'])
        for (const n of Object.keys(imp?.[f] ?? {})) root.add(n);
    info.rootDeps = root;
    for (const [key, p] of Object.entries((y.packages ?? {}) as Record<string, any>)) {
      // v5/6: "/name@1.2.3" or "/name/1.2.3"; v9: "name@1.2.3" (peer suffix in parentheses).
      const k = key.replace(/^\//, '').replace(/\(.*$/, '');
      const at = k.lastIndexOf('@');
      let name: string;
      let version: string;
      if (at > 0) {
        name = k.slice(0, at);
        version = k.slice(at + 1);
      } else {
        const slash = k.lastIndexOf('/');
        name = k.slice(0, slash);
        version = k.slice(slash + 1);
      }
      if (!name || !version || !/^\d/.test(version)) continue;
      info.packages.push({
        name,
        version,
        ecosystem: 'npm',
        dev: p?.dev === true,
        hasInstallScript: p?.requiresBuild === true,
      });
    }
  } catch (e) {
    info.error = (e as Error).message;
  }
  return info;
}

function yarnLock(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'npm', packages: [] };
  // Works for yarn v1 and berry: entries start at column 0 with the descriptor list, then an indented version.
  const blocks = text.split(/\n(?=\S)/);
  for (const b of blocks) {
    const header = b.split('\n', 1)[0]!;
    if (header.startsWith('#') || header.startsWith('__metadata')) continue;
    const first = header.replace(/:$/, '').split(',')[0]!.trim().replace(/^"|"$/g, '');
    const at = first.lastIndexOf('@');
    if (at <= 0) continue;
    const name = first.slice(0, at);
    const version = /\n\s+version:?\s+"?([^"\s]+)"?/.exec(b)?.[1];
    if (version) info.packages.push({ name, version, ecosystem: 'npm' });
  }
  return info;
}

function composerLock(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'Packagist', packages: [] };
  try {
    const j = JSON.parse(text) as { packages?: any[]; 'packages-dev'?: any[] };
    for (const [list, dev] of [
      [j.packages ?? [], false],
      [j['packages-dev'] ?? [], true],
    ] as const)
      for (const p of list)
        if (p?.name && p.version)
          info.packages.push({
            name: p.name,
            version: String(p.version).replace(/^v/, ''),
            ecosystem: 'Packagist',
            dev,
          });
  } catch (e) {
    info.error = (e as Error).message;
  }
  return info;
}

function tomlPackages(file: string, text: string, ecosystem: Ecosystem): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem, packages: [] };
  try {
    const t = parseToml(text) as {
      package?: { name?: string; version?: string; category?: string; source?: unknown }[];
    };
    for (const p of t.package ?? [])
      if (p.name && p.version)
        info.packages.push({
          name: ecosystem === 'PyPI' ? p.name.toLowerCase() : p.name,
          version: p.version,
          ecosystem,
          dev: p.category === 'dev',
        });
  } catch (e) {
    info.error = (e as Error).message;
  }
  return info;
}

function pipfileLock(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'PyPI', packages: [] };
  try {
    const j = JSON.parse(text) as Record<string, Record<string, { version?: string }>>;
    for (const [section, dev] of [
      ['default', false],
      ['develop', true],
    ] as const)
      for (const [name, p] of Object.entries(j[section] ?? {}))
        if (p.version)
          info.packages.push({
            name: name.toLowerCase(),
            version: p.version.replace(/^==/, ''),
            ecosystem: 'PyPI',
            dev,
          });
  } catch (e) {
    info.error = (e as Error).message;
  }
  return info;
}

/** Fully pinned requirement lines (`name==1.2.3`) act as a lockfile. */
export function pinnedRequirements(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'PyPI', packages: [] };
  for (const l of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?\s*==\s*([^\s;#]+)/.exec(l);
    if (m)
      info.packages.push({ name: m[1]!.toLowerCase().replace(/_/g, '-'), version: m[2]!, ecosystem: 'PyPI' });
  }
  return info;
}

function goSum(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'Go', packages: [] };
  const seen = new Set<string>();
  for (const l of text.split('\n')) {
    const m = /^(\S+)\s+(v[^\s/]+)(?:\/go\.mod)?\s/.exec(l);
    if (!m) continue;
    const key = `${m[1]}@${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    info.packages.push({ name: m[1]!, version: m[2]!, ecosystem: 'Go' });
  }
  return info;
}

function gemfileLock(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'RubyGems', packages: [] };
  const specs = /\n\s{2}specs:\n([\s\S]*?)(?:\n\S|$)/.exec(text)?.[1] ?? '';
  for (const m of specs.matchAll(/^ {4}([\w.-]+) \(([^)]+)\)$/gm))
    info.packages.push({ name: m[1]!, version: m[2]!, ecosystem: 'RubyGems' });
  return info;
}

function pubspecLock(file: string, text: string): LockfileInfo {
  const info: LockfileInfo = { file, ecosystem: 'Pub', packages: [] };
  try {
    const y = (parseYaml(text) ?? {}) as {
      packages?: Record<string, { version?: string; source?: string; dependency?: string }>;
    };
    for (const [name, p] of Object.entries(y.packages ?? {}))
      if (p.version && p.source !== 'sdk')
        info.packages.push({
          name,
          version: p.version,
          ecosystem: 'Pub',
          dev: p.dependency === 'direct dev',
          nonRegistry: p.source === 'git' || p.source === 'path' ? p.source : undefined,
        });
  } catch (e) {
    info.error = (e as Error).message;
  }
  return info;
}

export function parseLockfile(file: string, text: string): LockfileInfo | null {
  const b = file.split('/').pop()!;
  switch (b) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return npmLock(file, text);
    case 'pnpm-lock.yaml':
      return pnpmLock(file, text);
    case 'yarn.lock':
      return yarnLock(file, text);
    case 'composer.lock':
      return composerLock(file, text);
    case 'poetry.lock':
    case 'uv.lock':
    case 'pdm.lock':
      return tomlPackages(file, text, 'PyPI');
    case 'Cargo.lock':
      return tomlPackages(file, text, 'crates.io');
    case 'Pipfile.lock':
      return pipfileLock(file, text);
    case 'go.sum':
      return goSum(file, text);
    case 'Gemfile.lock':
      return gemfileLock(file, text);
    case 'pubspec.lock':
      return pubspecLock(file, text);
    default:
      return null;
  }
}
