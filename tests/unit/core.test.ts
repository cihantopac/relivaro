import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gateFailed, runAudit } from '../../src/audit.js';
import { parseArgs } from '../../src/cli/args.js';
import { defaultConfig, validateConfig } from '../../src/core/config.js';
import type { RelivaroError } from '../../src/core/errors.js';
import { globToRegExp, matchesAny } from '../../src/core/glob.js';
import { findingId, fingerprint } from '../../src/core/hash.js';
import { isPlaceholder, maskSecret, redact, shannonEntropy } from '../../src/core/secrets.js';
import { splitCommand } from '../../src/exec/runner.js';
import { classify, FileSet, isToolReport } from '../../src/fs/files.js';

describe('config', () => {
  it('accepts a valid config and fills defaults', () => {
    const c = validateConfig({
      exclude: ['legacy/**'],
      failOn: 'high',
      rules: { 'sec/xss': 'off', 'perf/query-in-loop': { severity: 'low' } },
      release: { minCoverage: 70 },
    });
    expect(c.exclude).toEqual(['legacy/**']);
    expect(c.rules['sec/xss']).toBe('off');
    expect(c.release.minCoverage).toBe(70);
    expect(c.release.requireTests).toBe(true);
  });
  it.each([
    [{ unknown: 1 }, /unknown key/],
    [{ failOn: 'urgent' }, /failOn/],
    [{ rules: { x: 'on' } }, /rules\.x/],
    [{ maxFileSizeKb: 0 }, /maxFileSizeKb/],
    [{ commands: { deploy: 'x' } }, /not a known command/],
    [{ release: { blockOn: 'low' } }, /blockOn/],
    [{ performance: { budgets: { api: { p95: 3 } } } }, /unknown/],
    [[], /object/],
  ])('rejects %j', (raw, msg) => {
    expect(() => validateConfig(raw)).toThrow(msg);
    try {
      validateConfig(raw);
    } catch (e) {
      expect((e as RelivaroError).exitCode).toBe(2);
    }
  });
  it('has sane defaults', () => {
    expect(defaultConfig().failOn).toBe('none');
  });
});

describe('glob', () => {
  it.each([
    ['src/**/*.ts', 'src/a/b/c.ts', true],
    ['src/**/*.ts', 'lib/a.ts', false],
    ['*.min.js', 'public/js/app.min.js', true],
    ['legacy/', 'legacy/x/y.php', true],
    ['{app,lib}/*.py', 'lib/x.py', true],
    ['tests/**', 'src/tests.ts', false],
    ['**/fixtures/**', 'a/fixtures/b.json', true],
  ])('%s vs %s → %s', (g, p, r) => expect(globToRegExp(g).test(p)).toBe(r));
  it('matchesAny', () => expect(matchesAny('docs/x.md', ['src/**', 'docs/**'])).toBe(true));
});

describe('fingerprints', () => {
  it('are stable across whitespace changes and differ by occurrence', () => {
    expect(fingerprint('r', 'f', 'a  =  b', 0)).toBe(fingerprint('r', 'f', 'a = b', 0));
    expect(fingerprint('r', 'f', 'a = b', 0)).not.toBe(fingerprint('r', 'f', 'a = b', 1));
    expect(findingId('abcdef0123456789')).toBe('RLV-abcdef01');
  });
});

describe('secrets', () => {
  const gh = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  const aws = ['AK', 'IA', 'Q7R2T9W3E5Y1U8P4'].join('');
  it('redacts provider tokens and generic secrets, idempotently', () => {
    const text = `token=${gh}\naws ${aws}\npassword = "Xk9mP2vQ8zLw4r"\n-----BEGIN RSA PRIVATE KEY-----`;
    const out = redact(text);
    expect(out).not.toContain(gh);
    expect(out).not.toContain(aws);
    expect(out).not.toContain('Xk9mP2vQ8zLw4r');
    expect(out).toContain('[REDACTED]');
    expect(redact(out)).toBe(out);
  });
  it('keeps placeholders', () => {
    expect(redact('password = "changeme"')).toBe('password = "changeme"');
    expect(isPlaceholder('your-api-key-here')).toBe(true);
    expect(isPlaceholder('${DB_PASSWORD}')).toBe(true);
    expect(isPlaceholder('q8Zx2LmP')).toBe(false);
  });
  it('masks and measures entropy', () => {
    expect(maskSecret('AKIAABCDEFGHIJKLMNOP')).toMatch(/^AKIA\*+$/);
    expect(shannonEntropy('aaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBe(2);
  });
});

describe('args', () => {
  const spec = {
    name: 't',
    summary: '',
    usage: '',
    options: [
      { name: 'fail-on', type: 'string' as const, description: '', choices: ['high', 'low'] },
      { name: 'format', type: 'list' as const, description: '' },
      { name: 'runs', type: 'number' as const, description: '' },
      { name: 'yes', type: 'boolean' as const, short: 'y', description: '' },
    ],
  };
  it('parses options, lists, numbers, flags and positionals', () => {
    const p = parseArgs(
      [
        'x',
        '--fail-on',
        'high',
        '--format=md,html',
        '--format',
        'sarif',
        '--runs',
        '3',
        '-y',
        '--',
        '--literal',
      ],
      spec,
    );
    expect(p.positionals).toEqual(['x', '--literal']);
    expect(p.opts).toMatchObject({ 'fail-on': 'high', format: ['md', 'html', 'sarif'], runs: 3, yes: true });
  });
  it('rejects unknown options and bad values with usage errors', () => {
    expect(() => parseArgs(['--nope'], spec)).toThrow(/Unknown option/);
    expect(() => parseArgs(['--fail-on', 'urgent'], spec)).toThrow(/must be one of/);
    expect(() => parseArgs(['--runs', 'x'], spec)).toThrow(/number/);
    expect(() => parseArgs(['--runs'], spec)).toThrow(/requires a value/);
  });
});

describe('splitCommand', () => {
  it('splits without a shell and keeps quoted arguments', () => {
    expect(splitCommand('npm run "test:unit" -- --grep \'a b\'')).toEqual([
      'npm',
      'run',
      'test:unit',
      '--',
      '--grep',
      'a b',
    ]);
  });
  it('refuses shell operators', () => {
    expect(() => splitCommand('npm test && rm -rf /')).toThrow(/Shell operators/);
    expect(() => splitCommand('cat x | sh')).toThrow(/Shell operators/);
    expect(() => splitCommand('echo "unterminated')).toThrow(/Unterminated/);
  });
});

describe('tool reports', () => {
  it('recognises Relivaro, Jourilo and Searvex reports by their exact markers', () => {
    expect(isToolReport('docs/x/report.html', '<meta name="generator" content="Relivaro 1.2.2">')).toBe(true);
    expect(isToolReport('a/index.html', '<meta name="generator" content="Jourilo 1.0.0">')).toBe(true);
    expect(
      isToolReport('r.md', 'Generated 2026-11-01T00:00:00Z · Searvex 1.4.0 · rules 12 · run `abc`'),
    ).toBe(true);
    expect(
      isToolReport(
        'r.md',
        '# Relivaro report — site\n\nRun `20261101-abc` · `relivaro audit` · Relivaro 1.2.2',
      ),
    ).toBe(true);
    expect(
      isToolReport('r.md', '# Jourilo report — https://x.test\n\nRun `j-1` · lab mode · chromium 1'),
    ).toBe(true);
    expect(isToolReport('run.json', '{\n  "schemaVersion": 1,\n  "tool": {\n    "name": "relivaro",')).toBe(
      true,
    );
    expect(
      isToolReport('run.json', '{"schemaVersion":3,"id":"x","tool":{"name":"jourilo","version":"1.0.0"}'),
    ).toBe(true);
    expect(isToolReport('out/report.sarif', '{')).toBe(false);
  });

  it('keeps project files that only mention a tool', () => {
    expect(isToolReport('README.md', 'Relivaro audit is part of our CI')).toBe(false);
    expect(isToolReport('page.html', '<meta name="generator" content="Hugo 0.120">')).toBe(false);
    expect(isToolReport('docs/relivaro.md', '# Relivaro report — how we read it\n\nWe run it weekly.')).toBe(
      false,
    );
    expect(isToolReport('package.json', '{"name":"relivaro","tool":{"name":"relivaro"}}')).toBe(false);
    expect(isToolReport('app.ts', '<meta name="generator" content="Relivaro 1.2.2">')).toBe(false);
  });

  it('skips untracked and committed tool reports and counts them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relivaro-reports-'));
    const git = (...args: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args],
        {
          cwd: dir,
          stdio: 'ignore',
        },
      );
    try {
      git('init', '-q');
      writeFileSync(join(dir, 'app.js'), 'console.log(1);\n');
      mkdirSync(join(dir, 'docs/verification'), { recursive: true });
      const report = '<!doctype html><meta name="generator" content="Relivaro 1.2.2"><title>r</title>';
      writeFileSync(join(dir, 'docs/verification/report.html'), report);
      let files = new FileSet(dir);
      expect(files.files.map((f) => f.path)).toEqual(['app.js']);
      expect(files.skipped.reports).toBe(1);
      git('add', '-A');
      git('commit', '-qm', 'x');
      files = new FileSet(dir);
      expect(files.files.map((f) => f.path)).toEqual(['app.js']);
      expect(files.skipped.reports).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('inline annotations', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const LOOP = 'for (const r of rows) await pool.query("UPDATE t SET x = 1 WHERE id = $1", [r]);';
  async function auditSource(source: string, opts: { inlineSuppressions?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'rlv-annot-'));
    made.push(dir);
    writeFileSync(join(dir, 'jobs.ts'), source);
    const { run } = await runAudit({
      root: dir,
      command: 'audit',
      noWrite: true,
      useGit: false,
      rules: ['perf/query-in-loop'],
      ...opts,
    });
    return run;
  }
  const fn = (comment: string) =>
    `import { pool } from './db';\nexport async function touch(rows: string[]) {\n  ${comment}\n  ${LOOP}\n}\n`;

  it('relivaro-accept-next-line records an accepted finding with its reason', async () => {
    const run = await auditSource(
      fn('// relivaro-accept-next-line perf/query-in-loop: sequential row locks, bounded by plan size'),
    );
    const f = run.findings.find((x) => x.ruleId === 'perf/query-in-loop');
    expect(f?.status).toBe('open');
    expect(f?.accepted).toEqual({ reason: 'sequential row locks, bounded by plan size', source: 'inline' });
    expect(run.summary.accepted).toBe(1);
    expect(gateFailed(run, 'low')).toBe(false);
    expect(run.errors.rules).toEqual([]);
  });

  it('reports show an inline acceptance with its reason', async () => {
    const { toMarkdown } = await import('../../src/report/markdown.js');
    const { toSarif } = await import('../../src/report/sarif.js');
    const run = await auditSource(
      fn('// relivaro-accept-next-line perf/query-in-loop: bounded by plan size'),
    );
    expect(toMarkdown(run)).toContain('Accepted in code: bounded by plan size');
    const result = (toSarif(run) as any).runs[0].results.find((r: any) => r.ruleId === 'perf/query-in-loop');
    expect(result.suppressions).toEqual([
      { kind: 'inSource', status: 'accepted', justification: 'Accepted in code: bounded by plan size' },
    ]);
  });

  it('relivaro-accept without a reason accepts nothing and is reported', async () => {
    const run = await auditSource(fn('// relivaro-accept-next-line perf/query-in-loop'));
    const f = run.findings.find((x) => x.ruleId === 'perf/query-in-loop');
    expect(f?.accepted).toBeUndefined();
    expect(gateFailed(run, 'low')).toBe(true);
    expect(run.errors.rules.map((e) => e.message)).toEqual([
      'Invalid relivaro-accept at jobs.ts:3: a rule id and a reason are required',
    ]);
  });

  it('a relivaro-accept inside a string literal is not an annotation', async () => {
    const run = await auditSource(
      fn(`const doc = '// relivaro-accept-next-line perf/query-in-loop'; void doc;`),
    );
    expect(run.errors.rules).toEqual([]);
    expect(run.findings.find((x) => x.ruleId === 'perf/query-in-loop')?.accepted).toBeUndefined();
  });

  it('relivaro-accept without a rule id accepts nothing and is reported', async () => {
    const run = await auditSource(fn('// relivaro-accept-next-line: it is fine'));
    expect(run.findings.find((x) => x.ruleId === 'perf/query-in-loop')?.accepted).toBeUndefined();
    expect(run.errors.rules.map((e) => e.message)).toEqual([
      'Invalid relivaro-accept at jobs.ts:3: a rule id and a reason are required',
    ]);
  });

  it('inlineSuppressions: false ignores relivaro-ignore-file and relivaro-accept', async () => {
    const src = `// relivaro-ignore-file\n${fn('// relivaro-accept-next-line perf/query-in-loop: bounded')}`;
    const honoured = await auditSource(src);
    expect(honoured.findings.find((x) => x.ruleId === 'perf/query-in-loop')?.status).toBe('suppressed');
    const run = await auditSource(src, { inlineSuppressions: false });
    const f = run.findings.find((x) => x.ruleId === 'perf/query-in-loop');
    expect(f?.status).toBe('open');
    expect(f?.accepted).toBeUndefined();
    expect(run.limitations).toContain(
      'Inline relivaro-ignore/relivaro-accept comments in the audited code were not honoured (--no-inline-suppressions).',
    );
  });

  it('audit accepts --no-inline-suppressions', async () => {
    const { COMMANDS } = await import('../../src/cli/commands.js');
    const audit = COMMANDS.find((c) => c.spec.name === 'audit')!;
    expect(parseArgs(['.', '--no-inline-suppressions'], audit.spec).opts['no-inline-suppressions']).toBe(
      true,
    );
  });
});

describe('FileSet walk mode', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tree = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), 'rlv-walk-'));
    made.push(root);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(root, p, '..'), { recursive: true });
      writeFileSync(join(root, p), c);
    }
    return root;
  };

  it('counts and names files hidden by .gitignore, and --no-gitignore lists them', async () => {
    const root = tree({
      '.gitignore': 'web/\n',
      'a.ts': 'export const a = 1;\n',
      'web/x.ts': '1;\n',
      'web/y.ts': '2;\n',
    });
    const files = new FileSet(root, { useGit: false });
    expect(files.files.map((f) => f.path)).not.toContain('web/x.ts');
    expect(files.skipped.gitignored).toBe(2);
    expect(files.skippedPaths.gitignored).toEqual(['web/']);
    const { run } = await runAudit({ root, command: 'audit', noWrite: true, useGit: false });
    expect(run.limitations).toContain(
      '2 file(s) ignored by .gitignore were not analysed (top entries: web/); use --no-gitignore to include them.',
    );
    const all = new FileSet(root, { useGit: false, respectGitignore: false });
    expect(all.files.map((f) => f.path)).toEqual(expect.arrayContaining(['web/x.ts', 'web/y.ts']));
    expect(all.skipped.gitignored).toBe(0);
  });

  it('analyses an in-tree file symlink once', () => {
    const root = tree({ 'a.ts': 'export const a = 1;\n' });
    symlinkSync('a.ts', join(root, 'b.ts'));
    const files = new FileSet(root, { useGit: false });
    expect(files.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(files.skipped.symlinkDuplicate).toBe(1);
  });

  it('does not count an in-tree directory symlink as outside', () => {
    const root = tree({ 'src/a.ts': 'export const a = 1;\n' });
    symlinkSync('src', join(root, 'lib'));
    const files = new FileSet(root, { useGit: false });
    expect(files.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(files.skipped.symlinkDir).toBe(1);
    expect(files.skipped.symlinkOutside).toBe(0);
  });

  it('survives a symlink loop', () => {
    const root = tree({ 'a.ts': 'export const a = 1;\n' });
    symlinkSync('.', join(root, 'loop'));
    const files = new FileSet(root, { useGit: false });
    expect(files.files.map((f) => f.path)).toEqual(['a.ts']);
    expect(files.skipped.symlinkDir).toBe(1);
  });
});

describe('1.3.0 review minors', () => {
  it('nginx/default.conf.template is a web server config', () => {
    expect(classify('nginx/default.conf.template').kind).toBe('webserver');
    expect(classify('deploy/nginx.conf.template').kind).toBe('webserver');
    expect(classify('templates/email.conf.template').kind).not.toBe('webserver');
  });
  it('discover lists an nginx .conf.template as an nginx deploy target', async () => {
    const { discover } = await import('../../src/intel/discover.js');
    const dir = mkdtempSync(join(tmpdir(), 'rlv-tpl-'));
    try {
      mkdirSync(join(dir, 'nginx'));
      writeFileSync(join(dir, 'nginx/default.conf.template'), 'server {\n  listen 80;\n}\n');
      expect(discover(new FileSet(dir, { useGit: false })).deploy.map((d) => d.kind)).toContain('nginx');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('only a .sarif written by Relivaro, Jourilo or Searvex is a tool report', () => {
    const sarif = (name: string) =>
      JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name } }, results: [] }] });
    expect(isToolReport('out/report.sarif', sarif('Relivaro'))).toBe(true);
    expect(isToolReport('out/report.sarif', sarif('Searvex'))).toBe(true);
    expect(isToolReport('codeql/results.sarif', sarif('CodeQL'))).toBe(false);
  });
  it('the "Generated" marker counts only within the first 5 lines', () => {
    const marker = 'Generated 2026-11-01T00:00:00Z · Relivaro 1.3.0 · rules 89';
    expect(isToolReport('r.md', `# Notes\n\n${marker}\n`)).toBe(true);
    expect(isToolReport('r.md', `# Notes\n\n1\n2\n3\n4\n${marker}\n`)).toBe(false);
  });
  it('the HTML report KPI shows the accepted count', async () => {
    const { REPORT_JS } = await import('../../src/report/html-client.js');
    const { I18N } = await import('../../src/report/html-i18n.js');
    expect(REPORT_JS).toContain("t('kpi.accepted'");
    expect(Object.keys(I18N.en)).toContain('kpi.accepted');
    expect(Object.keys(I18N.tr)).toContain('kpi.accepted');
  });
});
