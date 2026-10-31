import { spawnSync } from 'node:child_process';
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
