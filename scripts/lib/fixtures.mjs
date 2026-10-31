// Shared by the detection benchmark (scripts/bench.mjs) and the integration tests.
// Fixture projects live in fixtures/projects/<name>. Expected findings are declared inline with
// `expect: <rule> [<rule>…]` in a trailing comment on the reported line, or in `.expect.json` for findings without
// an annotatable line. Synthetic secrets are injected at materialisation time (`__RLV_SECRET_<KIND>__`) so the
// repository itself never contains strings that look like real credentials.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES = join(ROOT, 'fixtures', 'projects');

const SECRETS = {
  AWS: ['AK', 'IA', 'Q7R2T9W3E5Y1U8P4'].join(''),
  GITHUB: ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join(''),
  STRIPE: ['sk', '_live_', '4eC39HqLyjWDarjtT1zdp7dc'].join(''),
  DBPASS: ['Xk9', 'mP2vQ', '8zLw4'].join(''),
  SLACK: ['xo', 'xb-', '2048193741-9183748172-aB3dE5fG7hJ9kL1mN3pQ5rS7'].join(''),
  LARAVEL: ['base64', ':', 'q3Lf8cK2mXv9Z1aR7tY4wE6uI0oP5sD3gH8jK2lN6bM='].join(''),
  OPENAI: ['sk-', 'proj-', 'Ab12Cd34Ef56Gh78Ij90', 'T3Blbk', 'FJ', 'Kl12Mn34Op56Qr78St90Uv'].join(''),
};

export function listFixtures() {
  return readdirSync(FIXTURES)
    .filter((d) => statSync(join(FIXTURES, d)).isDirectory())
    .sort();
}

function walk(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(p, base, out);
    } else out.push(relative(base, p).split(sep).join('/'));
  }
  return out;
}

const ANNOT = /(?:\/\/|#|<!--|\{\{--|\/\*|--)\s*expect:\s*([\w/.\- ]+?)\s*(?:-->|--\}\}|\*\/\s*\}?)?\s*$/;

export function expectations(dir) {
  const out = [];
  for (const f of walk(dir)) {
    if (f === '.expect.json' || f === '.setup.json') continue;
    let text;
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    text.split(/\r?\n/).forEach((l, i) => {
      const m = ANNOT.exec(l);
      if (m) for (const rule of m[1].trim().split(/\s+/)) out.push({ rule, file: f, line: i + 1 });
    });
  }
  const extra = join(dir, '.expect.json');
  if (existsSync(extra)) for (const e of JSON.parse(readFileSync(extra, 'utf8')).findings) out.push(e);
  return out;
}

function git(cwd, args) {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Relivaro Fixture',
      '-c',
      'user.email=fixture@relivaro.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
}

/** Copies a fixture to a temp dir, injects synthetic secrets and (by default) makes it a git repo with one commit. */
export function materialize(name, { gitInit = true } = {}) {
  const src = join(FIXTURES, name);
  const dir = mkdtempSync(join(tmpdir(), `relivaro-fx-${name}-`));
  cpSync(src, dir, { recursive: true });
  const expected = expectations(dir);
  const setup = existsSync(join(dir, '.setup.json'))
    ? JSON.parse(readFileSync(join(dir, '.setup.json'), 'utf8'))
    : {};
  rmSync(join(dir, '.expect.json'), { force: true });
  rmSync(join(dir, '.setup.json'), { force: true });
  for (const f of walk(dir)) {
    const p = join(dir, f);
    const t = readFileSync(p, 'utf8');
    if (t.includes('__RLV_SECRET_'))
      writeFileSync(
        p,
        t.replace(/__RLV_SECRET_([A-Z]+)__/g, (_m, k) => SECRETS[k] ?? 'unknown'),
      );
  }
  if (gitInit) {
    git(dir, ['init', '-q', '-b', 'main']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'fixture']);
  }
  for (const [f, content] of Object.entries(setup.untracked ?? {})) writeFileSync(join(dir, f), content);
  return { dir, expected, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Matches findings to expectations (rule + file + line when the expectation has one). */
export function score(findings, expected) {
  const open = findings.filter((f) => f.status === 'open' || f.status === 'suppressed');
  const used = new Set();
  const tp = [];
  const fn = [];
  for (const e of expected) {
    const idx = open.findIndex(
      (f, i) =>
        !used.has(i) &&
        f.ruleId === e.rule &&
        (f.location?.file ?? '') === (e.file ?? '') &&
        (e.line === undefined || f.location?.line === e.line),
    );
    const idx2 =
      idx >= 0
        ? idx
        : open.findIndex(
            (f, i) => !used.has(i) && f.ruleId === e.rule && e.file === undefined && !f.location,
          );
    if (idx2 >= 0) {
      used.add(idx2);
      tp.push(e);
    } else fn.push(e);
  }
  const fp = open.filter((_f, i) => !used.has(i));
  const byRule = {};
  const bump = (r, k) => {
    byRule[r] ??= { tp: 0, fp: 0, fn: 0 };
    byRule[r][k]++;
  };
  for (const e of tp) bump(e.rule, 'tp');
  for (const e of fn) bump(e.rule, 'fn');
  for (const f of fp) bump(f.ruleId, 'fp');
  const precision = tp.length + fp.length ? tp.length / (tp.length + fp.length) : 1;
  const recall = tp.length + fn.length ? tp.length / (tp.length + fn.length) : 1;
  return { tp: tp.length, fp, fn, precision, recall, byRule };
}
