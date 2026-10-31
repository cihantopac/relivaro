import { describe, expect, it } from 'vitest';

describe('Bio', () => {
  it.only('renders', () => { // expect: test/focused-test
    expect(true).toBe(true);
  });
  it.skip('handles empty bio', () => { // expect: test/skipped-tests
    expect(true).toBe(true);
  });
});
