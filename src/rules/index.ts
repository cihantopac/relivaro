import { performanceRules } from './performance.js';
import { qualityAstRules, qualityFileRules } from './quality.js';
import { reliabilityAstRules, reliabilityFileRules, reliabilityProjectRules } from './reliability.js';
import { securityCodeRules } from './security/code.js';
import { securityFileRules, securityProjectRules } from './security/files.js';
import { supplyChainRules } from './supply-chain.js';
import type { Rule, RuleMeta } from './types.js';

export const RULES: Rule[] = [
  ...securityCodeRules,
  ...securityFileRules,
  ...securityProjectRules,
  ...supplyChainRules,
  ...reliabilityAstRules,
  ...reliabilityFileRules,
  ...reliabilityProjectRules,
  ...performanceRules,
  ...qualityAstRules,
  ...qualityFileRules,
];

/**
 * Metadata for findings produced outside the rule engine (execution checks, dependency vulnerabilities,
 * benchmarks). Registered here so docs, SARIF and `rules list` cover every finding type.
 */
export const EXTERNAL_RULES: RuleMeta[] = [];

export function registerExternalRule(meta: RuleMeta): RuleMeta {
  if (!EXTERNAL_RULES.some((r) => r.id === meta.id)) EXTERNAL_RULES.push(meta);
  return meta;
}

export function allRuleMeta(): RuleMeta[] {
  return [...RULES, ...EXTERNAL_RULES].sort((a, b) => a.id.localeCompare(b.id));
}

export function findRule(id: string): RuleMeta | undefined {
  return allRuleMeta().find((r) => r.id === id);
}

{
  const ids = new Set<string>();
  for (const r of RULES) {
    if (ids.has(r.id)) throw new Error(`Duplicate rule id ${r.id}`);
    ids.add(r.id);
  }
}
