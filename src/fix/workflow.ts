import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { RelivaroError } from '../core/errors.js';
import { sha256 } from '../core/hash.js';
import type { Finding } from '../core/types.js';
import { VERSION } from '../core/version.js';
import { atomicWrite, type Workspace } from '../core/workspace.js';
import { runCommand, splitCommand, tail } from '../exec/runner.js';
import { FileSet, safeResolve } from '../fs/files.js';
import { discover } from '../intel/discover.js';
import { analyze } from '../rules/engine.js';
import { RULES } from '../rules/index.js';
import { unifiedDiff } from './diff.js';
import { findFixer, type Fixer } from './fixers.js';

export interface PlanItem {
  findingId: string;
  fingerprint: string;
  ruleId: string;
  fixer: string;
  title: string;
  safety: Fixer['safety'];
  file: string;
  line?: number;
  message: string;
}

export interface PlannedFile {
  path: string;
  beforeHash: string;
  afterHash: string;
  existed: boolean;
  diff: string;
}

export interface FixPlan {
  schemaVersion: 1;
  tool: string;
  planId: string;
  createdAt: string;
  root: string;
  items: PlanItem[];
  skipped: { findingId: string; reason: string }[];
  files: PlannedFile[];
}

export interface ApplyRecord {
  schemaVersion: 1;
  applyId: string;
  planId: string;
  appliedAt: string;
  root: string;
  items: PlanItem[];
  files: { path: string; beforeHash: string; afterHash: string; existed: boolean; mode?: number }[];
  verification: Verification;
  rolledBackAt?: string;
}

export interface Verification {
  static: { resolved: string[]; unresolved: string[]; introduced: { ruleId: string; file?: string; message: string }[] };
  command?: { command: string; isolated: boolean; before?: { exitCode: number | null; durationMs: number; timedOut: boolean }; after: { exitCode: number | null; durationMs: number; timedOut: boolean; outputTail: string } };
  verdict: 'verified' | 'static-only' | 'failed';
  notes: string[];
}

/** Generates new file contents for the given fixable findings, applying bottom-up per file so locations stay valid. */
export async function generateFixes(root: string, findings: Finding[], readFile: (p: string) => string | undefined): Promise<{ contents: Map<string, { before: string; after: string; existed: boolean }>; items: PlanItem[]; skipped: FixPlan['skipped'] }> {
  const contents = new Map<string, { before: string; after: string; existed: boolean }>();
  const items: PlanItem[] = [];
  const skipped: FixPlan['skipped'] = [];
  const sorted = [...findings].sort((a, b) => (a.location?.file ?? '').localeCompare(b.location?.file ?? '') || (b.location?.line ?? 0) - (a.location?.line ?? 0) || (b.location?.column ?? 0) - (a.location?.column ?? 0));
  for (const f of sorted) {
    const fixer = f.fixer ? findFixer(f.fixer) : undefined;
    if (!fixer) {
      skipped.push({ findingId: f.id, reason: 'no automated fixer for this finding' });
      continue;
    }
    const target = fixer.target?.(f) ?? f.location?.file;
    if (!target) {
      skipped.push({ findingId: f.id, reason: 'finding has no file location' });
      continue;
    }
    safeResolve(root, target);
    let entry = contents.get(target);
    if (!entry) {
      const text = readFile(target);
      const existed = text !== undefined;
      if (!existed && !fixer.target) {
        skipped.push({ findingId: f.id, reason: `cannot read ${target}` });
        continue;
      }
      entry = { before: text ?? '', after: text ?? '', existed };
    }
    let next: string | null;
    try {
      next = await fixer.apply({ path: target, text: entry.after, finding: f });
    } catch (e) {
      skipped.push({ findingId: f.id, reason: `fixer error: ${(e as Error).message}` });
      continue;
    }
    if (next === null || next === entry.after) {
      skipped.push({ findingId: f.id, reason: 'code no longer matches the pattern the fixer expects (already fixed or changed)' });
      continue;
    }
    entry.after = next;
    contents.set(target, entry);
    items.push({ findingId: f.id, fingerprint: f.fingerprint, ruleId: f.ruleId, fixer: fixer.id, title: fixer.title, safety: fixer.safety, file: target, line: f.location?.line, message: f.message });
  }
  return { contents, items, skipped };
}

export async function createPlan(root: string, findings: Finding[], ws: Workspace): Promise<FixPlan> {
  const files = new FileSet(root);
  const { contents, items, skipped } = await generateFixes(files.root, findings, (p) => files.read(p) ?? files.readAny(p));
  const planId = ws.newRunId('fix-');
  const planned: PlannedFile[] = [];
  for (const [path, c] of contents) {
    planned.push({ path, beforeHash: sha256(c.before), afterHash: sha256(c.after), existed: c.existed, diff: unifiedDiff(path, c.before, c.after) });
    ws.writeText(['fixes', planId, 'after', ...path.split('/')], c.after);
  }
  const plan: FixPlan = { schemaVersion: 1, tool: VERSION, planId, createdAt: new Date().toISOString(), root: files.root, items: items.reverse(), skipped, files: planned };
  ws.writeJson(['fixes', planId, 'plan.json'], plan);
  return plan;
}

export function loadPlan(ws: Workspace, id: string): FixPlan {
  const planId = id === 'latest' ? latestOf(ws, 'plan.json') : id;
  const plan = ws.readJson<FixPlan>(['fixes', planId, 'plan.json']);
  if (!plan) throw new RelivaroError('NOT_FOUND', `Fix plan not found: ${id}`, 'Create one with `relivaro fix plan`.');
  return plan;
}

function latestOf(ws: Workspace, marker: string): string {
  const dir = ws.path('fixes');
  if (!existsSync(dir)) throw new RelivaroError('NOT_FOUND', 'No fix plans or applies exist yet.');
  const ids = readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, marker)))
    .sort((a, b) => statSync(join(dir, a, marker)).mtimeMs - statSync(join(dir, b, marker)).mtimeMs || a.localeCompare(b));
  if (!ids.length) throw new RelivaroError('NOT_FOUND', `No ${marker === 'plan.json' ? 'fix plans' : 'applied fixes'} found.`);
  return ids[ids.length - 1]!;
}

function currentHash(root: string, path: string): string | null {
  try {
    return sha256(readFileSync(safeResolve(root, path)));
  } catch {
    return null;
  }
}

/** Copies the project into a temporary directory for isolated verification; dependency folders are symlinked. */
export function isolatedCopy(files: FileSet): string {
  const dest = mkdtempSync(join(tmpdir(), 'relivaro-verify-'));
  const listed = files.gitRepo ? files.files.map((f) => f.path) : files.files.map((f) => f.path);
  for (const p of listed) {
    const src = join(files.root, p);
    const dst = join(dest, p);
    mkdirSync(dirname(dst), { recursive: true });
    try {
      cpSync(src, dst, { dereference: false, preserveTimestamps: true });
    } catch {
      /* unreadable file: skipped */
    }
  }
  // Configuration files excluded from analysis but needed by test runners.
  for (const extra of ['.env.testing', 'phpunit.xml', 'phpunit.xml.dist', '.npmrc']) {
    const src = join(files.root, extra);
    if (existsSync(src) && !existsSync(join(dest, extra))) {
      if (extra.startsWith('.env')) continue;
      cpSync(src, join(dest, extra));
    }
  }
  for (const dep of ['node_modules', 'vendor', '.venv', 'venv']) {
    const src = join(files.root, dep);
    if (existsSync(src) && !existsSync(join(dest, dep))) {
      try {
        symlinkSync(src, join(dest, dep), process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        /* symlinks unavailable: verification will report missing dependencies */
      }
    }
  }
  return dest;
}

export interface ApplyOptions {
  only?: string[];
  yes: boolean;
  verifyCommand?: string;
  allowExec: boolean;
  isolate: boolean;
  timeoutSeconds?: number;
  onProgress?: (m: string) => void;
}

export async function applyPlan(ws: Workspace, plan: FixPlan, opts: ApplyOptions): Promise<ApplyRecord> {
  const root = plan.root;
  let items = plan.items;
  if (opts.only?.length) {
    items = items.filter((i) => opts.only!.includes(i.findingId) || opts.only!.includes(i.fixer) || opts.only!.includes(i.ruleId));
    if (!items.length) throw new RelivaroError('USAGE', `None of ${opts.only.join(', ')} are in plan ${plan.planId}.`);
  }
  if (!opts.yes)
    throw new RelivaroError('APPROVAL_REQUIRED', `Applying ${items.length} fix(es) to ${new Set(items.map((i) => i.file)).size} file(s) modifies your working tree.`, `Review the diff (\`relivaro fix show ${plan.planId}\`) and re-run with --yes.`);
  if (opts.verifyCommand && !opts.allowExec) throw new RelivaroError('EXEC_NOT_ALLOWED', 'Running a verification command executes project code and requires --allow-exec.');
  for (const f of plan.files) {
    const cur = currentHash(root, f.path);
    if (f.existed ? cur !== f.beforeHash : cur !== null && cur !== f.beforeHash)
      throw new RelivaroError('FIX_CONFLICT', `${f.path} changed since plan ${plan.planId} was created.`, 'Create a new plan with `relivaro fix plan`.');
  }

  // Desired contents: whole plan, or regenerated for the selected subset from the current files.
  const desired = new Map<string, { before: string; after: string; existed: boolean }>();
  if (items.length === plan.items.length) {
    for (const f of plan.files) {
      const before = f.existed ? readFileSync(safeResolve(root, f.path), 'utf8') : '';
      const after = readFileSync(ws.path('fixes', plan.planId, 'after', ...f.path.split('/')), 'utf8');
      if (sha256(after) !== f.afterHash) throw new RelivaroError('FIX_FAILED', `Planned content for ${f.path} is corrupt.`);
      desired.set(f.path, { before, after, existed: f.existed });
    }
  } else {
    const filesNow = new FileSet(root);
    const { analyzeFindings } = await reanalyze(filesNow, new Set(items.map((i) => i.file)));
    const selected = analyzeFindings.filter((f) => items.some((i) => i.fingerprint === f.fingerprint));
    const regenerated = await generateFixes(root, selected, (p) => filesNow.read(p) ?? filesNow.readAny(p));
    for (const [p, c] of regenerated.contents) desired.set(p, c);
    items = regenerated.items;
  }

  const verification = await verify(root, items, desired, opts);
  if (verification.verdict === 'failed') {
    const rec = record(ws, plan, items, desired, verification, false);
    throw Object.assign(new RelivaroError('FIX_FAILED', `Verification failed; your working tree was not modified. ${verification.notes.join(' ')}`), { record: rec });
  }

  // Apply with backups.
  const applyId = ws.newRunId('apply-');
  const files: ApplyRecord['files'] = [];
  for (const [path, c] of desired) {
    const abs = safeResolve(root, path);
    let mode: number | undefined;
    if (c.existed) {
      mode = statSync(abs).mode;
      ws.writeText(['fixes', applyId, 'backup', ...path.split('/')], c.before);
    }
    files.push({ path, beforeHash: sha256(c.before), afterHash: sha256(c.after), existed: c.existed, mode });
  }
  const rec: ApplyRecord = { schemaVersion: 1, applyId, planId: plan.planId, appliedAt: new Date().toISOString(), root, items, files, verification };
  ws.writeJson(['fixes', applyId, 'apply.json'], rec);
  for (const [path, c] of desired) {
    const abs = safeResolve(root, path);
    atomicWrite(abs, c.after);
    const m = files.find((f) => f.path === path)?.mode;
    if (m !== undefined) chmodSync(abs, m & 0o7777);
  }
  return rec;
}

function record(ws: Workspace, plan: FixPlan, items: PlanItem[], desired: Map<string, { before: string; after: string; existed: boolean }>, verification: Verification, applied: boolean): ApplyRecord {
  const applyId = ws.newRunId(applied ? 'apply-' : 'rejected-');
  const rec: ApplyRecord = { schemaVersion: 1, applyId, planId: plan.planId, appliedAt: new Date().toISOString(), root: plan.root, items, files: [...desired].map(([path, c]) => ({ path, beforeHash: sha256(c.before), afterHash: sha256(c.after), existed: c.existed })), verification };
  ws.writeJson(['fixes', applyId, applied ? 'apply.json' : 'rejected.json'], rec);
  return rec;
}

async function reanalyze(files: FileSet, only: Set<string>) {
  const { config } = loadConfig(files.root);
  const scoped = new FileSet(files.root, { include: [...only], exclude: config.exclude, maxFileSizeKb: config.maxFileSizeKb });
  return { scoped, config, analyzeFindings: (await analyze({ files: scoped, profile: discover(scoped), config }, RULES.filter((r) => r.kind !== 'project'))).findings };
}

async function verify(root: string, items: PlanItem[], desired: Map<string, { before: string; after: string; existed: boolean }>, opts: ApplyOptions): Promise<Verification> {
  const notes: string[] = [];
  const changed = new Set([...desired.keys()]);
  // Static: analyse the changed files before and after (in memory) and compare fingerprints.
  opts.onProgress?.('re-analysing changed files');
  const { config } = loadConfig(root);
  const before = new FileSet(root, { include: [...changed], exclude: config.exclude, maxFileSizeKb: config.maxFileSizeKb });
  const astRules = RULES.filter((r) => r.kind !== 'project');
  const beforeF = (await analyze({ files: before, profile: discover(before), config }, astRules)).findings;
  const after = new FileSet(root, { include: [...changed], exclude: config.exclude, maxFileSizeKb: config.maxFileSizeKb });
  after.overlay(new Map([...desired].map(([p, c]) => [p, c.after])));
  const afterF = (await analyze({ files: after, profile: discover(after), config }, astRules)).findings;
  const beforeKeys = new Set(beforeF.map((f) => `${f.ruleId}|${f.location?.file}|${f.message}`));
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const i of items) {
    const stillThere = afterF.some((f) => f.ruleId === i.ruleId && f.location?.file === i.file && f.message === i.message);
    const analysable = beforeF.some((f) => f.fingerprint === i.fingerprint) || beforeF.some((f) => f.ruleId === i.ruleId && f.location?.file === i.file);
    if (!analysable) {
      resolved.push(i.findingId);
      notes.push(`${i.findingId} (${i.ruleId}) is not re-checkable statically; confirm with \`relivaro audit\` after applying.`);
    } else if (stillThere) unresolved.push(i.findingId);
    else resolved.push(i.findingId);
  }
  const introduced = afterF.filter((f) => !beforeKeys.has(`${f.ruleId}|${f.location?.file}|${f.message}`)).map((f) => ({ ruleId: f.ruleId, file: f.location?.file, message: f.message }));
  const v: Verification = { static: { resolved, unresolved, introduced }, verdict: 'static-only', notes };
  if (unresolved.length) notes.push(`${unresolved.length} finding(s) still detected after the change.`);
  if (introduced.length) notes.push(`The change introduces ${introduced.length} new finding(s): ${introduced.slice(0, 3).map((x) => x.ruleId).join(', ')}.`);
  if (unresolved.length || introduced.length) v.verdict = 'failed';

  if (opts.verifyCommand && v.verdict !== 'failed') {
    const argv = splitCommand(opts.verifyCommand);
    const timeoutMs = (opts.timeoutSeconds ?? 600) * 1000;
    if (opts.isolate) {
      opts.onProgress?.('creating isolated copy for verification');
      const filesAll = new FileSet(root, { exclude: config.exclude });
      const dir = isolatedCopy(filesAll);
      try {
        opts.onProgress?.(`baseline: ${opts.verifyCommand}`);
        const b = await runCommand(argv, { cwd: dir, timeoutMs, allowExec: true });
        for (const [p, c] of desired) {
          const dst = join(dir, p);
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, c.after);
        }
        opts.onProgress?.(`after fix: ${opts.verifyCommand}`);
        const a = await runCommand(argv, { cwd: dir, timeoutMs, allowExec: true });
        v.command = { command: a.command, isolated: true, before: { exitCode: b.exitCode, durationMs: b.durationMs, timedOut: b.timedOut }, after: { exitCode: a.exitCode, durationMs: a.durationMs, timedOut: a.timedOut, outputTail: tail(`${a.stdout}\n${a.stderr}`, 30) } };
        if (a.exitCode === 0) v.verdict = 'verified';
        else if (b.exitCode !== 0) {
          v.verdict = 'failed';
          notes.push('The verification command already failed before the fix, so the fix cannot be verified. Fix the existing failures first or verify with a narrower command.');
        } else {
          v.verdict = 'failed';
          notes.push('The verification command passed before the fix and fails after it: the fix introduces a regression.');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      notes.push('Verification ran in the working tree after applying (--no-isolate); failures are rolled back automatically.');
      v.command = { command: argv.join(' '), isolated: false, after: { exitCode: null, durationMs: 0, timedOut: false, outputTail: '' } };
    }
  }
  return v;
}

/** In-place verification for --no-isolate: run the command after applying; roll back automatically on failure. */
export async function verifyInPlace(ws: Workspace, rec: ApplyRecord, command: string, timeoutSeconds: number): Promise<ApplyRecord> {
  const r = await runCommand(splitCommand(command), { cwd: rec.root, timeoutMs: timeoutSeconds * 1000, allowExec: true });
  rec.verification.command = { command: r.command, isolated: false, after: { exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, outputTail: tail(`${r.stdout}\n${r.stderr}`, 30) } };
  if (r.exitCode === 0) rec.verification.verdict = 'verified';
  else {
    rec.verification.verdict = 'failed';
    rec.verification.notes.push('Verification command failed after applying; the change was rolled back.');
    ws.writeJson(['fixes', rec.applyId, 'apply.json'], rec);
    rollback(ws, rec.applyId, false);
    throw new RelivaroError('FIX_FAILED', `Verification failed after applying; changes were rolled back.\n${rec.verification.command.after.outputTail}`);
  }
  ws.writeJson(['fixes', rec.applyId, 'apply.json'], rec);
  return rec;
}

export function loadApply(ws: Workspace, id: string): ApplyRecord {
  const applyId = id === 'latest' ? latestOf(ws, 'apply.json') : id;
  const rec = ws.readJson<ApplyRecord>(['fixes', applyId, 'apply.json']);
  if (!rec) throw new RelivaroError('NOT_FOUND', `Applied fix not found: ${id}`);
  return rec;
}

export function rollback(ws: Workspace, id: string, force: boolean): ApplyRecord {
  const rec = loadApply(ws, id);
  if (rec.rolledBackAt) throw new RelivaroError('ROLLBACK_CONFLICT', `${rec.applyId} was already rolled back at ${rec.rolledBackAt}.`);
  const conflicts = rec.files.filter((f) => currentHash(rec.root, f.path) !== f.afterHash);
  if (conflicts.length && !force)
    throw new RelivaroError('ROLLBACK_CONFLICT', `Files changed after the fix was applied: ${conflicts.map((c) => c.path).join(', ')}. Rolling back would overwrite those changes.`, 'Inspect the files, or re-run with --force to restore the backups anyway.');
  for (const f of rec.files) {
    const abs = safeResolve(rec.root, f.path);
    if (!f.existed) {
      rmSync(abs, { force: true });
      continue;
    }
    const backup = readFileSync(ws.path('fixes', rec.applyId, 'backup', ...f.path.split('/')), 'utf8');
    if (sha256(backup) !== f.beforeHash) throw new RelivaroError('ROLLBACK_CONFLICT', `Backup for ${f.path} is corrupt; not restoring.`);
    atomicWrite(abs, backup);
    if (f.mode !== undefined) chmodSync(abs, f.mode & 0o7777);
  }
  rec.rolledBackAt = new Date().toISOString();
  ws.writeJson(['fixes', rec.applyId, 'apply.json'], rec);
  return rec;
}

export function history(ws: Workspace): ApplyRecord[] {
  const dir = ws.path('fixes');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((d) => ws.readJson<ApplyRecord>(['fixes', d, 'apply.json']))
    .filter((r): r is ApplyRecord => !!r)
    .sort((a, b) => a.appliedAt.localeCompare(b.appliedAt));
}
