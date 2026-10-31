import type { ManifestInfo } from '../deps/manifests.js';
import { OWASP } from './helpers.js';
import type { Hit, ProjectContext, ProjectRule } from './types.js';

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '.' : p.slice(0, i);
}

/** Lockfile kinds that satisfy each manifest kind. */
const LOCK_FOR: Record<string, RegExp> = {
  'package.json': /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/,
  'composer.json': /^composer\.lock$/,
  'pyproject.toml': /^(?:poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|requirements(?:[-_.][\w.-]+)?\.txt)$/,
  Pipfile: /^Pipfile\.lock$/,
  'Cargo.toml': /^Cargo\.lock$/,
  Gemfile: /^Gemfile\.lock$/,
  'pubspec.yaml': /^pubspec\.lock$/,
  'go.mod': /^go\.sum$/,
};

function isWorkspaceMember(ctx: ProjectContext, m: ManifestInfo): string | undefined {
  // A lockfile in any ancestor directory (workspace root) covers nested packages.
  let dir = dirOf(m.file);
  const b = m.file.split('/').pop()!;
  while (dir !== '.') {
    dir = dirOf(dir);
    const lock = ctx.profile.lockfiles.find((l) => dirOf(l.file) === dir && LOCK_FOR[b]?.test(l.file.split('/').pop()!));
    if (lock) return lock.file;
    if (dir === '.') break;
  }
  return undefined;
}

const missingLockfile: ProjectRule = {
  kind: 'project',
  id: 'sc/missing-lockfile',
  title: 'Dependencies are not locked',
  category: 'supply-chain',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-1357', 'CWE-829'],
  owasp: [OWASP.A03],
  description: 'A manifest declares dependencies but no lockfile is committed for it, so every install may resolve different (possibly compromised) versions.',
  impact: 'Builds are not reproducible; a malicious or broken release of any transitive dependency reaches production without review.',
  recommendation: 'Generate and commit the lockfile (`npm install`, `composer update --lock`, `poetry lock`/`uv lock`, `flutter pub get`) and install with the frozen mode in CI (`npm ci`, `composer install`, `--frozen-lockfile`).',
  verification: 'The lockfile is tracked by git and CI installs with the frozen/ci command.',
  check(ctx) {
    const out: Hit[] = [];
    for (const m of ctx.profile.manifests) {
      const b = m.file.split('/').pop()!;
      const lockRe = LOCK_FOR[b];
      if (!lockRe || m.error) continue;
      const runtimeDeps = m.deps.filter((d) => !d.dev && d.source !== 'workspace' && d.spec !== 'sdk');
      if (!runtimeDeps.length) continue;
      const dir = dirOf(m.file);
      const hasLock = ctx.profile.lockfiles.some((l) => dirOf(l.file) === dir && lockRe.test(l.file.split('/').pop()!)) || ctx.files.files.some((f) => dirOf(f.path) === dir && lockRe.test(f.path.split('/').pop()!) && f.path !== m.file);
      if (hasLock || isWorkspaceMember(ctx, m)) continue;
      // Libraries published to a registry conventionally do not commit lockfiles for consumers.
      if (b === 'package.json' && m.private !== true && m.version && (m.extra.main || m.extra.bin) && !ctx.profile.technologies.some((t) => t.unit === dir && ['fullstack', 'backend', 'frontend'].includes(t.kind))) continue;
      if (b === 'pyproject.toml' && ctx.files.files.some((f) => dirOf(f.path) === dir && /requirements.*\.txt$/.test(f.path))) continue;
      out.push({ file: m.file, line: 1, message: `\`${m.file}\` declares ${runtimeDeps.length} runtime dependencies but no lockfile is committed.`, anchor: m.file });
    }
    return out;
  },
};

const lockfileDrift: ProjectRule = {
  kind: 'project',
  id: 'sc/lockfile-out-of-sync',
  title: 'Lockfile does not match the manifest',
  category: 'supply-chain',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-1357'],
  owasp: [OWASP.A03],
  description: 'Dependencies declared in the manifest are missing from the lockfile, so the lockfile was not regenerated after the manifest changed.',
  impact: 'Frozen installs (`npm ci`, `composer install`) fail or install different versions than reviewed; deployments break or drift.',
  recommendation: 'Regenerate the lockfile with the project\'s package manager and commit both files together.',
  verification: '`npm ci` / `composer install` / `poetry check --lock` succeed without modifying the lockfile.',
  check(ctx) {
    const out: Hit[] = [];
    for (const m of ctx.profile.manifests) {
      const dir = dirOf(m.file);
      const b = m.file.split('/').pop()!;
      if (b === 'package.json') {
        const lock = ctx.profile.lockfiles.find((l) => dirOf(l.file) === dir && /package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml/.test(l.file));
        if (!lock?.rootDeps || lock.error) continue;
        const missing = m.deps.filter((d) => d.source !== 'workspace' && !lock.rootDeps!.has(d.name) && !m.deps.some((x) => x.name === d.name && x !== d && lock.rootDeps!.has(x.name)));
        const declared = m.deps.filter((d) => d.source !== 'workspace');
        // Peer-only dependencies are not recorded at the root.
        const realMissing = missing.filter((d) => !(d.dev === false && /peer/.test(d.spec)));
        if (realMissing.length && realMissing.length < declared.length)
          out.push({ file: lock.file, message: `${realMissing.length} dependencies in \`${m.file}\` are missing from \`${lock.file}\`: ${realMissing.slice(0, 8).map((d) => d.name).join(', ')}${realMissing.length > 8 ? ', …' : ''}.`, anchor: `${lock.file}:${realMissing.map((d) => d.name).sort().join(',')}` });
      } else if (b === 'composer.json') {
        const lock = ctx.profile.lockfiles.find((l) => l.file === (dir === '.' ? 'composer.lock' : `${dir}/composer.lock`));
        if (!lock || lock.error) continue;
        const names = new Set(lock.packages.map((p) => p.name.toLowerCase()));
        const missing = m.deps.filter((d) => !names.has(d.name.toLowerCase()));
        if (missing.length) out.push({ file: lock.file, message: `${missing.length} packages required in \`${m.file}\` are missing from \`${lock.file}\`: ${missing.slice(0, 8).map((d) => d.name).join(', ')}.`, anchor: `${lock.file}:${missing.map((d) => d.name).sort().join(',')}` });
      } else if (b === 'pubspec.yaml') {
        const lock = ctx.profile.lockfiles.find((l) => l.file === (dir === '.' ? 'pubspec.lock' : `${dir}/pubspec.lock`));
        if (!lock || lock.error) continue;
        const names = new Set(lock.packages.map((p) => p.name));
        const missing = m.deps.filter((d) => d.spec !== 'sdk' && d.source !== 'path' && !names.has(d.name));
        if (missing.length) out.push({ file: lock.file, message: `${missing.length} packages in \`${m.file}\` are missing from \`${lock.file}\`: ${missing.slice(0, 8).map((d) => d.name).join(', ')}.`, anchor: `${lock.file}:${missing.map((d) => d.name).sort().join(',')}` });
      }
    }
    return out;
  },
};

const multipleLockfiles: ProjectRule = {
  kind: 'project',
  id: 'sc/multiple-lockfiles',
  title: 'Multiple JavaScript lockfiles',
  category: 'supply-chain',
  severity: 'low',
  confidence: 'high',
  cwe: ['CWE-1357'],
  description: 'More than one JavaScript package manager lockfile exists in the same directory.',
  impact: 'Developers and CI may install different dependency trees depending on which tool they use.',
  recommendation: 'Pick one package manager (declare it in `packageManager`), delete the other lockfiles and enforce it in CI.',
  verification: 'Only one lockfile remains per package directory.',
  check(ctx) {
    const byDir = new Map<string, string[]>();
    for (const f of ctx.files.byKind('lockfile'))
      if (/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(f.path)) byDir.set(dirOf(f.path), [...(byDir.get(dirOf(f.path)) ?? []), f.path]);
    return [...byDir.values()].filter((l) => l.length > 1).map((l) => ({ file: l[0], message: `Conflicting lockfiles: ${l.join(', ')}.`, anchor: l.join(',') }));
  },
};

const nonRegistry: ProjectRule = {
  kind: 'project',
  id: 'sc/non-registry-dependency',
  title: 'Dependency installed from git, URL or insecure source',
  category: 'supply-chain',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-829', 'CWE-494'],
  owasp: [OWASP.A03, OWASP.A08],
  description: 'A dependency is fetched from a git repository, a tarball URL or over plain HTTP instead of a package registry.',
  impact: 'Git branches and URLs are mutable and bypass registry protections (provenance, malware scanning, immutability); HTTP downloads can be tampered with in transit.',
  recommendation: 'Publish the package to a (private) registry, or pin git dependencies to an immutable commit SHA; never use `http://` sources.',
  verification: 'Lockfile entries resolve from the registry or from a full commit SHA.',
  check(ctx) {
    const out: Hit[] = [];
    for (const m of ctx.profile.manifests)
      for (const d of m.deps) {
        if (d.source !== 'git' && d.source !== 'url') continue;
        const pinned = /#[0-9a-f]{40}$|@[0-9a-f]{40}$|commit=[0-9a-f]{40}|rev=["']?[0-9a-f]{40}/.test(d.spec);
        const insecure = /^http:\/\//.test(d.spec);
        if (pinned && !insecure) continue;
        const line = (ctx.files.read(m.file) ?? '').split('\n').findIndex((l) => l.includes(d.name)) + 1 || 1;
        out.push({ file: m.file, line, message: `\`${d.name}\` comes from ${insecure ? 'an insecure HTTP URL' : d.source === 'git' ? 'a git ref that is not a commit SHA' : 'a tarball URL'} (${d.spec.replace(/\/\/[^@/]+@/, '//***@').slice(0, 80)}).`, severity: insecure ? 'high' : 'medium', anchor: `${m.file}:${d.name}` });
      }
    for (const l of ctx.profile.lockfiles)
      for (const p of l.packages)
        if (p.nonRegistry && /^http:\/\//.test(p.nonRegistry))
          out.push({ file: l.file, message: `\`${p.name}@${p.version}\` resolves over plain HTTP.`, severity: 'high', anchor: `${l.file}:${p.name}` });
    return out;
  },
};

const installScripts: ProjectRule = {
  kind: 'project',
  id: 'sc/dependency-install-scripts',
  title: 'Dependencies run install scripts',
  category: 'supply-chain',
  severity: 'low',
  confidence: 'high',
  cwe: ['CWE-829'],
  owasp: [OWASP.A03],
  description: 'Packages in the lockfile declare install-time lifecycle scripts, which run arbitrary code on every developer machine and CI runner during `npm install`.',
  impact: 'A compromised dependency executes code at install time, the most common npm malware vector.',
  recommendation: 'Review the listed packages. Install with `--ignore-scripts` (or `ignore-scripts=true` in `.npmrc`) and allowlist the scripts you need (pnpm `onlyBuiltDependencies`, npm `@lavamoat/allow-scripts`).',
  verification: 'CI installs with scripts disabled except for allowlisted packages.',
  check(ctx) {
    const out: Hit[] = [];
    const npmrc = ctx.files.readAny('.npmrc') ?? '';
    if (/ignore-scripts\s*=\s*true/.test(npmrc)) return out;
    for (const l of ctx.profile.lockfiles) {
      const pkgs = [...new Set(l.packages.filter((p) => p.hasInstallScript).map((p) => p.name))];
      if (!pkgs.length) continue;
      out.push({ file: l.file, message: `${pkgs.length} packages run install scripts: ${pkgs.slice(0, 12).join(', ')}${pkgs.length > 12 ? ', …' : ''}.`, anchor: `${l.file}:${pkgs.sort().join(',')}`, facts: { count: pkgs.length } });
    }
    return out;
  },
};

const unpinned: ProjectRule = {
  kind: 'project',
  id: 'sc/unpinned-dependency',
  title: 'Dependency without a version constraint',
  category: 'supply-chain',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-1357'],
  owasp: [OWASP.A03],
  description: 'A dependency accepts any version (`*`, `latest`, empty constraint in requirements.txt without a lockfile, `minimum-stability: dev`).',
  impact: 'A new major version or a malicious release is installed automatically and can break or compromise the application.',
  recommendation: 'Constrain versions (`^1.4.0`, `~=1.4`, `==1.4.2`) and use a lockfile for applications.',
  verification: 'All dependencies specify a version range and the lockfile is committed.',
  check(ctx) {
    const out: Hit[] = [];
    for (const m of ctx.profile.manifests) {
      if (m.ecosystem === 'npm' || m.ecosystem === 'Packagist') {
        const any = m.deps.filter((d) => /^(?:\*|latest|x|)$/.test(d.spec.trim()) && d.source === 'registry');
        if (any.length) out.push({ file: m.file, message: `Unconstrained versions: ${any.map((d) => `${d.name}@"${d.spec}"`).join(', ')}.`, anchor: `${m.file}:${any.map((d) => d.name).join(',')}` });
      }
      if (m.ecosystem === 'Packagist' && m.extra['minimum-stability'] === 'dev' && m.extra['prefer-stable'] !== true)
        out.push({ file: m.file, message: '`minimum-stability: dev` without `prefer-stable: true` installs development versions.', severity: 'low', anchor: `${m.file}:minimum-stability` });
      if (m.ecosystem === 'PyPI' && /requirements/.test(m.file)) {
        const dir = dirOf(m.file);
        const locked = ctx.profile.lockfiles.some((l) => dirOf(l.file) === dir && l.ecosystem === 'PyPI' && l.file !== m.file);
        const bare = m.deps.filter((d) => !d.spec && d.source === 'registry');
        if (bare.length && !locked && !m.deps.every((d) => !d.spec))
          out.push({ file: m.file, message: `${bare.length} requirements have no version: ${bare.slice(0, 10).map((d) => d.name).join(', ')}.`, severity: 'low', anchor: `${m.file}:${bare.map((d) => d.name).join(',')}` });
        else if (bare.length && !locked && m.deps.every((d) => !d.spec) && m.deps.length > 2)
          out.push({ file: m.file, message: `No requirement in \`${m.file}\` has a version constraint and no lockfile exists.`, anchor: `${m.file}:all` });
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// End-of-life runtimes and frameworks. Dates from the projects' official release schedules (as tracked by
// endoflife.date), current as of 2026-10-31. Update this table with each Relivaro release.

export const EOL_AS_OF = '2026-10-31';

interface EolEntry {
  product: string;
  /** Major (or major.minor) versions that no longer receive security fixes, with their end date. */
  eol: { version: string; date: string }[];
}

const EOL: Record<string, EolEntry> = {
  node: {
    product: 'Node.js',
    eol: [
      { version: '14', date: '2023-04-30' },
      { version: '16', date: '2023-09-11' },
      { version: '17', date: '2022-06-01' },
      { version: '18', date: '2025-04-30' },
      { version: '19', date: '2023-06-01' },
      { version: '20', date: '2026-04-30' },
      { version: '21', date: '2024-06-01' },
      { version: '23', date: '2025-06-01' },
    ],
  },
  php: {
    product: 'PHP',
    eol: [
      { version: '7.4', date: '2022-11-28' },
      { version: '8.0', date: '2023-11-26' },
      { version: '8.1', date: '2025-12-31' },
    ],
  },
  python: {
    product: 'Python',
    eol: [
      { version: '3.7', date: '2023-06-27' },
      { version: '3.8', date: '2024-10-07' },
      { version: '3.9', date: '2025-10-31' },
    ],
  },
  ruby: {
    product: 'Ruby',
    eol: [
      { version: '2.7', date: '2023-03-31' },
      { version: '3.0', date: '2024-04-23' },
      { version: '3.1', date: '2025-03-31' },
    ],
  },
  laravel: {
    product: 'Laravel',
    eol: [
      { version: '8', date: '2023-01-24' },
      { version: '9', date: '2024-02-06' },
      { version: '10', date: '2025-02-04' },
      { version: '11', date: '2026-03-12' },
    ],
  },
  django: {
    product: 'Django',
    eol: [
      { version: '3.2', date: '2024-04-01' },
      { version: '4.0', date: '2023-04-01' },
      { version: '4.1', date: '2023-12-01' },
      { version: '4.2', date: '2026-04-30' },
      { version: '5.0', date: '2025-04-30' },
      { version: '5.1', date: '2025-12-31' },
    ],
  },
};

function lowestMajor(spec: string): string | undefined {
  // `>=18`, `^20.10`, `~3.11`, `8.2.*`, `22-alpine`, `3.12-slim`, `php:8.1-fpm`
  const m = /(\d+)(?:\.(\d+))?/.exec(spec);
  if (!m) return undefined;
  return m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1];
}

function eolMatch(key: string, version: string | undefined): { version: string; date: string } | undefined {
  if (!version) return undefined;
  const entry = EOL[key];
  if (!entry) return undefined;
  const [maj, min] = version.split('.');
  return entry.eol.find((e) => (e.version.includes('.') ? e.version === `${maj}.${min ?? '0'}` : e.version === maj));
}

const runtimeEol: ProjectRule = {
  kind: 'project',
  id: 'sc/end-of-life-runtime',
  title: 'End-of-life runtime or framework',
  category: 'supply-chain',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-1104'],
  owasp: [OWASP.A03],
  description: `The project targets a runtime or framework version that no longer receives security fixes (schedule as of ${EOL_AS_OF}).`,
  impact: 'Newly discovered vulnerabilities in the runtime or framework will not be patched.',
  recommendation: 'Upgrade to a supported release line and run the test suite; update CI images, Docker base images and engine constraints together.',
  verification: 'Engine constraints, version files, Docker images and CI matrices reference supported versions only.',
  references: ['https://endoflife.date'],
  check(ctx) {
    const out: Hit[] = [];
    const seen = new Set<string>();
    const report = (key: string, version: string | undefined, file: string, source: string, needle = source) => {
      const hit = eolMatch(key, version);
      if (!hit) return;
      const id = `${key}:${hit.version}:${file}`;
      if (seen.has(id)) return;
      seen.add(id);
      const line = (ctx.files.read(file) ?? ctx.files.readAny(file) ?? '').split('\n').findIndex((l) => l.includes(needle)) + 1 || 1;
      // `>=20` still allows supported versions: it only advertises support for an EOL line.
      const openRange = /^\s*>=?/.test(source) || /\|\|/.test(source);
      out.push({
        file,
        line,
        message: openRange
          ? `Minimum supported ${EOL[key]!.product} version ${hit.version} reached end of life on ${hit.date} (${source.trim().slice(0, 60)}).`
          : `${EOL[key]!.product} ${hit.version} reached end of life on ${hit.date} (${source.trim().slice(0, 60)}).`,
        severity: openRange ? 'low' : 'medium',
        anchor: id,
        facts: { product: EOL[key]!.product, version: hit.version, eolDate: hit.date },
      });
    };
    for (const m of ctx.profile.manifests) {
      if (m.runtime.node) report('node', lowestMajor(m.runtime.node), m.file, m.runtime.node);
      if (m.runtime.php) report('php', lowestMajor(m.runtime.php), m.file, m.runtime.php);
      if (m.runtime.python) report('python', lowestMajor(m.runtime.python), m.file, m.runtime.python);
      if (m.runtime.ruby) report('ruby', lowestMajor(m.runtime.ruby), m.file, m.runtime.ruby);
      const laravel = m.deps.find((d) => d.name === 'laravel/framework');
      if (laravel) report('laravel', lowestMajor(laravel.spec)?.split('.')[0], m.file, laravel.spec);
      const django = m.deps.find((d) => d.name === 'django');
      if (django?.spec) report('django', lowestMajor(django.spec), m.file, django.spec);
    }
    for (const l of ctx.profile.lockfiles) {
      const lv = l.packages.find((p) => p.name === 'laravel/framework');
      if (lv) report('laravel', lv.version.split('.')[0], l.file, `laravel/framework ${lv.version}`, 'laravel/framework');
      const dj = l.packages.find((p) => p.name === 'django');
      if (dj) report('django', lowestMajor(dj.version), l.file, `django ${dj.version}`, dj.version);
    }
    for (const f of ctx.files.files) {
      const b = f.path.split('/').pop()!;
      if (b === '.nvmrc' || b === '.node-version') report('node', lowestMajor(ctx.files.read(f.path) ?? ''), f.path, (ctx.files.read(f.path) ?? '').trim());
      if (b === '.python-version') report('python', lowestMajor(ctx.files.read(f.path) ?? ''), f.path, (ctx.files.read(f.path) ?? '').trim());
      if (b === '.ruby-version') report('ruby', lowestMajor(ctx.files.read(f.path) ?? ''), f.path, (ctx.files.read(f.path) ?? '').trim());
      if (f.kind === 'dockerfile')
        for (const m of (ctx.files.read(f.path) ?? '').matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(?:[\w.-]+\/)?(node|php|python|ruby):(\d+(?:\.\d+)?)/gim))
          report(m[1]!.toLowerCase(), m[2], f.path, m[0]);
      if (f.kind === 'workflow')
        for (const m of (ctx.files.read(f.path) ?? '').matchAll(/(node|php|python|ruby)-version:\s*['"]?(\d+(?:\.\d+)?)/g)) report(m[1]!, m[2], f.path, m[0]);
    }
    return out;
  },
};

export const supplyChainRules: ProjectRule[] = [missingLockfile, lockfileDrift, multipleLockfiles, nonRegistry, installScripts, unpinned, runtimeEol];

export type { Hit };
