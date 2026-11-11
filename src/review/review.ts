import { closeSync, openSync, rmSync, statSync } from 'node:fs';
import type { RunRecord } from '../audit.js';
import { RelivaroError } from '../core/errors.js';
import { redact } from '../core/secrets.js';
import { SEVERITIES, type Severity } from '../core/types.js';
import { VERSION } from '../core/version.js';
import type { Workspace } from '../core/workspace.js';

/**
 * Review artifact (`runs/<runId>/review.json`): verdicts an agent or a person recorded after reading the code behind
 * a finding. It sits next to the run and never modifies it — reports show the raw detection and the reviewed
 * conclusion side by side. Entries exist only for findings someone actually reviewed; nothing is inferred.
 */
export const REVIEW_SCHEMA_VERSION = 1;
export const VERDICTS = ['confirmed', 'false-positive', 'needs-runtime', 'accepted'] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ReviewEvidence {
  /** POSIX path relative to the project root. */
  file: string;
  line?: number;
}

export interface ReviewEntry {
  findingId: string;
  /** Fingerprint of the reviewed finding, so a review can never attach to a different finding with the same id. */
  fingerprint: string;
  ruleId: string;
  verdict: Verdict;
  justification: string;
  evidence: ReviewEvidence[];
  /** Severity the reviewer considers appropriate, when it differs from the detected one. */
  severity?: Severity;
  reviewer: { kind: 'agent' | 'human'; name: string };
  reviewedAt: string;
  toolVersion: string;
  /** Set on read when the verdict was recorded for the same finding (same fingerprint) in an earlier run. */
  carriedFrom?: string;
}

export interface ReviewFile {
  schema: 'relivaro.review';
  schemaVersion: number;
  runId: string;
  project: string;
  createdAt: string;
  updatedAt: string;
  entries: ReviewEntry[];
}

export interface ReviewInput {
  findingIds: string[];
  verdict: string;
  justification: string;
  evidence?: string[];
  severity?: string;
  reviewer?: string;
  human?: boolean;
}

const MAX_JUSTIFICATION = 1000;

/** Collapse whitespace, drop control characters and redact anything that looks like a credential. */
function clean(text: string, max: number): string {
  const t = redact(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function parseEvidence(spec: string): ReviewEvidence {
  const m = /^(.+?)(?::(\d+))?$/.exec(spec.trim());
  const file = m?.[1]?.replace(/\\/g, '/');
  if (!file || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split('/').includes('..'))
    throw new RelivaroError(
      'USAGE',
      `Invalid --evidence "${spec}".`,
      'Use a project-relative path with an optional line, e.g. src/api/users.ts:42.',
    );
  return m?.[2] ? { file, line: Number(m[2]) } : { file };
}

export function loadReview(ws: Workspace, runId: string): ReviewFile | undefined {
  const r = ws.readJson<ReviewFile>(['runs', runId, 'review.json']);
  if (!r) return undefined;
  if (r.schema !== 'relivaro.review' || !Array.isArray(r.entries))
    throw new RelivaroError('CONFIG_INVALID', `runs/${runId}/review.json is not a Relivaro review file.`);
  if (r.schemaVersion > REVIEW_SCHEMA_VERSION)
    throw new RelivaroError(
      'CONFIG_INVALID',
      `runs/${runId}/review.json uses schema ${r.schemaVersion}; this Relivaro reads up to ${REVIEW_SCHEMA_VERSION}.`,
      'Upgrade Relivaro.',
    );
  return r;
}

/** Entries that still match a finding of the run (same id and fingerprint), keyed by finding id. */
export function reviewIndex(run: RunRecord, review: ReviewFile | undefined): Record<string, ReviewEntry> {
  const out: Record<string, ReviewEntry> = {};
  if (!review || review.runId !== run.runId) return out;
  const fp = new Map(run.findings.map((f) => [f.id, f.fingerprint]));
  for (const e of review.entries) if (fp.get(e.findingId) === e.fingerprint) out[e.findingId] = e;
  return out;
}

/**
 * Verdicts that apply to a run: its own, plus verdicts recorded in earlier runs for findings with the same fingerprint
 * (the same rule on the same code), marked with `carriedFrom` so reports can say where they came from.
 */
export function effectiveReview(ws: Workspace, run: RunRecord, maxRuns = 10): Record<string, ReviewEntry> {
  const out = reviewIndex(run, loadReview(ws, run.runId));
  const byFp = new Map(run.findings.filter((f) => !out[f.id]).map((f) => [f.fingerprint, f.id]));
  const runs = ws.listRuns();
  const earlier = runs
    .slice(0, Math.max(0, runs.indexOf(run.runId)))
    .reverse()
    .slice(0, maxRuns);
  for (const id of earlier) {
    if (!byFp.size) break;
    let r: ReviewFile | undefined;
    try {
      r = loadReview(ws, id);
    } catch {
      continue;
    }
    for (const e of r?.entries ?? []) {
      const fid = byFp.get(e.fingerprint);
      if (!fid || fid !== e.findingId) continue;
      out[fid] = { ...e, carriedFrom: id };
      byFp.delete(e.fingerprint);
    }
  }
  return out;
}

export function reviewSummary(run: RunRecord, index: Record<string, ReviewEntry>) {
  const open = run.findings.filter((f) => f.status === 'open');
  const count = (v: Verdict) =>
    open.filter((f) => (index[f.id] ? index[f.id]!.verdict === v : v === 'accepted' && !!f.accepted)).length;
  const confirmed = count('confirmed');
  const falsePositive = count('false-positive');
  const needsRuntime = count('needs-runtime');
  const accepted = count('accepted');
  return {
    confirmed,
    falsePositive,
    needsRuntime,
    accepted,
    unreviewed: open.length - confirmed - falsePositive - needsRuntime - accepted,
  };
}

/** Validates the input against the run and records (or replaces) one entry per finding. */
export function recordReview(ws: Workspace, run: RunRecord, input: ReviewInput): ReviewFile {
  if (!VERDICTS.includes(input.verdict as Verdict))
    throw new RelivaroError('USAGE', `--verdict must be one of ${VERDICTS.join(', ')}.`);
  const justification = clean(input.justification ?? '', MAX_JUSTIFICATION);
  if (justification.length < 3)
    throw new RelivaroError('USAGE', 'A review needs a short justification (--reason "<why>").');
  if (input.severity && !SEVERITIES.includes(input.severity as Severity))
    throw new RelivaroError('USAGE', `--severity must be one of ${SEVERITIES.join(', ')}.`);
  const name = (input.reviewer ?? (input.human ? 'human' : 'agent')).trim();
  if (!/^[\w .@/+-]{1,60}$/.test(name))
    throw new RelivaroError('USAGE', '--reviewer may contain letters, digits, spaces and ._@/+- (max 60).');
  const ids = [...new Set(input.findingIds)];
  if (!ids.length) throw new RelivaroError('USAGE', 'Name the reviewed finding(s) with --finding <ids>.');
  const byId = new Map(run.findings.map((f) => [f.id, f]));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length)
    throw new RelivaroError(
      'NOT_FOUND',
      `Finding(s) not in run ${run.runId}: ${unknown.join(', ')}.`,
      'Finding ids belong to one run; use the run the ids came from (--run) or re-run the audit.',
    );
  const evidence = (input.evidence ?? []).slice(0, 10).map(parseEvidence);
  // Agents record verdicts in parallel; serialise the read-modify-write so no verdict is lost.
  return withLock(ws.path('runs', run.runId, 'review.json.lock'), () => {
    const now = new Date().toISOString();
    const file: ReviewFile = loadReview(ws, run.runId) ?? {
      schema: 'relivaro.review',
      schemaVersion: REVIEW_SCHEMA_VERSION,
      runId: run.runId,
      project: run.profile.name,
      createdAt: now,
      updatedAt: now,
      entries: [],
    };
    for (const id of ids) {
      const f = byId.get(id)!;
      const entry: ReviewEntry = {
        findingId: id,
        fingerprint: f.fingerprint,
        ruleId: f.ruleId,
        verdict: input.verdict as Verdict,
        justification,
        evidence,
        ...(input.severity && input.severity !== f.severity ? { severity: input.severity as Severity } : {}),
        reviewer: { kind: input.human ? 'human' : 'agent', name },
        reviewedAt: now,
        toolVersion: VERSION,
      };
      file.entries = [...file.entries.filter((e) => e.findingId !== id), entry];
    }
    file.updatedAt = now;
    ws.writeJson(['runs', run.runId, 'review.json'], file);
    return file;
  });
}

/** Exclusive lock file (O_EXCL) with a short wait; a lock older than 30 s is considered abandoned. */
function withLock<T>(lock: string, fn: () => T): T {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { force: true });
      } catch {
        /* lock released meanwhile */
      }
      if (Date.now() > deadline)
        throw new RelivaroError(
          'INTERNAL',
          `Timed out waiting for ${lock}; remove it if no Relivaro is running.`,
        );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}
