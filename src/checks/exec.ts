import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RelivaroConfig } from '../core/config.js';
import { type RunResult, runCommand, splitCommand, tail, whichSync } from '../exec/runner.js';
import type { FileSet } from '../fs/files.js';
import type { ProjectProfile, Unit } from '../intel/discover.js';
import { registerExternalRule } from '../rules/index.js';
import type { Hit, RuleMeta } from '../rules/types.js';

export type CheckKind = 'build' | 'test' | 'typecheck' | 'lint';

export interface PlannedCheck {
  kind: CheckKind;
  unit: string;
  argv: string[];
  cwd: string;
  /** Why the check cannot run (missing dependencies/tool). */
  skipReason?: string;
  parser: 'tsc' | 'phpstan' | 'tests' | 'generic';
}

export interface CheckResult {
  kind: CheckKind;
  unit: string;
  command: string;
  status: 'passed' | 'failed' | 'error' | 'timeout' | 'skipped';
  durationMs: number;
  reason?: string;
  tests?: { passed: number; failed: number; skipped: number; total: number; failing: string[] };
  diagnostics?: number;
  outputTail?: string;
}

const NPM_DEFAULT_TEST = /no test specified/;

function hasDir(root: string, unit: string, d: string): boolean {
  return existsSync(join(root, unit === '.' ? '' : unit, d)) || existsSync(join(root, d));
}

function localBin(root: string, unit: string, bin: string): string | null {
  for (const base of [join(root, unit === '.' ? '' : unit), root]) {
    for (const p of [
      join(base, 'node_modules', '.bin', bin),
      join(base, 'node_modules', '.bin', `${bin}.cmd`),
      join(base, 'vendor', 'bin', bin),
      join(base, '.venv', 'bin', bin),
      join(base, 'venv', 'bin', bin),
      join(base, '.venv', 'Scripts', `${bin}.exe`),
    ])
      if (existsSync(p)) return p;
  }
  return null;
}

function npmRun(pm: string, script: string): string[] {
  if (pm === 'yarn') return ['yarn', 'run', script];
  if (pm === 'pnpm') return ['pnpm', 'run', script];
  if (pm === 'bun') return ['bun', 'run', script];
  return ['npm', 'run', script, '--silent'];
}

/** Determines which build/test/typecheck/lint commands exist for each unit. Nothing is executed here. */
export function planChecks(
  files: FileSet,
  profile: ProjectProfile,
  config: RelivaroConfig,
  kinds: CheckKind[],
): PlannedCheck[] {
  const root = files.root;
  const out: PlannedCheck[] = [];
  const add = (c: PlannedCheck) => {
    if (kinds.includes(c.kind) && !out.some((x) => x.kind === c.kind && x.unit === c.unit)) out.push(c);
  };
  for (const [kind, cmd] of Object.entries(config.commands) as [CheckKind, string][])
    add({
      kind,
      unit: '.',
      argv: splitCommand(cmd),
      cwd: root,
      parser: kind === 'test' ? 'tests' : kind === 'typecheck' && /\btsc\b/.test(cmd) ? 'tsc' : 'generic',
    });

  for (const u of profile.units) {
    const cwd = join(root, u.path === '.' ? '' : u.path);
    const eco = new Set(u.ecosystems);
    if (eco.has('npm')) planNode(u, root, cwd, add, files);
    if (eco.has('Packagist')) planPhp(u, root, cwd, add);
    if (eco.has('PyPI')) planPython(u, root, cwd, add);
    if (eco.has('Go')) {
      const go = whichSync('go');
      add({
        kind: 'test',
        unit: u.path,
        argv: ['go', 'test', './...'],
        cwd,
        parser: 'tests',
        skipReason: go ? undefined : 'Go toolchain not found on PATH',
      });
      add({
        kind: 'lint',
        unit: u.path,
        argv: ['go', 'vet', './...'],
        cwd,
        parser: 'generic',
        skipReason: go ? undefined : 'Go toolchain not found on PATH',
      });
      add({
        kind: 'build',
        unit: u.path,
        argv: ['go', 'build', './...'],
        cwd,
        parser: 'generic',
        skipReason: go ? undefined : 'Go toolchain not found on PATH',
      });
    }
    if (eco.has('crates.io')) {
      const cargo = whichSync('cargo');
      add({
        kind: 'test',
        unit: u.path,
        argv: ['cargo', 'test'],
        cwd,
        parser: 'tests',
        skipReason: cargo ? undefined : 'cargo not found on PATH',
      });
      add({
        kind: 'build',
        unit: u.path,
        argv: ['cargo', 'build'],
        cwd,
        parser: 'generic',
        skipReason: cargo ? undefined : 'cargo not found on PATH',
      });
    }
    if (eco.has('Pub')) {
      const flutter = u.frameworks.includes('Flutter');
      const bin = flutter ? 'flutter' : 'dart';
      const found = whichSync(bin);
      const hasTests = files.files.some(
        (f) =>
          f.path.startsWith(u.path === '.' ? 'test/' : `${u.path}/test/`) && f.path.endsWith('_test.dart'),
      );
      if (hasTests)
        add({
          kind: 'test',
          unit: u.path,
          argv: [bin, 'test'],
          cwd,
          parser: 'tests',
          skipReason: found ? undefined : `${bin} not found on PATH`,
        });
      add({
        kind: 'lint',
        unit: u.path,
        argv: [bin, 'analyze'],
        cwd,
        parser: 'generic',
        skipReason: found ? undefined : `${bin} not found on PATH`,
      });
    }
  }
  return out;
}

function planNode(u: Unit, root: string, cwd: string, add: (c: PlannedCheck) => void, files: FileSet) {
  const pm = u.packageManager ?? 'npm';
  const installed = hasDir(root, u.path, 'node_modules');
  const skip = installed
    ? undefined
    : `dependencies are not installed (run \`${pm === 'npm' ? 'npm ci' : `${pm} install --frozen-lockfile`}\` first; Relivaro never installs dependencies)`;
  const pmMissing = whichSync(pm) ? undefined : `${pm} not found on PATH`;
  const s = u.scripts;
  if (s.test && !NPM_DEFAULT_TEST.test(s.test))
    add({
      kind: 'test',
      unit: u.path,
      argv: pm === 'npm' ? ['npm', 'test', '--silent'] : [pm, 'test'],
      cwd,
      parser: 'tests',
      skipReason: skip ?? pmMissing,
    });
  if (s.build)
    add({
      kind: 'build',
      unit: u.path,
      argv: npmRun(pm, 'build'),
      cwd,
      parser: 'generic',
      skipReason: skip ?? pmMissing,
    });
  const tc = ['typecheck', 'type-check', 'check-types', 'types', 'tsc'].find((k) => s[k]);
  if (tc)
    add({
      kind: 'typecheck',
      unit: u.path,
      argv: npmRun(pm, tc),
      cwd,
      parser: /\btsc\b/.test(s[tc]!) ? 'tsc' : 'generic',
      skipReason: skip ?? pmMissing,
    });
  else if (files.has(u.path === '.' ? 'tsconfig.json' : `${u.path}/tsconfig.json`)) {
    const tsc = localBin(root, u.path, 'tsc');
    add({
      kind: 'typecheck',
      unit: u.path,
      argv: tsc ? [tsc, '--noEmit', '--pretty', 'false'] : ['tsc', '--noEmit'],
      cwd,
      parser: 'tsc',
      skipReason: tsc ? undefined : (skip ?? 'TypeScript compiler not installed locally'),
    });
  }
  const lint = ['lint', 'lint:check', 'check'].find((k) => s[k] && !/--fix|--write/.test(s[k]!));
  if (lint)
    add({
      kind: 'lint',
      unit: u.path,
      argv: npmRun(pm, lint),
      cwd,
      parser: 'generic',
      skipReason: skip ?? pmMissing,
    });
}

function planPhp(u: Unit, root: string, cwd: string, add: (c: PlannedCheck) => void) {
  const vendor = hasDir(root, u.path, 'vendor');
  const php = whichSync('php');
  const skip = !php
    ? 'php not found on PATH'
    : !vendor
      ? 'dependencies are not installed (run `composer install` first; Relivaro never installs dependencies)'
      : undefined;
  const pest = localBin(root, u.path, 'pest');
  const phpunit = localBin(root, u.path, 'phpunit');
  if (existsSync(join(cwd, 'artisan')) && (pest || phpunit))
    add({
      kind: 'test',
      unit: u.path,
      argv: ['php', 'artisan', 'test'],
      cwd,
      parser: 'tests',
      skipReason: skip,
    });
  else if (pest)
    add({ kind: 'test', unit: u.path, argv: ['php', pest], cwd, parser: 'tests', skipReason: skip });
  else if (phpunit)
    add({ kind: 'test', unit: u.path, argv: ['php', phpunit], cwd, parser: 'tests', skipReason: skip });
  else if (existsSync(join(cwd, 'phpunit.xml')) || existsSync(join(cwd, 'phpunit.xml.dist')))
    add({
      kind: 'test',
      unit: u.path,
      argv: ['vendor/bin/phpunit'],
      cwd,
      parser: 'tests',
      skipReason: skip ?? 'vendor/bin/phpunit not found',
    });
  const phpstan = localBin(root, u.path, 'phpstan');
  if (
    phpstan &&
    ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'].some((f) => existsSync(join(cwd, f)))
  )
    add({
      kind: 'typecheck',
      unit: u.path,
      argv: ['php', phpstan, 'analyse', '--no-progress', '--error-format=json', '--memory-limit=1G'],
      cwd,
      parser: 'phpstan',
      skipReason: skip,
    });
  const pint = localBin(root, u.path, 'pint');
  if (pint)
    add({
      kind: 'lint',
      unit: u.path,
      argv: ['php', pint, '--test'],
      cwd,
      parser: 'generic',
      skipReason: skip,
    });
}

function planPython(u: Unit, root: string, cwd: string, add: (c: PlannedCheck) => void) {
  const pytest = localBin(root, u.path, 'pytest') ?? whichSync('pytest');
  const hasTests =
    existsSync(join(cwd, 'tests')) ||
    existsSync(join(cwd, 'test')) ||
    existsSync(join(cwd, 'pytest.ini')) ||
    existsSync(join(cwd, 'conftest.py'));
  if (hasTests)
    add({
      kind: 'test',
      unit: u.path,
      argv: [pytest ?? 'pytest', '-q', '-p', 'no:cacheprovider'],
      cwd,
      parser: 'tests',
      skipReason: pytest
        ? undefined
        : 'pytest not found (activate the virtualenv or install dev dependencies)',
    });
  const mypy = localBin(root, u.path, 'mypy');
  if (
    mypy &&
    (existsSync(join(cwd, 'mypy.ini')) || /\[tool\.mypy\]/.test(safeRead(join(cwd, 'pyproject.toml'))))
  )
    add({ kind: 'typecheck', unit: u.path, argv: [mypy, '.'], cwd, parser: 'generic' });
  const ruff = localBin(root, u.path, 'ruff');
  if (ruff) add({ kind: 'lint', unit: u.path, argv: [ruff, 'check', '.'], cwd, parser: 'generic' });
}

function safeRead(p: string): string {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------------------------------------------

/** Extracts pass/fail counts from the human output of common test runners. */
export function parseTestSummary(output: string): CheckResult['tests'] | undefined {
  const o = output;
  const num = (re: RegExp) => {
    const m = re.exec(o);
    return m ? Number(m[1]) : 0;
  };
  const failing: string[] = [];
  for (const m of o.matchAll(/^\s*(?:FAIL|✗|×|✕|❌)\s+(.{3,160})$/gm)) failing.push(m[1]!.trim());
  for (const m of o.matchAll(/^FAILED\s+(\S+)/gm)) failing.push(m[1]!);
  for (const m of o.matchAll(/^--- FAIL: (\S+)/gm)) failing.push(m[1]!);
  for (const m of o.matchAll(/^\s*(?:⨯|✘)\s+(.{3,160})$/gm)) failing.push(m[1]!.trim());
  // Vitest / Jest
  let mm = /Tests?:?\s+(?:(\d+) failed[^\n]*?)?(\d+) passed[^\n]*?\((\d+)\)/.exec(o);
  if (/Tests\s+(?:\d+ \w+ \| )*\d+ passed|Tests\s+\d+ failed/.test(o)) {
    const passed = num(/Tests\s+(?:[^\n]*?)(\d+) passed/);
    const failed = num(/Tests\s+(\d+) failed/);
    const skipped = num(/Tests\s+[^\n]*?(\d+) skipped/);
    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      failing: [...new Set(failing)].slice(0, 20),
    };
  }
  if (/^Tests:\s+/m.test(o) && /\d+ total/.test(o)) {
    const line = /^Tests:\s+(.*)$/m.exec(o)?.[1] ?? '';
    const passed = Number(/(\d+) passed/.exec(line)?.[1] ?? 0);
    const failed = Number(/(\d+) failed/.exec(line)?.[1] ?? 0);
    const skipped = Number(/(\d+) (?:skipped|pending|todo)/.exec(line)?.[1] ?? 0);
    const total = Number(/(\d+) total/.exec(line)?.[1] ?? passed + failed + skipped);
    return { passed, failed, skipped, total, failing: [...new Set(failing)].slice(0, 20) };
  }
  // Pest / Laravel artisan test: "Tests:    2 failed, 40 passed (120 assertions)"
  mm =
    /Tests:\s+(?:(\d+) failed,?\s*)?(?:(\d+) (?:skipped|incomplete|risky|warnings?),?\s*)*(\d+) passed/.exec(
      o,
    );
  if (mm) {
    const failed = Number(mm[1] ?? 0);
    const passed = Number(mm[3] ?? 0);
    const skipped = num(/(\d+) skipped/);
    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      failing: [...new Set(failing)].slice(0, 20),
    };
  }
  // PHPUnit: "OK (12 tests, 30 assertions)" / "Tests: 12, Assertions: 30, Failures: 2, Errors: 1, Skipped: 1."
  mm = /OK \((\d+) tests?/.exec(o);
  if (mm) return { passed: Number(mm[1]), failed: 0, skipped: 0, total: Number(mm[1]), failing: [] };
  mm =
    /Tests: (\d+), Assertions: \d+(?:, Errors: (\d+))?(?:, Failures: (\d+))?(?:, Errors: (\d+))?(?:, Warnings: \d+)?(?:, (?:Skipped|Incomplete): (\d+))?/.exec(
      o,
    );
  if (mm) {
    const total = Number(mm[1]);
    const failed = Number(mm[2] ?? 0) + Number(mm[3] ?? 0) + Number(mm[4] ?? 0);
    const skipped = Number(mm[5] ?? 0);
    return {
      passed: total - failed - skipped,
      failed,
      skipped,
      total,
      failing: [...new Set(failing)].slice(0, 20),
    };
  }
  // pytest: "== 3 failed, 10 passed, 1 skipped in 0.5s =="
  mm = /=+ (.*?) in [\d.]+s/.exec(o);
  if (mm && /passed|failed|error/.test(mm[1]!)) {
    const s = mm[1]!;
    const passed = Number(/(\d+) passed/.exec(s)?.[1] ?? 0);
    const failed = Number(/(\d+) failed/.exec(s)?.[1] ?? 0) + Number(/(\d+) errors?/.exec(s)?.[1] ?? 0);
    const skipped = Number(/(\d+) skipped/.exec(s)?.[1] ?? 0);
    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      failing: [...new Set(failing)].slice(0, 20),
    };
  }
  // node:test / TAP
  if (/^# pass \d+/m.test(o)) {
    const passed = num(/^# pass (\d+)/m);
    const failed = num(/^# fail (\d+)/m);
    const skipped = num(/^# skip(?:ped)? (\d+)/m);
    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      failing: [...new Set(failing)].slice(0, 20),
    };
  }
  // Mocha: "  12 passing (30ms)\n  2 failing"
  if (/\d+ passing/.test(o)) {
    const passed = num(/(\d+) passing/);
    const failed = num(/(\d+) failing/);
    const skipped = num(/(\d+) pending/);
    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      failing: [...new Set(failing)].slice(0, 20),
    };
  }
  // cargo: "test result: FAILED. 3 passed; 1 failed; 0 ignored"
  mm = /test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/.exec(o);
  if (mm)
    return {
      passed: Number(mm[1]),
      failed: Number(mm[2]),
      skipped: Number(mm[3]),
      total: Number(mm[1]) + Number(mm[2]) + Number(mm[3]),
      failing: [...new Set(failing)].slice(0, 20),
    };
  // flutter/dart: "+12 ~1 -2: Some tests failed." / "+12: All tests passed!"
  mm = /\+(\d+)(?: ~(\d+))?(?: -(\d+))?: (?:All tests passed|Some tests failed)/.exec(o);
  if (mm) {
    const passed = Number(mm[1]);
    const skipped = Number(mm[2] ?? 0);
    const failed = Number(mm[3] ?? 0);
    return {
      passed,
      failed,
      skipped,
      total: passed + failed + skipped,
      failing: [...new Set(failing)].slice(0, 20),
    };
  }
  // go test: count ok/FAIL packages
  if (/^(?:ok|FAIL|---)\s/m.test(o)) {
    const passed = (o.match(/^ok\s/gm) ?? []).length;
    const failed = (o.match(/^FAIL\s/gm) ?? []).length;
    if (passed + failed)
      return {
        passed,
        failed,
        skipped: 0,
        total: passed + failed,
        failing: [...new Set(failing)].slice(0, 20),
      };
  }
  return undefined;
}

export interface TscDiagnostic {
  file: string;
  line: number;
  column: number;
  code: string;
  message: string;
}

export function parseTsc(output: string): TscDiagnostic[] {
  const out: TscDiagnostic[] = [];
  for (const m of output.matchAll(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm))
    out.push({ file: m[1]!.trim(), line: Number(m[2]), column: Number(m[3]), code: m[4]!, message: m[5]! });
  for (const m of output.matchAll(/^(.+?):(\d+):(\d+) - error (TS\d+): (.+)$/gm))
    out.push({ file: m[1]!.trim(), line: Number(m[2]), column: Number(m[3]), code: m[4]!, message: m[5]! });
  return out;
}

export function parsePhpstan(output: string): TscDiagnostic[] {
  const start = output.indexOf('{');
  if (start < 0) return [];
  try {
    const j = JSON.parse(output.slice(start)) as {
      files?: Record<string, { messages: { message: string; line: number; identifier?: string }[] }>;
    };
    const out: TscDiagnostic[] = [];
    for (const [file, v] of Object.entries(j.files ?? {}))
      for (const m of v.messages)
        out.push({ file, line: m.line, column: 1, code: m.identifier ?? 'phpstan', message: m.message });
    return out;
  } catch {
    return [];
  }
}

export const EXEC_RULES = {
  test: registerExternalRule({
    id: 'exec/test-failure',
    title: 'Test suite fails',
    category: 'testing',
    severity: 'high',
    confidence: 'high',
    description:
      "The project's own test command exits with a failure when run by Relivaro (with `--allow-exec`).",
    impact:
      'A failing suite means the current code does not meet its own specification, or the suite is broken and no longer protects against regressions.',
    recommendation:
      'Fix the failing tests (or the code under test) before release; investigate flaky tests separately and quarantine them explicitly.',
    verification: 'Re-run `relivaro test --allow-exec`; the test check must pass.',
  }),
  build: registerExternalRule({
    id: 'exec/build-failure',
    title: 'Build fails',
    category: 'release',
    severity: 'critical',
    confidence: 'high',
    description: "The project's build command exits with a failure.",
    impact: 'The current revision cannot be deployed.',
    recommendation: 'Fix the build errors shown in the evidence and add the build to CI as a required check.',
    verification: 'Re-run `relivaro release --allow-exec`; the build check must pass.',
  }),
  typecheck: registerExternalRule({
    id: 'exec/type-error',
    title: 'Type checker reports errors',
    category: 'quality',
    severity: 'medium',
    confidence: 'high',
    description: 'The static type checker (tsc, PHPStan, mypy) reports errors.',
    impact:
      'Type errors frequently correspond to real runtime defects (undefined access, wrong argument types).',
    recommendation: 'Fix the reported errors and run the type checker in CI.',
    verification: 'Re-run the type check; it must report zero errors.',
  }),
  lint: registerExternalRule({
    id: 'exec/lint-failure',
    title: 'Linter reports errors',
    category: 'quality',
    severity: 'low',
    confidence: 'high',
    description: "The project's lint command fails.",
    impact: "Lint failures indicate code that violates the team's agreed rules and often block CI.",
    recommendation: 'Fix the lint errors (or update the configuration deliberately).',
    verification: 'Re-run the lint command; it must exit 0.',
  }),
  timeout: registerExternalRule({
    id: 'exec/check-timeout',
    title: 'Check timed out',
    category: 'reliability',
    severity: 'medium',
    confidence: 'high',
    description:
      'A build/test/type-check command did not finish within the configured timeout and was terminated.',
    impact: 'Hanging tests or builds block CI and usually indicate open handles, network calls or deadlocks.',
    recommendation:
      'Find the hanging test (run with verbose output), close open handles, mock network calls, or raise `timeouts.commandSeconds` if the check is legitimately long.',
    verification: 'The check completes within the timeout on re-run.',
  }),
} satisfies Record<string, RuleMeta>;

export interface ExecOutcome {
  results: CheckResult[];
  hits: { rule: RuleMeta; hit: Hit; provenance: 'executed' }[];
}

export async function runChecks(
  planned: PlannedCheck[],
  opts: { allowExec: boolean; timeoutSeconds: number; root: string; onProgress?: (msg: string) => void },
): Promise<ExecOutcome> {
  const results: CheckResult[] = [];
  const hits: ExecOutcome['hits'] = [];
  for (const p of planned) {
    const display = p.argv.join(' ');
    if (p.skipReason || !opts.allowExec) {
      results.push({
        kind: p.kind,
        unit: p.unit,
        command: display,
        status: 'skipped',
        durationMs: 0,
        reason: p.skipReason ?? 'requires --allow-exec',
      });
      continue;
    }
    opts.onProgress?.(`running ${p.kind} (${p.unit}): ${display}`);
    let r: RunResult;
    try {
      r = await runCommand(p.argv, {
        cwd: p.cwd,
        timeoutMs: opts.timeoutSeconds * 1000,
        allowExec: true,
        env: { NODE_ENV: p.kind === 'build' ? 'production' : 'test', APP_ENV: 'testing' },
      });
    } catch (e) {
      results.push({
        kind: p.kind,
        unit: p.unit,
        command: display,
        status: 'error',
        durationMs: 0,
        reason: (e as Error).message,
      });
      continue;
    }
    const output = `${r.stdout}\n${r.stderr}`;
    const res: CheckResult = {
      kind: p.kind,
      unit: p.unit,
      command: r.command,
      status: r.timedOut ? 'timeout' : r.error ? 'error' : r.exitCode === 0 ? 'passed' : 'failed',
      durationMs: r.durationMs,
      outputTail: tail(output, 60),
    };
    if (r.error) res.reason = r.error;
    if (p.parser === 'tests') res.tests = parseTestSummary(output);
    const evidence = { command: r.command, output: tail(output, 40) };
    const unitPrefix = p.unit === '.' ? '' : `${p.unit}/`;
    if (p.parser === 'tsc' || p.parser === 'phpstan') {
      const diags = p.parser === 'tsc' ? parseTsc(output) : parsePhpstan(output);
      res.diagnostics = diags.length;
      for (const d of diags.slice(0, 200)) {
        const rel = d.file.startsWith(opts.root)
          ? d.file.slice(opts.root.length + 1).replace(/\\/g, '/')
          : `${unitPrefix}${d.file.replace(/\\/g, '/').replace(/^\.\//, '')}`;
        hits.push({
          rule: EXEC_RULES.typecheck,
          hit: {
            file: rel,
            line: d.line,
            column: d.column,
            message: `${d.code}: ${d.message}`,
            facts: { code: d.code },
          },
          provenance: 'executed',
        });
      }
      if (res.status === 'failed' && diags.length === 0)
        hits.push({
          rule: EXEC_RULES.typecheck,
          hit: {
            message: `\`${r.command}\` failed in \`${p.unit}\`.`,
            snippet: evidence.output,
            anchor: `typecheck:${p.unit}`,
          },
          provenance: 'executed',
        });
    } else if (
      res.status === 'failed' ||
      res.status === 'timeout' ||
      (res.status === 'error' && p.kind !== 'lint')
    ) {
      const rule = res.status === 'timeout' ? EXEC_RULES.timeout : EXEC_RULES[p.kind];
      const t = res.tests;
      const msg =
        res.status === 'timeout'
          ? `\`${r.command}\` (${p.kind}, \`${p.unit}\`) was terminated after ${opts.timeoutSeconds}s.`
          : p.kind === 'test' && t
            ? `${t.failed} of ${t.total} tests failed in \`${p.unit}\`${t.failing.length ? ` (e.g. ${t.failing.slice(0, 3).join('; ')})` : ''}.`
            : `\`${r.command}\` exited with code ${r.exitCode ?? r.signal ?? 'error'} in \`${p.unit}\`.`;
      hits.push({
        rule,
        hit: {
          message: msg,
          snippet: evidence.output,
          anchor: `${p.kind}:${p.unit}`,
          facts: { command: r.command, exitCode: r.exitCode, durationMs: r.durationMs },
        },
        provenance: 'executed',
      });
    }
    results.push(res);
  }
  return { results, hits };
}
