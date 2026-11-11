// Pins the hand-written public declarations (types/api.d.ts) to the implementation: `npm run typecheck` fails when an
// export's signature drifts. The runtime test only makes vitest count the file.
import { describe, expect, it } from 'vitest';
import type * as Impl from '../../src/api.js';
import type * as Pub from '../../types/api.js';

type Assert<T extends true> = T;
type Extends<A, B> = [A] extends [B] ? true : false;

// What the implementation returns satisfies the published types, and what a consumer passes in is accepted by it.
type Pinned = [
  Assert<Extends<Impl.RunRecord, Pub.RunRecord>>,
  Assert<Extends<Awaited<ReturnType<typeof Impl.runAudit>>['run'], Pub.RunRecord>>,
  Assert<Extends<ReturnType<typeof Impl.toSarif>, Pub.SarifLog>>,
  Assert<Extends<ReturnType<typeof Impl.compareRuns>, Pub.RunComparison>>,
  Assert<Extends<ReturnType<typeof Impl.assessRelease>, Pub.ReleaseAssessment>>,
  Assert<Extends<Pub.AuditOptions, Impl.AuditOptions>>,
  Assert<Extends<typeof Impl.VERSION, typeof Pub.VERSION>>,
];

describe('public API types', () => {
  it('are pinned at compile time (see npm run typecheck)', () => {
    const pinned: Pinned = [true, true, true, true, true, true, true];
    expect(pinned.every(Boolean)).toBe(true);
  });
});
