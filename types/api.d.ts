// Type declarations of the Relivaro programmatic API (`import … from 'relivaro'`). Hand-written and pinned to the
// implementation by tests/unit/api-types.test.ts; copied to plugin/dist/api.d.ts by scripts/build.mjs.
// The run record is also described by schemas/run.schema.json.

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type Confidence = 'high' | 'medium' | 'low';
export type Category =
  | 'security'
  | 'supply-chain'
  | 'reliability'
  | 'performance'
  | 'quality'
  | 'testing'
  | 'release';
export type CheckKind = 'build' | 'test' | 'typecheck' | 'lint';
export type StopReason = 'duration' | 'files' | 'bytes' | 'signal';

export interface Location {
  file: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface Finding {
  id: string;
  ruleId: string;
  title: string;
  message: string;
  severity: Severity;
  confidence: Confidence;
  category: Category;
  provenance: 'static' | 'executed' | 'measured' | 'agent';
  location?: Location;
  evidence: {
    snippet?: string;
    command?: string;
    output?: string;
    facts?: Record<string, string | number | boolean | null>;
  };
  impact: string;
  recommendation: string;
  verification: string;
  cwe?: string[];
  owasp?: string[];
  tags?: string[];
  fixer?: string;
  fingerprint: string;
  status: 'open' | 'suppressed' | 'baseline';
  suppression?: { kind: 'inline' | 'baseline' | 'config'; reason?: string };
  accepted?: { reason: string; source: 'inline' | 'review' };
}

export interface Summary {
  total: number;
  open: number;
  suppressed: number;
  baseline: number;
  accepted?: number;
  bySeverity: Record<Severity, number>;
  byCategory: Record<Category, number>;
}

export interface CheckResult {
  kind: CheckKind;
  unit: string;
  command: string;
  status: 'passed' | 'failed' | 'error' | 'timeout' | 'skipped';
  durationMs: number;
  reason?: string;
  tests?: { passed: number; failed: number; skipped: number; total: number; failing: string[] };
  diagnostics?: number;
  outputTail?: string;
}

export interface Gate {
  id: string;
  title: string;
  status: 'pass' | 'warn' | 'block' | 'unverified' | 'n/a';
  detail: string;
  findings?: string[];
  basis?: 'executed' | 'measured' | 'advisory-db' | 'static' | 'not-run';
}

export interface ReleaseAssessment {
  status: 'ready' | 'ready-with-warnings' | 'needs-verification' | 'not-ready';
  score: number;
  scoreCapped: boolean;
  gates: Gate[];
  blockers: string[];
  warnings: string[];
  unverified: string[];
  passed: string[];
  tally: Record<Gate['status'], number>;
  disclaimer: string;
}

/** The main fields of the project profile; schemas/run.schema.json describes all of them. */
export interface RunProfile {
  root: string;
  name: string;
  gitRepo: boolean;
  monorepo: boolean;
  languages: { name: string; files: number; lines: number }[];
  units: {
    path: string;
    kind: string;
    frameworks: string[];
    manifests: string[];
    testFiles: number;
    sourceFiles: number;
  }[];
  technologies: { name: string; kind: string; unit: string; evidence: string; version?: string }[];
  manifests: {
    file: string;
    ecosystem: string;
    dependencies: number;
    devDependencies: number;
    error?: string;
  }[];
  lockfiles: { file: string; ecosystem: string; packages: number; error?: string }[];
  vcs?: { revisionId: string; branch?: string; repositoryUri?: string };
}

export interface RunRecord {
  $schema?: string;
  schemaVersion: number;
  tool: { name: 'relivaro'; version: string };
  runId: string;
  command: string;
  startedAt: string;
  durationMs: number;
  /** Absolute project path, or the `rootLabel`. */
  root: string;
  options: {
    categories: Category[];
    online: boolean;
    allowExec: boolean;
    checks: CheckKind[];
    configFile?: string;
    baseline?: string;
  };
  profile: RunProfile;
  findings: Finding[];
  summary: Summary;
  checks: CheckResult[];
  coverage: {
    file: string;
    format: string;
    generatedAt: string;
    stale: boolean;
    pct: number;
    covered: number;
    total: number;
  }[];
  testGaps: { file: string; risk: number; reasons: string[]; coveragePct?: number }[];
  metrics: {
    files: number;
    bytes: number;
    linesOfCode: number;
    parsedFiles: number;
    functions: number;
    rulesRun: number;
    analysisMs: number;
    dependencies: number;
    dependencyEntries?: number;
    osvQueried?: number;
    filesSkipped: Record<string, number>;
  };
  limitations: string[];
  errors: {
    parse: { file: string; message: string }[];
    rules: { rule: string; file?: string; message: string }[];
    network: string[];
  };
  release?: ReleaseAssessment;
  partial?: { reason: StopReason; at: string };
}

export type ProgressEvent =
  | {
      type: 'stage';
      stage: 'index' | 'discover' | 'analyse' | 'osv' | 'checks' | 'report';
      state: 'start' | 'end';
      elapsedMs: number;
    }
  | { type: 'files'; done: number; total: number };

export interface AuditOptions {
  /** Directory to audit. */
  root: string;
  /** Name recorded in the run (e.g. 'audit', 'security', 'release'). */
  command: string;
  categories?: Category[];
  /** Rule ids to run; a trailing `*` matches a prefix. */
  rules?: string[];
  /** Query OSV.dev (sends package names and versions only). */
  online?: boolean;
  /** Run the project's build/test/typecheck/lint commands (executes project code). */
  allowExec?: boolean;
  checks?: CheckKind[];
  configPath?: string;
  workspace?: string;
  baseline?: string | false;
  release?: boolean;
  useGit?: boolean;
  respectGitignore?: boolean;
  assumeTracked?: boolean;
  inlineSuppressions?: boolean;
  ignoreRepoConfig?: boolean;
  rootLabel?: string;
  snippetLines?: number;
  limits?: { maxDurationMs?: number; maxFiles?: number; maxBytes?: number; parseTimeoutMs?: number };
  signal?: AbortSignal;
  /** Do not write anything to disk. */
  noWrite?: boolean;
  onProgress?: (message: string) => void;
  onEvent?: (event: ProgressEvent) => void;
  fetchImpl?: typeof fetch;
}

export interface RunComparison {
  base: { runId: string; startedAt: string; open: number };
  head: { runId: string; startedAt: string; open: number };
  introduced: Finding[];
  resolved: Finding[];
  persisting: number;
  checkRegressions: string[];
  checkImprovements: string[];
  releaseChange?: { from: string; to: string; scoreFrom: number; scoreTo: number };
}

/** A SARIF 2.1.0 log (only the top level is typed). */
export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: Record<string, unknown>[];
}

export declare const VERSION: string;

/** Audits a directory. Nothing is written when `noWrite` is set. */
export declare function runAudit(
  options: AuditOptions,
): Promise<{ run: RunRecord; config: unknown; workspace: unknown }>;

/** SARIF 2.1.0 for a run; pass the process exit code to record it in the invocation. */
export declare function toSarif(run: RunRecord, options?: { exitCode?: number }): SarifLog;

/** Findings introduced and resolved between two runs of the same project. */
export declare function compareRuns(base: RunRecord, head: RunRecord): RunComparison;

/** Release readiness of a run (defaults when no config is given). */
export declare function assessRelease(run: RunRecord, config?: unknown, bench?: unknown[]): ReleaseAssessment;

/** True when an open, medium/high-confidence finding is at or above `failOn` (the `--fail-on` gate). */
export declare function gateFailed(run: RunRecord, failOn: Severity | 'none'): boolean;
