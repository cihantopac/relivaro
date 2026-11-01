import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import type { ActionPin } from './actions.js';
import { unifiedDiff } from './diff.js';
import { type FixContext, type Fixer, findFixer } from './fixers.js';

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
  /** Action references this item pins, with the SHA and where it was resolved (gha-pin-action). */
  pins?: ActionPin[];
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
  /**
   * `applying` while files are being written; a record left in this state means the process was interrupted and
   * `fix rollback` restores whatever was written. `failed` means a write failed and the written files were restored.
   * Records from 1.0 have no state and are treated as `applied`.
   */
  state?: 'applying' | 'applied' | 'failed';
  rolledBackAt?: string;
  /** Files whose post-apply edits were saved under `fixes/<applyId>/conflicts/` before a forced rollback. */
  preserved?: string[];
}

export interface Verification {
  static: {
    resolved: string[];
    unresolved: string[];
    introduced: { ruleId: string; file?: string; message: string }[];
    /** Targeted findings the static re-analysis of the changed files cannot observe (e.g. project-level rules). */
    unverifiable?: string[];
  };
  command?: {
    command: string;
    isolated: boolean;
    before?: { exitCode: number | null; durationMs: number; timedOut: boolean };
    after: { exitCode: number | null; durationMs: number; timedOut: boolean; outputTail: string };
  };
  verdict: 'verified' | 'static-only' | 'failed';
  notes: string[];
}

/** Generates new file contents for the given fixable findings, applying bottom-up per file so locations stay valid. */
export async function generateFixes(
  root: string,
  findings: Finding[],
  readFile: (p: string) => string | undefined,
  ctx: FixContext = {},
): Promise<{
  contents: Map<string, { before: string; after: string; existed: boolean }>;
  items: PlanItem[];
  skipped: FixPlan['skipped'];
}> {
  const contents = new Map<string, { before: string; after: string; existed: boolean }>();
  const items: PlanItem[] = [];
  const skipped: FixPlan['skipped'] = [];
  const sorted = [...findings].sort(
    (a, b) =>
      (a.location?.file ?? '').localeCompare(b.location?.file ?? '') ||
      (b.location?.line ?? 0) - (a.location?.line ?? 0) ||
      (b.location?.column ?? 0) - (a.location?.column ?? 0),
  );
  for (const f of sorted) {
    const fixer = f.fixer ? findFixer(f.fixer) : undefined;
    if (!fixer) {
      skipped.push({ findingId: f.id, reason: 'no automated fixer for this finding' });
      continue;
    }
    if (fixer.online && !ctx.resolveAction) {
      skipped.push({
        findingId: f.id,
        reason: `needs --online: ${fixer.id} resolves commit SHAs from the action's GitHub repository`,
      });
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
    const pins: ActionPin[] = [];
    const itemCtx: FixContext = ctx.resolveAction
      ? {
          resolveAction: async (action, ref) => {
            const pin = await ctx.resolveAction!(action, ref);
            pins.push(pin);
            return pin;
          },
        }
      : {};
    try {
      next = await fixer.apply({ path: target, text: entry.after, finding: f, ctx: itemCtx });
    } catch (e) {
      skipped.push({ findingId: f.id, reason: `fixer error: ${(e as Error).message}` });
      continue;
    }
    if (next === null || next === entry.after) {
      skipped.push({
        findingId: f.id,
        reason: 'code no longer matches the pattern the fixer expects (already fixed or changed)',
      });
      continue;
    }
    entry.after = next;
    contents.set(target, entry);
    items.push({
      findingId: f.id,
      fingerprint: f.fingerprint,
      ruleId: f.ruleId,
      fixer: fixer.id,
      title: fixer.title,
      safety: fixer.safety,
      file: target,
      line: f.location?.line,
      message: f.message,
      ...(pins.length ? { pins } : {}),
    });
  }
  return { contents, items, skipped };
}

export async function createPlan(
  root: string,
  findings: Finding[],
  ws: Workspace,
  ctx: FixContext = {},
): Promise<FixPlan> {
  const files = new FileSet(root);
  const { contents, items, skipped } = await generateFixes(
    files.root,
    findings,
    (p) => files.read(p) ?? files.readAny(p),
    ctx,
  );
  const planId = ws.newRunId('fix-');
  const planned: PlannedFile[] = [];
  for (const [path, c] of contents) {
    planned.push({
      path,
      beforeHash: sha256(c.before),
      afterHash: sha256(c.after),
      existed: c.existed,
      diff: unifiedDiff(path, c.before, c.after),
    });
    ws.writeText(['fixes', planId, 'after', ...path.split('/')], c.after);
  }
  const plan: FixPlan = {
    schemaVersion: 1,
    tool: VERSION,
    planId,
    createdAt: new Date().toISOString(),
    root: files.root,
    items: items.reverse(),
    skipped,
    files: planned,
  };
  ws.writeJson(['fixes', planId, 'plan.json'], plan);
  return plan;
}

export function loadPlan(ws: Workspace, id: string): FixPlan {
  const planId = id === 'latest' ? latestOf(ws, 'plan.json') : id;
  const plan = ws.readJson<FixPlan>(['fixes', planId, 'plan.json']);
  if (!plan)
    throw new RelivaroError('NOT_FOUND', `Fix plan not found: ${id}`, 'Create one with `relivaro fix plan`.');
  return plan;
}

function latestOf(ws: Workspace, marker: string): string {
  const dir = ws.path('fixes');
  if (!existsSync(dir)) throw new RelivaroError('NOT_FOUND', 'No fix plans or applies exist yet.');
  const ids = readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, marker)))
    .sort(
      (a, b) =>
        statSync(join(dir, a, marker)).mtimeMs - statSync(join(dir, b, marker)).mtimeMs || a.localeCompare(b),
    );
  if (!ids.length)
    throw new RelivaroError(
      'NOT_FOUND',
      `No ${marker === 'plan.json' ? 'fix plans' : 'applied fixes'} found.`,
    );
  return ids[ids.length - 1]!;
}

function currentHash(root: string, path: string): string | null {
  try {
    return sha256(readFileSync(safeResolve(root, path)));
  } catch {
    return null;
  }
}

/**
 * Copies the project into a temporary directory for isolated verification. Files are copied as regular files
 * (symlinks are dereferenced) so writes in the copy never reach the original through a link. Dependency folders are
 * symlinked to avoid a full install: a command that writes into them (caches, postinstall output) still modifies the
 * original dependency folder — see docs/SECURITY_MODEL.md.
 */
export function isolatedCopy(files: FileSet): string {
  const dest = mkdtempSync(join(tmpdir(), 'relivaro-verify-'));
  for (const { path: p } of files.files) {
    const dst = join(dest, p);
    mkdirSync(dirname(dst), { recursive: true });
    try {
      cpSync(join(files.root, p), dst, { dereference: true, preserveTimestamps: true });
    } catch {
      /* unreadable file: skipped */
    }
  }
  // Configuration files excluded from analysis but needed by test runners (never `.env*`).
  for (const extra of ['phpunit.xml', 'phpunit.xml.dist', '.npmrc']) {
    const src = join(files.root, extra);
    if (existsSync(src) && !existsSync(join(dest, extra)))
      cpSync(src, join(dest, extra), { dereference: true });
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

/** Size and mtime of every project file: a cheap fingerprint to detect a verification run touching the original. */
function treeSnapshot(files: FileSet): Map<string, string> {
  const snap = new Map<string, string>();
  for (const { path } of files.files) {
    try {
      const st = statSync(join(files.root, path));
      snap.set(path, `${st.size}:${st.mtimeMs}`);
    } catch {
      snap.set(path, 'missing');
    }
  }
  return snap;
}

function changedSince(files: FileSet, before: Map<string, string>): string[] {
  const now = treeSnapshot(files);
  return [...before].filter(([p, v]) => now.get(p) !== v).map(([p]) => p);
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
    items = items.filter(
      (i) =>
        opts.only!.includes(i.findingId) || opts.only!.includes(i.fixer) || opts.only!.includes(i.ruleId),
    );
    if (!items.length)
      throw new RelivaroError('USAGE', `None of ${opts.only.join(', ')} are in plan ${plan.planId}.`);
  }
  if (!opts.yes)
    throw new RelivaroError(
      'APPROVAL_REQUIRED',
      `Applying ${items.length} fix(es) to ${new Set(items.map((i) => i.file)).size} file(s) modifies your working tree.`,
      `Review the diff (\`relivaro fix show ${plan.planId}\`) and re-run with --yes.`,
    );
  if (opts.verifyCommand && !opts.allowExec)
    throw new RelivaroError(
      'EXEC_NOT_ALLOWED',
      'Running a verification command executes project code and requires --allow-exec.',
    );
  for (const f of plan.files) {
    const cur = currentHash(root, f.path);
    if (f.existed ? cur !== f.beforeHash : cur !== null && cur !== f.beforeHash)
      throw new RelivaroError(
        'FIX_CONFLICT',
        `${f.path} changed since plan ${plan.planId} was created.`,
        'Create a new plan with `relivaro fix plan`.',
      );
  }

  // Desired contents: whole plan, or regenerated for the selected subset from the current files.
  const desired = new Map<string, { before: string; after: string; existed: boolean }>();
  if (items.length === plan.items.length) {
    for (const f of plan.files) {
      const before = f.existed ? readFileSync(safeResolve(root, f.path), 'utf8') : '';
      const after = readFileSync(ws.path('fixes', plan.planId, 'after', ...f.path.split('/')), 'utf8');
      if (sha256(after) !== f.afterHash)
        throw new RelivaroError('FIX_FAILED', `Planned content for ${f.path} is corrupt.`);
      desired.set(f.path, { before, after, existed: f.existed });
    }
  } else {
    const filesNow = new FileSet(root);
    const { analyzeFindings } = await reanalyze(filesNow, new Set(items.map((i) => i.file)));
    const selected = analyzeFindings.filter((f) => items.some((i) => i.fingerprint === f.fingerprint));
    // Never go online while applying: pins come from the SHAs the plan resolved and showed.
    const planned = plan.items.flatMap((i) => i.pins ?? []);
    const resolveAction = async (action: string, ref: string) => {
      const pin = planned.find((p) => p.action === action && p.ref === ref);
      if (!pin) throw new Error(`${action}@${ref} was not resolved in plan ${plan.planId}`);
      return pin;
    };
    const regenerated = await generateFixes(root, selected, (p) => filesNow.read(p) ?? filesNow.readAny(p), {
      resolveAction,
    });
    for (const [p, c] of regenerated.contents) desired.set(p, c);
    items = regenerated.items;
  }

  const verification = await verify(root, items, desired, opts);
  if (verification.verdict === 'failed') {
    const rec = record(ws, plan, items, desired, verification, false);
    throw Object.assign(
      new RelivaroError(
        'FIX_FAILED',
        `Verification failed; your working tree was not modified. ${verification.notes.join(' ')}`,
      ),
      { record: rec },
    );
  }

  // Verification can take minutes: re-check that nobody edited the targets in the meantime before writing.
  for (const [path, c] of desired) {
    const cur = currentHash(root, path);
    if (c.existed ? cur !== sha256(c.before) : cur !== null)
      throw new RelivaroError(
        'FIX_CONFLICT',
        `${path} changed while the fix was being verified; nothing was written.`,
        'Create a new plan with `relivaro fix plan`.',
      );
  }

  // Apply with backups; the record is written first (state `applying`) so an interrupted run can be rolled back.
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
  const rec: ApplyRecord = {
    schemaVersion: 1,
    applyId,
    planId: plan.planId,
    appliedAt: new Date().toISOString(),
    root,
    items,
    files,
    verification,
    state: 'applying',
  };
  ws.writeJson(['fixes', applyId, 'apply.json'], rec);
  const written: ApplyRecord['files'] = [];
  try {
    for (const f of files) {
      const abs = safeResolve(root, f.path);
      atomicWrite(abs, desired.get(f.path)!.after);
      written.push(f);
      if (f.mode !== undefined) chmodSync(abs, f.mode & 0o7777);
    }
  } catch (e) {
    const failedPath = files[written.length]?.path ?? files[files.length - 1]!.path;
    const unrestored = restore(ws, rec, written.reverse());
    rec.state = 'failed';
    rec.rolledBackAt = new Date().toISOString();
    rec.verification.notes.push(`Writing ${failedPath} failed: ${(e as Error).message}`);
    ws.writeJson(['fixes', applyId, 'apply.json'], rec);
    throw new RelivaroError(
      'FIX_FAILED',
      `Writing ${failedPath} failed (${(e as Error).message}). ${
        unrestored.length
          ? `Could not restore ${unrestored.join(', ')}; the originals are in ${ws.path('fixes', applyId, 'backup')}.`
          : 'Every file already written was restored; your working tree is unchanged.'
      }`,
    );
  }
  rec.state = 'applied';
  ws.writeJson(['fixes', applyId, 'apply.json'], rec);
  return rec;
}

/** Puts files back to their pre-apply state; returns the paths that could not be restored. */
function restore(ws: Workspace, rec: ApplyRecord, files: ApplyRecord['files']): string[] {
  const failed: string[] = [];
  for (const f of files) {
    try {
      const abs = safeResolve(rec.root, f.path);
      if (!f.existed) rmSync(abs, { force: true });
      else {
        atomicWrite(abs, readFileSync(ws.path('fixes', rec.applyId, 'backup', ...f.path.split('/'))));
        if (f.mode !== undefined) chmodSync(abs, f.mode & 0o7777);
      }
    } catch {
      failed.push(f.path);
    }
  }
  return failed;
}

function record(
  ws: Workspace,
  plan: FixPlan,
  items: PlanItem[],
  desired: Map<string, { before: string; after: string; existed: boolean }>,
  verification: Verification,
  applied: boolean,
): ApplyRecord {
  const applyId = ws.newRunId(applied ? 'apply-' : 'rejected-');
  const rec: ApplyRecord = {
    schemaVersion: 1,
    applyId,
    planId: plan.planId,
    appliedAt: new Date().toISOString(),
    root: plan.root,
    items,
    files: [...desired].map(([path, c]) => ({
      path,
      beforeHash: sha256(c.before),
      afterHash: sha256(c.after),
      existed: c.existed,
    })),
    verification,
  };
  ws.writeJson(['fixes', applyId, applied ? 'apply.json' : 'rejected.json'], rec);
  return rec;
}

async function reanalyze(files: FileSet, only: Set<string>) {
  const { config } = loadConfig(files.root);
  const scoped = new FileSet(files.root, {
    include: [...only],
    exclude: config.exclude,
    maxFileSizeKb: config.maxFileSizeKb,
  });
  return {
    scoped,
    config,
    analyzeFindings: (
      await analyze(
        { files: scoped, profile: discover(scoped), config },
        RULES.filter((r) => r.kind !== 'project'),
      )
    ).findings,
  };
}

async function verify(
  root: string,
  items: PlanItem[],
  desired: Map<string, { before: string; after: string; existed: boolean }>,
  opts: ApplyOptions,
): Promise<Verification> {
  const notes: string[] = [];
  const changed = new Set([...desired.keys()]);
  // Static: analyse the changed files before and after (in memory) and compare fingerprints.
  opts.onProgress?.('re-analysing changed files');
  const { config } = loadConfig(root);
  const before = new FileSet(root, {
    include: [...changed],
    exclude: config.exclude,
    maxFileSizeKb: config.maxFileSizeKb,
  });
  const astRules = RULES.filter((r) => r.kind !== 'project');
  const beforeF = (await analyze({ files: before, profile: discover(before), config }, astRules)).findings;
  const after = new FileSet(root, {
    include: [...changed],
    exclude: config.exclude,
    maxFileSizeKb: config.maxFileSizeKb,
  });
  after.overlay(new Map([...desired].map(([p, c]) => [p, c.after])));
  const afterF = (await analyze({ files: after, profile: discover(after), config }, astRules)).findings;
  // Compare counts per (rule, file): messages and line numbers legitimately change when code is edited.
  const key = (rule: string, file?: string) => `${rule}\u0000${file ?? ''}`;
  const count = (fs: typeof beforeF) => {
    const m = new Map<string, number>();
    for (const f of fs)
      if (f.status !== 'suppressed')
        m.set(key(f.ruleId, f.location?.file), (m.get(key(f.ruleId, f.location?.file)) ?? 0) + 1);
    return m;
  };
  const bc = count(beforeF);
  const ac = count(afterF);
  const targeted = new Map<string, PlanItem[]>();
  for (const i of items)
    targeted.set(key(i.ruleId, i.file), [...(targeted.get(key(i.ruleId, i.file)) ?? []), i]);
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const introduced: Verification['static']['introduced'] = [];
  const unverifiable: string[] = [];
  for (const k of new Set([...bc.keys(), ...ac.keys(), ...targeted.keys()])) {
    const before = bc.get(k) ?? 0;
    const afterN = ac.get(k) ?? 0;
    const group = targeted.get(k) ?? [];
    if (group.length && before === 0) {
      for (const i of group) {
        unverifiable.push(i.findingId);
        notes.push(
          `${i.findingId} (${i.ruleId}) is not re-checkable statically; confirm with \`relivaro audit\` after applying.`,
        );
      }
      continue;
    }
    const fixed = Math.min(group.length, Math.max(0, before - afterN));
    for (const [idx, i] of group.entries()) (idx < fixed ? resolved : unresolved).push(i.findingId);
    if (afterN > before) {
      const [ruleId, file] = k.split('\u0000');
      for (const f of afterF
        .filter((x) => x.ruleId === ruleId && (x.location?.file ?? '') === file)
        .slice(before))
        introduced.push({ ruleId: f.ruleId, file: f.location?.file, message: f.message });
    }
  }
  const v: Verification = {
    static: { resolved, unresolved, introduced, unverifiable },
    verdict: 'static-only',
    notes,
  };
  if (unresolved.length) notes.push(`${unresolved.length} finding(s) still detected after the change.`);
  if (introduced.length)
    notes.push(
      `The change introduces ${introduced.length} new finding(s): ${introduced
        .slice(0, 3)
        .map((x) => x.ruleId)
        .join(', ')}.`,
    );
  if (unresolved.length || introduced.length) v.verdict = 'failed';

  if (opts.verifyCommand && v.verdict !== 'failed') {
    const argv = splitCommand(opts.verifyCommand);
    const timeoutMs = (opts.timeoutSeconds ?? 600) * 1000;
    if (opts.isolate) {
      opts.onProgress?.('creating isolated copy for verification');
      const filesAll = new FileSet(root, { exclude: config.exclude });
      const dir = isolatedCopy(filesAll);
      const snapshot = treeSnapshot(filesAll);
      try {
        opts.onProgress?.(`baseline: ${opts.verifyCommand}`);
        const b = await runCommand(argv, { cwd: dir, timeoutMs, allowExec: true });
        for (const [p, c] of desired) {
          const dst = join(dir, p);
          mkdirSync(dirname(dst), { recursive: true });
          rmSync(dst, { force: true });
          writeFileSync(dst, c.after);
        }
        opts.onProgress?.(`after fix: ${opts.verifyCommand}`);
        const a = await runCommand(argv, { cwd: dir, timeoutMs, allowExec: true });
        v.command = {
          command: a.command,
          isolated: true,
          before: { exitCode: b.exitCode, durationMs: b.durationMs, timedOut: b.timedOut },
          after: {
            exitCode: a.exitCode,
            durationMs: a.durationMs,
            timedOut: a.timedOut,
            outputTail: tail(`${a.stdout}\n${a.stderr}`, 30),
          },
        };
        if (a.exitCode === 0) v.verdict = 'verified';
        else if (b.exitCode !== 0) {
          v.verdict = 'failed';
          notes.push(
            'The verification command already failed before the fix, so the fix cannot be verified. Fix the existing failures first or verify with a narrower command.',
          );
        } else {
          v.verdict = 'failed';
          notes.push(
            'The verification command passed before the fix and fails after it: the fix introduces a regression.',
          );
        }
        const touched = changedSince(filesAll, snapshot);
        if (touched.length)
          notes.push(
            `The verification command modified ${touched.length} file(s) in the original project, outside the isolated copy: ${touched.slice(0, 5).join(', ')}${touched.length > 5 ? ', …' : ''}. Review them before continuing.`,
          );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else {
      notes.push(
        'Verification ran in the working tree after applying (--no-isolate); failures are rolled back automatically.',
      );
      v.command = {
        command: argv.join(' '),
        isolated: false,
        after: { exitCode: null, durationMs: 0, timedOut: false, outputTail: '' },
      };
    }
  }
  return v;
}

/** In-place verification for --no-isolate: run the command after applying; roll back automatically on failure. */
export async function verifyInPlace(
  ws: Workspace,
  rec: ApplyRecord,
  command: string,
  timeoutSeconds: number,
): Promise<ApplyRecord> {
  const r = await runCommand(splitCommand(command), {
    cwd: rec.root,
    timeoutMs: timeoutSeconds * 1000,
    allowExec: true,
  });
  rec.verification.command = {
    command: r.command,
    isolated: false,
    after: {
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
      outputTail: tail(`${r.stdout}\n${r.stderr}`, 30),
    },
  };
  if (r.exitCode === 0) rec.verification.verdict = 'verified';
  else {
    rec.verification.verdict = 'failed';
    rec.verification.notes.push('Verification command failed after applying; the change was rolled back.');
    ws.writeJson(['fixes', rec.applyId, 'apply.json'], rec);
    rollback(ws, rec.applyId, false);
    throw new RelivaroError(
      'FIX_FAILED',
      `Verification failed after applying; changes were rolled back.\n${rec.verification.command.after.outputTail}`,
    );
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
  if (rec.rolledBackAt)
    throw new RelivaroError(
      'ROLLBACK_CONFLICT',
      `${rec.applyId} was already rolled back at ${rec.rolledBackAt}.`,
    );
  // Files still in their original state need nothing (an interrupted apply may not have reached them).
  const pending = rec.files.filter((f) => {
    const cur = currentHash(rec.root, f.path);
    return f.existed ? cur !== f.beforeHash : cur !== null;
  });
  const conflicts = pending.filter((f) => currentHash(rec.root, f.path) !== f.afterHash);
  if (conflicts.length && !force)
    throw new RelivaroError(
      'ROLLBACK_CONFLICT',
      `Files changed after the fix was applied: ${conflicts.map((c) => c.path).join(', ')}. Rolling back would overwrite those changes.`,
      'Inspect the files, or re-run with --force to restore the backups anyway (your edits are saved under .relivaro/fixes/<apply id>/conflicts/).',
    );
  // Validate every backup before touching anything, so a corrupt backup never leaves a half-restored tree.
  for (const f of pending) {
    if (!f.existed) continue;
    const file = ws.path('fixes', rec.applyId, 'backup', ...f.path.split('/'));
    if (!existsSync(file) || sha256(readFileSync(file)) !== f.beforeHash)
      throw new RelivaroError(
        'ROLLBACK_CONFLICT',
        `Backup for ${f.path} is missing or corrupt; nothing restored.`,
      );
  }
  const preserved: string[] = [];
  for (const f of conflicts) {
    const abs = safeResolve(rec.root, f.path);
    if (!existsSync(abs)) continue;
    ws.writeText(['fixes', rec.applyId, 'conflicts', ...f.path.split('/')], readFileSync(abs, 'utf8'));
    preserved.push(f.path);
  }
  const unrestored = restore(ws, rec, pending);
  if (unrestored.length)
    throw new RelivaroError(
      'ROLLBACK_CONFLICT',
      `Could not restore ${unrestored.join(', ')}; the originals are in ${ws.path('fixes', rec.applyId, 'backup')}.`,
    );
  rec.rolledBackAt = new Date().toISOString();
  if (preserved.length) rec.preserved = preserved;
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
