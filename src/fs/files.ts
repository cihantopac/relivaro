import { spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { RelivaroError } from '../core/errors.js';
import { matchesAny } from '../core/glob.js';
import type { FileKind, Language, ProjectFile } from '../core/types.js';

/** Directories that hold dependencies, build output or caches. Never analysed. */
export const DEFAULT_EXCLUDED_DIRS = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  '.vercel',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  '.nyc_output',
  'target',
  'Pods',
  'DerivedData',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.dart_tool',
  '.gradle',
  '.idea',
  '.vscode',
  '.relivaro',
  '.terraform',
  'storage',
  'bootstrap/cache',
  'public/build',
  'public/vendor',
  'tmp',
  '.tmp',
]);

const LANGUAGE_BY_EXT: Record<string, Language> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.php': 'php',
  '.py': 'python',
};

const MANIFESTS = new Set([
  'package.json',
  'composer.json',
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'Pipfile',
  'go.mod',
  'Cargo.toml',
  'Gemfile',
  'pubspec.yaml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pom.xml',
  'Podfile',
  'Package.swift',
  'deno.json',
  'deno.jsonc',
]);

const LOCKFILES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'poetry.lock',
  'Pipfile.lock',
  'uv.lock',
  'pdm.lock',
  'go.sum',
  'Cargo.lock',
  'Gemfile.lock',
  'pubspec.lock',
  'Podfile.lock',
  'Package.resolved',
  'gradle.lockfile',
]);

const TEMPLATE_EXT = new Set([
  '.vue',
  '.svelte',
  '.html',
  '.htm',
  '.jinja',
  '.jinja2',
  '.j2',
  '.twig',
  '.hbs',
  '.ejs',
  '.erb',
  '.astro',
]);
const DOC_EXT = new Set(['.md', '.mdx', '.rst', '.adoc']);
const CONFIG_EXT = new Set([
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.xml',
  '.conf',
  '.properties',
  '.cfg',
  '.gradle',
  '.kts',
  '.tf',
  '.hcl',
  '.plist',
  '.neon',
]);
const OTHER_TEXT_EXT = new Set([
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.ps1',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.swift',
  '.dart',
  '.cs',
  '.scala',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.m',
  '.mm',
  '.lua',
  '.ex',
  '.exs',
  '.css',
  '.scss',
  '.less',
  '.txt',
  '.graphql',
  '.gql',
  '.proto',
  '.r',
]);

const BINARY_EXT = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.bmp',
  '.tiff',
  '.psd',
  '.pdf',
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.jar',
  '.war',
  '.class',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.bin',
  '.wasm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.mp4',
  '.mov',
  '.webm',
  '.wav',
  '.ogg',
  '.flac',
  '.mkv',
  '.sqlite',
  '.db',
  '.lockb',
  '.pyc',
  '.o',
  '.a',
  '.ipa',
  '.apk',
  '.aab',
  '.dmg',
  '.pkg',
  '.heic',
  '.riv',
  '.lottie',
]);

const TEST_DIR =
  /(?:^|\/)(?:tests?|__tests__|__mocks__|spec|specs|e2e|cypress|playwright|fixtures?|testdata|test-data|examples?|samples?|demo|stubs?|benchmarks?|bench)\//i;
const TEST_FILE =
  /(?:\.(?:test|spec|e2e|cy|stories)\.[cm]?[jt]sx?$|_test\.(?:py|go|dart)$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)conftest\.py$|Test\.php$|_spec\.rb$)/i;

const SENSITIVE_ENV = /^\.env(?:\..+)?$/i;
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist|defaults|schema)$|^\.env\..*\.example$/i;
const KEY_FILE =
  /(?:\.(?:pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$|^id_(?:rsa|dsa|ecdsa|ed25519)$|^\.(?:netrc|pypirc|htpasswd)$|^credentials(?:\.json)?$)/i;

export function isEnvTemplate(path: string): boolean {
  return ENV_TEMPLATE.test(basename(path));
}

/** Files whose content may hold live credentials. Their content is only read when git tracks them (already committed). */
export function isSensitivePath(path: string): boolean {
  const b = basename(path);
  if (isEnvTemplate(path)) return false;
  return SENSITIVE_ENV.test(b) || KEY_FILE.test(b);
}

export function classify(path: string): { kind: FileKind; language?: Language } {
  const b = basename(path);
  const lower = b.toLowerCase();
  const ext = extname(lower);
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return { kind: 'workflow' };
  if (
    /^(?:\.gitlab-ci\.ya?ml|azure-pipelines\.ya?ml|bitbucket-pipelines\.yml|\.circleci\/config\.yml|Jenkinsfile)$/.test(
      path,
    )
  )
    return { kind: 'config' };
  if (
    lower === 'dockerfile' ||
    lower.startsWith('dockerfile.') ||
    lower.endsWith('.dockerfile') ||
    lower === 'containerfile'
  )
    return { kind: 'dockerfile' };
  if (/^(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml$/.test(lower)) return { kind: 'compose' };
  if (
    /^Caddyfile(?:\.[\w-]+)?$/.test(b) ||
    lower.endsWith('.caddy') ||
    b === '_headers' ||
    /^(?:nginx|default|site)\.conf(?:\.template)?$/.test(lower) ||
    /(?:^|\/)nginx\/.+\.conf(?:\.template)?$/.test(path)
  )
    return { kind: 'webserver' };
  if (SENSITIVE_ENV.test(b) || isEnvTemplate(path)) return { kind: 'env' };
  if (LOCKFILES.has(b)) return { kind: 'lockfile' };
  if (MANIFESTS.has(b) || /^requirements(?:[-_.][\w.-]+)?\.(?:txt|in)$/i.test(b)) return { kind: 'manifest' };
  if (
    /(?:^|\/)database\/migrations\/[^/]+\.php$/.test(path) ||
    /(?:^|\/)migrations\/[^/]+\.(?:py|sql)$/.test(path) ||
    /(?:^|\/)prisma\/migrations\/[^/]+\/migration\.sql$/.test(path) ||
    /(?:^|\/)(?:db\/migrate|migrations?)\/.+\.(?:sql|rb|ts|js)$/.test(path)
  ) {
    const language = LANGUAGE_BY_EXT[ext];
    return language ? { kind: 'migration', language } : { kind: 'migration' };
  }
  if (lower.endsWith('.blade.php')) return { kind: 'template' };
  const language = LANGUAGE_BY_EXT[ext];
  if (language) return { kind: 'source', language };
  if (TEMPLATE_EXT.has(ext)) return { kind: 'template' };
  if (
    DOC_EXT.has(ext) ||
    /^(?:readme|license|licence|changelog|contributing|security|notice|code_of_conduct)(?:\..*)?$/i.test(b)
  )
    return { kind: 'doc' };
  if (
    CONFIG_EXT.has(ext) ||
    /^\.[\w.-]+rc$/.test(b) ||
    b === '.gitignore' ||
    b === '.dockerignore' ||
    b === 'Procfile'
  )
    return { kind: 'config' };
  if (OTHER_TEXT_EXT.has(ext)) return { kind: 'source' };
  return { kind: 'other' };
}

export function isTestPath(path: string): boolean {
  return TEST_DIR.test(path) || TEST_FILE.test(path);
}

const REPORT_EXT = new Set(['.html', '.md', '.json', '.sarif']);
const REPORT_MARKERS = [
  /<meta name="generator" content="(?:Relivaro|Jourilo|Searvex) \d/,
  /^\{\s*"schemaVersion"\s*:\s*\d+\s*,(?:\s*"id"\s*:\s*"[^"]*"\s*,)?\s*"tool"\s*:\s*\{\s*"name"\s*:\s*"(?:relivaro|jourilo|searvex)"/,
  /^(?:.*\n){0,4}Generated \S+ · (?:Relivaro|Jourilo|Searvex) \d/,
  /^# (?:Relivaro|Jourilo) report — .*\n\nRun `[^`]+` · /,
];

/** A report generated by Relivaro, Jourilo or Searvex, recognised by exact output markers in its first 4 KB. */
export function isToolReport(path: string, head: string): boolean {
  const ext = extname(path).toLowerCase();
  if (!REPORT_EXT.has(ext)) return false;
  // SARIF from other scanners (CodeQL, Semgrep) is project data; only the driver name identifies our own output.
  if (ext === '.sarif')
    return /"driver"\s*:\s*\{\s*"name"\s*:\s*"(?:Relivaro|Jourilo|Searvex)"/.test(head.slice(0, 4096));
  const h = head.slice(0, 4096);
  return REPORT_MARKERS.some((re) => re.test(h));
}

function readHead(abs: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(abs, 'r');
    const buf = Buffer.alloc(4096);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, 4096, 0));
  } catch {
    return '';
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface FileSetOptions {
  include?: string[];
  exclude?: string[];
  maxFileSizeKb?: number;
  /** Size limit for lockfiles (default 51200 KB). */
  maxLockfileSizeKb?: number;
  /** Use git to list files (respecting .gitignore). Default true. */
  useGit?: boolean;
  /** Without git, skip files matched by the root `.gitignore`. Default true; `--no-gitignore` sets false. */
  respectGitignore?: boolean;
  /**
   * Without git, treat every listed file as tracked (archives, exports). Sensitive files then reach
   * `sec/env-file-committed`, by path only: their content is never read.
   */
  assumeTracked?: boolean;
}

export interface SkipStats {
  excluded: number;
  binary: number;
  tooLarge: number;
  sensitive: number;
  symlinkOutside: number;
  generated: number;
  /** Reports written by Relivaro, Jourilo or Searvex (e.g. with `--out`), which describe the project but are not it. */
  reports: number;
  /** Files matched by the root `.gitignore` in walk mode (no git). */
  gitignored: number;
  /** Symlinks to a file that is already analysed under its own path (or through an earlier link). */
  symlinkDuplicate: number;
  /** Symlinks to a directory inside the root; the directory is analysed under its own path, never followed. */
  symlinkDir: number;
}

/**
 * The set of files Relivaro may look at, plus a guarded, cached reader. All file access of the analysis engines
 * goes through this class, which enforces: no reads outside the root (symlinks resolved), no reads of untracked
 * sensitive files (e.g. `.env`), size limits, binary and minified-file detection.
 */
export class FileSet {
  readonly root: string;
  readonly realRoot: string;
  readonly files: ProjectFile[];
  readonly gitRepo: boolean;
  readonly skipped: SkipStats = {
    excluded: 0,
    binary: 0,
    tooLarge: 0,
    sensitive: 0,
    symlinkOutside: 0,
    generated: 0,
    reports: 0,
    gitignored: 0,
    symlinkDuplicate: 0,
    symlinkDir: 0,
  };
  /** Sensitive files present on disk that were not read (path only). */
  readonly sensitiveUnread: { path: string; ignored: boolean | undefined }[] = [];
  /** Paths behind some of the `skipped` counts, so reports can name them. */
  readonly skippedPaths: { tooLarge: string[]; gitignored: string[] } = { tooLarge: [], gitignored: [] };
  /** Size in bytes of each file in `skippedPaths.tooLarge`. */
  readonly skippedSizes = new Map<string, number>();
  private readonly cache = new Map<string, string | null>();
  /** Walk mode stopped counting git-ignored files, or stopped listing files, at its caps. */
  walkLimits: { gitignoredCapped: boolean; truncated: boolean } = {
    gitignoredCapped: false,
    truncated: false,
  };
  /** Sensitive files listed because of `assumeTracked`: reported by path, never read. */
  private readonly unreadable = new Set<string>();
  private readonly byPath = new Map<string, ProjectFile>();
  private readonly maxBytes: number;
  private readonly maxLockfileBytes: number;

  constructor(root: string, opts: FileSetOptions = {}) {
    this.root = resolve(root);
    if (!existsSync(this.root) || !statSync(this.root).isDirectory())
      throw new RelivaroError('NOT_FOUND', `Not a directory: ${root}`);
    this.realRoot = realpathSync.native(this.root);
    this.maxBytes = (opts.maxFileSizeKb ?? 1024) * 1024;
    this.maxLockfileBytes = (opts.maxLockfileSizeKb ?? 51200) * 1024;
    const listed = opts.useGit === false ? null : gitListFiles(this.root);
    this.gitRepo = listed !== null;
    let candidates: { path: string; tracked: boolean | undefined }[];
    if (listed) candidates = listed;
    else {
      const w = walk(this.root, opts.respectGitignore !== false);
      candidates = w.entries;
      this.skipped.gitignored = w.gitignoredCount;
      this.skippedPaths.gitignored = w.gitignored;
      this.walkLimits = { gitignoredCapped: w.gitignoredCapped, truncated: w.truncated };
    }
    const assumeTracked = !listed && opts.assumeTracked === true;
    const ignoredSensitive = listed ? gitIgnoredSensitive(this.root) : [];
    // Regular files first, then symlinks: a link is a duplicate only when its target was actually kept.
    const keptReal = new Set<string>();
    const deferredLinks: { path: string; listedTracked: boolean | undefined; abs: string }[] = [];
    const files: ProjectFile[] = [];
    const consider = (
      path: string,
      listedTracked: boolean | undefined,
      abs: string,
      st: { size: number },
      real: string,
    ) => {
      const tracked = assumeTracked ? true : listedTracked;
      const ext = extname(path).toLowerCase();
      const sensitive = isSensitivePath(path);
      if (sensitive && tracked !== true) {
        this.skipped.sensitive++;
        this.sensitiveUnread.push({ path, ignored: listed ? false : undefined });
        return;
      }
      const { kind, language } = classify(path);
      const pf: ProjectFile = { path, size: st.size, kind, isTest: isTestPath(path), tracked };
      if (sensitive && assumeTracked) {
        pf.assumedTracked = true;
        this.unreadable.add(path);
      }
      if (language) pf.language = language;
      if (st.size > (kind === 'lockfile' ? this.maxLockfileBytes : this.maxBytes)) {
        this.skipped.tooLarge++;
        this.skippedPaths.tooLarge.push(path);
        this.skippedSizes.set(path, st.size);
        return;
      }
      // A sensitive file listed by --assume-tracked is never opened, not even its first bytes.
      if (!this.unreadable.has(path) && REPORT_EXT.has(ext) && isToolReport(path, readHead(abs))) {
        this.skipped.reports++;
        return;
      }
      keptReal.add(real);
      files.push(pf);
    };
    for (const { path, tracked: listedTracked } of candidates) {
      if (isExcludedPath(path) || (opts.exclude?.length && matchesAny(path, opts.exclude))) {
        this.skipped.excluded++;
        continue;
      }
      if (opts.include?.length && !matchesAny(path, opts.include) && !isRootMeta(path)) {
        this.skipped.excluded++;
        continue;
      }
      if (BINARY_EXT.has(extname(path).toLowerCase())) {
        this.skipped.binary++;
        continue;
      }
      if (/\.min\.(?:js|css)$|\.map$|\.bundle\.js$|(?:^|\/)plugin\/dist\//.test(path)) {
        this.skipped.generated++;
        continue;
      }
      const abs = join(this.root, path);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(abs);
      } catch {
        continue; // listed by git but deleted in the working tree
      }
      if (st.isSymbolicLink()) deferredLinks.push({ path, listedTracked, abs });
      else if (st.isFile()) consider(path, listedTracked, abs, st, join(this.realRoot, path));
    }
    for (const { path, listedTracked, abs } of deferredLinks) {
      try {
        const target = realpathSync.native(abs);
        if (!isInside(this.realRoot, target)) {
          this.skipped.symlinkOutside++;
          continue;
        }
        const tst = statSync(target);
        if (tst.isDirectory()) {
          this.skipped.symlinkDir++;
          continue;
        }
        if (!tst.isFile()) {
          this.skipped.symlinkOutside++;
          continue;
        }
        if (keptReal.has(target)) {
          this.skipped.symlinkDuplicate++;
          continue;
        }
        consider(path, listedTracked, abs, tst, target);
      } catch {
        this.skipped.symlinkOutside++;
      }
    }
    for (const path of ignoredSensitive) this.sensitiveUnread.push({ path, ignored: true });
    files.sort((a, b) => a.path.localeCompare(b.path));
    this.files = files;
    for (const f of files) this.byPath.set(f.path, f);
  }

  /** Replaces the content seen by analysis for files of the set (used to verify fixes without touching disk). */
  overlay(contents: Map<string, string>): void {
    for (const [path, text] of contents) if (this.byPath.has(path)) this.cache.set(path, text);
  }

  get(path: string): ProjectFile | undefined {
    return this.byPath.get(path);
  }

  has(path: string): boolean {
    return this.byPath.has(path);
  }

  /** Reads a file of the set. Returns undefined for files outside the set, binary or unreadable content. */
  read(path: string): string | undefined {
    if (this.cache.has(path)) return this.cache.get(path) ?? undefined;
    const pf = this.byPath.get(path);
    if (!pf || this.unreadable.has(path)) return undefined;
    let text: string | null = null;
    try {
      const abs = safeResolve(this.realRoot, path);
      const buf = readFileSync(abs);
      if (!looksBinary(buf)) {
        text = buf.toString('utf8');
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
        if (isMinified(text, pf.path)) {
          text = null;
          this.skipped.generated++;
        }
      } else this.skipped.binary++;
    } catch {
      text = null;
    }
    this.cache.set(path, text);
    return text ?? undefined;
  }

  /** Reads a root-relative path that may be outside the analysed set (e.g. `.gitignore`), with the same guards. */
  readAny(path: string): string | undefined {
    if (this.byPath.has(path)) return this.read(path);
    if (isSensitivePath(path)) return undefined;
    try {
      const abs = safeResolve(this.realRoot, path);
      const st = statSync(abs);
      if (!st.isFile() || st.size > this.maxBytes) return undefined;
      const buf = readFileSync(abs);
      return looksBinary(buf) ? undefined : buf.toString('utf8');
    } catch {
      return undefined;
    }
  }

  byKind(kind: FileKind): ProjectFile[] {
    return this.files.filter((f) => f.kind === kind);
  }

  matching(re: RegExp): ProjectFile[] {
    return this.files.filter((f) => re.test(f.path));
  }
}

function isRootMeta(path: string): boolean {
  return !path.includes('/') && (MANIFESTS.has(path) || LOCKFILES.has(path) || path === '.gitignore');
}

export function isExcludedPath(path: string): boolean {
  const parts = path.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (DEFAULT_EXCLUDED_DIRS.has(parts[i]!)) return true;
    if (i > 0 && DEFAULT_EXCLUDED_DIRS.has(`${parts[i - 1]}/${parts[i]}`)) return true;
  }
  return false;
}

export function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Resolves a root-relative path and refuses anything (including symlinks) that leaves the root. */
export function safeResolve(root: string, relPath: string): string {
  if (isAbsolute(relPath) || relPath.split(/[\\/]/).includes('..'))
    throw new RelivaroError('PATH_OUTSIDE_ROOT', `Path escapes the project root: ${relPath}`);
  let realRoot = root;
  try {
    realRoot = realpathSync.native(root);
  } catch {
    /* root does not exist yet */
  }
  const abs = join(realRoot, relPath);
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    real = abs;
  }
  if (!isInside(realRoot, real))
    throw new RelivaroError('PATH_OUTSIDE_ROOT', `Path escapes the project root: ${relPath}`);
  return real;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function isMinified(text: string, path: string): boolean {
  if (!/\.(?:[cm]?js|css)$/.test(path) || text.length < 5000) return false;
  const lines = text.split('\n', 50);
  const longest = Math.max(...lines.map((l) => l.length));
  return longest > 1000 && text.length / (text.split('\n').length || 1) > 300;
}

/** Hardened git invocation: repository-local config cannot run commands (fsmonitor, hooks, pagers). */
export function gitArgs(args: string[]): string[] {
  return [
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.pager=cat',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'protocol.file.allow=never',
    '--no-optional-locks',
    ...args,
  ];
}

export function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    LC_ALL: 'C',
  };
}

export function runGit(cwd: string, args: string[], maxBuffer = 256 * 1024 * 1024): string | null {
  const r = spawnSync('git', gitArgs(args), {
    cwd,
    env: gitEnv(),
    encoding: 'utf8',
    maxBuffer,
    timeout: 60_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

function gitListFiles(root: string): { path: string; tracked: boolean }[] | null {
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  if (inside === null || inside.trim() !== 'true') return null;
  // Without --full-name, ls-files prints paths relative to the working directory (the analysed root). This avoids
  // comparing git's top-level path with ours, which differs on Windows (8.3 short names) and through symlinks.
  const tracked = runGit(root, ['ls-files', '-z', '--cached', '--', '.']);
  const untracked = runGit(root, ['ls-files', '-z', '--others', '--exclude-standard', '--', '.']);
  if (tracked === null || untracked === null) return null;
  const strip = (p: string): string | null => (p.startsWith('../') ? null : p);
  const out: { path: string; tracked: boolean }[] = [];
  const seen = new Set<string>();
  for (const [list, isTracked] of [
    [tracked, true],
    [untracked, false],
  ] as const) {
    for (const p of list.split('\0')) {
      if (!p) continue;
      const rel = strip(p);
      if (rel === null || seen.has(rel)) continue;
      seen.add(rel);
      out.push({ path: rel, tracked: isTracked });
    }
  }
  return out;
}

/** Sensitive files that exist but are git-ignored (reported as present-and-ignored, never read). */
function gitIgnoredSensitive(root: string): string[] {
  const out = runGit(root, [
    'ls-files',
    '-z',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--directory',
    '--',
    '.',
  ]);
  if (!out) return [];
  return out
    .split('\0')
    .filter((p) => p && !p.endsWith('/') && isSensitivePath(p) && !isExcludedPath(p))
    .slice(0, 200);
}

/** Walk mode lists at most this many files; beyond it the walk stops and says so. */
const WALK_MAX_FILES = 200_000;
/** Files inside git-ignored directories are counted up to this many; beyond it they are reported as "at least". */
const WALK_MAX_IGNORED = 20_000;

/**
 * Fallback enumeration when git is unavailable: walks the tree without following directory symlinks. Files matched by
 * the root `.gitignore` are counted (and the ignored entries named, at most 20) but not listed, unless they are
 * sensitive files, which stay listed so they are reported as unread. Counting ignored files has its own budget, so a
 * huge ignored data directory never cuts the walk of the analysed tree short.
 */
function walk(
  root: string,
  respectGitignore = true,
): {
  entries: { path: string; tracked: undefined }[];
  gitignored: string[];
  gitignoredCount: number;
  gitignoredCapped: boolean;
  truncated: boolean;
} {
  const out: { path: string; tracked: undefined }[] = [];
  const ignore = respectGitignore ? readRootGitignore(root) : [];
  const gitignored: string[] = [];
  let gitignoredCount = 0;
  let gitignoredCapped = false;
  let truncated = false;
  const note = (entry: string) => {
    if (gitignored.length < 20) gitignored.push(entry);
  };
  // Analysed directories first; ignored directories are only counted, after the analysed tree is listed.
  const stack: string[] = [''];
  const ignoredStack: string[] = [];
  while (stack.length && !truncated) {
    const dir = stack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (DEFAULT_EXCLUDED_DIRS.has(e.name)) continue;
        if (ignore.length > 0 && matchesAny(`${rel}/`, ignore)) {
          note(`${rel}/`);
          ignoredStack.push(rel);
        } else stack.push(rel);
      } else if (e.isFile() || e.isSymbolicLink()) {
        // A sensitive file matched directly stays listed (reported unread); inside an ignored directory it is only counted.
        if (ignore.length > 0 && matchesAny(rel, ignore) && !isSensitivePath(rel)) {
          gitignoredCount++;
          note(rel);
          continue;
        }
        if (out.length >= WALK_MAX_FILES) {
          truncated = true;
          break;
        }
        out.push({ path: rel, tracked: undefined });
      }
    }
  }
  while (ignoredStack.length) {
    const dir = ignoredStack.pop()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!DEFAULT_EXCLUDED_DIRS.has(e.name)) ignoredStack.push(`${dir}/${e.name}`);
      } else if (++gitignoredCount >= WALK_MAX_IGNORED) {
        gitignoredCapped = true;
        break;
      }
    }
    if (gitignoredCapped) break;
  }
  return { entries: out, gitignored: gitignored.sort(), gitignoredCount, gitignoredCapped, truncated };
}

function readRootGitignore(root: string): string[] {
  try {
    const fd = openSync(join(root, '.gitignore'), 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    return buf
      .toString('utf8', 0, n)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('!'))
      .map((l) => l.replace(/^\//, ''));
  } catch {
    return [];
  }
}
