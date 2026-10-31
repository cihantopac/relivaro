#!/usr/bin/env node
// Relivaro benchmark: detection accuracy on the fixture corpus and analysis performance on a generated synthetic
// repository (plus optional local repositories: RELIVARO_BENCH_REPOS=/path/a,/path/b, reported anonymously).
// Writes bench/results/latest.json and prints a summary.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { listFixtures, materialize, ROOT, score } from './lib/fixtures.mjs';

const CLI = join(ROOT, 'plugin', 'dist', 'relivaro.mjs');
const MEASURE = join(ROOT, 'scripts', 'lib', 'measure.mjs');
const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

function measure(args) {
  const out = join(mkdtempSync(join(tmpdir(), 'relivaro-m-')), 'm.json');
  const r = spawnSync(process.execPath, [MEASURE, CLI, out, ...args], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`measure failed: ${r.stderr}`);
  const m = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(join(out, '..'), { recursive: true, force: true });
  return m;
}

// 1. Detection accuracy
const detection = { fixtures: {}, byRule: {} };
let TP = 0;
let FP = 0;
let FN = 0;
for (const name of listFixtures()) {
  const fx = materialize(name);
  try {
    const m = measure(['audit', fx.dir, '--json', '--no-write']);
    const run = JSON.parse(m.stdout);
    const s = score(run.findings, fx.expected);
    TP += s.tp;
    FP += s.fp.length;
    FN += s.fn.length;
    detection.fixtures[name] = {
      tp: s.tp,
      fp: s.fp.length,
      fn: s.fn.length,
      precision: s.precision,
      recall: s.recall,
      ms: Math.round(m.ms),
    };
    for (const [rule, v] of Object.entries(s.byRule)) {
      detection.byRule[rule] ??= { tp: 0, fp: 0, fn: 0 };
      const agg = detection.byRule[rule];
      agg.tp += v.tp;
      agg.fp += v.fp;
      agg.fn += v.fn;
    }
  } finally {
    fx.cleanup();
  }
}
detection.total = {
  tp: TP,
  fp: FP,
  fn: FN,
  precision: TP / (TP + FP || 1),
  recall: TP / (TP + FN || 1),
  rulesCovered: Object.keys(detection.byRule).length,
};

// 2. Performance on a generated repository (deterministic content, ~3,000 files)
function synth(dir, units = 60) {
  const js = (i) =>
    `import express from 'express';\nimport { pool } from './db.js';\nconst router = express.Router();\nrouter.get('/items/${i}', async (req, res) => {\n  const r = await pool.query('SELECT * FROM items WHERE id = $1', [req.params.id]);\n  if (!r.rows.length) return res.status(404).end();\n  res.json(r.rows[0]);\n});\nexport function helper${i}(a, b) {\n  if (a > b) return a - b;\n  for (const x of [a, b]) { if (x % 2) return x; }\n  return a + b;\n}\nexport default router;\n`;
  const php = (i) =>
    `<?php\n\nnamespace App\\Http\\Controllers;\n\nuse App\\Models\\Item;\nuse Illuminate\\Http\\Request;\n\nclass Item${i}Controller extends Controller\n{\n    public function show(Request $request, string $id)\n    {\n        $item = Item::with('tags')->findOrFail($id);\n        return response()->json($item);\n    }\n\n    public function store(Request $request)\n    {\n        $data = $request->validate(['name' => 'required|string']);\n        return Item::create($data);\n    }\n}\n`;
  const py = (i) =>
    `import requests\n\n\ndef fetch_${i}(session, item_id):\n    r = requests.get(f"https://api.example.com/items/{item_id}", timeout=10)\n    r.raise_for_status()\n    return r.json()\n\n\ndef total_${i}(values):\n    return sum(v for v in values if v > 0)\n`;
  for (let u = 0; u < units; u++) {
    const base = join(dir, `services/svc${u}`);
    mkdirSync(join(base, 'src'), { recursive: true });
    mkdirSync(join(base, 'app/Http/Controllers'), { recursive: true });
    mkdirSync(join(base, 'py'), { recursive: true });
    writeFileSync(
      join(base, 'package.json'),
      JSON.stringify({ name: `svc${u}`, private: true, dependencies: { express: '4.21.2' } }),
    );
    for (let i = 0; i < 20; i++) writeFileSync(join(base, 'src', `route${i}.js`), js(i));
    for (let i = 0; i < 15; i++)
      writeFileSync(join(base, 'app/Http/Controllers', `Item${i}Controller.php`), php(i));
    for (let i = 0; i < 15; i++) writeFileSync(join(base, 'py', `mod${i}.py`), py(i));
  }
}
const synthDir = mkdtempSync(join(tmpdir(), 'relivaro-synth-'));
synth(synthDir);
execFileSync('git', ['init', '-q'], { cwd: synthDir });
execFileSync(
  'git',
  ['-c', 'user.name=b', '-c', 'user.email=b@b.invalid', '-c', 'commit.gpgsign=false', 'add', '-A'],
  { cwd: synthDir },
);
execFileSync(
  'git',
  ['-c', 'user.name=b', '-c', 'user.email=b@b.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 's'],
  { cwd: synthDir },
);
const perf = {};
const runs = [];
for (let i = 0; i < 3; i++) runs.push(measure(['audit', synthDir, '--json', '--no-write']));
const synthRun = JSON.parse(runs[0].stdout);
const times = runs.map((r) => r.ms).sort((a, b) => a - b);
perf.synthetic = {
  files: synthRun.metrics.files,
  linesOfCode: synthRun.metrics.linesOfCode,
  parsedFiles: synthRun.metrics.parsedFiles,
  rulesRun: synthRun.metrics.rulesRun,
  medianMs: Math.round(times[1]),
  minMs: Math.round(times[0]),
  maxMs: Math.round(times[2]),
  filesPerSecond: Math.round(synthRun.metrics.files / (times[1] / 1000)),
  linesPerSecond: Math.round(synthRun.metrics.linesOfCode / (times[1] / 1000)),
  peakRssMb: Math.round(Math.max(...runs.map((r) => r.maxRssKb)) / 1024),
  openFindings: synthRun.summary.open,
};
rmSync(synthDir, { recursive: true, force: true });

// 3. Optional real repositories (anonymised)
perf.repositories = [];
for (const [i, repo] of (process.env.RELIVARO_BENCH_REPOS ?? '').split(',').filter(Boolean).entries()) {
  const m = measure(['audit', repo, '--json', '--no-write']);
  const run = JSON.parse(m.stdout);
  perf.repositories.push({
    id: `repo-${i + 1}`,
    stack:
      [...new Set(run.profile.units.flatMap((u) => u.frameworks))].slice(0, 6).join(', ') ||
      run.profile.languages[0]?.name,
    files: run.metrics.files,
    linesOfCode: run.metrics.linesOfCode,
    parsedFiles: run.metrics.parsedFiles,
    ms: Math.round(m.ms),
    peakRssMb: Math.round(m.maxRssKb / 1024),
    open: run.summary.open,
    bySeverity: run.summary.bySeverity,
  });
}

const result = {
  relivaro: version,
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    cpuModel: cpus()[0]?.model,
    memoryGb: Math.round(totalmem() / 1024 ** 3),
  },
  detection,
  performance: perf,
};
mkdirSync(join(ROOT, 'bench', 'results'), { recursive: true });
writeFileSync(join(ROOT, 'bench', 'results', 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);

console.log(
  `Relivaro ${version} benchmark (${result.environment.platform}/${result.environment.arch}, ${result.environment.cpuModel}, node ${process.version})`,
);
console.log(
  `Detection: precision ${(detection.total.precision * 100).toFixed(1)}%  recall ${(detection.total.recall * 100).toFixed(1)}%  (tp ${TP}, fp ${FP}, fn ${FN}, ${detection.total.rulesCovered} rules covered)`,
);
for (const [n, f] of Object.entries(detection.fixtures))
  console.log(`  ${n.padEnd(16)} tp ${String(f.tp).padStart(3)}  fp ${f.fp}  fn ${f.fn}  ${f.ms} ms`);
const s = perf.synthetic;
console.log(
  `Synthetic repo: ${s.files} files, ${s.linesOfCode} lines → median ${s.medianMs} ms (${s.filesPerSecond} files/s, ${s.linesPerSecond} lines/s), peak RSS ${s.peakRssMb} MB`,
);
for (const r of perf.repositories)
  console.log(
    `  ${r.id} (${r.stack}): ${r.files} files, ${r.linesOfCode} lines → ${r.ms} ms, ${r.peakRssMb} MB, ${r.open} open findings`,
  );
const failed = detection.total.precision < 0.95 || detection.total.recall < 0.95;
if (failed) {
  console.error('Detection accuracy below the 95% gate.');
  process.exitCode = 1;
}
