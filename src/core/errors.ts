/** Process exit codes. Stable public contract (documented in docs/CLI.md). */
export const EXIT = {
  OK: 0,
  /** A quality gate failed: findings at/above `--fail-on`, release not ready, verification failed. */
  GATE_FAILED: 1,
  /** Invalid arguments or configuration. */
  USAGE: 2,
  /** Unexpected runtime error. */
  RUNTIME: 3,
} as const;

export type ErrorCode =
  | 'USAGE'
  | 'CONFIG_INVALID'
  | 'NOT_FOUND'
  | 'PATH_OUTSIDE_ROOT'
  | 'EXEC_NOT_ALLOWED'
  | 'EXEC_FAILED'
  | 'NETWORK_NOT_ALLOWED'
  | 'NETWORK_FAILED'
  | 'TARGET_NOT_ALLOWED'
  | 'APPROVAL_REQUIRED'
  | 'FIX_CONFLICT'
  | 'FIX_FAILED'
  | 'ROLLBACK_CONFLICT'
  | 'PARSE_FAILED'
  | 'INTERNAL';

const USAGE_CODES = new Set<ErrorCode>([
  'USAGE',
  'CONFIG_INVALID',
  'NOT_FOUND',
  'PATH_OUTSIDE_ROOT',
  'EXEC_NOT_ALLOWED',
  'NETWORK_NOT_ALLOWED',
  'TARGET_NOT_ALLOWED',
  'APPROVAL_REQUIRED',
]);

export class RelivaroError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;
  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'RelivaroError';
    this.code = code;
    this.hint = hint;
  }
  get exitCode(): number {
    return USAGE_CODES.has(this.code)
      ? EXIT.USAGE
      : this.code === 'FIX_CONFLICT' || this.code === 'ROLLBACK_CONFLICT' || this.code === 'FIX_FAILED'
        ? EXIT.GATE_FAILED
        : EXIT.RUNTIME;
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
