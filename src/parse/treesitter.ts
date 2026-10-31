import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language as TSLanguage, Parser, type Node, type Tree } from 'web-tree-sitter';
import type { Language } from '../core/types.js';

export type { Node, Tree };

const GRAMMAR_FILES: Record<Language, { pkg: string; file: string }> = {
  javascript: { pkg: 'tree-sitter-javascript', file: 'tree-sitter-javascript.wasm' },
  typescript: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-typescript.wasm' },
  tsx: { pkg: 'tree-sitter-typescript', file: 'tree-sitter-tsx.wasm' },
  php: { pkg: 'tree-sitter-php', file: 'tree-sitter-php.wasm' },
  python: { pkg: 'tree-sitter-python', file: 'tree-sitter-python.wasm' },
};

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/** Package directory even when `package.json` is not in the package's exports map. */
function pkgDir(name: string): string {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    let d = dirname(require.resolve(name));
    while (!existsSync(join(d, 'package.json')) && dirname(d) !== d) d = dirname(d);
    return d;
  }
}

/** Bundled layout first (`dist/grammars/*.wasm`), then node_modules (development and tests). */
function locate(pkg: string, file: string): string {
  const bundled = join(here, 'grammars', file);
  if (existsSync(bundled)) return bundled;
  return join(pkgDir(pkg), file);
}

let initPromise: Promise<void> | null = null;
const languages = new Map<Language, Promise<TSLanguage>>();
const parsers = new Map<Language, Parser>();

function init(): Promise<void> {
  initPromise ??= Parser.init({
    locateFile: (name: string) => {
      const bundled = join(here, 'grammars', name);
      if (existsSync(bundled)) return bundled;
      return join(pkgDir('web-tree-sitter'), name);
    },
  });
  return initPromise;
}

async function language(lang: Language): Promise<TSLanguage> {
  let p = languages.get(lang);
  if (!p) {
    const g = GRAMMAR_FILES[lang];
    p = init().then(() => TSLanguage.load(locate(g.pkg, g.file)));
    languages.set(lang, p);
  }
  return p;
}

export async function getParser(lang: Language): Promise<Parser> {
  let parser = parsers.get(lang);
  if (!parser) {
    const l = await language(lang);
    parser = new Parser();
    parser.setLanguage(l);
    parsers.set(lang, parser);
  }
  return parser;
}

export async function parse(lang: Language, source: string): Promise<Tree | null> {
  const parser = await getParser(lang);
  return parser.parse(source);
}

export function grammarAssets(): { name: string; path: string }[] {
  const out = Object.values(GRAMMAR_FILES).map((g) => ({ name: g.file, path: locate(g.pkg, g.file) }));
  out.push({ name: 'web-tree-sitter.wasm', path: locate('web-tree-sitter', 'web-tree-sitter.wasm') });
  return out;
}
