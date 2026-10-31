import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

/** Declared dependencies of one manifest. Parsers are tolerant: malformed files yield `error`, never throw. */
export type Ecosystem =
  | 'npm'
  | 'Packagist'
  | 'PyPI'
  | 'Go'
  | 'crates.io'
  | 'RubyGems'
  | 'Pub'
  | 'Maven'
  | 'SwiftPM'
  | 'CocoaPods';

export interface DeclaredDep {
  name: string;
  spec: string;
  dev: boolean;
  /** Where the dependency comes from when not a registry (git, url, path, workspace). */
  source?: 'git' | 'url' | 'path' | 'workspace' | 'registry';
}

export interface ManifestInfo {
  file: string;
  ecosystem: Ecosystem;
  name?: string;
  version?: string;
  deps: DeclaredDep[];
  scripts: Record<string, string>;
  runtime: Record<string, string>;
  workspaces: string[];
  packageManager?: string;
  private?: boolean;
  extra: Record<string, unknown>;
  error?: string;
}

const empty = (file: string, ecosystem: Ecosystem): ManifestInfo => ({
  file,
  ecosystem,
  deps: [],
  scripts: {},
  runtime: {},
  workspaces: [],
  extra: {},
});

function npmSource(spec: string): DeclaredDep['source'] {
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:|[\w-]+\/[\w.-]+(?:#.*)?$)/.test(spec)) return 'git';
  if (/^https?:/.test(spec)) return 'url';
  if (/^(?:file:|link:|\.\.?\/)/.test(spec)) return 'path';
  if (/^workspace:/.test(spec)) return 'workspace';
  return 'registry';
}

export function parsePackageJson(file: string, text: string): ManifestInfo {
  const m = empty(file, 'npm');
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    m.name = typeof j.name === 'string' ? j.name : undefined;
    m.version = typeof j.version === 'string' ? j.version : undefined;
    m.private = j.private === true;
    for (const [field, dev] of [
      ['dependencies', false],
      ['devDependencies', true],
      ['optionalDependencies', false],
      ['peerDependencies', false],
    ] as const) {
      const d = j[field];
      if (d && typeof d === 'object')
        for (const [name, spec] of Object.entries(d as Record<string, unknown>))
          if (
            typeof spec === 'string' &&
            !(field === 'peerDependencies' && m.deps.some((x) => x.name === name))
          )
            m.deps.push({ name, spec, dev, source: npmSource(spec) });
    }
    if (j.scripts && typeof j.scripts === 'object')
      for (const [k, v] of Object.entries(j.scripts as Record<string, unknown>))
        if (typeof v === 'string') m.scripts[k] = v;
    if (j.engines && typeof j.engines === 'object')
      for (const [k, v] of Object.entries(j.engines as Record<string, unknown>))
        if (typeof v === 'string') m.runtime[k] = v;
    const ws = j.workspaces;
    if (Array.isArray(ws)) m.workspaces = ws.filter((x): x is string => typeof x === 'string');
    else if (ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages))
      m.workspaces = (ws as { packages: unknown[] }).packages.filter(
        (x): x is string => typeof x === 'string',
      );
    if (typeof j.packageManager === 'string') m.packageManager = j.packageManager;
    m.extra.type = j.type;
    m.extra.bin = j.bin;
    m.extra.main = j.main;
  } catch (e) {
    m.error = (e as Error).message;
  }
  return m;
}

export function parseComposerJson(file: string, text: string): ManifestInfo {
  const m = empty(file, 'Packagist');
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    m.name = typeof j.name === 'string' ? j.name : undefined;
    for (const [field, dev] of [
      ['require', false],
      ['require-dev', true],
    ] as const) {
      const d = j[field];
      if (d && typeof d === 'object')
        for (const [name, spec] of Object.entries(d as Record<string, unknown>)) {
          if (typeof spec !== 'string') continue;
          if (name === 'php') m.runtime.php = spec;
          else if (!name.startsWith('ext-') && !name.startsWith('lib-'))
            m.deps.push({ name, spec, dev, source: 'registry' });
        }
    }
    if (j.scripts && typeof j.scripts === 'object')
      for (const [k, v] of Object.entries(j.scripts as Record<string, unknown>))
        m.scripts[k] = Array.isArray(v) ? v.join(' && ') : String(v);
    m.extra['minimum-stability'] = j['minimum-stability'];
    m.extra['prefer-stable'] = j['prefer-stable'];
    const repos = Array.isArray(j.repositories) ? j.repositories : [];
    m.extra.vcsRepositories = repos.filter(
      (r) => r && typeof r === 'object' && /vcs|git|path/.test(String((r as { type?: unknown }).type)),
    ).length;
  } catch (e) {
    m.error = (e as Error).message;
  }
  return m;
}

/** PEP 508 requirement → name + spec. */
function pep508(line: string): { name: string; spec: string; source: DeclaredDep['source'] } | null {
  const s = line.replace(/\s+#.*$/, '').trim();
  if (!s || s.startsWith('#') || s.startsWith('-')) return null;
  if (/^(?:git\+|https?:\/\/)/.test(s))
    return { name: s.replace(/.*#egg=/, ''), spec: s, source: /^git/.test(s) ? 'git' : 'url' };
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/.exec(s);
  if (!m) return null;
  const rest = m[3] ?? '';
  const source = /@\s*(?:git\+|https?:)/.test(rest)
    ? rest.includes('git+')
      ? 'git'
      : 'url'
    : rest.includes('@ file:')
      ? 'path'
      : 'registry';
  return { name: m[1]!.toLowerCase().replace(/_/g, '-'), spec: rest.split(';')[0]!.trim(), source };
}

export function parseRequirements(file: string, text: string): ManifestInfo {
  const m = empty(file, 'PyPI');
  const dev = /dev|test|lint/i.test(file);
  for (const raw of text.split(/\r?\n/)) {
    const r = pep508(raw);
    if (r) m.deps.push({ name: r.name, spec: r.spec, dev, source: r.source });
  }
  return m;
}

export function parsePyproject(file: string, text: string): ManifestInfo {
  const m = empty(file, 'PyPI');
  try {
    const t = parseToml(text) as Record<string, any>;
    const p = t.project ?? {};
    m.name = p.name;
    m.version = p.version;
    if (typeof p['requires-python'] === 'string') m.runtime.python = p['requires-python'];
    for (const d of (p.dependencies ?? []) as string[]) {
      const r = pep508(d);
      if (r) m.deps.push({ name: r.name, spec: r.spec, dev: false, source: r.source });
    }
    for (const [group, list] of Object.entries(
      (p['optional-dependencies'] ?? {}) as Record<string, string[]>,
    ))
      for (const d of list) {
        const r = pep508(d);
        if (r)
          m.deps.push({ name: r.name, spec: r.spec, dev: /dev|test|lint/i.test(group), source: r.source });
      }
    for (const [, list] of Object.entries((t['dependency-groups'] ?? {}) as Record<string, unknown[]>))
      for (const d of list) {
        if (typeof d !== 'string') continue;
        const r = pep508(d);
        if (r) m.deps.push({ name: r.name, spec: r.spec, dev: true, source: r.source });
      }
    const poetry = t.tool?.poetry;
    if (poetry) {
      m.name ??= poetry.name;
      const addPoetry = (deps: Record<string, unknown> | undefined, dev: boolean) => {
        for (const [name, spec] of Object.entries(deps ?? {})) {
          if (name === 'python') {
            m.runtime.python = String(spec);
            continue;
          }
          const s = typeof spec === 'string' ? spec : JSON.stringify(spec);
          const source =
            typeof spec === 'object' && spec && 'git' in spec
              ? 'git'
              : typeof spec === 'object' && spec && 'path' in spec
                ? 'path'
                : 'registry';
          m.deps.push({ name: name.toLowerCase(), spec: s, dev, source });
        }
      };
      addPoetry(poetry.dependencies, false);
      addPoetry(poetry['dev-dependencies'], true);
      for (const g of Object.values(
        (poetry.group ?? {}) as Record<string, { dependencies?: Record<string, unknown> }>,
      ))
        addPoetry(g.dependencies, true);
    }
    if (t.project?.scripts)
      for (const [k, v] of Object.entries(t.project.scripts as Record<string, string>)) m.scripts[k] = v;
    m.extra.tools = Object.keys(t.tool ?? {});
  } catch (e) {
    m.error = (e as Error).message;
  }
  return m;
}

export function parseGoMod(file: string, text: string): ManifestInfo {
  const m = empty(file, 'Go');
  m.name = /^module\s+(\S+)/m.exec(text)?.[1];
  const go = /^go\s+(\S+)/m.exec(text)?.[1];
  if (go) m.runtime.go = go;
  const add = (l: string) => {
    const mm = /^\s*([^\s/][^\s]*)\s+(v[^\s]+)(\s*\/\/\s*indirect)?/.exec(l);
    if (mm) m.deps.push({ name: mm[1]!, spec: mm[2]!, dev: false, source: 'registry' });
  };
  for (const block of text.matchAll(/^require\s*\(([\s\S]*?)^\)/gm))
    for (const l of block[1]!.split('\n')) add(l);
  for (const single of text.matchAll(/^require\s+([^\s(]\S*\s+v\S+)/gm)) add(single[1]!);
  return m;
}

export function parseCargoToml(file: string, text: string): ManifestInfo {
  const m = empty(file, 'crates.io');
  try {
    const t = parseToml(text) as Record<string, any>;
    m.name = t.package?.name;
    m.version = typeof t.package?.version === 'string' ? t.package.version : undefined;
    if (t.package?.['rust-version']) m.runtime.rust = String(t.package['rust-version']);
    for (const [field, dev] of [
      ['dependencies', false],
      ['dev-dependencies', true],
      ['build-dependencies', true],
    ] as const)
      for (const [name, spec] of Object.entries((t[field] ?? {}) as Record<string, unknown>)) {
        const s =
          typeof spec === 'string'
            ? spec
            : String((spec as { version?: string })?.version ?? JSON.stringify(spec));
        const source =
          typeof spec === 'object' && spec && 'git' in spec
            ? 'git'
            : typeof spec === 'object' && spec && 'path' in spec
              ? 'path'
              : 'registry';
        m.deps.push({ name, spec: s, dev, source });
      }
    m.workspaces = (t.workspace?.members ?? []) as string[];
  } catch (e) {
    m.error = (e as Error).message;
  }
  return m;
}

export function parseGemfile(file: string, text: string): ManifestInfo {
  const m = empty(file, 'RubyGems');
  let devDepth = 0;
  for (const l of text.split(/\r?\n/)) {
    if (/^\s*group\s+.*:(?:development|test)/.test(l)) devDepth++;
    else if (/^\s*end\b/.test(l) && devDepth) devDepth--;
    const g = /^\s*gem\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?(.*)$/.exec(l);
    if (g) {
      const rest = g[3] ?? '';
      m.deps.push({
        name: g[1]!,
        spec: g[2] ?? '',
        dev: devDepth > 0,
        source: /git(?:hub)?:/.test(rest) ? 'git' : /path:/.test(rest) ? 'path' : 'registry',
      });
    }
    const rb = /^\s*ruby\s+['"]([^'"]+)['"]/.exec(l);
    if (rb) m.runtime.ruby = rb[1]!;
  }
  return m;
}

export function parsePubspec(file: string, text: string): ManifestInfo {
  const m = empty(file, 'Pub');
  try {
    const y = (parseYaml(text) ?? {}) as Record<string, any>;
    m.name = y.name;
    m.version = typeof y.version === 'string' ? y.version : undefined;
    if (y.environment?.sdk) m.runtime.dart = String(y.environment.sdk);
    if (y.environment?.flutter) m.runtime.flutter = String(y.environment.flutter);
    for (const [field, dev] of [
      ['dependencies', false],
      ['dev_dependencies', true],
    ] as const)
      for (const [name, spec] of Object.entries((y[field] ?? {}) as Record<string, unknown>)) {
        const isSdk = typeof spec === 'object' && spec !== null && 'sdk' in spec;
        const source =
          typeof spec === 'object' && spec && 'git' in spec
            ? 'git'
            : typeof spec === 'object' && spec && 'path' in spec
              ? 'path'
              : 'registry';
        m.deps.push({
          name,
          spec: isSdk ? 'sdk' : typeof spec === 'string' ? spec : spec == null ? 'any' : JSON.stringify(spec),
          dev,
          source,
        });
      }
  } catch (e) {
    m.error = (e as Error).message;
  }
  return m;
}

export function parseGradle(file: string, text: string): ManifestInfo {
  const m = empty(file, 'Maven');
  for (const mm of text.matchAll(/id\s*\(?\s*["']([\w.-]+)["']\s*\)?(?:\s+version\s+["']([^"']+)["'])?/g))
    m.deps.push({ name: mm[1]!, spec: mm[2] ?? '', dev: false, source: 'registry' });
  for (const mm of text.matchAll(/apply\s+plugin:\s*["']([\w.-]+)["']/g))
    m.deps.push({ name: mm[1]!, spec: '', dev: false });
  for (const mm of text.matchAll(
    /(implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|kapt|ksp)\s*\(?\s*["']([\w.-]+):([\w.-]+):?([^"']*)["']/g,
  ))
    m.deps.push({
      name: `${mm[2]}:${mm[3]}`,
      spec: mm[4] ?? '',
      dev: /test/i.test(mm[1]!),
      source: 'registry',
    });
  return m;
}

export function parsePomXml(file: string, text: string): ManifestInfo {
  const m = empty(file, 'Maven');
  m.name = /<artifactId>([^<]+)<\/artifactId>/.exec(text)?.[1];
  const parent =
    /<parent>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>[\s\S]*?<\/parent>/.exec(
      text,
    );
  if (parent) m.deps.push({ name: `${parent[1]}:${parent[2]}`, spec: '', dev: false, source: 'registry' });
  for (const d of text.matchAll(
    /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?([\s\S]*?)<\/dependency>/g,
  ))
    m.deps.push({
      name: `${d[1]}:${d[2]}`,
      spec: d[3] ?? '',
      dev: /<scope>test<\/scope>/.test(d[4] ?? ''),
      source: 'registry',
    });
  const java = /<java\.version>([^<]+)</.exec(text)?.[1];
  if (java) m.runtime.java = java;
  return m;
}

export function parseManifest(file: string, text: string): ManifestInfo | null {
  const b = file.split('/').pop()!;
  if (b === 'package.json') return parsePackageJson(file, text);
  if (b === 'composer.json') return parseComposerJson(file, text);
  if (b === 'pyproject.toml') return parsePyproject(file, text);
  if (/^requirements(?:[-_.][\w.-]+)?\.(?:txt|in)$/i.test(b)) return parseRequirements(file, text);
  if (b === 'go.mod') return parseGoMod(file, text);
  if (b === 'Cargo.toml') return parseCargoToml(file, text);
  if (b === 'Gemfile') return parseGemfile(file, text);
  if (b === 'pubspec.yaml') return parsePubspec(file, text);
  if (b === 'build.gradle' || b === 'build.gradle.kts') return parseGradle(file, text);
  if (b === 'pom.xml') return parsePomXml(file, text);
  if (b === 'Podfile') {
    const m = empty(file, 'CocoaPods');
    for (const mm of text.matchAll(/^\s*pod\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/gm))
      m.deps.push({ name: mm[1]!, spec: mm[2] ?? '', dev: false });
    const ios = /platform\s+:ios,\s*['"]([^'"]+)['"]/.exec(text)?.[1];
    if (ios) m.runtime.ios = ios;
    return m;
  }
  if (b === 'Package.swift') {
    const m = empty(file, 'SwiftPM');
    for (const mm of text.matchAll(/\.package\(\s*url:\s*"([^"]+)"/g))
      m.deps.push({ name: mm[1]!, spec: '', dev: false, source: 'git' });
    return m;
  }
  return null;
}
