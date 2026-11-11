import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { materialize, ROOT } from '../helpers/fixtures.js';

const API = join(ROOT, 'plugin', 'dist', 'api.mjs');

describe('programmatic API (plugin/dist/api.mjs)', () => {
  it('package.json exposes the API and its types', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.exports['.']).toEqual({ types: './plugin/dist/api.d.ts', import: './plugin/dist/api.mjs' });
    expect(pkg.types).toBe('./plugin/dist/api.d.ts');
    expect(existsSync(join(ROOT, 'plugin', 'dist', 'api.d.ts'))).toBe(true);
  });

  it('runs an audit, renders SARIF, compares runs and assesses a release', async () => {
    const api = await import(pathToFileURL(API).href);
    const fx = materialize('node-api');
    try {
      const { run } = await api.runAudit({ root: fx.dir, command: 'audit', noWrite: true });
      expect(run.findings.length).toBeGreaterThan(10);
      const sarif = api.toSarif(run);
      expect(sarif.version).toBe('2.1.0');
      expect(sarif.runs[0].results.length).toBeGreaterThan(0);
      expect(api.compareRuns(run, run).introduced).toEqual([]);
      expect(['ready', 'ready-with-warnings', 'needs-verification', 'not-ready']).toContain(
        api.assessRelease(run).status,
      );
      expect(typeof api.VERSION).toBe('string');
    } finally {
      fx.cleanup();
    }
  });

  it('the --json --compact output matches the contract fixture', () => {
    const contract = JSON.parse(
      readFileSync(join(ROOT, 'tests', 'fixtures', 'contract', 'compact.json'), 'utf8'),
    );
    const fx = materialize('node-api');
    try {
      const r = spawnSync(
        process.execPath,
        [join(ROOT, 'plugin', 'dist', 'relivaro.mjs'), 'audit', fx.dir, '--json', '--compact', '--no-write'],
        { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      );
      const out = JSON.parse(r.stdout);
      const keys = Object.keys(out);
      for (const k of contract.keys.required) expect(keys, k).toContain(k);
      for (const k of keys) expect([...contract.keys.required, ...contract.keys.optional], k).toContain(k);
      for (const [k, sub] of Object.entries(contract.nested) as [string, string[]][])
        expect(Object.keys(out[k]).sort(), k).toEqual([...sub].sort());
      for (const f of out.findings) {
        for (const k of contract.finding.required) expect(Object.keys(f), k).toContain(k);
        for (const k of Object.keys(f))
          expect([...contract.finding.required, ...contract.finding.optional], k).toContain(k);
      }
      for (const g of out.groups) expect(Object.keys(g).sort()).toEqual([...contract.group].sort());
    } finally {
      fx.cleanup();
    }
  });
});
