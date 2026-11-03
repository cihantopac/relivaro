import type { Finding } from '../core/types.js';
import { findFixer } from '../fix/fixers.js';
import type { ReviewEntry } from '../review/review.js';

/**
 * How a finding can be remediated. Kept deliberately separate from "can a file be edited": a coding agent can edit
 * anything, but some changes need runtime evidence, an operational decision or human approval first.
 *
 * - `deterministic` — a registered Relivaro fixer produces a concrete, reviewable patch (`relivaro fix plan`).
 * - `agent` — no fixer, but a coding agent can investigate the issue, make a targeted change, add a regression test
 *   and verify it.
 * - `manual` — needs runtime evidence, an operational or architectural decision, or human approval before any
 *   change is appropriate.
 * - `none` — a reviewer marked the finding as a false positive; nothing to change.
 */
export type RemediationKind = 'deterministic' | 'agent' | 'manual' | 'none';

export type RemediationReason =
  | 'fixer'
  | 'code'
  | 'runtime'
  | 'operational'
  | 'architecture'
  | 'dependency'
  | 'secret'
  | 'data'
  | 'payment'
  | 'container'
  | 'reviewed-runtime'
  | 'false-positive'
  | 'accepted';

export interface Remediation {
  kind: RemediationKind;
  reason: RemediationReason;
  fixer?: string;
  safety?: 'safe' | 'review';
  /** The fixer needs network access at plan time (e.g. resolving an action tag to a commit SHA). */
  online?: boolean;
}

/** Rules whose findings need a decision or evidence a code change cannot supply. */
const MANUAL: Record<string, RemediationReason> = {
  'qual/high-complexity': 'architecture',
  'rel/no-error-monitoring': 'operational',
  'rel/no-health-check': 'operational',
  'sec/web-missing-csp': 'operational',
  'sec/web-csp-unsafe-inline': 'operational',
  'sec/web-missing-frame-protection': 'operational',
  'sec/web-missing-hsts': 'operational',
  'sec/web-hsts-include-subdomains': 'operational',
  'rel/queue-job-without-retry-policy': 'operational',
  'rel/destructive-migration': 'data',
  'rel/destructive-sql-migration': 'data',
  'rel/migration-without-rollback': 'data',
  'rel/payment-without-idempotency-key': 'payment',
  'perf/foreign-key-without-index': 'data',
  'sec/docker-runs-as-root': 'container',
  'sec/docker-unpinned-base-image': 'container',
  'sec/compose-insecure-service': 'container',
  'sec/hardcoded-secret': 'secret',
  'sec/hardcoded-signing-secret': 'secret',
  'sec/env-file-committed': 'secret',
  'sec/secret-exposed-to-client': 'secret',
  'sec/production-env-debug': 'operational',
  'sc/known-vulnerability': 'dependency',
  'sc/unpinned-dependency': 'dependency',
  'sc/missing-lockfile': 'dependency',
  'sc/lockfile-out-of-sync': 'dependency',
  'sc/multiple-lockfiles': 'dependency',
  'sc/end-of-life-runtime': 'dependency',
  'sc/non-registry-dependency': 'dependency',
  'sc/dependency-install-scripts': 'dependency',
  'exec/check-timeout': 'runtime',
};

/** English one-liners for prompts and Markdown; the HTML report translates the reason codes itself. */
export const REMEDIATION_TEXT: Record<RemediationReason, string> = {
  fixer: 'a Relivaro fixer generates a reviewable patch',
  code: 'a targeted code change with a regression test',
  runtime: 'needs runtime evidence before any change',
  operational: 'needs an operational decision (tooling, thresholds, environments)',
  architecture: 'a refactoring decision, not a defect fix',
  dependency: 'dependency changes need a compatibility assessment and approval',
  secret: 'rotate the credential first; code changes alone do not remove the exposure',
  data: 'affects production data or schema; needs a migration and backup plan',
  payment: 'payment logic; needs human approval and end-to-end tests',
  container: 'container runtime change; needs deployment testing and approval',
  'reviewed-runtime': 'reviewer asked for runtime verification first',
  'false-positive': 'reviewed as a false positive; no change needed',
  accepted: 'risk accepted by a reviewer; no change planned',
};

export function remediationOf(f: Finding, review?: Pick<ReviewEntry, 'verdict'>): Remediation {
  if (review?.verdict === 'false-positive') return { kind: 'none', reason: 'false-positive' };
  if (review?.verdict === 'accepted') return { kind: 'none', reason: 'accepted' };
  if (review?.verdict === 'needs-runtime') return { kind: 'manual', reason: 'reviewed-runtime' };
  const fixer = f.fixer ? findFixer(f.fixer) : undefined;
  if (fixer)
    return {
      kind: 'deterministic',
      reason: 'fixer',
      fixer: fixer.id,
      safety: fixer.safety,
      ...(fixer.online ? { online: true } : {}),
    };
  const manual = MANUAL[f.ruleId];
  if (manual) return { kind: 'manual', reason: manual };
  return { kind: 'agent', reason: 'code' };
}
