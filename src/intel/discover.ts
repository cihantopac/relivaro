import { parse as parseYaml } from 'yaml';
import { type LockfileInfo, parseLockfile, pinnedRequirements } from '../deps/lockfiles.js';
import { type Ecosystem, type ManifestInfo, parseManifest } from '../deps/manifests.js';
import { type FileSet, isEnvTemplate } from '../fs/files.js';
import {
  CARGO,
  COMPOSE_IMAGES,
  COMPOSER,
  GO,
  lookup,
  MAVEN,
  NPM,
  PUB,
  PYPI,
  RUBYGEMS,
  type Tech,
  type TechKind,
} from './catalog.js';

export interface TechHit extends Tech {
  /** Unit path where it was found (`.` for root). */
  unit: string;
  version?: string;
  evidence: string;
}

export interface Unit {
  path: string;
  name?: string;
  ecosystems: Ecosystem[];
  manifests: string[];
  lockfiles: string[];
  packageManager?: string;
  frameworks: string[];
  kind: 'web-frontend' | 'web-backend' | 'fullstack' | 'mobile' | 'desktop' | 'library' | 'cli' | 'unknown';
  /** Next.js with a literal `output: 'export'`: static files only, no server at runtime. */
  staticExport?: boolean;
  scripts: Record<string, string>;
  runtime: Record<string, string>;
  testFiles: number;
  sourceFiles: number;
}

export interface EnvVarInfo {
  name: string;
  /** Files where the variable is read (max 5). */
  usedIn: string[];
  /** Read without a default/fallback. */
  required: boolean;
  documented: boolean;
}

export interface ProjectProfile {
  root: string;
  name: string;
  gitRepo: boolean;
  monorepo: boolean;
  languages: { name: string; files: number; lines: number }[];
  units: Unit[];
  technologies: TechHit[];
  ci: { system: string; file: string; runsTests: boolean; runsLint: boolean; runsBuild: boolean }[];
  containers: { dockerfiles: string[]; compose: string[]; services: string[] };
  deploy: { kind: string; file: string }[];
  tests: {
    frameworks: string[];
    testFiles: number;
    sourceFiles: number;
    e2e: string[];
    coverageReports: string[];
  };
  api: { routeFiles: string[]; routes: number; specs: string[]; graphql: string[] };
  envVars: EnvVarInfo[];
  envTemplates: string[];
  docs: {
    readme?: string;
    readmeBytes: number;
    license?: string;
    changelog?: string;
    contributing?: string;
    security?: string;
    docsDir: boolean;
  };
  manifests: ManifestInfo[];
  lockfiles: LockfileInfo[];
  migrations: string[];
  stats: { files: number; bytes: number };
}

const LANG_BY_EXT: Record<string, string> = {
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JavaScript',
  ts: 'TypeScript',
  mts: 'TypeScript',
  cts: 'TypeScript',
  tsx: 'TypeScript',
  php: 'PHP',
  py: 'Python',
  go: 'Go',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  swift: 'Swift',
  m: 'Objective-C',
  mm: 'Objective-C',
  dart: 'Dart',
  rs: 'Rust',
  cs: 'C#',
  c: 'C',
  h: 'C/C++ header',
  cpp: 'C++',
  hpp: 'C++',
  scala: 'Scala',
  ex: 'Elixir',
  exs: 'Elixir',
  lua: 'Lua',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  ps1: 'PowerShell',
  sql: 'SQL',
  vue: 'Vue',
  svelte: 'Svelte',
  astro: 'Astro',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
};

const CATALOG_BY_ECO: Partial<Record<Ecosystem, Record<string, Tech>>> = {
  npm: NPM,
  Packagist: COMPOSER,
  PyPI: PYPI,
  Go: GO,
  RubyGems: RUBYGEMS,
  Pub: PUB,
  'crates.io': CARGO,
  Maven: MAVEN,
};

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '.' : path.slice(0, i);
}

function within(unit: string, path: string): boolean {
  return unit === '.' || path === unit || path.startsWith(`${unit}/`);
}

export function discover(files: FileSet): ProjectProfile {
  const langs = new Map<string, { files: number; lines: number }>();
  let bytes = 0;
  for (const f of files.files) {
    bytes += f.size;
    const ext = f.path.split('.').pop()?.toLowerCase() ?? '';
    const lang = f.path.endsWith('.blade.php') ? 'Blade' : LANG_BY_EXT[ext];
    if (!lang) continue;
    const entry = langs.get(lang) ?? { files: 0, lines: 0 };
    entry.files++;
    const text = files.read(f.path);
    if (text) entry.lines += countLines(text);
    langs.set(lang, entry);
  }

  const manifests: ManifestInfo[] = [];
  for (const f of files.byKind('manifest')) {
    const text = files.read(f.path);
    if (text === undefined) continue;
    const m = parseManifest(f.path, text);
    if (m) manifests.push(m);
  }
  const lockfiles: LockfileInfo[] = [];
  for (const f of files.byKind('lockfile')) {
    const text = files.read(f.path);
    if (text === undefined) continue;
    const l = parseLockfile(f.path, text);
    if (l) lockfiles.push(l);
  }
  // requirements.txt with every line pinned also serves as the resolved set for Python.
  for (const m of manifests)
    if (
      m.ecosystem === 'PyPI' &&
      /requirements/.test(m.file) &&
      m.deps.length &&
      m.deps.every((d) => d.spec.startsWith('=='))
    )
      lockfiles.push(pinnedRequirements(m.file, files.read(m.file) ?? ''));

  const xcodeProjects = files.files
    .filter((f) => /\.xcodeproj\/project\.pbxproj$/.test(f.path))
    .map((f) => f.path.replace(/\/[^/]+\.xcodeproj\/project\.pbxproj$/, '') || '.');

  // Units: every directory with a manifest (or an Xcode project).
  const unitPaths = new Set<string>([
    ...manifests.map((m) => dirOf(m.file)),
    ...xcodeProjects.map((p) => (p === '' ? '.' : p)),
  ]);
  if (unitPaths.size === 0) unitPaths.add('.');
  // Android Gradle modules (`app/build.gradle`) belong to the enclosing Flutter/Android project unit.
  for (const p of [...unitPaths]) {
    const parent = dirOf(p);
    if (
      /(?:^|\/)(?:android|ios|macos|linux|windows|web)(?:\/app)?$/.test(p) &&
      unitPaths.has(parent.replace(/\/android$|\/ios$/, '') || '.')
    )
      unitPaths.delete(p);
    if (/(?:^|\/)android\/app$/.test(p) || /(?:^|\/)android$/.test(p)) {
      const flutterRoot = p.replace(/\/android(?:\/app)?$/, '') || '.';
      if (
        unitPaths.has(flutterRoot) &&
        manifests.some(
          (m) => m.file === (flutterRoot === '.' ? 'pubspec.yaml' : `${flutterRoot}/pubspec.yaml`),
        )
      )
        unitPaths.delete(p);
    }
  }

  const technologies: TechHit[] = [];
  const addTech = (hit: TechHit) => {
    if (!technologies.some((t) => t.name === hit.name && t.unit === hit.unit)) technologies.push(hit);
  };

  const units: Unit[] = [...unitPaths]
    .sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)))
    .map((path) => {
      const ms = manifests.filter((m) => dirOf(m.file) === path);
      const unit: Unit = {
        path,
        name: ms.find((m) => m.name)?.name,
        ecosystems: [...new Set(ms.map((m) => m.ecosystem))],
        manifests: ms.map((m) => m.file),
        lockfiles: lockfiles.filter((l) => dirOf(l.file) === path).map((l) => l.file),
        packageManager: undefined,
        frameworks: [],
        kind: 'unknown',
        scripts: Object.assign({}, ...ms.map((m) => m.scripts)),
        runtime: Object.assign({}, ...ms.map((m) => m.runtime)),
        testFiles: 0,
        sourceFiles: 0,
      };
      for (const m of ms) {
        const cat = CATALOG_BY_ECO[m.ecosystem];
        if (!cat) continue;
        for (const d of m.deps) {
          const tech = lookup(cat, d.name);
          if (tech) addTech({ ...tech, unit: path, version: cleanVersion(d.spec), evidence: m.file });
        }
        if (m.packageManager) unit.packageManager = m.packageManager.split('@')[0];
      }
      if (!unit.packageManager && unit.ecosystems.includes('npm')) {
        const lf = unit.lockfiles.map((l) => l.split('/').pop());
        unit.packageManager = lf.includes('pnpm-lock.yaml')
          ? 'pnpm'
          : lf.includes('yarn.lock')
            ? 'yarn'
            : lf.some((l) => l?.startsWith('bun.'))
              ? 'bun'
              : lf.includes('package-lock.json') || lf.includes('npm-shrinkwrap.json')
                ? 'npm'
                : undefined;
      }
      if (xcodeProjects.includes(path) || (path === '.' && xcodeProjects.includes('')))
        addTech({ name: 'iOS (Xcode)', kind: 'mobile', unit: path, evidence: 'xcodeproj' });
      return unit;
    });

  // Workspace packages without their own `packageManager` field or lockfile use the nearest ancestor's manager.
  // Units are sorted so every ancestor comes before its descendants.
  for (const u of units) {
    if (u.packageManager || !u.ecosystems.includes('npm')) continue;
    const parent = units
      .filter((a) => a !== u && a.packageManager && within(a.path, u.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    u.packageManager = parent?.packageManager ?? 'npm';
  }

  // Unit attribution for files: deepest unit containing the file.
  const unitFor = (p: string): Unit => {
    let best = units[0]!;
    for (const u of units)
      if (within(u.path, p) && u.path.length >= best.path.length && (u.path !== '.' || best.path === '.'))
        best = u;
    return best;
  };
  for (const f of files.files) {
    if (
      f.kind !== 'source' ||
      !/\.(?:[cm]?[jt]sx?|php|py|go|rb|java|kt|swift|dart|rs|cs|vue|svelte)$/.test(f.path)
    )
      continue;
    const u = unitFor(f.path);
    if (f.isTest) u.testFiles++;
    else u.sourceFiles++;
  }

  // Structural framework signals that do not depend on manifests.
  if (files.has('artisan')) addTech({ name: 'Laravel', kind: 'fullstack', unit: '.', evidence: 'artisan' });
  for (const f of files.files) {
    const b = f.path.split('/').pop()!;
    if (b === 'manage.py')
      addTech({ name: 'Django', kind: 'fullstack', unit: unitFor(f.path).path, evidence: f.path });
    if (/^next\.config\.[cm]?[jt]s$/.test(b))
      addTech({ name: 'Next.js', kind: 'fullstack', unit: unitFor(f.path).path, evidence: f.path });
    if (b === 'artisan' && f.path !== 'artisan')
      addTech({ name: 'Laravel', kind: 'fullstack', unit: unitFor(f.path).path, evidence: f.path });
  }

  for (const u of units) {
    const techs = technologies.filter((t) => t.unit === u.path);
    u.frameworks = [
      ...new Set(
        techs
          .filter((t) => ['frontend', 'backend', 'fullstack', 'mobile', 'desktop'].includes(t.kind))
          .map((t) => t.name),
      ),
    ];
    u.kind = unitKind(
      techs.map((t) => t.kind),
      manifests.filter((m) => dirOf(m.file) === u.path),
    );
    if (u.frameworks.includes('Next.js') && isNextStaticExport(files, u.path)) {
      u.staticExport = true;
      u.kind = 'web-frontend';
    }
  }

  // CI
  const ci: ProjectProfile['ci'] = [];
  for (const f of files.files) {
    let system: string | undefined;
    if (f.kind === 'workflow') system = 'GitHub Actions';
    else if (/^\.gitlab-ci\.ya?ml$/.test(f.path)) system = 'GitLab CI';
    else if (f.path === '.circleci/config.yml') system = 'CircleCI';
    else if (/^azure-pipelines\.ya?ml$/.test(f.path)) system = 'Azure Pipelines';
    else if (f.path === 'bitbucket-pipelines.yml') system = 'Bitbucket Pipelines';
    else if (f.path === 'Jenkinsfile') system = 'Jenkins';
    else if (f.path === '.travis.yml') system = 'Travis CI';
    else if (/^codemagic\.ya?ml$/.test(f.path)) system = 'Codemagic';
    else if (/(?:^|\/)fastlane\/Fastfile$/.test(f.path)) system = 'fastlane';
    if (!system) continue;
    const text = (files.read(f.path) ?? '').toLowerCase();
    ci.push({
      system,
      file: f.path,
      runsTests:
        /\b(?:test|pytest|phpunit|pest|vitest|jest|mocha|go test|cargo test|flutter test|rspec)\b/.test(text),
      runsLint:
        /\b(?:lint|eslint|biome|phpstan|psalm|ruff|flake8|mypy|pint|rubocop|analyze|tsc|typecheck)\b/.test(
          text,
        ),
      runsBuild: /\b(?:build|compile|bundle|assemble)\b/.test(text),
    });
  }

  // Containers & deploy
  const dockerfiles = files.byKind('dockerfile').map((f) => f.path);
  const compose = files.byKind('compose').map((f) => f.path);
  const services = new Set<string>();
  for (const c of compose) {
    try {
      const y = parseYaml(files.read(c) ?? '') as { services?: Record<string, { image?: string }> } | null;
      for (const s of Object.values(y?.services ?? {})) {
        const img = s?.image?.toLowerCase();
        if (!img) continue;
        const hit = COMPOSE_IMAGES.find((x) => x.re.test(img.replace(/^docker\.io\/(?:library\/)?/, '')));
        if (hit) {
          services.add(hit.tech.name);
          addTech({ ...hit.tech, unit: unitFor(c).path, evidence: c });
        }
      }
    } catch {
      /* malformed compose file: reported by config rules */
    }
  }
  const deploy: ProjectProfile['deploy'] = [];
  const DEPLOY: [RegExp, string][] = [
    [/^vercel\.json$/, 'Vercel'],
    [/^netlify\.toml$/, 'Netlify'],
    [/^fly\.toml$/, 'Fly.io'],
    [/^render\.ya?ml$/, 'Render'],
    [/^railway\.(?:json|toml)$/, 'Railway'],
    [/^app\.ya?ml$/, 'Google App Engine'],
    [/^Procfile$/, 'Procfile (Heroku-style)'],
    [/^serverless\.ya?ml$/, 'Serverless Framework'],
    [/^Chart\.yaml$/, 'Helm'],
    [/\.tf$/, 'Terraform'],
    [/^ecosystem\.config\.[cm]?js$/, 'PM2'],
    [/^(?:nginx|default|site)\.conf$|\/nginx\/.+\.conf$/, 'nginx'],
    [/^Caddyfile(?:\.[\w-]+)?$/, 'Caddy'],
    [/\.service$/, 'systemd'],
    [/^supervisord?\.conf$|\/supervisor\/.+\.conf$/, 'Supervisor'],
    [/^wrangler\.(?:toml|jsonc?)$/, 'Cloudflare Workers'],
    [/^amplify\.ya?ml$/, 'AWS Amplify'],
    [/^firebase\.json$/, 'Firebase Hosting'],
    [/^eas\.json$/, 'Expo EAS'],
  ];
  for (const f of files.files) {
    const b = f.path.split('/').pop()!;
    for (const [re, kind] of DEPLOY)
      if (re.test(b) || re.test(f.path)) {
        if (!deploy.some((d) => d.kind === kind)) deploy.push({ kind, file: f.path });
        break;
      }
    if (
      f.kind === 'config' &&
      /\.ya?ml$/.test(f.path) &&
      /(?:^|\/)(?:k8s|kubernetes|deploy|manifests|helm)\//.test(f.path) &&
      !deploy.some((d) => d.kind === 'Kubernetes')
    ) {
      const text = files.read(f.path) ?? '';
      if (/^kind:\s*(?:Deployment|StatefulSet|Service|Ingress)\b/m.test(text) && /^apiVersion:/m.test(text))
        deploy.push({ kind: 'Kubernetes', file: f.path });
    }
  }

  // Tests
  const testFrameworks = [...new Set(technologies.filter((t) => t.kind === 'testing').map((t) => t.name))];
  if (
    files.files.some((f) => /(?:^|\/)phpunit\.xml(?:\.dist)?$/.test(f.path)) &&
    !testFrameworks.includes('PHPUnit')
  )
    testFrameworks.push('PHPUnit');
  if (
    files.files.some((f) => /(?:^|\/)(?:pytest\.ini|conftest\.py)$/.test(f.path)) &&
    !testFrameworks.includes('pytest')
  )
    testFrameworks.push('pytest');
  if (files.files.some((f) => f.path.endsWith('_test.go'))) testFrameworks.push('go test');
  const e2e = files.files
    .filter((f) =>
      /(?:^|\/)(?:playwright\.config\.[cm]?[jt]s|cypress\.config\.[cm]?[jt]s|integration_test\/|tests\/Browser\/|e2e\/)/.test(
        f.path,
      ),
    )
    .map((f) => f.path)
    .slice(0, 10);
  const coverageReports = files.files
    .filter((f) =>
      /(?:^|\/)(?:lcov\.info|clover\.xml|cobertura(?:-coverage)?\.xml|coverage\.xml|coverage-final\.json|coverage-summary\.json)$/.test(
        f.path,
      ),
    )
    .map((f) => f.path);

  // API surface
  const routeFiles: string[] = [];
  let routes = 0;
  const ROUTE_RE: [RegExp, RegExp][] = [
    [
      /(?:^|\/)routes\/[^/]+\.php$/,
      /\bRoute::(?:get|post|put|patch|delete|options|any|match|resource|apiResource|view|redirect)\s*\(/g,
    ],
    [
      /\.(?:[cm]?[jt]s)$/,
      /\b(?:app|router|server|api|fastify)\.(?:get|post|put|patch|delete|all|route)\s*\(\s*['"`]\//g,
    ],
    [/(?:^|\/)urls\.py$/, /\b(?:re_)?path\s*\(/g],
    [/\.py$/, /@\w+\.(?:route|get|post|put|patch|delete|api_route)\s*\(/g],
  ];
  for (const f of files.files) {
    if (f.isTest || (f.kind !== 'source' && f.kind !== 'migration')) continue;
    if (/(?:^|\/)(?:app\/.+\/route|pages\/api\/.+)\.[cm]?[jt]sx?$/.test(f.path)) {
      routeFiles.push(f.path);
      routes++;
      continue;
    }
    for (const [fileRe, routeRe] of ROUTE_RE) {
      if (!fileRe.test(f.path)) continue;
      const text = files.read(f.path) ?? '';
      const n = (text.match(routeRe) ?? []).length;
      if (n) {
        routeFiles.push(f.path);
        routes += n;
      }
      break;
    }
  }
  const specs = files.files
    .filter((f) => /(?:^|\/)(?:openapi|swagger)[\w.-]*\.(?:ya?ml|json)$/i.test(f.path))
    .map((f) => f.path);
  const graphql = files.files
    .filter((f) => /\.(?:graphql|gql)$/.test(f.path) || /(?:^|\/)schema\.graphql/.test(f.path))
    .map((f) => f.path)
    .slice(0, 20);

  // Environment variables
  const envTemplates = files.files.filter((f) => isEnvTemplate(f.path)).map((f) => f.path);
  const documented = new Set<string>();
  for (const t of envTemplates)
    for (const m of (files.read(t) ?? '').matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm))
      documented.add(m[1]!);
  for (const c of compose)
    for (const m of (files.read(c) ?? '').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) documented.add(m[1]!);
  for (const c of compose)
    for (const m of (files.read(c) ?? '').matchAll(/^\s+-?\s*([A-Z][A-Z0-9_]{2,})\s*[:=]/gm))
      documented.add(m[1]!);
  const readme = files.files.find((f) => /^readme(?:\.\w+)?$/i.test(f.path));
  const docText = [
    readme?.path,
    ...files.files
      .filter((f) => /^docs\/.*\.md$/i.test(f.path))
      .map((f) => f.path)
      .slice(0, 50),
  ]
    .filter((p): p is string => !!p)
    .map((p) => files.read(p) ?? '')
    .join('\n');
  for (const m of docText.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g)) documented.add(m[1]!);
  const envVars = collectEnvVars(files, documented);

  const docs: ProjectProfile['docs'] = {
    readme: readme?.path,
    readmeBytes: readme?.size ?? 0,
    license: files.files.find((f) => /^(?:license|licence|copying)(?:\.\w+)?$/i.test(f.path))?.path,
    changelog: files.files.find((f) => /^(?:changelog|changes|history)(?:\.\w+)?$/i.test(f.path))?.path,
    contributing: files.files.find((f) => /^(?:\.github\/)?contributing(?:\.\w+)?$/i.test(f.path))?.path,
    security: files.files.find((f) => /^(?:\.github\/)?security(?:\.\w+)?$/i.test(f.path))?.path,
    docsDir: files.files.some((f) => f.path.startsWith('docs/')),
  };

  const rootManifest = manifests.find((m) => !m.file.includes('/') && m.name);
  const name = rootManifest?.name ?? files.root.split(/[\\/]/).pop() ?? 'project';

  return {
    root: files.root,
    name,
    gitRepo: files.gitRepo,
    monorepo:
      units.filter((u) => u.manifests.length).length > 1 ||
      manifests.some((m) => m.workspaces.length > 0) ||
      files.has('pnpm-workspace.yaml'),
    languages: [...langs.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.lines - a.lines),
    units,
    technologies,
    ci,
    containers: { dockerfiles, compose, services: [...services] },
    deploy,
    tests: {
      frameworks: testFrameworks,
      testFiles: units.reduce((s, u) => s + u.testFiles, 0),
      sourceFiles: units.reduce((s, u) => s + u.sourceFiles, 0),
      e2e,
      coverageReports,
    },
    api: { routeFiles: routeFiles.slice(0, 200), routes, specs, graphql },
    envVars,
    envTemplates,
    docs,
    manifests,
    lockfiles,
    migrations: files.byKind('migration').map((f) => f.path),
    stats: { files: files.files.length, bytes },
  };
}

function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function cleanVersion(spec: string): string | undefined {
  const m = /(\d+(?:\.\d+){0,2})/.exec(spec);
  return m?.[1];
}

/** Only a literal `output: 'export'` counts; a value computed at build time (e.g. from an env var) is unknown. */
function isNextStaticExport(files: FileSet, unit: string): boolean {
  for (const ext of ['js', 'mjs', 'cjs', 'ts']) {
    const text = files.read(unit === '.' ? `next.config.${ext}` : `${unit}/next.config.${ext}`);
    if (text && /\boutput\s*:\s*['"]export['"]/.test(text)) return true;
  }
  return false;
}

function unitKind(kinds: TechKind[], ms: ManifestInfo[]): Unit['kind'] {
  if (kinds.includes('mobile')) return 'mobile';
  if (kinds.includes('desktop')) return 'desktop';
  if (kinds.includes('fullstack')) return 'fullstack';
  const fe = kinds.includes('frontend');
  const be = kinds.includes('backend');
  if (fe && be) return 'fullstack';
  if (be) return 'web-backend';
  if (fe) return 'web-frontend';
  if (ms.some((m) => m.extra.bin)) return 'cli';
  if (ms.length) return 'library';
  return 'unknown';
}

const ENV_PATTERNS: { re: RegExp; ext: RegExp }[] = [
  // JS/TS: process.env.X, process.env['X'], import.meta.env.X; optional when followed by ?? or ||.
  {
    re: /\b(?:process\.env|import\.meta\.env)(?:\.([A-Z_][A-Z0-9_]*)(?![A-Za-z0-9_])|\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\])(\s*(?:\?\?|\|\|))?/g,
    ext: /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/,
  },
  // PHP: env('X'), env('X', default), getenv('X')
  { re: /\b(?:env|getenv)\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*(,)?/g, ext: /\.php$/ },
  // Python: os.environ['X'], os.environ.get('X', d), os.getenv('X', d)
  {
    re: /\bos\.(?:environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]|environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*(,)?|getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*(,)?)/g,
    ext: /\.py$/,
  },
  // Go, Ruby, Dart
  { re: /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/g, ext: /\.go$/ },
  {
    re: /\bENV(?:\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]|\.fetch\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*(,)?)/g,
    ext: /\.rb$/,
  },
  { re: /\bString\.fromEnvironment\(\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*(,)?/g, ext: /\.dart$/ },
];

const AMBIENT_ENV =
  /^(?:NODE_ENV|CI|HOME|PATH|Path|PWD|USER|USERNAME|USERPROFILE|SYSTEMROOT|SystemRoot|APPDATA|LOCALAPPDATA|COMSPEC|PATHEXT|WINDIR|TEMP|TMP|PROGRAMFILES|SHELL|TERM|TZ|LANG|LC_ALL|NO_COLOR|FORCE_COLOR|PORT|HOST|HOSTNAME|DEBUG|VERCEL|VERCEL_ENV|VERCEL_URL|NEXT_RUNTIME|NEXT_PHASE|npm_\w+|GITHUB_\w+|RUNNER_\w+|APP_ENV|APP_DEBUG|LOG_LEVEL|TMPDIR|PYTHONPATH|VIRTUAL_ENV|RELIVARO\w*)$/;

function collectEnvVars(files: FileSet, documented: Set<string>): EnvVarInfo[] {
  const vars = new Map<string, EnvVarInfo>();
  for (const f of files.files) {
    if (
      f.isTest ||
      (f.kind !== 'source' &&
        f.kind !== 'template' &&
        f.kind !== 'migration' &&
        !(f.kind === 'config' && f.path.endsWith('.php')))
    )
      continue;
    for (const p of ENV_PATTERNS) {
      if (!p.ext.test(f.path)) continue;
      const text = files.read(f.path);
      if (!text) continue;
      p.re.lastIndex = 0;
      for (const m of text.matchAll(p.re)) {
        // Mentions in comments and docblocks are not reads.
        const lineStart = text.lastIndexOf('\n', m.index ?? 0) + 1;
        if (/^\s*(?:\/\/|#|\*|\/\*)/.test(text.slice(lineStart, m.index))) continue;
        const groups = m.slice(1);
        const name = groups.find((g) => g && /^[A-Z_][A-Z0-9_]*$/.test(g));
        if (!name || AMBIENT_ENV.test(name)) continue;
        const hasDefault = groups.some((g) => g !== undefined && /^(?:,|\s*(?:\?\?|\|\|))$/.test(g));
        const v = vars.get(name) ?? { name, usedIn: [], required: false, documented: documented.has(name) };
        if (!hasDefault) v.required = true;
        if (v.usedIn.length < 5 && !v.usedIn.includes(f.path)) v.usedIn.push(f.path);
        vars.set(name, v);
      }
    }
  }
  return [...vars.values()].sort((a, b) => a.name.localeCompare(b.name));
}
