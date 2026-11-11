import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { materialize, ROOT } from '../helpers/fixtures.js';

const CLI = join(ROOT, 'plugin', 'dist', 'relivaro.mjs');

function cli(args: string[], cwd = ROOT, env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

let fx: ReturnType<typeof materialize>;
beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('Run `npm run build` before the e2e tests.');
  fx = materialize('node-api');
});
afterAll(() => fx.cleanup());

describe('relivaro CLI', () => {
  it('--progress ndjson writes ordered stage events to stderr, even with --json', () => {
    const a = cli(['audit', fx.dir, '--json', '--progress', 'ndjson', '--no-write']);
    expect(a.code).toBe(0);
    expect(() => JSON.parse(a.stdout)).not.toThrow();
    const lines = a.stderr.split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const events = lines.map((l) => JSON.parse(l));
    const stages = events.filter((e) => e.type === 'stage').map((e) => `${e.stage}:${e.state}`);
    expect(stages).toEqual([
      'index:start',
      'index:end',
      'discover:start',
      'discover:end',
      'analyse:start',
      'analyse:end',
      'checks:start',
      'checks:end',
    ]);
    for (const e of events.filter((x) => x.type === 'stage')) expect(typeof e.elapsedMs).toBe('number');
    const files = events.filter((e) => e.type === 'files');
    expect(files.length).toBeGreaterThan(0);
    expect(files[files.length - 1].done).toBe(files[files.length - 1].total);
  });

  it('--progress off and --json print nothing on stderr', () => {
    const a = cli(['audit', fx.dir, '--json', '--no-write']);
    expect(a.stderr).toBe('');
    const b = cli(['audit', fx.dir, '--progress', 'off', '--no-write']);
    expect(b.stderr).toBe('');
  });

  it.skipIf(process.platform === 'win32')(
    'SIGTERM writes a partial run record atomically and exits 4',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'rlv-sig-'));
      const ws = mkdtempSync(join(tmpdir(), 'rlv-sig-ws-'));
      try {
        for (let i = 0; i < 20_000; i++) writeFileSync(join(dir, `f${i}.js`), `export const x${i} = ${i};\n`);
        const child = spawn(process.execPath, [CLI, 'audit', dir, '--no-git', '--workspace', ws, '--quiet'], {
          env: { ...process.env, NO_COLOR: '1' },
          stdio: 'ignore',
        });
        const code: number | null = await new Promise((resolve) => {
          setTimeout(() => child.kill('SIGTERM'), 300);
          child.on('exit', (c) => resolve(c));
        });
        expect(code).toBe(4);
        const runs = readdirSync(join(ws, 'runs'));
        expect(runs).toHaveLength(1);
        const files = readdirSync(join(ws, 'runs', runs[0]!));
        expect(files.some((f) => f.endsWith('.tmp'))).toBe(false);
        const run = JSON.parse(readFileSync(join(ws, 'runs', runs[0]!, 'run.json'), 'utf8'));
        expect(run.partial.reason).toBe('signal');
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(ws, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it('prints help and version', () => {
    const h = cli(['--help']);
    expect(h.code).toBe(0);
    for (const c of [
      'audit',
      'security',
      'performance',
      'reliability',
      'test',
      'release',
      'fix',
      'bench',
      'load',
      'contract',
    ])
      expect(h.stdout).toContain(c);
    expect(cli(['version']).stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(cli(['audit', '--help']).stdout).toContain('--fail-on');
  });

  it('re-renders the latest run with the default formats and shows a rule by id', () => {
    const ws = mkdtempSync(join(tmpdir(), 'relivaro-ws-'));
    try {
      expect(cli(['audit', fx.dir, '--workspace', ws, '--format', 'json']).code).not.toBe(2);
      const r = cli(['report', '--path', fx.dir, '--workspace', ws]);
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/report\.md/);
      expect(r.stdout).toMatch(/report\.html/);
      const rule = cli(['rules', 'sec/hardcoded-secret']);
      expect(rule.code).toBe(0);
      expect(rule.stdout).toMatch(/^sec\/hardcoded-secret — /);
      expect(cli(['rules', 'no-such-rule']).code).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('uses exit code 2 for usage errors, with JSON errors on stderr in --json mode', () => {
    const r = cli(['audit', '--bogus']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown option --bogus');
    const j = cli(['nope', '--json']);
    expect(j.code).toBe(2);
    expect(JSON.parse(j.stderr).error.code).toBe('USAGE');
    expect(cli(['audit', '/definitely/not/here']).code).toBe(2);
  });

  it('audits, writes reports and honours --fail-on', () => {
    const ok = cli(['audit', fx.dir, '--format', 'json,md,html,sarif', '--quiet']);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/open findings/);
    const runs = join(fx.dir, '.relivaro', 'runs');
    expect(readFileSync(join(fx.dir, '.relivaro', '.gitignore'), 'utf8')).toContain('*');
    const id = readdirSync(runs)[0]!;
    for (const f of ['run.json', 'report.json', 'report.md', 'report.html', 'report.sarif'])
      expect(existsSync(join(runs, id, f))).toBe(true);
    const sarif = JSON.parse(readFileSync(join(runs, id, 'report.sarif'), 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.length).toBeGreaterThan(10);
    expect(cli(['security', fx.dir, '--fail-on', 'high', '--no-write', '--quiet']).code).toBe(1);
    expect(cli(['performance', fx.dir, '--fail-on', 'critical', '--no-write', '--quiet']).code).toBe(0);
  });

  it('the Next: hint quotes a path with shell metacharacters', () => {
    // `|` is not a valid file name character on Windows.
    for (const ch of process.platform === 'win32' ? ['&', ';'] : ['&', ';', '|']) {
      const dir = mkdtempSync(join(tmpdir(), `rlv a${ch}b-`.replace(' ', '')));
      try {
        writeFileSync(join(dir, 'index.js'), 'console.log(1);\n');
        const a = cli(['audit', dir, '--no-write', '--no-git']);
        expect(a.stdout).toContain(`Next: relivaro release '${dir}' for a release verdict`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('prints a coverage line for every run', () => {
    const a = cli(['audit', fx.dir, '--no-write']);
    expect(a.stdout).toMatch(/^Coverage: security \d+ rules\/\d+ files · /m);
  });

  it('rules list --json exports the full rule metadata as a stable shape', () => {
    const r = cli(['rules', 'list', '--json']);
    const rules = JSON.parse(r.stdout);
    expect(rules.length).toBeGreaterThan(80);
    const shape = [
      'id',
      'category',
      'severity',
      'confidence',
      'cwe',
      'owasp',
      'fixer',
      'title',
      'description',
      'impact',
      'recommendation',
      'verification',
    ].sort();
    for (const rule of rules) expect(Object.keys(rule).sort(), rule.id).toEqual(shape);
    expect(rules.every((x: { description: string }) => x.description.length > 10)).toBe(true);
  });

  it('suggests a baseline after an audit with findings, and counts baseline findings afterwards (baseline hint)', () => {
    const own = materialize('python-app');
    try {
      const first = cli(['audit', own.dir, '--no-write']);
      expect(first.stdout).toContain(
        `Next: relivaro baseline ${own.dir} to track only new findings from now on.`,
      );
      expect(cli(['baseline', own.dir, '--reason', 'accepted for now']).code).toBe(0);
      const second = cli(['audit', own.dir, '--no-write']);
      expect(second.stdout).toMatch(/\d+ findings in baseline \(not shown\)/);
      expect(second.stdout).not.toContain('Next: relivaro baseline');
    } finally {
      own.cleanup();
    }
  });

  it('audit ends with the release next step and an explicit offline OSV disclosure', () => {
    const a = cli(['audit', fx.dir, '--no-write']);
    expect(a.code).toBe(0);
    // Windows temp paths contain `\` (and often `~`), which the hint quotes for the shell.
    const shown = /[\\~]/.test(fx.dir) ? `'${fx.dir}'` : fx.dir;
    expect(a.stdout).toContain(
      `Next: relivaro release ${shown} for a release verdict (add --allow-exec --online to verify more)`,
    );
    const run = JSON.parse(cli(['audit', fx.dir, '--no-write', '--json']).stdout);
    expect(JSON.stringify(run)).not.toContain('Next:');
    expect(run.limitations).toContain(
      `Known vulnerabilities in ${run.metrics.dependencies} locked package(s) were not checked (offline). --online sends only ecosystem, package name and version to OSV.dev — no source code.`,
    );
    const r = cli(['release', fx.dir, '--no-write']);
    expect(r.stdout).not.toContain('Next:');
    const rel = JSON.parse(cli(['release', fx.dir, '--no-write', '--json']).stdout);
    expect(rel.release.gates.find((g: { id: string }) => g.id === 'dependencies').detail).toBe(
      `Not checked (offline). --online sends only ecosystem, package name and version to OSV.dev — no source code.`,
    );
    expect(cli(['audit', '--help']).stdout).toContain('Boolean flags can be negated: --no-<flag>.');
  });

  it('emits a machine-readable run with --json and --workspace keeps the project untouched', () => {
    const ws = mkdtempSync(join(tmpdir(), 'relivaro-ws-'));
    try {
      const r = cli(['reliability', fx.dir, '--json', '--workspace', ws]);
      expect(r.code).toBe(0);
      const run = JSON.parse(r.stdout);
      expect(run.schemaVersion).toBe(1);
      expect(run.options.categories).toEqual(['reliability']);
      expect(run.findings.every((f: { category: string }) => f.category === 'reliability')).toBe(true);
      expect(existsSync(join(ws, 'runs'))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('discover, rules and doctor work', () => {
    const d = cli(['discover', fx.dir, '--json']);
    expect(JSON.parse(d.stdout).technologies.map((t: { name: string }) => t.name)).toContain('Express');
    const rules = JSON.parse(cli(['rules', '--json']).stdout);
    expect(rules.length).toBeGreaterThan(60);
    expect(cli(['rules', 'show', 'sec/sql-injection']).stdout).toContain('CWE-89');
    expect(cli(['rules', 'show', 'nope/x']).code).toBe(2);
    expect(cli(['doctor', '--json']).code).toBe(0);
  });

  it('release reports gates and fails when not ready', () => {
    const r = cli(['release', fx.dir, '--no-write']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('NOT READY');
    expect(r.stdout).toMatch(/blocker/);
    const j = JSON.parse(cli(['release', fx.dir, '--no-write', '--json']).stdout);
    expect(j.release.status).toBe('not-ready');
    expect(j.release.score).toBeLessThanOrEqual(40);
  });

  it('compare and baseline flows', () => {
    const p = materialize('python-app');
    try {
      cli(['audit', p.dir, '--quiet']);
      writeFileSync(join(p.dir, 'extra.py'), 'import yaml\n\ndef f(x):\n    return yaml.load(x)\n');
      cli(['audit', p.dir, '--quiet']);
      const c = cli(['compare', '--path', p.dir, '--fail-on', 'high', '--json']);
      expect(c.code).toBe(1);
      expect(JSON.parse(c.stdout).introduced.map((f: { ruleId: string }) => f.ruleId)).toContain(
        'sec/unsafe-deserialization',
      );
      expect(cli(['baseline', p.dir]).code).toBe(0);
      const after = JSON.parse(cli(['security', p.dir, '--json', '--no-write']).stdout);
      expect(after.summary.open).toBe(0);
      expect(after.summary.baseline).toBeGreaterThan(0);
      expect(cli(['security', p.dir, '--fail-on', 'low', '--no-write', '--quiet']).code).toBe(0);
    } finally {
      p.cleanup();
    }
  });

  it('fix plan / apply / rollback via the CLI', () => {
    const p = materialize('python-app');
    try {
      const plan = JSON.parse(cli(['fix', 'plan', p.dir, '--json']).stdout);
      expect(plan.items.length).toBeGreaterThan(0);
      expect(cli(['fix', 'apply', 'latest', '--path', p.dir]).code).toBe(2);
      const applied = JSON.parse(cli(['fix', 'apply', 'latest', '--path', p.dir, '--yes', '--json']).stdout);
      expect(applied.verification.verdict).toBe('static-only');
      expect(cli(['fix', 'rollback', 'latest', '--path', p.dir]).code).toBe(0);
      expect(
        spawnSync('git', ['status', '--porcelain'], { cwd: p.dir, encoding: 'utf8' }).stdout.trim(),
      ).toBe('');
    } finally {
      p.cleanup();
    }
  });

  it('contract validate and diff', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relivaro-api-'));
    try {
      const v1 = {
        openapi: '3.0.3',
        info: { title: 'A', version: '1' },
        paths: {
          '/a': { get: { responses: { '200': { description: 'ok' } } } },
          '/b': { get: { responses: { '200': { description: 'ok' } } } },
        },
      };
      const v2 = { ...v1, paths: { '/a': v1.paths['/a'] } };
      writeFileSync(join(dir, 'v1.json'), JSON.stringify(v1));
      writeFileSync(join(dir, 'v2.json'), JSON.stringify(v2));
      expect(cli(['contract', 'validate', join(dir, 'v1.json')]).code).toBe(0);
      const d = cli(['contract', 'diff', join(dir, 'v1.json'), join(dir, 'v2.json')]);
      expect(d.code).toBe(1);
      expect(d.stdout).toContain('BREAKING');
      expect(cli(['contract', 'diff', join(dir, 'v2.json'), join(dir, 'v1.json')]).code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bench requires --allow-exec and measures a command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relivaro-bench-'));
    try {
      const cmd = `${JSON.stringify(process.execPath)} -e "let s=0;for(let i=0;i<1e5;i++)s+=i"`;
      expect(cli(['bench', dir, '--cmd', cmd, '--runs', '3']).code).toBe(2);
      const r = JSON.parse(
        cli([
          'bench',
          dir,
          '--cmd',
          cmd,
          '--runs',
          '3',
          '--warmup',
          '0',
          '--name',
          'loop',
          '--allow-exec',
          '--json',
        ]).stdout,
      );
      expect(r.stats.n).toBe(3);
      expect(r.stats.meanMs).toBeGreaterThan(0);
      const again = JSON.parse(
        cli([
          'bench',
          dir,
          '--cmd',
          cmd,
          '--runs',
          '3',
          '--warmup',
          '0',
          '--name',
          'loop',
          '--allow-exec',
          '--json',
        ]).stdout,
      );
      expect(again.comparison).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('load tests a local server and refuses public targets', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), 'relivaro-load-'));
    try {
      const { spawn } = await import('node:child_process');
      const out = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            CLI,
            'load',
            `http://127.0.0.1:${port}/`,
            '--duration',
            '1',
            '--concurrency',
            '4',
            '--json',
            '--path',
            dir,
          ],
          { env: { ...process.env, NO_COLOR: '1' } },
        );
        let stdout = '';
        child.stdout.on('data', (d) => (stdout += d));
        child.on('close', (code) => resolve({ code, stdout }));
      });
      expect(out.code).toBe(0);
      const r = JSON.parse(out.stdout);
      expect(r.requests).toBeGreaterThan(10);
      expect(r.errors).toBe(0);
      expect(r.statusCodes['200']).toBe(r.requests);
      expect(cli(['load', 'http://1.1.1.1/', '--duration', '1']).code).toBe(2);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init writes a config and an optional workflow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relivaro-init-'));
    try {
      expect(cli(['init', dir, '--github-action']).code).toBe(0);
      expect(JSON.parse(readFileSync(join(dir, 'relivaro.config.json'), 'utf8')).failOn).toBe('high');
      expect(readFileSync(join(dir, '.github/workflows/relivaro.yml'), 'utf8')).toContain('upload-sarif');
      expect(cli(['init', dir]).code).toBe(2);
      writeFileSync(join(dir, 'relivaro.config.json'), '{"failOn": "urgent"}');
      expect(cli(['audit', dir, '--no-write']).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review, recheck and report access', () => {
  it('records reviews, re-renders the report and re-checks findings against changed code', () => {
    const p = materialize('python-app');
    try {
      const a = cli(['audit', p.dir, '--json', '--compact']);
      const run = JSON.parse(a.stdout);
      expect(run.report.html).toMatch(/report\.html$/);
      expect(existsSync(run.report.html)).toBe(true);
      expect(run.report.open).toContain(run.report.html);
      expect(run.remediation.deterministic).toBeGreaterThan(0);
      expect(run.review.unreviewed).toBe(run.summary.open);
      const target = run.findings.find(
        (f: { rule: string; message: string }) =>
          f.rule === 'sec/unsafe-deserialization' && f.message.includes('yaml.load'),
      );
      const other = run.findings.find((f: { id: string; where?: string }) => f.id !== target.id && f.where);

      const r = cli([
        'review',
        'add',
        '--path',
        p.dir,
        '--finding',
        target.id,
        '--verdict',
        'confirmed',
        '--reason',
        'request body reaches yaml.load',
        '--evidence',
        target.where,
        '--reviewer',
        'e2e',
        '--json',
      ]);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).summary.confirmed).toBe(1);
      const html = readFileSync(run.report.html, 'utf8');
      expect(html).toContain('request body reaches yaml.load');
      expect(
        cli([
          'review',
          'add',
          '--path',
          p.dir,
          '--finding',
          'RLV-00000000',
          '--verdict',
          'confirmed',
          '--reason',
          'x y z',
        ]).code,
      ).toBe(2);
      expect(JSON.parse(cli(['review', 'list', '--path', p.dir, '--json']).stdout).entries).toHaveLength(1);

      const before = JSON.parse(
        cli(['recheck', p.dir, '--finding', `${target.id},${other.id}`, '--json']).stdout,
      );
      expect(before.results.map((x: { status: string }) => x.status)).toEqual(['present', 'present']);
      // Fix the deserialization by hand and shift the other finding down a line.
      const file = join(p.dir, 'app.py');
      writeFileSync(
        file,
        `# moved\n${readFileSync(file, 'utf8').replace('yaml.load(request.data)', 'yaml.safe_load(request.data)')}`,
      );
      const after = JSON.parse(
        cli(['recheck', p.dir, '--finding', `${target.id},${other.id}`, '--json']).stdout,
      );
      const byId = Object.fromEntries(
        after.results.map((x: { id: string; status: string }) => [x.id, x.status]),
      );
      expect(byId[target.id]).toBe('gone');
      if (other.where.startsWith('app.py')) expect(byId[other.id]).toBe('moved');

      const plan = JSON.parse(cli(['fix', 'plan', p.dir, '--finding', target.id, '--json']).stdout);
      expect(plan.notes.join(' ')).toMatch(/not found in the current source/);

      const rep = JSON.parse(cli(['report', 'latest', '--path', p.dir, '--json']).stdout);
      expect(rep.open).toContain('report.html');
      expect(
        cli(['recheck', p.dir, '--finding', target.id, '--run', 'latest', '--workspace', join(p.dir, 'nope')])
          .code,
      ).toBe(2);
    } finally {
      p.cleanup();
    }
  });
});

describe('parallel review recording', () => {
  it('keeps every verdict when agents record them concurrently', async () => {
    const p = materialize('python-app');
    try {
      const run = JSON.parse(cli(['audit', p.dir, '--json', '--compact']).stdout);
      const ids: string[] = run.findings.slice(0, 8).map((f: { id: string }) => f.id);
      const codes = await Promise.all(
        ids.map(
          (id) =>
            new Promise<number | null>((done) => {
              const c = spawn(
                process.execPath,
                [
                  CLI,
                  'review',
                  'add',
                  '--path',
                  p.dir,
                  '--finding',
                  id,
                  '--verdict',
                  'confirmed',
                  '--reason',
                  `checked ${id}`,
                ],
                { stdio: 'ignore' },
              );
              c.on('close', done);
            }),
        ),
      );
      expect(codes.every((c) => c === 0)).toBe(true);
      const list = JSON.parse(cli(['review', 'list', '--path', p.dir, '--json']).stdout);
      expect(list.entries.map((e: { findingId: string }) => e.findingId).sort()).toEqual([...ids].sort());
    } finally {
      p.cleanup();
    }
  });
});
