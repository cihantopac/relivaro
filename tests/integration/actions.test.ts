import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAudit } from '../../src/audit.js';
import { Workspace } from '../../src/core/workspace.js';
import type { ActionPin } from '../../src/fix/actions.js';
import { applyPlan, createPlan } from '../../src/fix/workflow.js';
import { toHtml } from '../../src/report/html.js';
import { toMarkdown } from '../../src/report/markdown.js';
import {
  effectiveReview,
  loadReview,
  recordReview,
  reviewIndex,
  reviewSummary,
} from '../../src/review/review.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'relivaro-act-'));
  dirs.push(dir);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

const WORKFLOW = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: "some-org/setup-thing@v2"
      - uses: other-org/tool/sub@v1.2.0 # pinned later
      - run: npm test
`;
const SHA = (c: string) => c.repeat(40);

describe('gha-pin-action fixer', () => {
  it('pins to the SHA the resolver verified, keeps the tag as a comment, and never resolves while applying', async () => {
    const dir = project({ '.github/workflows/ci.yml': WORKFLOW });
    const ws = new Workspace(dir);
    const { run } = await runAudit({ root: dir, command: 'audit', noWrite: true, useGit: false });
    const pinFindings = run.findings.filter((f) => f.fixer === 'gha-pin-action');
    expect(pinFindings.map((f) => f.message).sort()).toEqual([
      'GitHub-owned actions use mutable tags: actions/checkout@v4.',
      '`other-org/tool/sub@v1.2.0` is pinned to a mutable ref.',
      '`some-org/setup-thing@v2` is pinned to a mutable ref.',
    ]);

    // Offline: nothing is guessed.
    const offline = await createPlan(dir, pinFindings, ws);
    expect(offline.items).toHaveLength(0);
    expect(offline.skipped.every((s) => /needs --online/.test(s.reason))).toBe(true);

    const asked: string[] = [];
    const resolveAction = async (action: string, ref: string): Promise<ActionPin> => {
      asked.push(`${action}@${ref}`);
      const sha = action.startsWith('actions/')
        ? SHA('a')
        : action.startsWith('some-org')
          ? SHA('b')
          : SHA('c');
      return { action, ref, sha, source: `test resolver for ${action}` };
    };
    const plan = await createPlan(dir, pinFindings, ws, { resolveAction });
    expect(asked.sort()).toEqual([
      'actions/checkout@v4',
      'other-org/tool/sub@v1.2.0',
      'some-org/setup-thing@v2',
    ]);
    expect(plan.items).toHaveLength(3);
    expect(plan.items.flatMap((i) => i.pins ?? []).map((p) => p.sha)).toHaveLength(3);
    const diff = plan.files[0]!.diff;
    expect(diff).toContain(`+      - uses: actions/checkout@${SHA('a')} # v4`);
    expect(diff).toContain(`+      - uses: "some-org/setup-thing@${SHA('b')}" # v2`);
    expect(diff).toContain(`+      - uses: other-org/tool/sub@${SHA('c')} # pinned later`);

    // Applying a subset regenerates from the plan's pins; the network is never used.
    const rec = await applyPlan(ws, plan, {
      only: [plan.items.find((i) => i.message.includes('some-org'))!.findingId],
      yes: true,
      allowExec: false,
      isolate: true,
    });
    expect(rec.verification.verdict).toBe('static-only');
    expect(rec.verification.static.unresolved).toEqual([]);
    const text = readFileSync(join(dir, '.github/workflows/ci.yml'), 'utf8');
    expect(text).toContain(`"some-org/setup-thing@${SHA('b')}" # v2`);
    expect(text).toContain('actions/checkout@v4\n');
  });

  it('pins annotated tags to their commit, not to the tag object', async () => {
    const { commitFor } = await import('../../src/fix/actions.js');
    const out = `${SHA('d')}\trefs/tags/v2\n${SHA('e')}\trefs/tags/v2^{}\n${SHA('f')}\trefs/heads/v2\n`;
    expect(commitFor(out, 'v2')).toBe(SHA('e'));
    expect(commitFor(`${SHA('d')}\trefs/tags/v3\n`, 'v3')).toBe(SHA('d'));
    expect(commitFor(`${SHA('f')}\trefs/heads/main\n`, 'main')).toBe(SHA('f'));
    expect(commitFor(`${SHA('f')}\trefs/heads/releases/v2\n`, 'v2')).toBeUndefined();
  });

  it('refuses malformed action references before touching the network', async () => {
    const { resolveActionRef } = await import('../../src/fix/actions.js');
    await expect(resolveActionRef('../../etc', 'v1')).rejects.toMatchObject({ code: 'USAGE' });
    await expect(resolveActionRef('org/repo', '--upload-pack=x')).rejects.toMatchObject({ code: 'USAGE' });
  });
});

describe('fixers in test files', () => {
  it('does not offer behaviour-changing fixers for code under test (round-trips, self-signed TLS)', async () => {
    const php = '<?php\n$x = unserialize($payload);\n';
    const dir = project({
      'composer.json': '{"require":{"php":"^8.3"}}',
      'src/Cache.php': php,
      'tests/Feature/CacheTest.php': php,
    });
    const { run } = await runAudit({ root: dir, command: 'audit', noWrite: true, useGit: false });
    const des = run.findings.filter((f) => f.ruleId === 'sec/unsafe-deserialization');
    expect(des.find((f) => f.location?.file === 'src/Cache.php')?.fixer).toBe(
      'php-unserialize-allowed-classes',
    );
    expect(des.find((f) => f.location?.file === 'tests/Feature/CacheTest.php')?.fixer).toBeUndefined();
  });
});

describe('review artifact', () => {
  async function auditedProject() {
    const dir = project({
      'app.py': 'import yaml\nfrom flask import request\n\ndef load():\n    return yaml.load(request.data)\n',
      '.github/workflows/ci.yml': WORKFLOW,
    });
    const ws = new Workspace(dir);
    const { run } = await runAudit({ root: dir, command: 'audit', useGit: false });
    run.runId = 'run-a';
    ws.writeJson(['runs', run.runId, 'run.json'], run);
    return { dir, ws, run };
  }

  it('records verdicts next to the run without touching the findings, and reports show both', async () => {
    const { ws, run } = await auditedProject();
    const yaml = run.findings.find((f) => f.ruleId === 'sec/unsafe-deserialization')!;
    const before = JSON.stringify(run.findings);
    const file = recordReview(ws, run, {
      findingIds: [yaml.id],
      verdict: 'confirmed',
      justification:
        'request body reaches yaml.load; token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa leaked\nin note',
      evidence: ['app.py:5'],
      reviewer: 'claude-code',
    });
    expect(JSON.stringify(run.findings)).toBe(before);
    const e = file.entries[0]!;
    expect(e).toMatchObject({
      findingId: yaml.id,
      fingerprint: yaml.fingerprint,
      verdict: 'confirmed',
      evidence: [{ file: 'app.py', line: 5 }],
      reviewer: { kind: 'agent', name: 'claude-code' },
    });
    expect(e.justification).not.toMatch(/ghp_a{10}/);
    expect(e.justification).not.toContain('\n');
    expect(loadReview(ws, run.runId)!.schemaVersion).toBe(1);

    const index = reviewIndex(run, file);
    expect(reviewSummary(run, index)).toMatchObject({ confirmed: 1, falsePositive: 0 });
    const html = toHtml(run, { review: index });
    expect(html).toContain('"verdict":"confirmed"');
    expect(html).toContain('"kind":"deterministic"');
    const md = toMarkdown(run, { review: index });
    expect(md).toContain('**Status:** confirmed (agent review by claude-code)');
    expect(md).toContain('**Status:** detected, not reviewed');
  });

  it('carries verdicts to later runs only for the same finding, and labels where they came from', async () => {
    const { ws, run } = await auditedProject();
    const [a, b] = run.findings;
    recordReview(ws, run, {
      findingIds: [a!.id, b!.id],
      verdict: 'false-positive',
      justification: 'checked',
    });
    const next = { ...run, runId: 'run-b', findings: [a!, { ...b!, fingerprint: 'changed-code' }] };
    ws.writeJson(['runs', 'run-b', 'run.json'], next);
    const eff = effectiveReview(ws, next);
    expect(Object.keys(eff)).toEqual([a!.id]);
    expect(eff[a!.id]!.carriedFrom).toBe('run-a');
    // The later run's own verdict wins over a carried one.
    recordReview(ws, next, { findingIds: [a!.id], verdict: 'confirmed', justification: 'new evidence' });
    expect(effectiveReview(ws, next)[a!.id]!.verdict).toBe('confirmed');
    expect(effectiveReview(ws, next)[a!.id]!.carriedFrom).toBeUndefined();
  });

  it('validates input and never attaches a verdict to a different finding', async () => {
    const { ws, run } = await auditedProject();
    const id = run.findings[0]!.id;
    const ok = { findingIds: [id], verdict: 'false-positive', justification: 'guarded by middleware' };
    expect(() => recordReview(ws, run, { ...ok, findingIds: ['RLV-deadbeef'] })).toThrow(/not in run run-a/);
    expect(() => recordReview(ws, run, { ...ok, verdict: 'maybe' })).toThrow(/--verdict/);
    expect(() => recordReview(ws, run, { ...ok, justification: ' ' })).toThrow(/justification/);
    expect(() => recordReview(ws, run, { ...ok, evidence: ['../../etc/passwd:1'] })).toThrow(
      /Invalid --evidence/,
    );
    expect(() => recordReview(ws, run, { ...ok, evidence: ['/etc/passwd'] })).toThrow(/Invalid --evidence/);
    expect(() => recordReview(ws, run, { ...ok, reviewer: '<script>' })).toThrow(/--reviewer/);
    const file = recordReview(ws, run, ok);
    // Same id, different fingerprint (another run, changed code): the review does not apply.
    const other = { ...run, findings: run.findings.map((f) => ({ ...f, fingerprint: `${f.fingerprint}x` })) };
    expect(reviewIndex(other, file)).toEqual({});
    expect(reviewIndex({ ...run, runId: 'run-b' }, file)).toEqual({});
    // A newer schema is refused rather than misread.
    ws.writeJson(['runs', run.runId, 'review.json'], { ...file, schemaVersion: 99 });
    expect(() => loadReview(ws, run.runId)).toThrow(/schema 99/);
  });
});
