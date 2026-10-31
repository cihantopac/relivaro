import { describe, expect, it } from 'vitest';
import { newResetToken } from '../src/lib/tokens';

describe('tokens', () => {
  it('creates 64-char reset tokens', () => {
    expect(newResetToken()).toHaveLength(64);
  });
});
