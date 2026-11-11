import * as cp from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { materialize } from '../helpers/fixtures.js';

// Pass-through spies on every way to start a process; this file owns the module mock, so it stays out of the
// other security tests.
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const wrap = <F extends (...a: never[]) => unknown>(f: F) => vi.fn(f);
  return {
    ...orig,
    spawn: wrap(orig.spawn),
    spawnSync: wrap(orig.spawnSync),
    exec: wrap(orig.exec),
    execSync: wrap(orig.execSync),
    execFile: wrap(orig.execFile),
    execFileSync: wrap(orig.execFileSync),
    fork: wrap(orig.fork),
  };
});

const { main } = await import('../../src/cli/main.js');

type Spy = { mock: { calls: unknown[] }; mockClear(): void };
const PROCESS_SPIES = [
  cp.spawn,
  cp.spawnSync,
  cp.exec,
  cp.execSync,
  cp.execFile,
  cp.execFileSync,
  cp.fork,
].map((f) => f as unknown as Spy);
const processCalls = () => PROCESS_SPIES.reduce((n, f) => n + f.mock.calls.length, 0);
const resetProcessSpies = () => {
  for (const f of PROCESS_SPIES) f.mockClear();
};

let stderr = '';
let stdout = '';
const dirs: string[] = [];
beforeEach(() => {
  stderr = '';
  stdout = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    stderr += String(s);
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    stdout += String(s);
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.RELIVARO_LOCKDOWN;
});
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'rlv-lock-'));
  dirs.push(d);
  return d;
};

describe('lockdown', () => {
  const forbidden: [string[], string][] = [
    [['audit', '.', '--lockdown', '--allow-exec'], '--allow-exec'],
    [['release', '.', '--lockdown', '--online'], '--online'],
    [['fix', 'apply', 'latest', '--lockdown'], 'fix apply'],
    [['baseline', '.', '--lockdown'], 'baseline'],
    [['init', '.', '--lockdown'], 'init'],
    [['load', '--lockdown'], 'load'],
    [['bench', '--lockdown', '--cmd', 'node -v'], 'bench'],
    [['review', 'add', '--lockdown'], 'review add'],
  ];
  for (const [argv, what] of forbidden)
    it(`--lockdown forbids ${what}`, async () => {
      expect(await main(argv)).toBe(2);
      expect(stderr).toContain(`--lockdown forbids ${what}`);
    });

  it('RELIVARO_LOCKDOWN=1 is the same as --lockdown', async () => {
    process.env.RELIVARO_LOCKDOWN = '1';
    expect(await main(['audit', '.', '--allow-exec'])).toBe(2);
    expect(stderr).toContain('--lockdown forbids --allow-exec');
  });

  it('refuses to write reports into the audited directory', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'a.js'), 'console.log(1);\n');
    expect(await main(['audit', dir, '--lockdown'])).toBe(2);
    expect(stderr).toContain('--lockdown forbids writing into the audited directory');
  });

  it('a full audit starts no process and makes no network request', async () => {
    const fx = materialize('node-api', { gitInit: true });
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      resetProcessSpies();
      const code = await main(['audit', fx.dir, '--lockdown', '--workspace', scratch(), '--json']);
      expect(code).toBe(0);
      expect(processCalls()).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(JSON.parse(stdout).findings.length).toBeGreaterThan(10);
    } finally {
      fx.cleanup();
    }
  });

  it('ignores a hostile repository config', async () => {
    const dir = scratch();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'run.js'), 'eval(process.argv[2]);\n');
    writeFileSync(join(dir, 'relivaro.config.json'), JSON.stringify({ exclude: ['**'] }));
    expect(await main(['audit', dir, '--no-write', '--json'])).toBe(0);
    expect(
      JSON.parse(stdout).findings.some((f: { ruleId: string }) => f.ruleId === 'sec/code-injection'),
    ).toBe(false);
    for (const flag of ['--lockdown', '--ignore-repo-config']) {
      stdout = '';
      expect(await main(['audit', dir, '--no-write', '--json', flag])).toBe(0);
      expect(
        JSON.parse(stdout).findings.some((f: { ruleId: string }) => f.ruleId === 'sec/code-injection'),
        flag,
      ).toBe(true);
    }
  });
});
