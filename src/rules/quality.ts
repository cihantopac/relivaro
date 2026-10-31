import type { Language } from '../core/types.js';
import { collect, FUNCTION_TYPES, functionName, isJs, walk } from '../parse/ast.js';
import type { Node } from '../parse/treesitter.js';
import { ALL_LANGS, type AstRule, type FileRule, type Hit, JS_LANGS } from './types.js';

const debugLeftover: AstRule = {
  kind: 'ast',
  id: 'qual/debug-statement',
  title: 'Debugging statement left in code',
  category: 'quality',
  severity: 'medium',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-489'],
  description:
    'Application code contains a debugger breakpoint or dump call (`debugger`, `dd()`, `dump()`, `var_dump()`, `breakpoint()`, `pdb.set_trace()`).',
  impact:
    '`dd()`/breakpoints halt requests in production; dumps leak internal data (models, credentials, queries) to users.',
  recommendation: 'Remove the statement; use the logger at debug level for diagnostics that should stay.',
  verification: 'Search the codebase for the statement and run the test suite.',
  check(ctx) {
    if (ctx.file.isTest) return [];
    const out: Hit[] = [];
    if (isJs(ctx.lang)) {
      for (const n of collect(ctx.tree.rootNode, 'debugger_statement'))
        out.push({ node: n, message: '`debugger` statement.', fixer: 'js-remove-debugger' });
    } else if (ctx.lang === 'php') {
      if (/(?:^|\/)(?:config|routes\/console|database\/seeders)\//.test(ctx.file.path)) return out;
      for (const c of ctx.calls)
        if (
          /^(?:dd|dump|var_dump|ray|ddd|dumps)$/.test(c.callee) ||
          (c.callee === 'print_r' && c.args.length === 1) ||
          (c.callee === 'var_export' && c.args.length === 1)
        )
          out.push({
            node: c.node,
            message: `\`${c.callee}()\` debug output left in code.`,
            fixer: c.node.parent?.type === 'expression_statement' ? 'php-remove-debug-call' : null,
          });
    } else {
      for (const c of ctx.calls)
        if (/^(?:breakpoint|pdb\.set_trace|ipdb\.set_trace|pudb\.set_trace)$/.test(c.callee))
          out.push({
            node: c.node,
            message: `\`${c.callee}()\` breakpoint left in code.`,
            fixer: c.node.parent?.type === 'expression_statement' ? 'py-remove-breakpoint' : null,
          });
    }
    return out;
  },
};

const focusedTest: AstRule = {
  kind: 'ast',
  id: 'test/focused-test',
  title: 'Focused test (`.only`) committed',
  category: 'testing',
  severity: 'high',
  confidence: 'high',
  languages: [...JS_LANGS, 'php'],
  tags: ['test-aware'],
  description:
    'A test or suite is focused with `.only` / `fit` / `fdescribe` (or Pest `->only()`), so the runner silently skips every other test.',
  impact: 'CI reports green while most of the suite does not run; regressions ship undetected.',
  recommendation:
    'Remove the focus modifier. Enable `--forbid-only` (Mocha/Playwright) or Vitest/Jest `allowOnly: false` in CI.',
  verification: 'Run the suite and confirm the total number of executed tests matches the full suite.',
  check(ctx) {
    if (!ctx.file.isTest) return [];
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      if (isJs(ctx.lang)) {
        if (
          /^(?:it|test|describe|context|suite|specify)\.only$/.test(c.callee) ||
          /^(?:fit|fdescribe|fcontext)$/.test(c.callee)
        )
          out.push({
            node: c.node.childForFieldName('function') ?? c.node,
            message: `\`${c.callee}\` focuses the run on this test.`,
            fixer: /\.only$/.test(c.callee) ? 'js-remove-only' : null,
          });
      } else if (c.name === 'only' && c.args.length === 0 && /^(?:it|test|describe)\(/.test(c.node.text)) {
        out.push({ node: c.node, message: 'Pest `->only()` focuses the run on this test.' });
      }
    }
    return out;
  },
};

const skippedTests: AstRule = {
  kind: 'ast',
  id: 'test/skipped-tests',
  title: 'Skipped tests',
  category: 'testing',
  severity: 'info',
  confidence: 'high',
  languages: ALL_LANGS,
  tags: ['test-aware'],
  description:
    'Tests are skipped unconditionally (`it.skip`, `xit`, `markTestSkipped`, `@pytest.mark.skip`).',
  impact: 'Skipped tests give a false sense of coverage and often hide known regressions.',
  recommendation:
    'Fix or delete skipped tests; skip conditionally (platform/feature flags) with a tracked reason.',
  verification: 'The skipped-test count trends to zero across runs (`relivaro compare`).',
  check(ctx) {
    if (!ctx.file.isTest) return [];
    let count = 0;
    let first: Node | undefined;
    for (const c of ctx.calls) {
      const skip = isJs(ctx.lang)
        ? /^(?:it|test|describe|context)\.skip$/.test(c.callee) || /^(?:xit|xdescribe|xtest)$/.test(c.callee)
        : ctx.lang === 'php'
          ? /^\$this->markTestSkipped$/.test(c.callee) ||
            (c.name === 'skip' && /^(?:it|test)\(/.test(c.node.text))
          : /^(?:pytest\.skip|self\.skipTest|unittest\.skip)$/.test(c.callee);
      if (skip) {
        count++;
        first ??= c.node;
      }
    }
    if (ctx.lang === 'python')
      for (const d of collect(ctx.tree.rootNode, 'decorator'))
        if (/^@(?:pytest\.mark\.skip|unittest\.skip)\b(?!If|_if)/.test(d.text)) {
          count++;
          first ??= d;
        }
    return count
      ? [
          {
            node: first,
            message: `${count} test(s) skipped unconditionally in this file.`,
            anchor: `skips:${ctx.file.path}`,
            facts: { count },
          },
        ]
      : [];
  },
};

const DECISION_TYPES: Record<'js' | 'php' | 'python', Set<string>> = {
  js: new Set([
    'if_statement',
    'for_statement',
    'for_in_statement',
    'while_statement',
    'do_statement',
    'switch_case',
    'catch_clause',
    'ternary_expression',
  ]),
  php: new Set([
    'if_statement',
    'else_if_clause',
    'for_statement',
    'foreach_statement',
    'while_statement',
    'do_statement',
    'case_statement',
    'catch_clause',
    'conditional_expression',
    'match_conditional_expression',
  ]),
  python: new Set([
    'if_statement',
    'elif_clause',
    'for_statement',
    'while_statement',
    'except_clause',
    'conditional_expression',
    'if_clause',
    'case_clause',
  ]),
};

export function cyclomaticComplexity(fn: Node, lang: Language): number {
  const set = DECISION_TYPES[isJs(lang) ? 'js' : lang === 'php' ? 'php' : 'python'];
  const fnTypes = FUNCTION_TYPES[lang];
  let n = 1;
  walk(fn, (x) => {
    if (x.id !== fn.id && fnTypes.has(x.type)) return false;
    if (set.has(x.type)) n++;
    else if (x.type === 'binary_expression' || x.type === 'boolean_operator') {
      const op = x.childForFieldName('operator')?.text;
      if (op === '&&' || op === '||' || op === '??' || op === 'and' || op === 'or') n++;
    }
  });
  return n;
}

const complexity: AstRule = {
  kind: 'ast',
  id: 'qual/high-complexity',
  title: 'Function with very high cyclomatic complexity',
  category: 'quality',
  severity: 'low',
  confidence: 'high',
  languages: ALL_LANGS,
  description:
    'A function has a cyclomatic complexity above 25 (number of independent paths through the code).',
  impact:
    'Highly branched functions are where defects concentrate; they are hard to test exhaustively and risky to change.',
  recommendation:
    'Extract cohesive branches into well-named functions, replace conditionals with lookup tables or polymorphism, and add tests for each path before refactoring.',
  verification: 'Re-run `relivaro audit`; complexity drops below the threshold and tests still pass.',
  check(ctx) {
    if (ctx.file.isTest) return [];
    const out: Hit[] = [];
    for (const fn of collect(ctx.tree.rootNode, FUNCTION_TYPES[ctx.lang])) {
      const cc = cyclomaticComplexity(fn, ctx.lang);
      if (cc <= 25) continue;
      const name = functionName(fn) ?? '(anonymous)';
      const lines = fn.endPosition.row - fn.startPosition.row + 1;
      out.push({
        node: fn.childForFieldName('name') ?? fn,
        line: fn.startPosition.row + 1,
        message: `\`${name}\` has cyclomatic complexity ${cc} across ${lines} lines.`,
        severity: cc > 50 ? 'medium' : 'low',
        anchor: `fn:${name}`,
        facts: { complexity: cc, lines },
      });
    }
    return out;
  },
};

const tsNoCheck: FileRule = {
  kind: 'file',
  id: 'qual/type-checking-disabled',
  title: 'Type checking disabled for a whole file',
  category: 'quality',
  severity: 'low',
  confidence: 'high',
  description:
    'A TypeScript/JavaScript source file starts with `// @ts-nocheck`, or a Python module has `# type: ignore` at the top, turning off type checking for the entire file.',
  impact: 'Type errors in the file are invisible to the compiler and CI.',
  recommendation:
    'Remove the directive and fix the reported errors, or suppress narrowly with an explained `@ts-expect-error` on specific lines.',
  verification: '`tsc --noEmit` passes without the file-level directive.',
  appliesTo: (f) =>
    !f.isTest && (f.language === 'typescript' || f.language === 'tsx' || f.language === 'javascript'),
  check(ctx) {
    const head = ctx.lines.slice(0, 10);
    const i = head.findIndex((l) => /^\s*\/\/\s*@ts-nocheck\b/.test(l));
    return i >= 0 ? [{ line: i + 1, message: '`// @ts-nocheck` disables type checking for this file.' }] : [];
  },
};

export const qualityAstRules: AstRule[] = [debugLeftover, focusedTest, skippedTests, complexity];
export const qualityFileRules: FileRule[] = [tsNoCheck];
