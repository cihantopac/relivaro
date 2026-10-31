import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export function newResetToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex');
}

export function contentEtag(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

export function verifySignature(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function retryDelay(attempt: number): number {
  const jitter = Math.random() * 100;
  return 2 ** attempt * 100 + jitter;
}
