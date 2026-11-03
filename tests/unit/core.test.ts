import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../src/cli/args.js';
import { defaultConfig, validateConfig } from '../../src/core/config.js';
import type { RelivaroError } from '../../src/core/errors.js';
import { globToRegExp, matchesAny } from '../../src/core/glob.js';
import { findingId, fingerprint } from '../../src/core/hash.js';
import { isPlaceholder, maskSecret, redact, shannonEntropy } from '../../src/core/secrets.js';
import { splitCommand } from '../../src/exec/runner.js';
import { FileSet, isToolReport } from '../../src/fs/files.js';

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
    expect(isToolReport('out/report.sarif', '{')).toBe(true);
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
