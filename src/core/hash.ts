import { createHash } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Whitespace-insensitive normalisation used for fingerprints so that reformatting does not churn ids. */
export function normalizeCode(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Fingerprint = rule + file + normalised source line + occurrence index of that triple. Independent of line
 * numbers, so findings keep their id when unrelated code above them changes.
 */
export function fingerprint(ruleId: string, file: string, anchor: string, occurrence: number): string {
  return sha256(`${ruleId}\u0000${file}\u0000${normalizeCode(anchor)}\u0000${occurrence}`).slice(0, 32);
}

export function findingId(fp: string): string {
  return `RLV-${fp.slice(0, 8)}`;
}
