import { describe, expect, it } from 'vitest';
import { redosRisk } from '../../src/rules/performance.js';

describe('redosRisk', () => {
  it.each([
    '(a+)+$',
    '^(\\w+\\s?)*$',
    '(.*,)+x',
    '^(\\d+)*$',
    '(x+x+)+y',
    '^([a-zA-Z0-9]+)*@',
    '(a|aa)+$',
    '^(\\s*\\w+\\s*)+$',
  ])('flags %s', (p) => expect(redosRisk(p)).toBe(true));

  it.each([
    '^[a-z]+(?:[_-][a-z]+)*$',
    '^([a-z0-9]+\\.)+[a-z]{2,}$',
    '^\\d+(,\\d+)*$',
    '^[\\w.-]+@[\\w-]+\\.[a-z]+$',
    'a+b+c*',
    '^(?:\\d{1,3}\\.){3}\\d{1,3}$',
    '(foo|bar)+',
    '^/api/(v\\d+)/users/(\\d+)$',
    '\\s+',
    '^(?:[A-Z][a-z]+ )+[A-Z][a-z]+$',
  ])('does not flag %s', (p) => expect(redosRisk(p)).toBe(false));
});
