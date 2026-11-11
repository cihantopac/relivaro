import { RelivaroError } from './errors.js';

/** Bounds of one run. Unset limits are unbounded; `parseTimeoutMs` defaults to 5000. */
export interface RunBudget {
  maxDurationMs?: number;
  maxFiles?: number;
  maxBytes?: number;
  parseTimeoutMs: number;
}

export type BudgetReason = 'duration' | 'files' | 'bytes';
export type StopReason = BudgetReason | 'signal';

export const DEFAULT_PARSE_TIMEOUT_MS = 5000;

/**
 * Tracks the files and bytes analysed and the time spent. The engine asks `exceeded()` before each file; the run
 * then stops and is marked partial. Duration is checked first, then files, then bytes.
 */
export class Budget {
  private files = 0;
  private bytes = 0;
  private readonly start: number;

  constructor(
    readonly limits: RunBudget,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.start = now();
  }

  exceeded(): BudgetReason | null {
    const { maxDurationMs, maxFiles, maxBytes } = this.limits;
    if (maxDurationMs !== undefined && this.now() - this.start >= maxDurationMs) return 'duration';
    if (maxFiles !== undefined && this.files >= maxFiles) return 'files';
    if (maxBytes !== undefined && this.bytes >= maxBytes) return 'bytes';
    return null;
  }

  noteFile(bytes: number): void {
    this.files++;
    this.bytes += bytes;
  }

  get filesAnalysed(): number {
    return this.files;
  }
}

/** `500`, `10K`, `2M`, `1G` (binary units) → bytes. */
export function parseSize(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([KMG])?B?$/i.exec(text.replace(/\s/g, ''));
  if (!m)
    throw new RelivaroError(
      'USAGE',
      `--max-bytes must be a number with an optional K, M or G suffix, got "${text}".`,
    );
  const unit = (m[2] ?? '').toUpperCase();
  const mult = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : 1;
  return Math.round(Number(m[1]) * mult);
}

/**
 * Process-wide abort for SIGTERM/SIGINT. The CLI aborts it from its signal handler; analysis commands pass its signal
 * to `runAudit`, which then returns what it has as a partial run.
 */
export const processAbort = new AbortController();
