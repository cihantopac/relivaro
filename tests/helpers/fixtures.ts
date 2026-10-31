// Typed re-export of the shared fixture harness (scripts/lib/fixtures.mjs).
// @ts-expect-error -- plain ESM module without type declarations
import * as m from '../../scripts/lib/fixtures.mjs';

export interface Expected {
  rule: string;
  file?: string;
  line?: number;
}

export const listFixtures: () => string[] = m.listFixtures;
export const materialize: (
  name: string,
  opts?: { gitInit?: boolean },
) => { dir: string; expected: Expected[]; cleanup: () => void } = m.materialize;
export const score: (
  findings: unknown[],
  expected: Expected[],
) => {
  tp: number;
  fp: { ruleId: string; location?: { file: string; line?: number }; message: string }[];
  fn: Expected[];
  precision: number;
  recall: number;
} = m.score;
export const ROOT: string = m.ROOT;
