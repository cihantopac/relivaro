#!/usr/bin/env node
// Clean-environment installation test: packs the npm tarball, installs it into an empty directory with no access
// to this repository's node_modules, and runs the installed CLI against a fixture.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materialize, ROOT } from './lib/fixtures.mjs';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const work = mkdtempSync(join(tmpdir(), 'relivaro-install-'));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
try {
  run(npm, ['pack', '--pack-destination', work, '--silent'], ROOT);
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');
  const app = join(work, 'app');
  execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(app)})`]);
  writeFileSync(join(app, 'package.json'), '{"name":"smoke","private":true}');
  run(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', join(work, tgz)], app);
  const bin = join(app, 'node_modules', 'relivaro', 'plugin', 'dist', 'relivaro.mjs');
  const version = run(process.execPath, [bin, 'version'], app).trim();
  const doctor = JSON.parse(run(process.execPath, [bin, 'doctor', '--json'], app));
  if (!doctor.ok)
    throw new Error(`doctor failed: ${JSON.stringify(doctor.checks.filter((c) => c.required && !c.ok))}`);
  const fx = materialize('python-app');
  try {
    const out = JSON.parse(run(process.execPath, [bin, 'security', fx.dir, '--json', '--no-write'], app));
    if (out.summary.open < 10)
      throw new Error(`expected findings from the installed CLI, got ${out.summary.open}`);
    console.log(
      `clean install OK: relivaro ${version}, ${out.summary.open} findings on the python fixture, tarball ${tgz}`,
    );
  } finally {
    fx.cleanup();
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
