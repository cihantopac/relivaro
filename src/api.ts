/**
 * Public programmatic entry point: `import { runAudit, toSarif } from 'relivaro'`. Built to plugin/dist/api.mjs; its
 * hand-written declarations are types/api.d.ts (pinned to these exports by tests/unit/api-types.test.ts).
 * Everything else under src/ is internal and may change in any release.
 */

import type { RunRecord } from './audit.js';
import { defaultConfig, type RelivaroConfig } from './core/config.js';
import { assessRelease as assess, type BenchSnapshot, type ReleaseAssessment } from './release/readiness.js';

export { type AuditOptions, gateFailed, type RunRecord, runAudit } from './audit.js';
export { VERSION } from './core/version.js';
export { compareRuns } from './report/compare.js';
export { toSarif } from './report/sarif.js';

/** Release readiness of a run; without a config the defaults are used (the CLI passes the project's config). */
export function assessRelease(
  run: RunRecord,
  config: RelivaroConfig = defaultConfig(),
  bench: BenchSnapshot[] = [],
): ReleaseAssessment {
  return assess(run, config, bench);
}
