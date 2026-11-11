import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { type RunRecord, runAudit } from '../../src/audit.js';
import { diffSpecs, validateSpec } from '../../src/contract/openapi.js';
import { defaultConfig } from '../../src/core/config.js';
import type { Finding } from '../../src/core/types.js';
import { cvss3Score, fixedVersions, severityOf } from '../../src/deps/osv.js';
import { unifiedDiff } from '../../src/fix/diff.js';
import { FileSet } from '../../src/fs/files.js';
import { discover } from '../../src/intel/discover.js';
import { isPrivateAddress } from '../../src/perf/bench.js';
import { compareStats, stats } from '../../src/perf/stats.js';
import { assessRelease, releaseTally } from '../../src/release/readiness.js';
import { compareRuns } from '../../src/report/compare.js';
import { HEALTH_ROUTE_RE } from '../../src/rules/reliability.js';

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

const tmpTrees: string[] = [];
afterAll(() => {
  for (const d of tmpTrees.splice(0)) rmSync(d, { recursive: true, force: true });
});
function makeTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rlv-eng-'));
  tmpTrees.push(root);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
}
async function ruleHits(root: string, rule: string): Promise<Finding[]> {
  const { run: r } = await runAudit({ root, command: 'audit', noWrite: true, useGit: false, rules: [rule] });
  return r.findings.filter((f) => f.ruleId === rule);
}

describe('dockerfile stages', () => {
  const asRoot = (dockerfile: string) =>
    ruleHits(makeTree({ Dockerfile: dockerfile }), 'sec/docker-runs-as-root');
  it('inherits USER from a named parent stage', async () => {
    expect(
      await asRoot('FROM node:22 AS base\nUSER 10001:10001\nFROM base AS runtime\nCMD ["node","x"]\n'),
    ).toEqual([]);
  });
  it('follows a chain of stages', async () => {
    expect(
      await asRoot(
        'FROM node:22 AS base\nUSER app\nFROM base AS mid\nRUN true\nFROM mid AS runtime\nCMD ["x"]\n',
      ),
    ).toEqual([]);
  });
  it('a parent stage that ends as root is still reported', async () => {
    const hits = await asRoot('FROM node:22 AS base\nUSER app\nUSER root\nFROM base AS runtime\nCMD ["x"]\n');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('base');
  });
  it("a final stage on an external image keeps today's behaviour", async () => {
    expect(await asRoot('FROM node:22\nCMD ["x"]\n')).toHaveLength(1);
  });
  it('the stage alias match is case-insensitive', async () => {
    expect(await asRoot('FROM node:22 AS Base\nUSER app\nFROM base\nCMD ["x"]\n')).toEqual([]);
  });
  it('a stage cycle does not hang and is reported', async () => {
    expect(await asRoot('FROM b AS a\nFROM a AS b\nCMD ["x"]\n')).toHaveLength(1);
  });
});

describe('dockerfile build context', () => {
  const DF = 'FROM node:22.11-alpine\nWORKDIR /app\nCOPY . .\nUSER node\nCMD ["node","x"]\n';
  it('build context: a package audited alone uses the workspace root .dockerignore', async () => {
    const root = makeTree({
      'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n",
      '.dockerignore': '.git\n.env*\n',
      'apps/web/package.json': '{"name":"web"}',
      'apps/web/Dockerfile': DF,
    });
    expect(await ruleHits(join(root, 'apps/web'), 'sec/docker-context-leak')).toEqual([]);
  });
  it('build context: an ancestor .dockerignore outside the workspace root is not used', async () => {
    const root = makeTree({ '.dockerignore': '.git\n', 'repo/package.json': '{}', 'repo/Dockerfile': DF });
    expect(await ruleHits(join(root, 'repo'), 'sec/docker-context-leak')).toHaveLength(1);
  });
  it('build context: no .dockerignore anywhere keeps medium confidence', async () => {
    const hits = await ruleHits(makeTree({ 'svc/Dockerfile': DF }), 'sec/docker-context-leak');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.confidence).toBe('medium');
    expect(hits[0]!.message).toContain('is not determined');
  });
  it('build context: an unknown context with a .dockerignore elsewhere is reported at low confidence', async () => {
    const hits = await ruleHits(
      makeTree({ 'svc/Dockerfile': DF, 'other/.dockerignore': '.git\n', 'other/x.js': '1;\n' }),
      'sec/docker-context-leak',
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.confidence).toBe('low');
  });
  it("build context: GitHub's Docker starter workflow names the root as context", async () => {
    const wf = [
      'on: push',
      'jobs:',
      '  b:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: docker build . --file Dockerfile --tag my-image-name:$(date +%s)',
      '      - run: docker build . -t img:${{ github.sha }}',
      '',
    ].join('\n');
    const root = makeTree({ Dockerfile: DF, '.dockerignore': '.git\n', '.github/workflows/docker.yml': wf });
    expect(await ruleHits(root, 'sec/docker-context-leak')).toEqual([]);
  });
  it('build context: a CI build step names the context', async () => {
    const wf =
      'on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker build -f svc/Dockerfile svc\n';
    const root = makeTree({ '.dockerignore': '.git\n', 'svc/Dockerfile': DF, '.github/workflows/b.yml': wf });
    const hits = await ruleHits(root, 'sec/docker-context-leak');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.confidence).toBe('medium');
    writeFileSync(join(root, 'svc/.dockerignore'), '.git\n');
    expect(await ruleHits(root, 'sec/docker-context-leak')).toEqual([]);
  });
  it('build context: docker/build-push-action with file and context', async () => {
    const wf =
      'on: push\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          context: .\n          file: svc/Dockerfile\n';
    const root = makeTree({ '.dockerignore': '.git\n', 'svc/Dockerfile': DF, '.github/workflows/b.yml': wf });
    expect(await ruleHits(root, 'sec/docker-context-leak')).toEqual([]);
  });
});

describe('unit kind', () => {
  const kindOf = (files: Record<string, string>) =>
    discover(new FileSet(makeTree(files), { useGit: false })).units.find((u) => u.path === '.')?.kind;
  const pkg = JSON.stringify({ name: 'adapter', version: '1.0.0', dependencies: { express: '^4.0.0' } });
  it('a package with express as a dependency and no server entry is a library', () => {
    expect(
      kindOf({
        'package.json': pkg,
        'src/index.ts': 'export function adapt(app: unknown) { return app; }\n',
      }),
    ).toBe('library');
  });
  it('a package with app.listen in src/server.ts is web-backend', () => {
    expect(
      kindOf({
        'package.json': pkg,
        'src/index.ts': 'export const x = 1;\n',
        'src/server.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
      }),
    ).toBe('web-backend');
  });
  it('a function named serve that wraps a server library is a declaration, not a server entry', () => {
    const hono = JSON.stringify({
      name: 'adapter-runtime',
      version: '0.0.0',
      dependencies: { hono: '4.0.0' },
    });
    expect(
      kindOf({
        'package.json': hono,
        'src/serve.ts':
          "import { serve as honoServe } from '@hono/node-server';\nexport function serve(app: any, port = 8080) {\n  return honoServe({ fetch: app.fetch, port });\n}\n",
      }),
    ).toBe('library');
  });
  it('a Go service without a Dockerfile stays web-backend', () => {
    expect(
      kindOf({
        'go.mod': 'module example.com/svc\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n',
        'main.go':
          'package main\n\nimport "github.com/gin-gonic/gin"\n\nfunc main() {\n\tr := gin.Default()\n\tr.Run(":8080")\n}\n',
      }),
    ).toBe('web-backend');
  });
  it('a start script that runs a file makes a service', () => {
    const withStart = JSON.stringify({ ...JSON.parse(pkg), scripts: { start: 'node dist/main.js' } });
    expect(kindOf({ 'package.json': withStart, 'src/index.ts': 'export const x = 1;\n' })).toBe(
      'web-backend',
    );
  });
  it('health route regex accepts versioned and prefixed routes', () => {
    for (const r of ["'/v1/health'", '"/api/v2/healthz"', '`/v1/ready`', "'/health'"])
      expect(HEALTH_ROUTE_RE.test(r), r).toBe(true);
    expect(HEALTH_ROUTE_RE.test("'/v1/users'")).toBe(false);
  });
});

describe('archive entry paths', () => {
  const src = (imports: string) =>
    `${imports}import { rm } from 'node:fs/promises';\nimport express from 'express';\nexport const app = express();\nexport function drop(entry: { path: string }) {\n  return rm(entry.path, { force: true });\n}\n`;
  it('an entry.path outside any archive code is not zip slip', async () => {
    expect(await ruleHits(makeTree({ 'uploads.ts': src('') }), 'sec/path-traversal')).toEqual([]);
  });
  it('an entry.path in a file that reads archives is zip slip', async () => {
    const hits = await ruleHits(
      makeTree({ 'unpack.ts': src("import yauzl from 'yauzl';\n") }),
      'sec/path-traversal',
    );
    expect(hits).toHaveLength(1);
  });
});
