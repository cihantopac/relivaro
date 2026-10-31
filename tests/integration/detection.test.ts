import { describe, expect, it } from 'vitest';
import { runAudit } from '../../src/audit.js';
import { listFixtures, materialize, score } from '../helpers/fixtures.js';

describe('detection corpus', () => {
  for (const name of listFixtures()) {
    it(`${name}: every expected finding and no unexpected finding`, async () => {
      const fx = materialize(name);
      try {
        const { run } = await runAudit({ root: fx.dir, command: 'audit', noWrite: true });
        const s = score(run.findings, fx.expected);
        const report = [
          ...s.fp.map((f) => `FP ${f.ruleId} ${f.location?.file}:${f.location?.line} ${f.message}`),
          ...s.fn.map((e) => `FN ${e.rule} ${e.file}:${e.line ?? ''}`),
        ];
        expect(report).toEqual([]);
        expect(run.errors.rules).toEqual([]);
        expect(run.errors.parse).toEqual([]);
      } finally {
        fx.cleanup();
      }
    });
  }

  it('is deterministic: two runs produce identical findings', async () => {
    const fx = materialize('node-api');
    try {
      const a = (await runAudit({ root: fx.dir, command: 'audit', noWrite: true })).run.findings;
      const b = (await runAudit({ root: fx.dir, command: 'audit', noWrite: true })).run.findings;
      expect(b.map((f) => f.fingerprint)).toEqual(a.map((f) => f.fingerprint));
      expect(new Set(a.map((f) => f.fingerprint)).size).toBe(a.length);
    } finally {
      fx.cleanup();
    }
  });

  it('keeps finding ids stable when unrelated lines are inserted above', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fx = materialize('python-app');
    try {
      const before = (
        await runAudit({ root: fx.dir, command: 'audit', noWrite: true, categories: ['security'] })
      ).run.findings;
      const p = join(fx.dir, 'app.py');
      writeFileSync(p, `# header comment\n# another\n${readFileSync(p, 'utf8')}`);
      const after = (
        await runAudit({ root: fx.dir, command: 'audit', noWrite: true, categories: ['security'] })
      ).run.findings;
      expect(after.map((f) => f.id).sort()).toEqual(before.map((f) => f.id).sort());
      expect(after.find((f) => f.ruleId === 'sec/sql-injection')!.location!.line).toBe(
        before.find((f) => f.ruleId === 'sec/sql-injection')!.location!.line! + 2,
      );
    } finally {
      fx.cleanup();
    }
  });
});
