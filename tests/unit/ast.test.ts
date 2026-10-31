import { describe, expect, it } from 'vitest';
import { collect, walk } from '../../src/parse/ast.js';
import { parse } from '../../src/parse/treesitter.js';

describe('walk', () => {
  it('visits every node exactly once', async () => {
    const tree = (await parse(
      'typescript',
      'export function f(fs: any) {\n  try {\n    fs.x();\n  } catch (e) {}\n}\nconst y = 2;',
    ))!;
    const types: string[] = [];
    walk(tree.rootNode, (n) => {
      types.push(n.type);
    });
    let count = 0;
    const rec = (n: typeof tree.rootNode) => {
      count++;
      for (const c of n.children) if (c) rec(c);
    };
    rec(tree.rootNode);
    expect(types.length).toBe(count);
    expect(collect(tree.rootNode, 'catch_clause')).toHaveLength(1);
    expect(collect(tree.rootNode, 'lexical_declaration')).toHaveLength(1);
  });

  it('walks a subtree without escaping it', async () => {
    const tree = (await parse('typescript', 'function a() { x(); }\nfunction b() { y(); }'))!;
    const fa = tree.rootNode.namedChildren[0]!;
    const calls = collect(fa, 'call_expression');
    expect(calls.map((c) => c.text)).toEqual(['x()']);
  });
});

describe('node identity', () => {
  it('complexity counts branches inside the function root', async () => {
    const { cyclomaticComplexity } = await import('../../src/rules/quality.js');
    const tree = (await parse(
      'typescript',
      'function f(a, b) { if (a) { return 1; } else if (b && a) { return 2; } for (;;) {} return a ? 1 : 2; }',
    ))!;
    const fn = collect(tree.rootNode, 'function_declaration')[0]!;
    // 1 + if + else-if + && + for + ternary
    expect(cyclomaticComplexity(fn, 'typescript')).toBe(6);
  });

  it('tracks taint through local variables in PHP and Python functions', async () => {
    const { taintedNames } = await import('../../src/parse/ast.js');
    const php = (await parse(
      'php',
      '<?php function f($request) { $name = $request->input("n"); $q = "x" . $name; return $q; }',
    ))!;
    const fnPhp = collect(php.rootNode, 'function_definition')[0]!;
    expect([...taintedNames(fnPhp, 'php')].sort()).toEqual(['$name', '$q']);
    const py = (await parse(
      'python',
      'def f():\n    cmd = request.args.get("c")\n    full = "ls " + cmd\n    return full\n',
    ))!;
    const fnPy = collect(py.rootNode, 'function_definition')[0]!;
    expect([...taintedNames(fnPy, 'python')].sort()).toEqual(['cmd', 'full']);
  });
});
