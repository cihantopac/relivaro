/** Shared domain types. Every report format and every engine speaks these types. */

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const CATEGORIES = [
  'security',
  'supply-chain',
  'reliability',
  'performance',
  'quality',
  'testing',
  'release',
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * How a finding was established. `static` = derived from source or configuration without running anything;
 * `executed` = observed by running a project tool (tests, type checker, build); `measured` = a numeric
 * measurement (benchmark, load test); `agent` = recorded by an AI agent and therefore a judgment.
 */
export type Provenance = 'static' | 'executed' | 'measured' | 'agent';

export type FindingStatus = 'open' | 'suppressed' | 'baseline';

export interface Location {
  /** POSIX-style path relative to the project root. */
  file: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Evidence {
  /** Redacted source excerpt around the location. */
  snippet?: string;
  /** Command that produced executed/measured evidence (never contains secrets). */
  command?: string;
  /** Truncated, redacted output of that command. */
  output?: string;
  /** Structured facts that support the finding. */
  facts?: Record<string, string | number | boolean | null>;
}

export interface Finding {
  /** Stable short id derived from the fingerprint, e.g. `RLV-3f9a1c2b`. */
  id: string;
  ruleId: string;
  title: string;
  message: string;
  severity: Severity;
  confidence: Confidence;
  category: Category;
  provenance: Provenance;
  location?: Location;
  evidence: Evidence;
  impact: string;
  recommendation: string;
  verification: string;
  cwe?: string[];
  owasp?: string[];
  tags?: string[];
  /** Id of a deterministic fixer that can address this finding. */
  fixer?: string;
  fingerprint: string;
  status: FindingStatus;
  suppression?: { kind: 'inline' | 'baseline' | 'config'; reason?: string };
}

export type Language = 'javascript' | 'typescript' | 'tsx' | 'php' | 'python';

export interface ProjectFile {
  /** POSIX path relative to root. */
  path: string;
  size: number;
  /** AST language if the file can be parsed. */
  language?: Language;
  /** Broad file kind used by rules. */
  kind: FileKind;
  /** True when the file is a test, fixture or example (findings get lower confidence/severity). */
  isTest: boolean;
  /** True when git reports the file as tracked (undefined outside git). */
  tracked?: boolean;
}

export type FileKind =
  | 'source'
  | 'config'
  | 'manifest'
  | 'lockfile'
  | 'workflow'
  | 'dockerfile'
  | 'compose'
  | 'env'
  | 'template'
  | 'migration'
  | 'doc'
  | 'other';

export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
export const CONFIDENCE_RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };

export function severityAtLeast(s: Severity, min: Severity): boolean {
  return SEVERITY_RANK[s] >= SEVERITY_RANK[min];
}

export function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
    (a.location?.file ?? '').localeCompare(b.location?.file ?? '') ||
    (a.location?.line ?? 0) - (b.location?.line ?? 0) ||
    a.ruleId.localeCompare(b.ruleId) ||
    a.fingerprint.localeCompare(b.fingerprint)
  );
}
