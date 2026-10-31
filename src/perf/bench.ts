import { lookup } from 'node:dns/promises';
import { existsSync, readdirSync } from 'node:fs';
import { isIP } from 'node:net';
import { cpus } from 'node:os';
import { RelivaroError } from '../core/errors.js';
import type { Workspace } from '../core/workspace.js';
import { runCommand, splitCommand } from '../exec/runner.js';
import type { BenchSnapshot } from '../release/readiness.js';
import { type Comparison, compareStats, type Stats, stats } from './stats.js';

export interface CommandBenchResult {
  schemaVersion: 1;
  kind: 'command';
  name: string;
  command: string;
  cwd: string;
  runs: number;
  warmup: number;
  measuredAt: string;
  samplesMs: number[];
  failures: number;
  stats: Stats;
  environment: { node: string; platform: string; arch: string; cpus: number };
  comparison?: Comparison;
}

export interface HttpLoadResult {
  schemaVersion: 1;
  kind: 'http';
  name: string;
  url: string;
  method: string;
  concurrency: number;
  durationSec: number;
  measuredAt: string;
  requests: number;
  errors: number;
  errorRate: number;
  throughputRps: number;
  statusCodes: Record<string, number>;
  stats: Stats;
  comparison?: Comparison;
  limitedBy: string[];
}

function envInfo() {
  return { node: process.version, platform: process.platform, arch: process.arch, cpus: cpus().length };
}

export async function benchCommand(opts: {
  name: string;
  command: string;
  cwd: string;
  runs: number;
  warmup: number;
  allowExec: boolean;
  timeoutSeconds: number;
  onProgress?: (m: string) => void;
}): Promise<CommandBenchResult> {
  if (opts.runs < 1 || opts.runs > 100) throw new RelivaroError('USAGE', '--runs must be between 1 and 100.');
  if (opts.warmup < 0 || opts.warmup > 20)
    throw new RelivaroError('USAGE', '--warmup must be between 0 and 20.');
  const argv = splitCommand(opts.command);
  const samples: number[] = [];
  let failures = 0;
  for (let i = 0; i < opts.warmup + opts.runs; i++) {
    const warm = i < opts.warmup;
    opts.onProgress?.(
      `${warm ? 'warmup' : 'run'} ${warm ? i + 1 : i - opts.warmup + 1}/${warm ? opts.warmup : opts.runs}`,
    );
    const t0 = performance.now();
    const r = await runCommand(argv, {
      cwd: opts.cwd,
      timeoutMs: opts.timeoutSeconds * 1000,
      allowExec: opts.allowExec,
      maxOutputBytes: 64 * 1024,
    });
    const ms = performance.now() - t0;
    if (r.exitCode !== 0) {
      failures++;
      if (failures > Math.max(1, Math.floor(opts.runs / 2)))
        throw new RelivaroError(
          'EXEC_FAILED',
          `\`${r.command}\` failed ${failures} times (exit ${r.exitCode ?? r.signal}); benchmark aborted.`,
          r.stderr.slice(-500) || undefined,
        );
      continue;
    }
    if (!warm) samples.push(ms);
  }
  if (!samples.length) throw new RelivaroError('EXEC_FAILED', 'No successful runs to measure.');
  return {
    schemaVersion: 1,
    kind: 'command',
    name: opts.name,
    command: argv.join(' '),
    cwd: opts.cwd,
    runs: opts.runs,
    warmup: opts.warmup,
    measuredAt: new Date().toISOString(),
    samplesMs: samples.map((s) => Math.round(s * 100) / 100),
    failures,
    stats: stats(samples),
    environment: envInfo(),
  };
}

const PRIVATE_V4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((r) => r.test(ip));
  const v = ip.toLowerCase();
  return (
    v === '::1' ||
    v.startsWith('fc') ||
    v.startsWith('fd') ||
    v.startsWith('fe80') ||
    v.startsWith('::ffff:127.') ||
    v.startsWith('::ffff:10.') ||
    v.startsWith('::ffff:192.168.')
  );
}

/** Resolves the target and refuses public addresses unless explicitly allowed (no load tests against production). */
export async function assertLoadTarget(url: URL, allowRemote: boolean): Promise<string[]> {
  if (!/^https?:$/.test(url.protocol))
    throw new RelivaroError('USAGE', 'Only http:// and https:// targets are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host)
    ? [host]
    : host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.test')
      ? ['127.0.0.1']
      : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new RelivaroError('NETWORK_FAILED', `Cannot resolve ${host}.`);
  const publicAddrs = addrs.filter((a) => !isPrivateAddress(a));
  if (publicAddrs.length && !allowRemote)
    throw new RelivaroError(
      'TARGET_NOT_ALLOWED',
      `${host} resolves to a public address (${publicAddrs[0]}). Load tests are limited to local and private-network targets.`,
      'Run against a local or staging environment you control. --allow-remote lifts this check for hosts you are authorized to test (caps still apply).',
    );
  return addrs;
}

export const LOAD_LIMITS = { maxConcurrency: 64, maxDurationSec: 120, maxRequests: 200_000 };

export async function loadTest(opts: {
  name: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  concurrency: number;
  durationSec: number;
  maxRequests?: number;
  timeoutMs: number;
  allowRemote: boolean;
  onProgress?: (m: string) => void;
  fetchImpl?: typeof fetch;
}): Promise<HttpLoadResult> {
  const url = new URL(opts.url);
  await assertLoadTarget(url, opts.allowRemote);
  const limitedBy: string[] = [];
  let concurrency = Math.floor(opts.concurrency);
  let durationSec = opts.durationSec;
  if (concurrency < 1) throw new RelivaroError('USAGE', '--concurrency must be at least 1.');
  if (concurrency > LOAD_LIMITS.maxConcurrency) {
    limitedBy.push(`concurrency capped at ${LOAD_LIMITS.maxConcurrency}`);
    concurrency = LOAD_LIMITS.maxConcurrency;
  }
  if (durationSec > LOAD_LIMITS.maxDurationSec) {
    limitedBy.push(`duration capped at ${LOAD_LIMITS.maxDurationSec}s`);
    durationSec = LOAD_LIMITS.maxDurationSec;
  }
  const maxRequests = Math.min(opts.maxRequests ?? LOAD_LIMITS.maxRequests, LOAD_LIMITS.maxRequests);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const latencies: number[] = [];
  const codes: Record<string, number> = {};
  let errors = 0;
  let sent = 0;
  const deadline = performance.now() + durationSec * 1000;
  const started = performance.now();
  let lastReport = 0;
  const worker = async () => {
    while (performance.now() < deadline && sent < maxRequests) {
      sent++;
      const t0 = performance.now();
      try {
        const res = await fetchImpl(url, {
          method: opts.method,
          headers: opts.headers,
          body: opts.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        await res.arrayBuffer();
        const key = String(res.status);
        codes[key] = (codes[key] ?? 0) + 1;
        if (res.status >= 500) errors++;
        latencies.push(performance.now() - t0);
      } catch (e) {
        errors++;
        const key = (e as Error).name === 'TimeoutError' ? 'timeout' : 'network-error';
        codes[key] = (codes[key] ?? 0) + 1;
      }
      const now = performance.now();
      if (now - lastReport > 1000) {
        lastReport = now;
        opts.onProgress?.(`${sent} requests, ${errors} errors, ${((now - started) / 1000).toFixed(0)}s`);
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsed = (performance.now() - started) / 1000;
  if (sent >= maxRequests) limitedBy.push(`stopped at ${maxRequests} requests`);
  return {
    schemaVersion: 1,
    kind: 'http',
    name: opts.name,
    url: url.origin + url.pathname,
    method: opts.method,
    concurrency,
    durationSec: Math.round(elapsed * 10) / 10,
    measuredAt: new Date().toISOString(),
    requests: sent,
    errors,
    errorRate: sent ? Math.round((errors / sent) * 10000) / 10000 : 0,
    throughputRps: Math.round((sent / elapsed) * 10) / 10,
    statusCodes: codes,
    stats: stats(latencies),
    limitedBy,
  };
}

export function saveBench(
  ws: Workspace,
  result: CommandBenchResult | HttpLoadResult,
  asBaseline: boolean,
): { latest: string; baseline?: string } {
  const safe = result.name.replace(/[^A-Za-z0-9._-]/g, '_');
  const latest = ws.writeJson(['bench', safe, 'latest.json'], result);
  ws.writeJson(['bench', safe, `${result.measuredAt.replace(/[:.]/g, '-')}.json`], result);
  const baseline = asBaseline ? ws.writeJson(['bench', safe, 'baseline.json'], result) : undefined;
  return { latest, baseline };
}

export function loadBaseline(ws: Workspace, name: string): CommandBenchResult | HttpLoadResult | undefined {
  return ws.readJson(['bench', name.replace(/[^A-Za-z0-9._-]/g, '_'), 'baseline.json']);
}

export function benchSnapshots(ws: Workspace): BenchSnapshot[] {
  const dir = ws.path('bench');
  if (!existsSync(dir)) return [];
  const out: BenchSnapshot[] = [];
  for (const d of readdirSync(dir)) {
    const r = ws.readJson<CommandBenchResult | HttpLoadResult>(['bench', d, 'latest.json']);
    if (r)
      out.push({
        name: r.name,
        kind: r.kind,
        stats: {
          meanMs: r.stats.meanMs,
          p95Ms: r.stats.p95Ms,
          p99Ms: r.stats.p99Ms,
          errorRate: r.kind === 'http' ? r.errorRate : 0,
        },
        measuredAt: r.measuredAt,
      });
  }
  return out;
}

export { compareStats };
