import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../../src/audit.js';
import { diffSpecs, validateSpec } from '../../src/contract/openapi.js';
import { defaultConfig } from '../../src/core/config.js';
import type { Finding } from '../../src/core/types.js';
import { cvss3Score, fixedVersions, severityOf } from '../../src/deps/osv.js';
import { unifiedDiff } from '../../src/fix/diff.js';
import { isPrivateAddress } from '../../src/perf/bench.js';
import { compareStats, stats } from '../../src/perf/stats.js';
import { assessRelease, releaseTally } from '../../src/release/readiness.js';
import { compareRuns } from '../../src/report/compare.js';

function finding(p: Partial<Finding>): Finding {
  return {
    id: 'RLV-1',
    ruleId: 'sec/xss',
    title: 'XSS',
    message: 'm',
    severity: 'high',
    confidence: 'high',
    category: 'security',
    provenance: 'static',
    evidence: {},
    impact: '',
    recommendation: '',
    verification: '',
    fingerprint: 'f1',
    status: 'open',
    ...p,
  };
}

function run(p: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    tool: { name: 'relivaro', version: '1.0.0' },
    runId: 'r',
    command: 'release',
    startedAt: '2026-01-01T00:00:00Z',
    durationMs: 1,
    root: '/x',
    options: {
      categories: ['security', 'supply-chain', 'reliability', 'performance', 'quality', 'testing', 'release'],
      online: true,
      allowExec: true,
      checks: ['build', 'test', 'typecheck', 'lint'],
    },
    profile: {
      root: '/x',
      name: 'x',
      gitRepo: true,
      monorepo: false,
      languages: [],
      units: [
        {
          path: '.',
          ecosystems: ['npm'],
          manifests: ['package.json'],
          lockfiles: ['package-lock.json'],
          frameworks: [],
          kind: 'library',
          scripts: {},
          runtime: {},
          testFiles: 3,
          sourceFiles: 10,
        },
      ],
      technologies: [],
      ci: [
        {
          system: 'GitHub Actions',
          file: '.github/workflows/ci.yml',
          runsTests: true,
          runsLint: true,
          runsBuild: true,
        },
      ],
      containers: { dockerfiles: [], compose: [], services: [] },
      deploy: [],
      tests: { frameworks: ['Vitest'], testFiles: 3, sourceFiles: 10, e2e: [], coverageReports: [] },
      api: { routeFiles: [], routes: 0, specs: [], graphql: [] },
      envVars: [],
      envTemplates: [],
      docs: { readme: 'README.md', readmeBytes: 5000, license: 'LICENSE', docsDir: true },
      manifests: [],
      lockfiles: [{ file: 'package-lock.json', ecosystem: 'npm', packages: 10 }],
      migrations: [],
      stats: { files: 20, bytes: 1 },
    },
    findings: [],
    summary: {
      total: 0,
      open: 0,
      suppressed: 0,
      baseline: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      byCategory: {
        security: 0,
        'supply-chain': 0,
        reliability: 0,
        performance: 0,
        quality: 0,
        testing: 0,
        release: 0,
      },
    },
    checks: (['build', 'test', 'typecheck', 'lint'] as const).map((kind) => ({
      kind,
      unit: '.',
      command: kind,
      status: 'passed' as const,
      durationMs: 100,
    })),
    coverage: [],
    testGaps: [],
    metrics: {
      files: 20,
      bytes: 1,
      linesOfCode: 100,
      parsedFiles: 10,
      functions: 5,
      rulesRun: 50,
      analysisMs: 10,
      dependencies: 10,
      osvQueried: 10,
      filesSkipped: {},
    },
    limitations: [],
    errors: { parse: [], rules: [], network: [] },
    ...p,
  };
}

describe('release readiness', () => {
  it('is ready when every gate passes', () => {
    const r = assessRelease(
      run(),
      { ...defaultConfig(), performance: { budgets: { api: { p95Ms: 100 } } } },
      [{ name: 'api', kind: 'http', stats: { meanMs: 20, p95Ms: 40 }, measuredAt: '' }],
    );
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.unverified).toEqual([]);
    expect(r.status).toBe('ready');
    expect(r.score).toBeGreaterThan(90);
    expect(r.gates.find((g) => g.id === 'tests')!.basis).toBe('executed');
    expect(r.gates.find((g) => g.id === 'performance')!.basis).toBe('measured');
    expect(r.gates.find((g) => g.id === 'security')!.basis).toBe('static');
  });
  it('a parse error never hides a blocking known vulnerability', () => {
    const base = run();
    const r = assessRelease(
      run({
        profile: {
          ...base.profile,
          lockfiles: [{ file: 'package-lock.json', ecosystem: 'npm', packages: 10 }],
          manifests: [
            {
              file: 'tools/x/package.json',
              ecosystem: 'npm',
              dependencies: 0,
              devDependencies: 0,
              error: 'bad',
            },
          ],
        },
        findings: [
          finding({
            id: 'RLV-v',
            ruleId: 'sc/known-vulnerability',
            severity: 'critical',
            category: 'supply-chain',
          }),
        ],
      }),
      defaultConfig(),
    );
    const g = r.gates.find((x) => x.id === 'dependencies')!;
    expect(g.status).toBe('block');
    expect(g.detail).toContain('Could not parse tools/x/package.json');
  });
  it('never reports ready while a gate is unverified', () => {
    const r = assessRelease(run(), { ...defaultConfig(), performance: { budgets: {} } });
    expect(r.warnings).toEqual([]);
    expect(r.gates.find((g) => g.id === 'performance')).toMatchObject({
      status: 'unverified',
      basis: 'not-run',
    });
    expect(r.status).toBe('ready-with-warnings');
    expect(r.tally.unverified).toBe(1);
    expect(releaseTally(r)).toMatch(/1 unverified/);
  });
  it('caps the score while a blocker exists, however good everything else is', () => {
    const r = assessRelease(run({ findings: [finding({})] }), defaultConfig());
    expect(r.status).toBe('not-ready');
    expect(r.score).toBeLessThanOrEqual(40);
    expect(r.gates.find((g) => g.id === 'security')!.status).toBe('block');
  });
  it('does not block on low-confidence findings', () => {
    const r = assessRelease(run({ findings: [finding({ confidence: 'low' })] }), defaultConfig());
    expect(r.gates.find((g) => g.id === 'security')!.status).toBe('pass');
  });
  it('blocks on failing tests and builds, and marks unexecuted checks unverified', () => {
    const failing = run({
      checks: [
        {
          kind: 'test',
          unit: '.',
          command: 'npm test',
          status: 'failed',
          durationMs: 1,
          tests: { passed: 1, failed: 2, skipped: 0, total: 3, failing: [] },
        },
        { kind: 'build', unit: '.', command: 'npm run build', status: 'passed', durationMs: 1 },
      ],
    });
    expect(assessRelease(failing, defaultConfig()).gates.find((g) => g.id === 'tests')!.status).toBe('block');
    const offline = run({ options: { ...run().options, checks: [], online: false } });
    const r = assessRelease(offline, defaultConfig());
    expect(r.gates.find((g) => g.id === 'build')!.status).toBe('unverified');
    expect(r.gates.find((g) => g.id === 'dependencies')!.status).toBe('unverified');
    expect(r.status).toBe('needs-verification');
  });
  it('enforces performance budgets from measurements', () => {
    const cfg = { ...defaultConfig(), performance: { budgets: { api: { p95Ms: 100 } } } };
    expect(
      assessRelease(run(), cfg, [
        { name: 'api', kind: 'http', stats: { meanMs: 50, p95Ms: 150 }, measuredAt: '' },
      ]).gates.find((g) => g.id === 'performance')!.status,
    ).toBe('block');
    expect(
      assessRelease(run(), cfg, [
        { name: 'api', kind: 'http', stats: { meanMs: 50, p95Ms: 80 }, measuredAt: '' },
      ]).gates.find((g) => g.id === 'performance')!.status,
    ).toBe('pass');
    expect(assessRelease(run(), cfg, []).gates.find((g) => g.id === 'performance')!.status).toBe(
      'unverified',
    );
  });
  it('requires tests when the project has none', () => {
    const r = assessRelease(
      run({ profile: { ...run().profile, tests: { ...run().profile.tests, testFiles: 0 } } }),
      defaultConfig(),
    );
    expect(r.gates.find((g) => g.id === 'tests')!.status).toBe('block');
  });
});

describe('compareRuns', () => {
  it('classifies introduced, resolved and persisting findings and check regressions', () => {
    const base = run({ findings: [finding({ fingerprint: 'a' }), finding({ fingerprint: 'b' })] });
    const head = run({
      findings: [finding({ fingerprint: 'b' }), finding({ fingerprint: 'c' })],
      checks: [{ kind: 'test', unit: '.', command: 't', status: 'failed', durationMs: 1 }],
    });
    const c = compareRuns(base, head);
    expect(c.introduced.map((f) => f.fingerprint)).toEqual(['c']);
    expect(c.resolved.map((f) => f.fingerprint)).toEqual(['a']);
    expect(c.persisting).toBe(1);
    expect(c.checkRegressions[0]).toMatch(/test .* passed before/);
  });
});

describe('osv helpers', () => {
  it('computes CVSS v3 base scores', () => {
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N')).toBe(6.1);
    expect(cvss3Score('CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N')).toBe(0);
  });
  it('maps severity labels and scores, and finds fixed versions', () => {
    expect(severityOf({ id: 'x', database_specific: { severity: 'MODERATE' } })).toBe('medium');
    expect(
      severityOf({
        id: 'x',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      }),
    ).toBe('critical');
    expect(severityOf({ id: 'x' })).toBe('medium');
    expect(
      fixedVersions(
        {
          id: 'x',
          affected: [
            {
              package: { name: 'lodash' },
              ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }],
            },
          ],
        },
        'lodash',
      ),
    ).toEqual(['4.17.21']);
  });
});

describe('openapi', () => {
  const v1 = {
    openapi: '3.0.3',
    info: { title: 'A', version: '1' },
    paths: {
      '/users/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          responses: {
            '200': {
              description: 'ok',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id', 'email'],
                    properties: {
                      id: { type: 'string' },
                      email: { type: 'string' },
                      role: { type: 'string', enum: ['a', 'b'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/old': { get: { responses: { '200': { description: 'ok' } } } },
    },
  };
  it('validates structure', () => {
    expect(validateSpec(v1)).toEqual([]);
    const bad = {
      openapi: '3.0.0',
      info: {},
      paths: {
        '/x/{id}': { get: { operationId: 'a', responses: {} } },
        '/y': { get: { operationId: 'a', responses: { '200': { $ref: '#/components/responses/Nope' } } } },
      },
    };
    const msgs = validateSpec(bad)
      .map((i) => i.message)
      .join('\n');
    expect(msgs).toMatch(/info\.title|Missing info.title/);
    expect(msgs).toMatch(/no responses/);
    expect(msgs).toMatch(/\{id\} is not declared/);
    expect(msgs).toMatch(/Duplicate operationId/);
    expect(msgs).toMatch(/Unresolved \$ref/);
  });
  it('detects breaking and compatible changes', () => {
    const v2 = structuredClone(v1) as any;
    delete v2.paths['/old'];
    v2.paths['/users/{id}'].get.parameters = [
      { name: 'expand', in: 'query', required: true, schema: { type: 'string' } },
    ];
    const schema = v2.paths['/users/{id}'].get.responses['200'].content['application/json'].schema;
    delete schema.properties.email;
    schema.properties.role.enum = ['a', 'b', 'c'];
    v2.paths['/new'] = { get: { responses: { '200': { description: 'ok' } } } };
    const changes = diffSpecs(v1, v2);
    const breaking = changes
      .filter((c) => c.breaking)
      .map((c) => c.kind)
      .sort();
    expect(breaking).toEqual([
      'enum-value-added',
      'path-removed',
      'property-removed',
      'required-parameter-added',
    ]);
    expect(changes.some((c) => c.kind === 'path-added' && !c.breaking)).toBe(true);
  });
});

describe('diff, stats, network policy', () => {
  it('produces unified diffs', () => {
    const d = unifiedDiff('a.txt', 'one\ntwo\nthree\n', 'one\n2\nthree\n');
    expect(d).toContain('--- a/a.txt');
    expect(d).toContain('-two');
    expect(d).toContain('+2');
    expect(unifiedDiff('a', 'x', 'x')).toBe('');
  });
  it('computes percentiles and significance', () => {
    const s = stats([10, 20, 30, 40, 50]);
    expect(s).toMatchObject({ n: 5, minMs: 10, maxMs: 50, meanMs: 30, medianMs: 30 });
    const slower = compareStats(stats([10, 10.5, 9.5, 10, 10]), stats([20, 21, 19, 20, 20]));
    expect(slower.verdict).toBe('slower');
    expect(compareStats(stats([10, 12, 8, 11, 9]), stats([10.2, 11.8, 8.1, 11, 9.1])).verdict).toBe(
      'no significant change',
    );
  });
  it('classifies private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.0.1', '::1', 'fd00::1'])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860::8888']) expect(isPrivateAddress(ip)).toBe(false);
  });
});

describe('sarif', () => {
  it('gives every result a location (GitHub code scanning requirement)', async () => {
    const { toSarif } = await import('../../src/report/sarif.js');
    const r = run({
      findings: [
        finding({ location: undefined, ruleId: 'exec/test-failure' }),
        finding({ location: { file: 'a.ts', line: 3 } }),
      ],
    });
    r.profile.manifests = [{ file: 'package.json', ecosystem: 'npm', dependencies: 0, devDependencies: 0 }];
    const results = (toSarif(r) as any).runs[0].results;
    expect(results.map((x: any) => x.locations[0].physicalLocation.artifactLocation.uri)).toEqual([
      'package.json',
      'a.ts',
    ]);
  });
});
