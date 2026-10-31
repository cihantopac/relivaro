#!/usr/bin/env node
// Debug helper: run the built CLI on one fixture and print false positives/negatives.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { materialize, ROOT, score } from './lib/fixtures.mjs';

const name = process.argv[2];
const { dir, expected, cleanup } = materialize(name);
try {
  let out;
  try {
    out = execFileSync(
      process.execPath,
      [join(ROOT, 'plugin/dist/relivaro.mjs'), 'audit', dir, '--json', '--no-write'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch (e) {
    out = e.stdout;
  }
  const run = JSON.parse(out);
  const s = score(run.findings, expected);
  console.log(
    `${name}: tp=${s.tp} fp=${s.fp.length} fn=${s.fn.length} precision=${s.precision.toFixed(3)} recall=${s.recall.toFixed(3)}`,
  );
  for (const f of s.fp)
    console.log(`  FP ${f.ruleId} ${f.location?.file}:${f.location?.line} — ${f.message}`);
  for (const e of s.fn) console.log(`  FN ${e.rule} ${e.file}:${e.line ?? ''}`);
  if (process.argv[3] === '--errors') console.log(JSON.stringify(run.errors, null, 2));
} finally {
  cleanup();
}
