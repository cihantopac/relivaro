import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runAudit } from '../../src/audit.js';
import { collect, walk } from '../../src/parse/ast.js';
import { parse } from '../../src/parse/treesitter.js';

describe('isSafePart', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  async function sqlHitsIn(source: string) {
    const root = mkdtempSync(join(tmpdir(), 'rlv-sql-'));
    dirs.push(root);
    writeFileSync(join(root, 'q.ts'), source);
    const { run } = await runAudit({
      root,
      command: 'audit',
      noWrite: true,
      useGit: false,
      rules: ['sec/sql-injection'],
    });
    return run.findings.filter((f) => f.ruleId === 'sec/sql-injection');
  }
  const sqlHits = (body: string) =>
    sqlHitsIn(
      `export async function f(pool: any, id: string, lock: boolean, cond: boolean, a: string, params: unknown[], rows: any[]) {\n${body}\n}\n`,
    );
  const constant = [
    "await pool.query(`SELECT * FROM t WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);",
    'await pool.query(`SELECT * FROM t WHERE id = $${params.length + 1}`, [...params, id]);',
    "await pool.query(`SELECT ${['a', 'b'].map((c) => `\"${c}\"`).join(',')} FROM t WHERE id = $1`, [id]);",
    "const COLS = ['id', 'name'];\nawait pool.query(`SELECT ${COLS.map((c) => c).join(', ')} FROM t WHERE id = $1`, [id]);",
  ];
  for (const body of constant)
    it(`constant: ${body.split('\n').pop()!.slice(0, 70)}`, async () => {
      expect(await sqlHits(body)).toEqual([]);
    });
  it('a ternary with a tainted branch is reported high', async () => {
    const hits = await sqlHitsIn(
      "import express from 'express';\nconst app = express();\napp.get('/x', async (req, res) => {\n  const lock = req.query.l === '1';\n  res.json(await pool.query(`SELECT * FROM t ${lock ? 'FOR UPDATE' : req.query.x}`));\n});\n",
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('high');
  });
  it('a ternary with a parameter branch is reported', async () => {
    const hits = await sqlHits("await pool.query(`SELECT * FROM t WHERE x = ${cond ? a : 'x'}`);");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('medium');
  });
  it('map-join over a parameter is reported', async () => {
    expect(
      await sqlHits("await pool.query(`SELECT ${rows.map((r) => r.name).join(',')} FROM t`);"),
    ).toHaveLength(1);
  });
  const route = (body: string) =>
    sqlHitsIn(
      `import express from 'express';\nconst app = express();\napp.get('/x', async (req, res) => {\n${body}\n});\n`,
    );
  it('a variable assigned from req.query.count is not a constant number', async () => {
    const hits = await route(
      '  const limit = req.query.count;\n  res.json(await pool.query(`SELECT * FROM t LIMIT ${limit}`));',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.severity).toBe('high');
  });
  it('a ternary with a req.query.size branch is not constant', async () => {
    const hits = await route(
      "  const order = req.query.dir ? req.query.size : 'ASC';\n  res.json(await pool.query(`SELECT * FROM t ORDER BY id ${order}`));",
    );
    expect(hits).toHaveLength(1);
  });
});

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
