import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RelivaroError } from './errors.js';
import { SEVERITIES, type Severity } from './types.js';

/**
 * Project configuration. JSON only: Relivaro never executes configuration code from an analysed repository.
 * Schema: schemas/config.schema.json.
 */
export interface RelivaroConfig {
  exclude: string[];
  include: string[];
  rules: Record<string, 'off' | { severity?: Severity; exclude?: string[] }>;
  failOn: Severity | 'none';
  maxFileSizeKb: number;
  /** Size limit for lockfiles, which are often several megabytes. */
  maxLockfileSizeKb: number;
  commands: Partial<Record<'build' | 'test' | 'typecheck' | 'lint', string>>;
  timeouts: { commandSeconds: number };
  release: {
    requireTests: boolean;
    requireCi: boolean;
    minCoverage?: number;
    blockOn: Severity;
  };
  performance: {
    budgets: Record<
      string,
      { meanMs?: number; p95Ms?: number; p99Ms?: number; errorRate?: number; maxRegressionPct?: number }
    >;
  };
  env: { optional: string[] };
}

export const CONFIG_FILES = ['relivaro.config.json', '.relivaro.json'];

export function defaultConfig(): RelivaroConfig {
  return {
    exclude: [],
    include: [],
    rules: {},
    failOn: 'none',
    maxFileSizeKb: 1024,
    maxLockfileSizeKb: 51200,
    commands: {},
    timeouts: { commandSeconds: 600 },
    release: { requireTests: true, requireCi: true, blockOn: 'high' },
    performance: { budgets: {} },
    env: { optional: [] },
  };
}

export function loadConfig(root: string, explicitPath?: string): { config: RelivaroConfig; path?: string } {
  const candidates = explicitPath ? [explicitPath] : CONFIG_FILES.map((f) => join(root, f));
  for (const file of candidates) {
    if (!existsSync(file)) {
      if (explicitPath) throw new RelivaroError('NOT_FOUND', `Config file not found: ${explicitPath}`);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new RelivaroError('CONFIG_INVALID', `${file} is not valid JSON: ${(e as Error).message}`);
    }
    return { config: validateConfig(raw, file), path: file };
  }
  return { config: defaultConfig() };
}

function fail(file: string, msg: string): never {
  throw new RelivaroError(
    'CONFIG_INVALID',
    `${file}: ${msg}`,
    'See docs/CONFIG.md for the configuration format.',
  );
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isSeverity = (v: unknown): v is Severity =>
  typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);

const KNOWN_KEYS = new Set([
  '$schema',
  'exclude',
  'include',
  'rules',
  'failOn',
  'maxFileSizeKb',
  'maxLockfileSizeKb',
  'commands',
  'timeouts',
  'release',
  'performance',
  'env',
]);

export function validateConfig(raw: unknown, file = 'config'): RelivaroConfig {
  if (!isObj(raw)) fail(file, 'top level must be an object');
  const c = defaultConfig();
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) fail(file, `unknown key "${key}"`);
  if (raw.exclude !== undefined) {
    if (!isStrArr(raw.exclude)) fail(file, '"exclude" must be an array of glob strings');
    c.exclude = raw.exclude;
  }
  if (raw.include !== undefined) {
    if (!isStrArr(raw.include)) fail(file, '"include" must be an array of glob strings');
    c.include = raw.include;
  }
  if (raw.rules !== undefined) {
    if (!isObj(raw.rules)) fail(file, '"rules" must be an object');
    for (const [id, v] of Object.entries(raw.rules)) {
      if (v === 'off') c.rules[id] = 'off';
      else if (isObj(v)) {
        if (v.severity !== undefined && !isSeverity(v.severity))
          fail(file, `rules.${id}.severity is invalid`);
        if (v.exclude !== undefined && !isStrArr(v.exclude))
          fail(file, `rules.${id}.exclude must be string[]`);
        c.rules[id] = {
          severity: v.severity as Severity | undefined,
          exclude: v.exclude as string[] | undefined,
        };
      } else fail(file, `rules.${id} must be "off" or an object`);
    }
  }
  if (raw.failOn !== undefined) {
    if (raw.failOn !== 'none' && !isSeverity(raw.failOn)) fail(file, '"failOn" must be a severity or "none"');
    c.failOn = raw.failOn;
  }
  if (raw.maxFileSizeKb !== undefined) {
    if (typeof raw.maxFileSizeKb !== 'number' || raw.maxFileSizeKb < 1 || raw.maxFileSizeKb > 20480)
      fail(file, '"maxFileSizeKb" must be a number between 1 and 20480');
    c.maxFileSizeKb = raw.maxFileSizeKb;
  }
  if (raw.maxLockfileSizeKb !== undefined) {
    if (
      typeof raw.maxLockfileSizeKb !== 'number' ||
      raw.maxLockfileSizeKb < 1 ||
      raw.maxLockfileSizeKb > 204800
    )
      fail(file, '"maxLockfileSizeKb" must be a number between 1 and 204800');
    c.maxLockfileSizeKb = raw.maxLockfileSizeKb;
  }
  if (raw.commands !== undefined) {
    if (!isObj(raw.commands)) fail(file, '"commands" must be an object');
    for (const [k, v] of Object.entries(raw.commands)) {
      if (!['build', 'test', 'typecheck', 'lint'].includes(k))
        fail(file, `commands.${k} is not a known command`);
      if (typeof v !== 'string' || !v.trim()) fail(file, `commands.${k} must be a non-empty string`);
      c.commands[k as keyof RelivaroConfig['commands']] = v;
    }
  }
  if (raw.timeouts !== undefined) {
    if (!isObj(raw.timeouts)) fail(file, '"timeouts" must be an object');
    const s = raw.timeouts.commandSeconds;
    if (s !== undefined) {
      if (typeof s !== 'number' || s < 1 || s > 7200) fail(file, 'timeouts.commandSeconds must be 1..7200');
      c.timeouts.commandSeconds = s;
    }
  }
  if (raw.release !== undefined) {
    if (!isObj(raw.release)) fail(file, '"release" must be an object');
    const r = raw.release;
    if (r.requireTests !== undefined) {
      if (typeof r.requireTests !== 'boolean') fail(file, 'release.requireTests must be boolean');
      c.release.requireTests = r.requireTests;
    }
    if (r.requireCi !== undefined) {
      if (typeof r.requireCi !== 'boolean') fail(file, 'release.requireCi must be boolean');
      c.release.requireCi = r.requireCi;
    }
    if (r.minCoverage !== undefined) {
      if (typeof r.minCoverage !== 'number' || r.minCoverage < 0 || r.minCoverage > 100)
        fail(file, 'release.minCoverage must be 0..100');
      c.release.minCoverage = r.minCoverage;
    }
    if (r.blockOn !== undefined) {
      if (!isSeverity(r.blockOn) || r.blockOn === 'info' || r.blockOn === 'low')
        fail(file, 'release.blockOn must be critical, high or medium');
      c.release.blockOn = r.blockOn;
    }
  }
  if (raw.performance !== undefined) {
    if (!isObj(raw.performance) || (raw.performance.budgets !== undefined && !isObj(raw.performance.budgets)))
      fail(file, '"performance.budgets" must be an object');
    for (const [name, b] of Object.entries((raw.performance.budgets ?? {}) as Record<string, unknown>)) {
      if (!isObj(b)) fail(file, `performance.budgets.${name} must be an object`);
      for (const [k, v] of Object.entries(b)) {
        if (!['meanMs', 'p95Ms', 'p99Ms', 'errorRate', 'maxRegressionPct'].includes(k))
          fail(file, `performance.budgets.${name}.${k} is unknown`);
        if (typeof v !== 'number' || v < 0)
          fail(file, `performance.budgets.${name}.${k} must be a non-negative number`);
      }
      c.performance.budgets[name] = b as RelivaroConfig['performance']['budgets'][string];
    }
  }
  if (raw.env !== undefined) {
    if (!isObj(raw.env) || (raw.env.optional !== undefined && !isStrArr(raw.env.optional)))
      fail(file, '"env.optional" must be an array of variable names');
    c.env.optional = (raw.env.optional as string[] | undefined) ?? [];
  }
  return c;
}
