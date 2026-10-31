import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAudit } from '../../src/audit.js';
import { runCommand, scrubbedEnv } from '../../src/exec/runner.js';
import { FileSet, safeResolve } from '../../src/fs/files.js';
import { assertLoadTarget, guardedLookup, isPrivateAddress, loadTest } from '../../src/perf/bench.js';
import { toHtml } from '../../src/report/html.js';
import { toMarkdown } from '../../src/report/markdown.js';
import { toSarif } from '../../src/report/sarif.js';
import { materialize } from '../helpers/fixtures.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'relivaro-sec-'));
const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]) {
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
}

describe('secret handling', () => {
  it('never emits a detected secret value in any report format', async () => {
    const fx = materialize('node-api');
    try {
      const { run } = await runAudit({ root: fx.dir, command: 'audit', noWrite: true });
      const secretFindings = run.findings.filter((f) => f.ruleId === 'sec/hardcoded-secret');
      expect(secretFindings.length).toBeGreaterThanOrEqual(3);
      const secrets = [
        ['AK', 'IA', 'Q7R2T9W3E5Y1U8P4'].join(''),
        ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join(''),
        ['Xk9', 'mP2vQ', '8zLw4'].join(''),
      ];
      const outputs = [JSON.stringify(run), toMarkdown(run), toHtml(run), JSON.stringify(toSarif(run))];
      for (const out of outputs) for (const s of secrets) expect(out).not.toContain(s);
    } finally {
      fx.cleanup();
    }
  });

  it('does not read untracked or ignored .env files, and reports them by path only', async () => {
    const dir = tmp();
    cleanups.push(dir);
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'app.js'), 'console.log(1);\n');
    writeFileSync(join(dir, '.gitignore'), '.env\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'x');
    const marker = `MARKER_${Date.now()}_PLEASE_DO_NOT_READ`;
    writeFileSync(join(dir, '.env'), `SECRET=${marker}\n`);
    writeFileSync(join(dir, '.env.local'), `TOKEN=${marker}\n`);
    const files = new FileSet(dir);
    expect(files.read('.env')).toBeUndefined();
    expect(files.readAny('.env')).toBeUndefined();
    expect(files.readAny('.env.local')).toBeUndefined();
    const { run } = await runAudit({ root: dir, command: 'audit', noWrite: true });
    const all = JSON.stringify(run);
    expect(all).not.toContain(marker);
    expect(
      run.findings.some((f) => f.ruleId === 'sec/env-file-not-ignored' && f.message.includes('.env.local')),
    ).toBe(true);
    expect(run.findings.some((f) => f.message.includes('`.env` is not ignored'))).toBe(false);
  });
});

describe('filesystem boundaries', () => {
  it('refuses traversal and absolute paths', () => {
    const dir = tmp();
    cleanups.push(dir);
    expect(() => safeResolve(dir, '../etc/passwd')).toThrow(/escapes/);
    expect(() => safeResolve(dir, '/etc/passwd')).toThrow(/escapes/);
    expect(() => safeResolve(dir, 'a/../../b')).toThrow(/escapes/);
  });

  it('does not follow symlinks that leave the project', () => {
    const outside = tmp();
    const dir = tmp();
    cleanups.push(outside, dir);
    writeFileSync(join(outside, 'secret.ts'), 'const leaked = "outside";\n');
    mkdirSync(join(outside, 'sub'));
    writeFileSync(join(outside, 'sub', 'x.ts'), 'export {};\n');
    writeFileSync(join(dir, 'ok.ts'), 'export const ok = 1;\n');
    try {
      symlinkSync(join(outside, 'secret.ts'), join(dir, 'link.ts'));
      symlinkSync(join(outside, 'sub'), join(dir, 'linkdir'), 'dir');
    } catch {
      return; // symlinks not permitted on this platform/user
    }
    const files = new FileSet(dir, { useGit: false });
    expect(files.files.map((f) => f.path)).toEqual(['ok.ts']);
    expect(files.skipped.symlinkOutside).toBeGreaterThanOrEqual(1);
    expect(() => safeResolve(dir, 'link.ts')).toThrow(/escapes/);
  });

  it('cannot be made to execute repository-configured git commands (core.fsmonitor)', () => {
    const dir = tmp();
    cleanups.push(dir);
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'a.js'), '1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'x');
    const pwned = join(dir, 'PWNED');
    const hook = process.platform === 'win32' ? `cmd /c type nul > "${pwned}"` : `touch "${pwned}"`;
    execFileSync('git', ['config', 'core.fsmonitor', hook], { cwd: dir });
    const files = new FileSet(dir);
    expect(files.gitRepo).toBe(true);
    expect(files.files.map((f) => f.path)).toContain('a.js');
    expect(existsSync(pwned)).toBe(false);
  });
});

describe('command execution', () => {
  it('refuses to run anything without allowExec', async () => {
    await expect(
      runCommand(['node', '-e', '1'], { cwd: process.cwd(), timeoutMs: 5000, allowExec: false }),
    ).rejects.toThrow(/--allow-exec/);
  });

  it('passes arguments without shell interpretation', async () => {
    const dir = tmp();
    cleanups.push(dir);
    const r = await runCommand(
      [process.execPath, '-e', 'console.log(process.argv[1])', '$(touch pwned); `touch pwned2`'],
      { cwd: dir, timeoutMs: 10000, allowExec: true },
    );
    expect(r.stdout.trim()).toBe('$(touch pwned); `touch pwned2`');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('scrubs secrets from the child environment', async () => {
    process.env.RELIVARO_TEST_API_TOKEN = 'should-not-leak';
    process.env.AWS_SECRET_ACCESS_KEY = 'should-not-leak-either';
    try {
      expect(scrubbedEnv().RELIVARO_TEST_API_TOKEN).toBeUndefined();
      const r = await runCommand([process.execPath, '-e', 'console.log(JSON.stringify(process.env))'], {
        cwd: process.cwd(),
        timeoutMs: 10000,
        allowExec: true,
      });
      expect(r.stdout).not.toContain('should-not-leak');
      expect(JSON.parse(r.stdout).CI).toBe('true');
    } finally {
      delete process.env.RELIVARO_TEST_API_TOKEN;
      delete process.env.AWS_SECRET_ACCESS_KEY;
    }
  });

  it('caps captured output', async () => {
    const r = await runCommand([process.execPath, '-e', 'process.stdout.write("x".repeat(500000))'], {
      cwd: process.cwd(),
      timeoutMs: 10000,
      allowExec: true,
      maxOutputBytes: 1000,
    });
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
    expect(r.truncated).toBe(true);
  });
});

describe('network boundaries', () => {
  it('makes no network request unless --online is given', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network used');
    });
    const fx = materialize('node-api');
    try {
      const { run } = await runAudit({ root: fx.dir, command: 'audit', noWrite: true });
      expect(spy).not.toHaveBeenCalled();
      expect(run.limitations.some((l) => /offline mode/.test(l))).toBe(true);
    } finally {
      spy.mockRestore();
      fx.cleanup();
    }
  });

  it('refuses load tests against public addresses', async () => {
    await expect(assertLoadTarget(new URL('http://8.8.8.8/'), false)).rejects.toMatchObject({
      code: 'TARGET_NOT_ALLOWED',
    });
    await expect(assertLoadTarget(new URL('http://127.0.0.1:1/'), false)).resolves.toEqual(['127.0.0.1']);
    await expect(assertLoadTarget(new URL('file:///etc/passwd'), false)).rejects.toThrow(/http/);
  });

  it('classifies private, mapped and special-purpose addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '169.254.169.254',
      '0.0.0.0',
      '198.18.0.1',
      '::1',
      '::',
      'fd12::1',
      'febf::1',
      '::ffff:127.0.0.1',
      '::ffff:172.16.0.1',
      '::ffff:7f00:1',
      '::ffff:a9fe:a9fe',
      '[::1]',
      'fe80::1%lo0',
    ])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of [
      '8.8.8.8',
      '172.32.0.1',
      '100.128.0.1',
      '::ffff:8.8.8.8',
      '64:ff9b::808:808',
      '2001:4860::8888',
    ])
      expect(isPrivateAddress(ip), ip).toBe(false);
  });

  it('re-checks the address every connection uses (DNS rebinding)', async () => {
    const lookupOnce = (allow: boolean, host: string) =>
      new Promise<string>((resolve, reject) =>
        guardedLookup(allow)(host, { family: 0 }, (err, address) =>
          err ? reject(err) : resolve(String(address)),
        ),
      );
    await expect(lookupOnce(false, '8.8.8.8')).rejects.toMatchObject({ code: 'TARGET_NOT_ALLOWED' });
    await expect(lookupOnce(true, '8.8.8.8')).resolves.toBe('8.8.8.8');
    await expect(lookupOnce(false, '127.0.0.1')).resolves.toBe('127.0.0.1');
  });

  it('load-tests a local server through the guarded client', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const port = (server.address() as { port: number }).port;
      const r = await loadTest({
        name: 'local',
        url: `http://127.0.0.1:${port}/`,
        method: 'GET',
        headers: {},
        concurrency: 2,
        durationSec: 0.3,
        maxRequests: 20,
        timeoutMs: 2000,
        allowRemote: false,
      });
      expect(r.requests).toBe(20);
      expect(r.statusCodes['200']).toBe(20);
      expect(r.errors).toBe(0);
    } finally {
      server.close();
    }
  });

  it('caps load test concurrency and duration', async () => {
    const fetchImpl = (async () => new Response('ok')) as unknown as typeof fetch;
    const r = await loadTest({
      name: 't',
      url: 'http://127.0.0.1:9/',
      method: 'GET',
      headers: {},
      concurrency: 1000,
      durationSec: 0.2,
      maxRequests: 50,
      timeoutMs: 1000,
      allowRemote: false,
      fetchImpl,
    });
    expect(r.concurrency).toBe(64);
    expect(r.limitedBy.join(' ')).toMatch(/concurrency capped/);
    expect(r.requests).toBeLessThanOrEqual(50 + 64);
  });
});

describe('report injection', () => {
  it('cannot inject markup or scripts into the HTML report', async () => {
    const dir = tmp();
    cleanups.push(dir);
    const payload = '</script><script>alert(document.cookie)</script><img src=x onerror=alert(1)>';
    writeFileSync(
      join(dir, 'app.py'),
      `import subprocess\nfrom flask import request\n\ndef run():\n    # ${payload}\n    subprocess.check_output(f"ls {request.args['d']}", shell=True)  # ${payload}\n`,
    );
    mkdirSync(join(dir, `${'x'.repeat(3)}`));
    const { run } = await runAudit({ root: dir, command: 'audit', noWrite: true, useGit: false });
    expect(run.findings.length).toBeGreaterThan(0);
    const html = toHtml(run);
    const dataStart = html.indexOf('<script type="application/json" id="data">');
    const dataEnd = html.indexOf('</script>', dataStart);
    const data = html.slice(dataStart, dataEnd);
    expect(data).not.toContain('</script>');
    expect(data).not.toContain('<script>');
    expect(html.match(/<script/g)!.length).toBe(2);
    expect(html).toContain("default-src 'none'");
    expect(readFileSync(join(dir, 'app.py'), 'utf8')).toContain(payload);
  });
});
