import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync as mkTemp,
  readFileSync,
  rmSync as removeTree,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir as osTmp } from 'node:os';
import { dirname as dirOfPath, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

describe('lockfile edge cases', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made.splice(0)) removeTree(d, { recursive: true, force: true });
  });
  const tree = (files: Record<string, string>) => {
    const root = mkTemp(join(osTmp(), 'rlv-lock-'));
    made.push(root);
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirOfPath(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), c);
    }
    return root;
  };
  const bigLock = () => {
    const packages: Record<string, unknown> = { '': { name: 'big', dependencies: { 'pkg-0': '1.0.0' } } };
    for (let i = 0; i < 52000; i++)
      packages[`node_modules/pkg-${i}`] = {
        version: '1.0.0',
        resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.0.tgz`,
        integrity: `sha512-${'A'.repeat(86)}==`,
      };
    return JSON.stringify({ name: 'big', lockfileVersion: 3, requires: true, packages }, null, 2);
  };
  const pkg = JSON.stringify({ name: 'big', private: true, dependencies: { 'pkg-0': '1.0.0' } });

  it('an 8.9 MB package-lock.json is parsed', async () => {
    const root = tree({ 'package.json': pkg, 'package-lock.json': bigLock() });
    expect(statSync(join(root, 'package-lock.json')).size).toBeGreaterThan(8.5 * 1024 * 1024);
    const { run } = await runAudit({ root, command: 'audit', noWrite: true, useGit: false });
    expect(run.metrics.dependencies).toBe(52000);
    expect(run.findings.some((f) => f.ruleId === 'sc/missing-lockfile')).toBe(false);
    expect(run.limitations.join('\n')).not.toMatch(/larger than|exceeds maxLockfileSizeKb/);
  });

  it('a lockfile over maxLockfileSizeKb is not reported missing', async () => {
    const root = tree({
      'package.json': pkg,
      'package-lock.json': bigLock(),
      'relivaro.config.json': JSON.stringify({ maxLockfileSizeKb: 5120 }),
    });
    const mb = (statSync(join(root, 'package-lock.json')).size / 1024 / 1024).toFixed(1);
    const { run } = await runAudit({ root, command: 'audit', noWrite: true, useGit: false });
    expect(run.findings.some((f) => f.ruleId === 'sc/missing-lockfile')).toBe(false);
    expect(run.limitations).toContain(
      `Lockfile \`package-lock.json\` (${mb} MB) exceeds maxLockfileSizeKb; its dependencies were not analysed.`,
    );
  });

  it('a workspace package audited alone uses the root lockfile', async () => {
    const root = tree({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'package.json': JSON.stringify({ name: 'mono', private: true }),
      'packages/preflight/package.json': JSON.stringify({
        name: 'preflight',
        dependencies: { yaml: '^2.0.0' },
      }),
      'packages/preflight/index.js': 'export const x = 1;\n',
    });
    const { run } = await runAudit({
      root: join(root, 'packages/preflight'),
      command: 'audit',
      noWrite: true,
      useGit: false,
    });
    expect(run.findings.filter((f) => f.ruleId === 'sc/missing-lockfile')).toEqual([]);
  });

  it('no test commands, but the workspace root has them', async () => {
    const root = tree({
      'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n",
      'package.json': JSON.stringify({
        name: 'mono',
        private: true,
        scripts: { test: 'vitest', typecheck: 'tsc --noEmit', format: 'biome format' },
      }),
      'packages/preflight/package.json': JSON.stringify({ name: 'preflight' }),
      'packages/preflight/index.js': 'export const x = 1;\n',
    });
    const { run } = await runAudit({
      root: join(root, 'packages/preflight'),
      command: 'audit',
      noWrite: true,
      useGit: false,
      checks: ['typecheck', 'test'],
    });
    expect(run.limitations).toContain(
      'No typecheck/test commands were detected in the audited directory; the workspace root (`../..`) defines: test, typecheck. Run the audit from the workspace root to include them.',
    );
  });

  it('dependency count is unique', async () => {
    const lock = JSON.stringify({
      name: 'x',
      lockfileVersion: 3,
      packages: { '': { name: 'x' }, 'node_modules/a': { version: '1.0.0' } },
    });
    const root = tree({
      'package.json': JSON.stringify({ name: 'x', private: true, dependencies: { a: '1.0.0' } }),
      'package-lock.json': lock,
      'tools/package.json': JSON.stringify({ name: 'tools', private: true, dependencies: { a: '1.0.0' } }),
      'tools/package-lock.json': lock,
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ results: [{}] }))) as unknown as typeof fetch;
    const { run } = await runAudit({
      root,
      command: 'audit',
      noWrite: true,
      useGit: false,
      online: true,
      fetchImpl,
    });
    expect(run.metrics.dependencies).toBe(1);
    expect(run.metrics.dependencyEntries).toBe(2);
    expect(run.metrics.osvQueried).toBe(1);
  });
});

import { runAudit } from '../../src/audit.js';
import { planChecks, runChecks } from '../../src/checks/exec.js';
import { defaultConfig } from '../../src/core/config.js';
import type { Finding } from '../../src/core/types.js';
import { Workspace } from '../../src/core/workspace.js';
import { queryOsv } from '../../src/deps/osv.js';
import { applyPlan, createPlan, history, loadPlan, rollback } from '../../src/fix/workflow.js';
import { FileSet } from '../../src/fs/files.js';
import { discover } from '../../src/intel/discover.js';
import { materialize } from '../helpers/fixtures.js';

describe('fix workflow', () => {
  it('plans, applies with backup, verifies statically and rolls back exactly', async () => {
    const fx = materialize('python-app');
    try {
      const ws = new Workspace(fx.dir);
      const original = readFileSync(join(fx.dir, 'app.py'), 'utf8');
      const { run } = await runAudit({ root: fx.dir, command: 'fix plan', noWrite: true });
      const plan = await createPlan(
        fx.dir,
        run.findings.filter((f) => f.fixer),
        ws,
      );
      expect(plan.items.length).toBeGreaterThanOrEqual(7);
      expect(plan.files.map((f) => f.path).sort()).toEqual(['app.py', 'shop/views.py']);
      expect(readFileSync(join(fx.dir, 'app.py'), 'utf8')).toBe(original);
      await expect(
        applyPlan(ws, plan, { yes: false, allowExec: false, isolate: true }),
      ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });
      const rec = await applyPlan(ws, loadPlan(ws, 'latest'), { yes: true, allowExec: false, isolate: true });
      expect(rec.verification.verdict).toBe('static-only');
      expect(rec.verification.static.unresolved).toEqual([]);
      expect(rec.verification.static.introduced).toEqual([]);
      const patched = readFileSync(join(fx.dir, 'app.py'), 'utf8');
      expect(patched).toContain('yaml.safe_load(request.data)');
      expect(patched).toContain('except Exception:');
      expect(patched).not.toContain('breakpoint()');
      const after = await runAudit({ root: fx.dir, command: 'audit', noWrite: true });
      for (const item of rec.items)
        expect(after.run.findings.some((f) => f.fingerprint === item.fingerprint)).toBe(false);
      rollback(ws, rec.applyId, false);
      expect(readFileSync(join(fx.dir, 'app.py'), 'utf8')).toBe(original);
      expect(history(ws)[0]!.rolledBackAt).toBeTruthy();
      expect(() => rollback(ws, rec.applyId, false)).toThrow(/already rolled back/);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses stale plans and conflicting rollbacks', async () => {
    const fx = materialize('node-api');
    try {
      const ws = new Workspace(fx.dir);
      const { run } = await runAudit({ root: fx.dir, command: 'fix plan', noWrite: true });
      const plan = await createPlan(
        fx.dir,
        run.findings.filter((f) => f.fixer),
        ws,
      );
      expect(plan.items.length).toBeGreaterThan(0);
      const target = join(fx.dir, plan.files[0]!.path);
      const original = readFileSync(target, 'utf8');
      writeFileSync(target, `${original}\n// edited after planning\n`);
      await expect(applyPlan(ws, plan, { yes: true, allowExec: false, isolate: true })).rejects.toThrow(
        /changed since plan/,
      );
      writeFileSync(target, original);
      const rec = await applyPlan(ws, plan, { yes: true, allowExec: false, isolate: true });
      writeFileSync(target, `${readFileSync(target, 'utf8')}\n// edited after applying\n`);
      expect(() => rollback(ws, rec.applyId, false)).toThrow(/changed after the fix/);
      rollback(ws, rec.applyId, true);
      expect(readFileSync(target, 'utf8')).toBe(original);
    } finally {
      fx.cleanup();
    }
  });

  it('verifies with a command in an isolated copy and leaves the tree untouched on regression', async () => {
    const fx = materialize('python-app');
    try {
      const ws = new Workspace(fx.dir);
      // A "test suite" that passes before and fails after the fix: it asserts the unsafe call is present.
      writeFileSync(
        join(fx.dir, 'check.mjs'),
        "import { readFileSync } from 'node:fs';\nprocess.exit(readFileSync('app.py','utf8').includes('yaml.load(request.data)') ? 0 : 1);\n",
      );
      const { run } = await runAudit({ root: fx.dir, command: 'fix plan', noWrite: true });
      const plan = await createPlan(
        fx.dir,
        run.findings.filter((f) => f.fixer === 'py-yaml-safe-load'),
        ws,
      );
      const before = readFileSync(join(fx.dir, 'app.py'), 'utf8');
      await expect(
        applyPlan(ws, plan, {
          yes: true,
          allowExec: true,
          isolate: true,
          verifyCommand: `${JSON.stringify(process.execPath)} check.mjs`,
        }),
      ).rejects.toThrow(/regression/);
      expect(readFileSync(join(fx.dir, 'app.py'), 'utf8')).toBe(before);
      writeFileSync(join(fx.dir, 'check.mjs'), 'process.exit(0);\n');
      const rec = await applyPlan(ws, plan, {
        yes: true,
        allowExec: true,
        isolate: true,
        verifyCommand: `${JSON.stringify(process.execPath)} check.mjs`,
      });
      expect(rec.verification.verdict).toBe('verified');
      expect(rec.verification.command?.isolated).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

describe('fix workflow: failure recovery', () => {
  const posixNonRoot = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.runIf(posixNonRoot)('restores files already written when a later write fails', async () => {
    const fx = materialize('python-app');
    const shop = join(fx.dir, 'shop');
    try {
      const ws = new Workspace(fx.dir);
      const { run } = await runAudit({ root: fx.dir, command: 'fix plan', noWrite: true });
      const plan = await createPlan(
        fx.dir,
        run.findings.filter((f) => f.fixer),
        ws,
      );
      expect(plan.files.map((f) => f.path)).toEqual(['app.py', 'shop/views.py']);
      const original = readFileSync(join(fx.dir, 'app.py'), 'utf8');
      chmodSync(shop, 0o555); // app.py is written first, shop/views.py cannot be replaced
      await expect(applyPlan(ws, plan, { yes: true, allowExec: false, isolate: true })).rejects.toThrow(
        /working tree is unchanged/,
      );
      expect(readFileSync(join(fx.dir, 'app.py'), 'utf8')).toBe(original);
      const rec = history(ws).at(-1)!;
      expect(rec.state).toBe('failed');
      expect(rec.rolledBackAt).toBeTruthy();
    } finally {
      chmodSync(shop, 0o755);
      fx.cleanup();
    }
  });

  it('rolls back an interrupted apply and keeps later edits on a forced rollback', async () => {
    const fx = materialize('python-app');
    try {
      const ws = new Workspace(fx.dir);
      const { run } = await runAudit({ root: fx.dir, command: 'fix plan', noWrite: true });
      const plan = await createPlan(
        fx.dir,
        run.findings.filter((f) => f.fixer),
        ws,
      );
      const app = join(fx.dir, 'app.py');
      const views = join(fx.dir, 'shop/views.py');
      const [appBefore, viewsBefore] = [readFileSync(app, 'utf8'), readFileSync(views, 'utf8')];
      const rec = await applyPlan(ws, plan, { yes: true, allowExec: false, isolate: true });
      // Simulate a crash after the first write: the second file was never written and the record says `applying`.
      writeFileSync(views, viewsBefore);
      ws.writeJson(['fixes', rec.applyId, 'apply.json'], { ...rec, state: 'applying' });
      rollback(ws, rec.applyId, false);
      expect(readFileSync(app, 'utf8')).toBe(appBefore);
      expect(readFileSync(views, 'utf8')).toBe(viewsBefore);

      const rec2 = await applyPlan(
        ws,
        await createPlan(
          fx.dir,
          run.findings.filter((f) => f.fixer),
          ws,
        ),
        {
          yes: true,
          allowExec: false,
          isolate: true,
        },
      );
      const edited = `${readFileSync(app, 'utf8')}\n# my own edit\n`;
      writeFileSync(app, edited);
      const rolled = rollback(ws, rec2.applyId, true);
      expect(readFileSync(app, 'utf8')).toBe(appBefore);
      expect(rolled.preserved).toEqual(['app.py']);
      expect(readFileSync(ws.path('fixes', rec2.applyId, 'conflicts', 'app.py'), 'utf8')).toBe(edited);
    } finally {
      fx.cleanup();
    }
  });

  it('refuses to roll back with a corrupt backup without touching any file', async () => {
    const fx = materialize('python-app');
    try {
      const ws = new Workspace(fx.dir);
      const { run } = await runAudit({ root: fx.dir, command: 'fix plan', noWrite: true });
      const plan = await createPlan(
        fx.dir,
        run.findings.filter((f) => f.fixer),
        ws,
      );
      const rec = await applyPlan(ws, plan, { yes: true, allowExec: false, isolate: true });
      const patched = readFileSync(join(fx.dir, 'app.py'), 'utf8');
      writeFileSync(ws.path('fixes', rec.applyId, 'backup', 'shop', 'views.py'), 'corrupted');
      expect(() => rollback(ws, rec.applyId, false)).toThrow(/missing or corrupt; nothing restored/);
      expect(readFileSync(join(fx.dir, 'app.py'), 'utf8')).toBe(patched);
    } finally {
      fx.cleanup();
    }
  });

  it('does not count findings it cannot re-check statically as resolved', async () => {
    const fx = materialize('python-app');
    try {
      const ws = new Workspace(fx.dir);
      const finding = {
        id: 'RLV-ENV1',
        fingerprint: 'env-fp',
        ruleId: 'sec/env-file-committed',
        fixer: 'gitignore-env',
        title: 'Environment file committed',
        message: '.env is not ignored',
        severity: 'high',
        category: 'security',
        confidence: 'high',
        status: 'open',
        location: { file: '.env' },
      } as unknown as Finding;
      const plan = await createPlan(fx.dir, [finding], ws);
      expect(plan.files.map((f) => f.path)).toEqual(['.gitignore']);
      const rec = await applyPlan(ws, plan, { yes: true, allowExec: false, isolate: true });
      expect(rec.verification.static.resolved).toEqual([]);
      expect(rec.verification.static.unverifiable).toEqual(['RLV-ENV1']);
      expect(rec.verification.verdict).toBe('static-only');
    } finally {
      fx.cleanup();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'never writes through a symlink in the isolated copy back into the project',
    async () => {
      const fx = materialize('python-app');
      try {
        const ws = new Workspace(fx.dir);
        // app.py becomes an absolute symlink to a file inside the project that is not analysed under its own path
        // (git-ignored), so the link itself carries the findings.
        const real = join(fx.dir, 'src_real_app.py');
        const { appendFileSync } = await import('node:fs');
        appendFileSync(join(fx.dir, '.gitignore'), '\nsrc_real_app.py\n');
        writeFileSync(real, readFileSync(join(fx.dir, 'app.py')));
        const original = readFileSync(real, 'utf8');
        const { rmSync } = await import('node:fs');
        rmSync(join(fx.dir, 'app.py'));
        symlinkSync(real, join(fx.dir, 'app.py'));
        writeFileSync(join(fx.dir, 'check.mjs'), 'process.exit(1);\n');
        const { run } = await runAudit({ root: fx.dir, command: 'fix plan', noWrite: true });
        const plan = await createPlan(
          fx.dir,
          run.findings.filter((f) => f.fixer === 'py-yaml-safe-load' && f.location?.file === 'app.py'),
          ws,
        );
        expect(plan.files.length).toBe(1);
        await expect(
          applyPlan(ws, plan, {
            yes: true,
            allowExec: true,
            isolate: true,
            verifyCommand: `${JSON.stringify(process.execPath)} check.mjs`,
          }),
        ).rejects.toThrow(/already failed before the fix/);
        expect(readFileSync(real, 'utf8')).toBe(original);
        expect(existsSync(join(fx.dir, 'app.py'))).toBe(true);
      } finally {
        fx.cleanup();
      }
    },
  );

  it('reports when a verification command modifies the original project', async () => {
    const fx = materialize('python-app');
    try {
      const ws = new Workspace(fx.dir);
      const outside = join(fx.dir, 'notes.txt');
      writeFileSync(outside, 'original\n');
      writeFileSync(
        join(fx.dir, 'check.mjs'),
        `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(outside)}, 'x');\n`,
      );
      const { run } = await runAudit({ root: fx.dir, command: 'fix plan', noWrite: true });
      const plan = await createPlan(
        fx.dir,
        run.findings.filter((f) => f.fixer === 'py-yaml-safe-load'),
        ws,
      );
      const rec = await applyPlan(ws, plan, {
        yes: true,
        allowExec: true,
        isolate: true,
        verifyCommand: `${JSON.stringify(process.execPath)} check.mjs`,
      });
      expect(rec.verification.notes.join(' ')).toMatch(
        /modified 1 file\(s\) in the original project.*notes\.txt/,
      );
    } finally {
      fx.cleanup();
    }
  });
});

describe('execution checks', () => {
  function project(testScript: string) {
    const fx = materialize('clean-service', { gitInit: false });
    const pkg = JSON.parse(readFileSync(join(fx.dir, 'package.json'), 'utf8'));
    pkg.scripts = { test: testScript };
    writeFileSync(join(fx.dir, 'package.json'), JSON.stringify(pkg));
    mkdirSync(join(fx.dir, 'node_modules'), { recursive: true });
    return fx;
  }

  it('runs the test command only with allowExec and parses the result', async () => {
    const fx = project(
      'node -e "console.log(\'Tests:       1 failed, 3 passed, 4 total\'); process.exit(1)"',
    );
    try {
      const files = new FileSet(fx.dir);
      const profile = discover(files);
      const planned = planChecks(files, profile, defaultConfig(), ['test']);
      expect(planned.map((p) => p.argv.join(' '))).toEqual(['npm test --silent']);
      const denied = await runChecks(planned, { allowExec: false, timeoutSeconds: 30, root: fx.dir });
      expect(denied.results[0]).toMatchObject({ status: 'skipped', reason: 'requires --allow-exec' });
      const done = await runChecks(planned, { allowExec: true, timeoutSeconds: 60, root: fx.dir });
      expect(done.results[0]).toMatchObject({ status: 'failed', tests: { passed: 3, failed: 1, total: 4 } });
      expect(done.hits[0]!.rule.id).toBe('exec/test-failure');
    } finally {
      fx.cleanup();
    }
  });

  it('kills commands that exceed the timeout', async () => {
    const fx = project('node -e "setTimeout(() => {}, 60000)"');
    try {
      const files = new FileSet(fx.dir);
      const planned = planChecks(files, discover(files), defaultConfig(), ['test']);
      const started = Date.now();
      const done = await runChecks(planned, { allowExec: true, timeoutSeconds: 2, root: fx.dir });
      expect(done.results[0]!.status).toBe('timeout');
      expect(done.hits[0]!.rule.id).toBe('exec/check-timeout');
      expect(Date.now() - started).toBeLessThan(15000);
    } finally {
      fx.cleanup();
    }
  });

  it('never plans checks for fixture, example or benchmark sub-projects', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'relivaro-units-'));
    try {
      for (const sub of ['', 'fixtures/app', 'bench/scenarios/demo', 'packages/core']) {
        mkdirSync(join(dir, sub, 'node_modules'), { recursive: true });
        writeFileSync(
          join(dir, sub, 'package.json'),
          JSON.stringify({ name: `p-${sub || 'root'}`, scripts: { test: 'vitest run' } }),
        );
      }
      const files = new FileSet(dir, { useGit: false });
      const planned = planChecks(files, discover(files), defaultConfig(), ['test']);
      expect(planned.map((p) => p.unit).sort()).toEqual(['.', 'packages/core']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips checks when dependencies are not installed instead of installing them', async () => {
    const fx = materialize('clean-service', { gitInit: false });
    try {
      const files = new FileSet(fx.dir);
      const planned = planChecks(files, discover(files), defaultConfig(), ['test', 'build']);
      expect(planned.every((p) => /not installed/.test(p.skipReason ?? ''))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });
});

describe('OSV lookup', () => {
  const lock = [
    {
      file: 'package-lock.json',
      ecosystem: 'npm' as const,
      packages: [
        { name: 'lodash', version: '4.17.20', ecosystem: 'npm' as const },
        { name: 'vitest', version: '1.0.0', ecosystem: 'npm' as const, dev: true },
        { name: 'safe', version: '1.0.0', ecosystem: 'npm' as const },
      ],
    },
  ];
  it('queries in batches, fetches details and reports with severity and fixed versions', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/querybatch')) {
        const body = JSON.parse(String(init!.body));
        expect(body.queries.map((q: { package: { name: string } }) => q.package.name)).toEqual([
          'lodash',
          'vitest',
          'safe',
        ]);
        return new Response(
          JSON.stringify({ results: [{ vulns: [{ id: 'GHSA-1' }] }, { vulns: [{ id: 'GHSA-2' }] }, {}] }),
        );
      }
      const id = String(url).split('/').pop();
      const vuln =
        id === 'GHSA-1'
          ? {
              id,
              summary: 'Prototype pollution',
              aliases: ['CVE-2021-23337'],
              database_specific: { severity: 'HIGH' },
              affected: [
                {
                  package: { name: 'lodash' },
                  ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
                },
              ],
            }
          : { id, summary: 'Dev issue', database_specific: { severity: 'CRITICAL' } };
      return new Response(JSON.stringify(vuln));
    }) as typeof fetch;
    const r = await queryOsv(lock, { fetchImpl });
    expect(r.queried).toBe(3);
    expect(r.vulnerable).toBe(2);
    const lodash = r.hits.find((h) => h.facts?.package === 'lodash')!;
    expect(lodash.severity).toBe('high');
    expect(lodash.message).toContain('Fixed in 4.17.21');
    expect(lodash.message).toContain('CVE-2021-23337');
    expect(r.hits.find((h) => h.facts?.package === 'vitest')!.severity).toBe('high');
    expect(calls.filter((c) => c.includes('/vulns/'))).toHaveLength(2);
  });
  it('reports network failures as errors instead of findings', async () => {
    const r = await queryOsv(lock, {
      fetchImpl: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
    });
    expect(r.hits).toEqual([]);
    expect(r.errors[0]).toMatch(/503/);
  });
});

describe('dependency parse errors', () => {
  const project = async (files: Record<string, string>) => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'relivaro-parse-'));
    for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
    return dir;
  };
  const fetchImpl = (() => {
    throw new Error('fetch must not be called');
  }) as unknown as typeof fetch;

  it('an unparsable lockfile is a limitation and leaves the dependencies gate unverified', async () => {
    const { rmSync } = await import('node:fs');
    const { assessRelease } = await import('../../src/release/readiness.js');
    const root = await project({
      'package.json': JSON.stringify({ name: 'p', dependencies: { left: '1.0.0' } }),
      'pnpm-lock.yaml': 'importers: [\n',
    });
    try {
      const { run } = await runAudit({
        root,
        command: 'release',
        release: true,
        online: true,
        noWrite: true,
        fetchImpl,
      });
      expect(run.limitations.join('\n')).toMatch(
        /Lockfile `pnpm-lock\.yaml` could not be parsed .*dependencies were not analysed/,
      );
      const gate = assessRelease(run, defaultConfig(), []).gates.find((g) => g.id === 'dependencies')!;
      expect(gate.status).toBe('unverified');
      expect(gate.detail).toMatch(/^Could not parse/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an unparsable manifest is a limitation', async () => {
    const { rmSync } = await import('node:fs');
    const root = await project({ 'package.json': '{' });
    try {
      const { run } = await runAudit({ root, command: 'audit', noWrite: true });
      expect(run.limitations.join('\n')).toMatch(/Manifest `package\.json` could not be parsed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('web server headers', () => {
  const ids = async (files: Record<string, string>) => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'relivaro-web-'));
    try {
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(join(root, f, '..'), { recursive: true });
        writeFileSync(join(root, f), text);
      }
      const { run } = await runAudit({ root, command: 'audit', noWrite: true, categories: ['security'] });
      return run.findings
        .filter((f) => f.ruleId.startsWith('sec/web-'))
        .map((f) => f.ruleId)
        .sort();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('an nginx site without security headers misses CSP, frame protection and HSTS', async () => {
    expect(await ids({ 'nginx/site.conf': 'server {\n  listen 80;\n  root /srv;\n}\n' })).toEqual([
      'sec/web-missing-csp',
      'sec/web-missing-frame-protection',
      'sec/web-missing-hsts',
    ]);
  });

  it('a CSP declared by a <meta http-equiv> tag in served HTML counts', async () => {
    expect(
      await ids({
        Caddyfile:
          'site.test {\n\theader Strict-Transport-Security "max-age=63072000"\n\theader X-Frame-Options DENY\n}\n',
        'public/index.html':
          '<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head>',
      }),
    ).toEqual([]);
  });

  it('a config that only reverse-proxies the app, or an unrelated site.conf, is not a header source', async () => {
    expect(
      await ids({
        'package.json': JSON.stringify({ name: 'api', dependencies: { express: '4.21.2', helmet: '8.0.0' } }),
        'src/app.js': "const helmet = require('helmet');\nrequire('express')().use(helmet());\n",
        'deploy/nginx.conf': 'server {\n  location / {\n    proxy_pass http://app:3000;\n  }\n}\n',
      }),
    ).toEqual([]);
    expect(await ids({ 'config/site.conf': '[app]\nname=foo\n' })).toEqual([]);
  });

  it('a CSP meta tag in JSX served as a static export counts', async () => {
    expect(
      await ids({
        Caddyfile:
          'site.test {\n\troot * out\n\tfile_server\n\theader Strict-Transport-Security "max-age=63072000"\n\theader X-Frame-Options DENY\n}\n',
        'app/layout.tsx':
          'export default function Root({ children }) {\n  return (<html><head><meta httpEquiv="Content-Security-Policy" content="default-src \'self\'" /></head><body>{children}</body></html>);\n}\n',
      }),
    ).toEqual([]);
  });

  it('no web server configuration, no web server findings', async () => {
    expect(await ids({ 'public/index.html': '<!doctype html><title>x</title>' })).toEqual([]);
  });
});

describe('static export', () => {
  const nextProject = async (config: Record<string, string>) => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'relivaro-next-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'site',
        dependencies: { next: '15.0.0', react: '19.0.0' },
        scripts: { build: 'next build' },
      }),
    );
    mkdirSync(join(root, 'app'));
    writeFileSync(join(root, 'app/page.tsx'), 'export default function Page() {\n  return <h1>Hi</h1>;\n}\n');
    for (const [f, text] of Object.entries(config)) writeFileSync(join(root, f), text);
    return root;
  };

  it("a literal output: 'export' makes the unit a frontend without backend operational findings", async () => {
    const { rmSync } = await import('node:fs');
    const root = await nextProject({ 'next.config.mjs': "export default { output: 'export' };\n" });
    try {
      const files = new FileSet(root, { useGit: false });
      const unit = discover(files).units[0]!;
      expect(unit.kind).toBe('web-frontend');
      expect(unit.staticExport).toBe(true);
      const { run } = await runAudit({ root, command: 'audit', noWrite: true });
      expect(run.findings.map((f) => f.ruleId)).not.toContain('rel/no-error-monitoring');
      expect(run.findings.map((f) => f.ruleId)).not.toContain('rel/no-health-check');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('double quotes in next.config.ts are detected', async () => {
    const { rmSync } = await import('node:fs');
    const root = await nextProject({
      'next.config.ts':
        'const config = { output: "export", images: { unoptimized: true } };\nexport default config;\n',
    });
    try {
      expect(discover(new FileSet(root, { useGit: false })).units[0]!.staticExport).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a commented-out output: export is not a static export', async () => {
    for (const cfg of [
      "export default {\n  // output: 'export',\n};\n",
      "export default {\n  /* output: 'export' */\n};\n",
      "export default {\n  /*\n   * output: 'export',\n   */\n};\n",
    ]) {
      const root = await nextProject({ 'next.config.mjs': cfg });
      try {
        expect(discover(new FileSet(root, { useGit: false })).units[0]!.staticExport, cfg).toBeUndefined();
      } finally {
        removeTree(root, { recursive: true, force: true });
      }
    }
  });

  it('an env-driven output is not treated as a static export', async () => {
    const { rmSync } = await import('node:fs');
    const root = await nextProject({ 'next.config.mjs': 'export default { output: process.env.OUT };\n' });
    try {
      const unit = discover(new FileSet(root, { useGit: false })).units[0]!;
      expect(unit.kind).toBe('fullstack');
      expect(unit.staticExport).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('workspace package manager', () => {
  it('workspace units inherit the root package manager in skip hints and commands', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'relivaro-pm-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: 'root',
          private: true,
          packageManager: 'pnpm@12.16.1',
          scripts: { test: 'turbo test' },
        }),
      );
      writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
      writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
      mkdirSync(join(dir, 'packages/a'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/a/package.json'),
        JSON.stringify({ name: 'a', scripts: { test: 'vitest run' } }),
      );
      const files = new FileSet(dir, { useGit: false });
      const profile = discover(files);
      expect(profile.units.find((u) => u.path === 'packages/a')!.packageManager).toBe('pnpm');
      const a = planChecks(files, profile, defaultConfig(), ['test']).find((p) => p.unit === 'packages/a')!;
      expect(a.skipReason).toContain('pnpm install --frozen-lockfile');
      expect(a.skipReason).not.toContain('npm ci');
      expect(a.argv[0]).toBe('pnpm');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('health endpoints in web server configs', () => {
  it('an nginx health location counts as a health endpoint', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'relivaro-health-'));
    try {
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'api', dependencies: { express: '4.21.2' } }),
      );
      mkdirSync(join(root, 'src'));
      writeFileSync(join(root, 'src/app.js'), "require('express')().listen(3000);\n");
      writeFileSync(join(root, 'Dockerfile'), 'FROM node:22\nCOPY . .\nCMD ["node", "src/app.js"]\n');
      mkdirSync(join(root, 'nginx'));
      writeFileSync(
        join(root, 'nginx/site.conf'),
        'server {\n  location /healthcheck {\n    return 200;\n  }\n  location / {\n    proxy_pass http://app:3000;\n  }\n}\n',
      );
      const { run } = await runAudit({ root, command: 'audit', noWrite: true, categories: ['reliability'] });
      expect(run.findings.map((f) => f.ruleId)).not.toContain('rel/no-health-check');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('run budget', () => {
  it('maxFiles stops the analysis, analyses root metadata first and marks the run partial', async () => {
    const { analysisOrder } = await import('../../src/rules/engine.js');
    const fx = materialize('node-api');
    try {
      const first = analysisOrder(new FileSet(fx.dir))
        .slice(0, 3)
        .map((f) => f.path);
      expect(first).toEqual(expect.arrayContaining(['package.json', 'package-lock.json']));
      const { run } = await runAudit({
        root: fx.dir,
        command: 'audit',
        noWrite: true,
        limits: { maxFiles: 3 },
      });
      expect(run.partial?.reason).toBe('files');
      expect(run.limitations[0]).toMatch(
        /^The run stopped early \(files\); results cover 3 of \d+ files and are incomplete\.$/,
      );
      expect(run.profile.lockfiles.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });

  it('maxBytes stops the analysis', async () => {
    const fx = materialize('node-api');
    try {
      const { run } = await runAudit({
        root: fx.dir,
        command: 'audit',
        noWrite: true,
        limits: { maxBytes: 1 },
      });
      expect(run.partial?.reason).toBe('bytes');
    } finally {
      fx.cleanup();
    }
  });

  it('an aborted signal stops the run as partial (signal)', async () => {
    const fx = materialize('node-api');
    try {
      const ac = new AbortController();
      ac.abort();
      const { run } = await runAudit({ root: fx.dir, command: 'audit', noWrite: true, signal: ac.signal });
      expect(run.partial?.reason).toBe('signal');
      expect(run.limitations[0]).toMatch(/^The run stopped early \(signal\)/);
    } finally {
      fx.cleanup();
    }
  });

  it('a parse over the parse timeout is recorded and the run continues', async () => {
    const fx = materialize('node-api');
    try {
      const { run } = await runAudit({
        root: fx.dir,
        command: 'audit',
        noWrite: true,
        limits: { parseTimeoutMs: 0 },
      });
      expect(run.partial).toBeUndefined();
      expect(run.errors.parse.some((e) => /timed out/.test(e.message))).toBe(true);
      expect(run.findings.length).toBeGreaterThan(0);
    } finally {
      fx.cleanup();
    }
  });

  it('a partial run is never READY', async () => {
    const fx = materialize('clean-service');
    try {
      const { run } = await runAudit({
        root: fx.dir,
        command: 'release',
        noWrite: true,
        release: true,
        limits: { maxFiles: 2 },
      });
      expect(run.partial?.reason).toBe('files');
      expect(run.release?.status).toBe('needs-verification');
    } finally {
      fx.cleanup();
    }
  });
});

describe('output privacy', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made.splice(0)) removeTree(d, { recursive: true, force: true });
  });
  const project = () => {
    const root = mkTemp(join(osTmp(), 'rlv-priv-'));
    made.push(root);
    mkdirSync(join(root, 'src'));
    // The absolute root appears in code, so it reaches snippets (Review Focus 3).
    writeFileSync(
      join(root, 'src', 'run.js'),
      `const base = ${JSON.stringify(root)};\nexport function run(x) {\n  return eval(base + x);\n}\n`,
    );
    return root;
  };

  it('--root-label replaces the absolute root everywhere in run, HTML and prompt data', async () => {
    const { toHtml } = await import('../../src/report/html.js');
    const { toMarkdown } = await import('../../src/report/markdown.js');
    const { toSarif } = await import('../../src/report/sarif.js');
    const root = project();
    const { realpathSync } = await import('node:fs');
    const { run } = await runAudit({
      root,
      command: 'audit',
      noWrite: true,
      useGit: false,
      rootLabel: 'repo',
    });
    expect(run.root).toBe('repo');
    expect(run.findings.some((f) => f.ruleId === 'sec/code-injection')).toBe(true);
    for (const text of [
      JSON.stringify(run),
      toHtml(run, {}),
      toMarkdown(run),
      JSON.stringify(toSarif(run)),
    ]) {
      expect(text).not.toContain(root);
      expect(text).not.toContain(realpathSync(root));
    }
    expect(JSON.stringify(run)).toContain('repo');
  });

  it('snippets can be turned off or shortened', async () => {
    const root = project();
    const off = (await runAudit({ root, command: 'audit', noWrite: true, useGit: false, snippetLines: 0 }))
      .run;
    expect(off.findings.length).toBeGreaterThan(0);
    expect(off.findings.every((f) => f.evidence.snippet === undefined)).toBe(true);
    const one = (await runAudit({ root, command: 'audit', noWrite: true, useGit: false, snippetLines: 1 }))
      .run;
    const f = one.findings.find((x) => x.ruleId === 'sec/code-injection')!;
    expect(f.evidence.snippet!.split('\n')).toHaveLength(1);
  });

  it('SARIF carries the snippet unless snippets are off', async () => {
    const { toSarif } = await import('../../src/report/sarif.js');
    const root = project();
    const on = (await runAudit({ root, command: 'audit', noWrite: true, useGit: false })).run;
    const r = (toSarif(on) as any).runs[0].results.find((x: any) => x.ruleId === 'sec/code-injection');
    expect(r.locations[0].physicalLocation.region.snippet.text).toContain('eval(');
    const off = (await runAudit({ root, command: 'audit', noWrite: true, useGit: false, snippetLines: 0 }))
      .run;
    const r2 = (toSarif(off) as any).runs[0].results.find((x: any) => x.ruleId === 'sec/code-injection');
    expect(r2.locations[0].physicalLocation.region.snippet).toBeUndefined();
  });

  it('compact output names the real report directory, or null without writes', async () => {
    const { compactRun } = await import('../../src/cli/commands.js');
    const root = project();
    const { run } = await runAudit({ root, command: 'audit', noWrite: true, useGit: false });
    expect(compactRun(run, 30, {}).reports).toBeNull();
    expect(compactRun(run, 30, { json: '/w/runs/x/report.json' }).reports).toBe('/w/runs/x');
  });
});

describe('coverage metrics', () => {
  it('counts rules run and files matched per category', async () => {
    const fx = materialize('node-api');
    try {
      const { run } = await runAudit({ root: fx.dir, command: 'audit', noWrite: true });
      const c = run.metrics.coverage!;
      expect(c.security!.rules).toBeGreaterThan(20);
      expect(c.security!.files).toBeGreaterThan(3);
      expect(c.security!.files).toBeLessThanOrEqual(run.metrics.files);
      const only = (
        await runAudit({ root: fx.dir, command: 'security', noWrite: true, categories: ['security'] })
      ).run;
      expect(Object.keys(only.metrics.coverage!)).toEqual(['security']);
    } finally {
      fx.cleanup();
    }
  });
});

describe('since', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made.splice(0)) removeTree(d, { recursive: true, force: true });
  });
  const repo = async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = mkTemp(join(osTmp(), 'rlv-since-'));
    made.push(dir);
    const git = (...a: string[]) =>
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...a],
        {
          cwd: dir,
          stdio: 'pipe',
        },
      );
    git('init', '-q');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'old.js'), 'export function a(x) {\n  return eval(x);\n}\n');
    writeFileSync(join(dir, 'src', 'keep.js'), 'export function b(y) {\n  return eval(y);\n}\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    return { dir, git };
  };
  const codeInjection = (run: {
    findings: { ruleId: string; location?: { file: string; line?: number } }[];
  }) =>
    run.findings
      .filter((f) => f.ruleId === 'sec/code-injection')
      .map((f) => `${f.location?.file}:${f.location?.line}`)
      .sort();

  it('shows only findings on lines changed since the ref', async () => {
    const { dir } = await repo();
    writeFileSync(
      join(dir, 'src', 'keep.js'),
      'export function b(y) {\n  return eval(y);\n}\nexport function c(z) {\n  return eval(z);\n}\n',
    );
    const full = (await runAudit({ root: dir, command: 'audit', noWrite: true })).run;
    expect(codeInjection(full)).toEqual(['src/keep.js:2', 'src/keep.js:5', 'src/old.js:2']);
    const { run } = await runAudit({ root: dir, command: 'audit', noWrite: true, since: 'HEAD' });
    expect(codeInjection(run)).toEqual(['src/keep.js:5']);
    expect(run.since).toEqual({ ref: 'HEAD', files: 1 });
    expect(
      run.limitations.some((l) =>
        /^Only findings on lines changed since `HEAD` are shown \(\d+ findings outside them were hidden\)\.$/.test(
          l,
        ),
      ),
    ).toBe(true);
  });

  it('a renamed file counts as changed in full', async () => {
    const { dir, git } = await repo();
    git('mv', 'src/old.js', 'src/renamed.js');
    const { run } = await runAudit({ root: dir, command: 'audit', noWrite: true, since: 'HEAD' });
    expect(codeInjection(run)).toEqual(['src/renamed.js:2']);
  });

  it('an untracked file counts as changed in full', async () => {
    const { dir } = await repo();
    writeFileSync(join(dir, 'src', 'new.js'), 'export const n = (q) => eval(q);\n');
    const { run } = await runAudit({ root: dir, command: 'audit', noWrite: true, since: 'HEAD' });
    expect(codeInjection(run)).toEqual(['src/new.js:1']);
  });

  it('handles file names with spaces, custom diff prefixes, ++ content lines and binary files', async () => {
    const { changedLines } = await import('../../src/fs/changed.js');
    const { dir, git } = await repo();
    git('config', 'diff.mnemonicPrefix', 'true');
    git('config', 'diff.noprefix', 'false');
    writeFileSync(join(dir, 'src', 'my file.js'), 'export const q = (x) => eval(x);\n');
    writeFileSync(
      join(dir, 'src', 'keep.js'),
      'export function b(y) {\n  return eval(y);\n}\nlet counter = 0;\n++ counter;\nexport const z = (w) => eval(w);\n',
    );
    writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    git('add', '-A');
    const changed = changedLines(dir, 'HEAD');
    expect(changed.get('src/my file.js')).toBe('all');
    expect(changed.get('logo.png')).toBe('all');
    expect([...(changed.get('src/keep.js') as Set<number>)].sort((a, b) => a - b)).toEqual([4, 5, 6]);
    expect([...changed.keys()].some((k) => k.startsWith('+') || k.startsWith('w/') || k.endsWith('\t'))).toBe(
      false,
    );
  });

  it('without git, or with an unknown ref, --since is a usage error', async () => {
    const dir = mkTemp(join(osTmp(), 'rlv-since-nogit-'));
    made.push(dir);
    writeFileSync(join(dir, 'a.js'), 'eval(x);\n');
    await expect(
      runAudit({ root: dir, command: 'audit', noWrite: true, since: 'HEAD' }),
    ).rejects.toMatchObject({
      code: 'USAGE',
    });
    const { dir: d2 } = await repo();
    await expect(
      runAudit({ root: d2, command: 'audit', noWrite: true, since: 'no-such-ref' }),
    ).rejects.toMatchObject({
      code: 'USAGE',
    });
    await expect(
      runAudit({ root: d2, command: 'audit', noWrite: true, since: '--output=/tmp/x' }),
    ).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('abort during later stages', () => {
  const made: string[] = [];
  afterAll(() => {
    for (const d of made.splice(0)) removeTree(d, { recursive: true, force: true });
  });
  const project = (scripts: Record<string, string> = {}) => {
    const root = mkTemp(join(osTmp(), 'rlv-abort-'));
    made.push(root);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'x', private: true, scripts, dependencies: { a: '1.0.0' } }),
    );
    writeFileSync(
      join(root, 'package-lock.json'),
      JSON.stringify({
        name: 'x',
        lockfileVersion: 3,
        packages: { '': { name: 'x' }, 'node_modules/a': { version: '1.0.0' } },
      }),
    );
    writeFileSync(join(root, 'index.js'), 'console.log(1);\n');
    return root;
  };

  it('a signal during the OSV lookup stops it and marks the run partial', async () => {
    const root = project();
    const ac = new AbortController();
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((resolveFetch, reject) => {
        const t = setTimeout(() => resolveFetch(new Response(JSON.stringify({ results: [{}] }))), 4000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      })) as unknown as typeof fetch;
    setTimeout(() => ac.abort(), 200);
    const started = Date.now();
    const { run } = await runAudit({
      root,
      command: 'audit',
      noWrite: true,
      useGit: false,
      online: true,
      categories: ['supply-chain'],
      fetchImpl,
      signal: ac.signal,
    });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(run.partial?.reason).toBe('signal');
  });

  it('a signal during a build/test command stops it and marks the run partial', async () => {
    const root = project({ test: 'node -e "setTimeout(()=>{},8000)"' });
    mkdirSync(join(root, 'node_modules')); // checks run only when dependencies look installed
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const started = Date.now();
    const { run } = await runAudit({
      root,
      command: 'release',
      noWrite: true,
      useGit: false,
      allowExec: true,
      checks: ['test'],
      signal: ac.signal,
    });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(run.partial?.reason).toBe('signal');
  }, 20_000);
});
