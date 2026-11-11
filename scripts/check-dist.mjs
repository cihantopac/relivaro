#!/usr/bin/env node
// CI guard: the committed plugin/dist bundle and generated docs must match a fresh build of src/.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'relivaro-dist-'));
execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs'), tmp], { stdio: 'inherit' });
const norm = (s) => s.replace(/\r\n/g, '\n');
let ok = true;
for (const f of ['relivaro.mjs', 'api.mjs', 'api.d.ts'])
  if (
    norm(readFileSync(join(tmp, f), 'utf8')) !== norm(readFileSync(join(root, 'plugin', 'dist', f), 'utf8'))
  ) {
    console.error(`plugin/dist/${f} is out of date. Run \`npm run build\` and commit the result.`);
    ok = false;
  }
for (const [arg, files] of [
  ['__cli-markdown', ['docs/CLI.md', 'plugin/skills/relivaro/references/cli.md']],
  ['__rules-markdown', ['docs/RULES.md', 'plugin/skills/relivaro/references/rules.md']],
]) {
  const md = norm(execFileSync(process.execPath, [join(tmp, 'relivaro.mjs'), arg], { encoding: 'utf8' }));
  for (const f of files)
    if (norm(readFileSync(join(root, f), 'utf8')) !== md) {
      console.error(`${f} is out of date. Run \`npm run build\`.`);
      ok = false;
    }
}
if (!ok) process.exit(1);
console.log('dist and generated docs are up to date.');
