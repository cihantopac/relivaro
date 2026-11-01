import type { Finding, Language } from '../core/types.js';
import { classify } from '../fs/files.js';
import { callInfo, collect, walk } from '../parse/ast.js';
import { type Node, parse } from '../parse/treesitter.js';
import type { ActionPin } from './actions.js';

/**
 * Deterministic fixers. Each makes the smallest change that removes the cause of one finding, operating on the
 * syntax tree (never on raw regex replacements across the file), and returns null when the code no longer matches
 * the expected shape — so a stale finding can never produce an unintended edit.
 */
export interface FixInput {
  path: string;
  text: string;
  finding: Finding;
  ctx?: FixContext;
}

/** Capabilities a fixer may need beyond the file text. Provided by the plan step, never by the fixer itself. */
export interface FixContext {
  /** Resolves a GitHub Action tag to its commit SHA (only available with `--online`). */
  resolveAction?: (action: string, ref: string) => Promise<ActionPin>;
}

export interface Fixer {
  id: string;
  title: string;
  /** `safe` = behaviour-preserving for correct programs; `review` = changes behaviour intentionally (needs approval). */
  safety: 'safe' | 'review';
  description: string;
  /** Needs network access while planning (the plan stores the result; applying never goes online). */
  online?: boolean;
  /** File the fixer edits when it differs from the finding's location (e.g. `.gitignore`). */
  target?: (f: Finding) => string;
  apply(input: FixInput): Promise<string | null>;
}

async function treeFor(path: string, text: string) {
  const lang = classify(path).language;
  if (!lang) return null;
  const tree = await parse(lang, text);
  return tree ? { tree, lang } : null;
}

/** Smallest node of one of `types` that starts on the finding line (and column when known). */
function nodeAt(root: Node, f: Finding, types: Set<string> | ((n: Node) => boolean)): Node | null {
  const line = (f.location?.line ?? 0) - 1;
  const col = (f.location?.column ?? 0) - 1;
  const match = typeof types === 'function' ? types : (n: Node) => types.has(n.type);
  let best: Node | null = null;
  walk(root, (n) => {
    if (n.endPosition.row < line || n.startPosition.row > line + 1) return false;
    if (n.startPosition.row === line && match(n)) {
      if (col >= 0 && n.startPosition.column !== col && best && best.startPosition.column === col) return;
      if (
        !best ||
        (col >= 0 && n.startPosition.column === col && best.startPosition.column !== col) ||
        n.endIndex - n.startIndex < best.endIndex - best.startIndex
      )
        best = n;
    }
  });
  return best;
}

function splice(text: string, start: number, end: number, insert: string): string {
  // tree-sitter indices are UTF-8 byte offsets; convert through Buffer for non-ASCII sources.
  const buf = Buffer.from(text, 'utf8');
  return Buffer.concat([buf.subarray(0, start), Buffer.from(insert, 'utf8'), buf.subarray(end)]).toString(
    'utf8',
  );
}

/** Removes a whole statement line (or replaces it with `pass` when it is the only statement of a Python block). */
function removeStatement(text: string, stmt: Node, lang: Language): string {
  const buf = Buffer.from(text, 'utf8');
  let s = stmt.startIndex;
  const e = stmt.endIndex;
  while (s > 0 && (buf[s - 1] === 0x20 || buf[s - 1] === 0x09)) s--;
  const lineStart = s === 0 || buf[s - 1] === 0x0a;
  let k = e;
  while (k < buf.length && (buf[k] === 0x20 || buf[k] === 0x09)) k++;
  const lineEnd = k >= buf.length || buf[k] === 0x0a || buf[k] === 0x0d;
  if (lang === 'python') {
    const block = stmt.parent;
    if (block?.type === 'block' && block.namedChildren.filter((x) => x && x.type !== 'comment').length === 1)
      return splice(text, stmt.startIndex, stmt.endIndex, 'pass');
  }
  if (lineStart && lineEnd) {
    if (buf[k] === 0x0d) k++;
    if (buf[k] === 0x0a) k++;
    return splice(text, s, k, '');
  }
  // Statement followed only by a trailing comment: drop the statement, keep the comment at the same indentation.
  if (lineStart) return splice(text, stmt.startIndex, k, '');
  return splice(text, stmt.startIndex, e, '');
}

const CALLS: Record<Language, Set<string>> = {
  python: new Set(['call']),
  php: new Set(['function_call_expression', 'member_call_expression', 'scoped_call_expression']),
  javascript: new Set(['call_expression']),
  typescript: new Set(['call_expression']),
  tsx: new Set(['call_expression']),
};

/** `uses: owner/repo[/path]@ref` with optional quotes and a trailing comment. */
const USES_LINE =
  /^(\s*(?:-\s+)?uses:\s*)(['"]?)([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)@([A-Za-z0-9_./-]+)\2(\s*(?:#.*)?)$/;

export const FIXERS: Fixer[] = [
  {
    id: 'py-requests-timeout',
    title: 'Add `timeout=30` to the requests call',
    safety: 'review',
    description: 'Adds an explicit 30 second timeout. Long-running downloads may need a larger value.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const call = nodeAt(
        t.tree.rootNode,
        finding,
        (n) => n.type === 'call' && /^requests\./.test(n.childForFieldName('function')?.text ?? ''),
      );
      const args = call?.childForFieldName('arguments');
      if (!call || !args || /\btimeout\s*=/.test(args.text) || args.namedChildren.length === 0) return null;
      const close = args.endIndex - 1;
      const inner = args.text.slice(1, -1);
      const trailingComma = /,\s*$/.test(inner);
      return splice(text, close, close, trailingComma ? ' timeout=30' : ', timeout=30');
    },
  },
  {
    id: 'py-yaml-safe-load',
    title: 'Use `yaml.safe_load`',
    safety: 'safe',
    description: 'Replaces `yaml.load(x)` with `yaml.safe_load(x)`, which only constructs plain data types.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const call = nodeAt(
        t.tree.rootNode,
        finding,
        (n) => n.type === 'call' && /^yaml\.load(?:_all)?$/.test(n.childForFieldName('function')?.text ?? ''),
      );
      const fn = call?.childForFieldName('function');
      if (!call || !fn || call.childForFieldName('arguments')!.namedChildren.length !== 1) return null;
      return splice(
        text,
        fn.startIndex,
        fn.endIndex,
        fn.text === 'yaml.load' ? 'yaml.safe_load' : 'yaml.safe_load_all',
      );
    },
  },
  {
    id: 'py-bare-except',
    title: 'Catch `Exception` instead of everything',
    safety: 'safe',
    description: 'Turns `except:` into `except Exception:` so KeyboardInterrupt/SystemExit propagate.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const ex = nodeAt(t.tree.rootNode, finding, new Set(['except_clause']));
      if (!ex || !/^except\s*:/.test(ex.text)) return null;
      return splice(
        text,
        ex.startIndex,
        ex.startIndex + Buffer.byteLength(/^except\s*:/.exec(ex.text)![0]),
        'except Exception:',
      );
    },
  },
  {
    id: 'py-remove-breakpoint',
    title: 'Remove the breakpoint',
    safety: 'safe',
    description: 'Deletes the `breakpoint()`/`pdb.set_trace()` statement.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const stmt = nodeAt(
        t.tree.rootNode,
        finding,
        (n) =>
          n.type === 'expression_statement' &&
          /^(?:breakpoint|i?pdb\.set_trace|pudb\.set_trace)\(\)$/.test(n.text.trim()),
      );
      return stmt ? removeStatement(text, stmt, 'python') : null;
    },
  },
  {
    id: 'py-flask-debug-off',
    title: 'Turn off Flask debug mode',
    safety: 'review',
    description:
      'Changes `app.run(debug=True)` to read the flag from the `FLASK_DEBUG` environment variable (off by default).',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const call = nodeAt(
        t.tree.rootNode,
        finding,
        (n) => n.type === 'call' && /\.run$/.test(n.childForFieldName('function')?.text ?? ''),
      );
      if (!call) return null;
      const kw = collect(call, 'keyword_argument').find(
        (k) => k.childForFieldName('name')?.text === 'debug' && k.childForFieldName('value')?.text === 'True',
      );
      const v = kw?.childForFieldName('value');
      if (!v) return null;
      let out = splice(text, v.startIndex, v.endIndex, 'os.environ.get("FLASK_DEBUG") == "1"');
      if (!/^\s*import os\b|^\s*import [\w, ]*\bos\b/m.test(out)) out = `import os\n${out}`;
      return out;
    },
  },
  {
    id: 'py-queryset-count',
    title: 'Count in the database',
    safety: 'safe',
    description: 'Replaces `len(queryset)` with `queryset.count()` (same number, one `COUNT(*)` query).',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const call = nodeAt(
        t.tree.rootNode,
        finding,
        (n) => n.type === 'call' && n.childForFieldName('function')?.text === 'len',
      );
      const arg = call?.childForFieldName('arguments')?.namedChildren[0];
      if (!call || !arg || !/\.objects\./.test(arg.text)) return null;
      return splice(text, call.startIndex, call.endIndex, `${arg.text}.count()`);
    },
  },
  {
    id: 'php-unserialize-allowed-classes',
    title: 'Forbid object instantiation in `unserialize()`',
    safety: 'review',
    description:
      "Adds `['allowed_classes' => false]`. Code that intentionally unserializes objects must list the allowed classes instead.",
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const call = nodeAt(
        t.tree.rootNode,
        finding,
        (n) =>
          n.type === 'function_call_expression' &&
          /^\\?unserialize$/.test(n.childForFieldName('function')?.text ?? ''),
      );
      const args = call?.childForFieldName('arguments');
      if (!call || !args || args.namedChildren.filter((x) => x?.type === 'argument').length !== 1)
        return null;
      return splice(text, args.endIndex - 1, args.endIndex - 1, ", ['allowed_classes' => false]");
    },
  },
  {
    id: 'php-remove-debug-call',
    title: 'Remove the debug dump',
    safety: 'safe',
    description: 'Deletes the `dd()`/`dump()`/`var_dump()` statement.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const stmt = nodeAt(
        t.tree.rootNode,
        finding,
        (n) =>
          n.type === 'expression_statement' &&
          /^\\?(?:dd|dump|var_dump|print_r|var_export|ray|ddd)\s*\(/.test(n.text.trim()),
      );
      return stmt ? removeStatement(text, stmt, 'php') : null;
    },
  },
  {
    id: 'php-count-query',
    title: 'Count in the database',
    safety: 'safe',
    description:
      'Replaces `->get()->count()` with `->count()` and `Model::all()->count()` with `Model::count()`.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const call = nodeAt(
        t.tree.rootNode,
        finding,
        (n) => n.type === 'member_call_expression' && n.childForFieldName('name')?.text === 'count',
      );
      const inner = call?.childForFieldName('object');
      if (!call || !inner) return null;
      const info = callInfo(inner, 'php');
      if (!info) return null;
      if (info.name === 'get' && inner.type === 'member_call_expression') {
        const base = inner.childForFieldName('object')!;
        return splice(text, call.startIndex, call.endIndex, `${base.text}->count()`);
      }
      if (info.name === 'all' && inner.type === 'scoped_call_expression')
        return splice(
          text,
          call.startIndex,
          call.endIndex,
          `${inner.childForFieldName('scope')!.text}::count()`,
        );
      return null;
    },
  },
  {
    id: 'js-remove-debugger',
    title: 'Remove the `debugger` statement',
    safety: 'safe',
    description: 'Deletes the `debugger;` statement.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const stmt = nodeAt(t.tree.rootNode, finding, new Set(['debugger_statement']));
      return stmt ? removeStatement(text, stmt, t.lang) : null;
    },
  },
  {
    id: 'js-remove-only',
    title: 'Remove `.only`',
    safety: 'safe',
    description: 'Turns `it.only(...)`/`describe.only(...)` back into normal tests so the full suite runs.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const member = nodeAt(
        t.tree.rootNode,
        finding,
        (n) =>
          n.type === 'member_expression' &&
          n.childForFieldName('property')?.text === 'only' &&
          /^(?:it|test|describe|context|suite|specify)$/.test(n.childForFieldName('object')?.text ?? ''),
      );
      if (!member) return null;
      const obj = member.childForFieldName('object')!;
      return splice(text, obj.endIndex, member.endIndex, '');
    },
  },
  {
    id: 'tls-verify-enable',
    title: 'Re-enable TLS certificate verification',
    safety: 'review',
    description:
      'Restores certificate verification. Environments with private CAs must configure the CA bundle instead.',
    async apply({ path, text, finding }) {
      const t = await treeFor(path, text);
      if (!t) return null;
      const lang = t.lang;
      if (lang === 'python') {
        const call = nodeAt(t.tree.rootNode, finding, CALLS.python);
        const kw =
          call &&
          collect(call, 'keyword_argument').find(
            (k) =>
              k.childForFieldName('name')?.text === 'verify' &&
              k.childForFieldName('value')?.text === 'False',
          );
        const v = kw?.childForFieldName('value');
        return v ? splice(text, v.startIndex, v.endIndex, 'True') : null;
      }
      if (lang === 'php') {
        const n = nodeAt(
          t.tree.rootNode,
          finding,
          (x) => x.type === 'function_call_expression' || x.type === 'array_element_initializer',
        );
        if (!n) return null;
        if (n.type === 'array_element_initializer') {
          const v = n.namedChildren[1];
          return v && /^(?:false|0)$/i.test(v.text) ? splice(text, v.startIndex, v.endIndex, 'true') : null;
        }
        const args =
          n.childForFieldName('arguments')?.namedChildren.filter((x) => x?.type === 'argument') ?? [];
        const opt = args[1]?.text ?? '';
        const v = args[2];
        if (!v || !/^(?:false|0)$/i.test(v.text)) return null;
        return splice(text, v.startIndex, v.endIndex, /VERIFYHOST/.test(opt) ? '2' : 'true');
      }
      const pair = nodeAt(
        t.tree.rootNode,
        finding,
        (n) =>
          n.type === 'pair' &&
          /^['"]?(?:rejectUnauthorized|strictSSL)['"]?$/.test(n.childForFieldName('key')?.text ?? ''),
      );
      const v = pair?.childForFieldName('value');
      return v && v.text === 'false' ? splice(text, v.startIndex, v.endIndex, 'true') : null;
    },
  },
  {
    id: 'gha-permissions-read',
    title: 'Restrict workflow token to read-only',
    safety: 'review',
    description:
      'Adds a top-level `permissions: contents: read` block. Jobs that need more must declare it explicitly.',
    async apply({ text }) {
      if (/^permissions:/m.test(text)) return null;
      const m = /^jobs:\s*$/m.exec(text);
      if (!m) return null;
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      return `${text.slice(0, m.index)}permissions:${eol}  contents: read${eol}${eol}${text.slice(m.index)}`;
    },
  },
  {
    id: 'gha-pin-action',
    title: 'Pin GitHub Actions to the commit their tag points to',
    safety: 'review',
    online: true,
    description:
      "Replaces `owner/action@<tag>` with the full commit SHA the tag points to today, resolved from the action's own GitHub repository (`git ls-remote`, needs `--online`), and keeps the tag as a comment so Dependabot/Renovate can update it.",
    async apply({ text, finding, ctx }) {
      if (!ctx?.resolveAction) return null;
      const facts = finding.evidence.facts ?? {};
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const lines = text.split(eol);
      // A third-party finding targets its own `uses:` line; the aggregated GitHub-owned finding targets every listed
      // action in the file.
      const wanted =
        typeof facts.action === 'string' && typeof facts.ref === 'string'
          ? new Set([`${facts.action}@${facts.ref}`])
          : typeof facts.actions === 'string'
            ? new Set(facts.actions.split(','))
            : null;
      if (!wanted) return null;
      const only = typeof facts.action === 'string' ? (finding.location?.line ?? 0) - 1 : -1;
      let changed = false;
      for (let i = 0; i < lines.length; i++) {
        if (only >= 0 && i !== only) continue;
        const m = USES_LINE.exec(lines[i]!);
        if (!m || !wanted.has(`${m[3]}@${m[4]}`) || /^[0-9a-f]{40}$/.test(m[4]!)) continue;
        const pin = await ctx.resolveAction(m[3]!, m[4]!);
        const comment = m[5]?.trim() ? m[5] : ` # ${m[4]}`;
        lines[i] = `${m[1]}${m[2]}${m[3]}@${pin.sha}${m[2]}${comment}`;
        changed = true;
      }
      return changed ? lines.join(eol) : null;
    },
  },
  {
    id: 'gitignore-env',
    title: 'Ignore local environment files',
    safety: 'safe',
    description: 'Adds `.env`, `.env.*` (keeping `.env.example`) to `.gitignore`.',
    target: () => '.gitignore',
    async apply({ text }) {
      const has = (p: string) => text.split(/\r?\n/).some((l) => l.trim() === p || l.trim() === `/${p}`);
      const add = ['.env', '.env.*', '!.env.example'].filter((p) => !has(p));
      if (!add.length || (has('.env') && has('.env.*'))) return null;
      const sep = text === '' || text.endsWith('\n') ? '' : '\n';
      return `${text}${sep}${text ? '\n' : ''}# Local environment files (added by Relivaro)\n${add.join('\n')}\n`;
    },
  },
];

export function findFixer(id: string): Fixer | undefined {
  return FIXERS.find((f) => f.id === id);
}
