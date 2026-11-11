/** Machine-readable progress, written as one JSON object per line on stderr by `--progress ndjson`. */
export type ProgressStage = 'index' | 'discover' | 'analyse' | 'osv' | 'checks' | 'report';

export type ProgressEvent =
  | { type: 'stage'; stage: ProgressStage; state: 'start' | 'end'; elapsedMs: number }
  | { type: 'files'; done: number; total: number };

export type ProgressMode = 'tty' | 'plain' | 'ndjson' | 'off';
export const PROGRESS_MODES: readonly ProgressMode[] = ['tty', 'plain', 'ndjson', 'off'];

/** Number of analysed files between two `files` events. */
export const FILE_EVENT_EVERY = 200;
