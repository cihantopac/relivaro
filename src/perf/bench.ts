import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { existsSync, readdirSync } from 'node:fs';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
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

/** Loopback, private, link-local, shared (CGNAT), benchmarking and "this network" ranges. */
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
] as const)
  PRIVATE.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
] as const)
  PRIVATE.addSubnet(net, prefix, 'ipv6');

/** The IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d / ::ffff:7f00:1) or NAT64 (64:ff9b::/96) address. */
function embeddedV4(ip: string): string | undefined {
  const m = /^(?:::ffff:(?:0:)?|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(
    ip,
  );
  if (!m) return undefined;
  if (m[1]) return m[1];
  const hi = Number.parseInt(m[2]!, 16);
  const lo = Number.parseInt(m[3]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(v);
  if (family === 4) return PRIVATE.check(v, 'ipv4');
  if (family !== 6) return false;
  const v4 = embeddedV4(v);
  return v4 ? PRIVATE.check(v4, 'ipv4') : PRIVATE.check(v, 'ipv6');
}

function refuse(host: string, address: string): RelivaroError {
  return new RelivaroError(
    'TARGET_NOT_ALLOWED',
    `${host} resolves to a public address (${address}). Load tests are limited to local and private-network targets.`,
    'Run against a local or staging environment you control. --allow-remote lifts this check for hosts you are authorized to test (caps still apply).',
  );
}

/** Resolves the target and refuses public addresses unless explicitly allowed (no load tests against production). */
export async function assertLoadTarget(url: URL, allowRemote: boolean): Promise<string[]> {
  if (!/^https?:$/.test(url.protocol))
    throw new RelivaroError('USAGE', 'Only http:// and https:// targets are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host)
    ? [host]
    : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new RelivaroError('NETWORK_FAILED', `Cannot resolve ${host}.`);
  const publicAddr = addrs.find((a) => !isPrivateAddress(a));
  if (publicAddr && !allowRemote) throw refuse(host, publicAddr);
  return addrs;
}

/**
 * A DNS lookup that re-applies the target policy to the addresses each connection actually uses, so a name that
 * resolved to a private address during the pre-check cannot be re-pointed at a public one mid-test (DNS rebinding).
 */
export function guardedLookup(allowRemote: boolean): LookupFunction {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 4);
      const list = addresses as LookupAddress[];
      const bad = allowRemote ? undefined : list.find((a) => !isPrivateAddress(a.address));
      if (bad) return callback(refuse(hostname, bad.address) as unknown as NodeJS.ErrnoException, '', 4);
      if (options.all) return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

/** Minimal HTTP client for the load test: keep-alive, no redirects, guarded DNS on every connection. */
function guardedFetch(allowRemote: boolean, concurrency: number): { fetch: typeof fetch; close: () => void } {
  const lookupFn = guardedLookup(allowRemote);
  const agents = {
    'http:': new HttpAgent({ keepAlive: true, maxSockets: concurrency, lookup: lookupFn }),
    'https:': new HttpsAgent({ keepAlive: true, maxSockets: concurrency, lookup: lookupFn }),
  };
  const close = () => {
    agents['http:'].destroy();
    agents['https:'].destroy();
  };
  const run = ((input: URL, init: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const send = input.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send(
        input,
        {
          method: init.method,
          headers: init.headers as Record<string, string>,
          agent: agents[input.protocol as 'http:' | 'https:'],
          signal: init.signal ?? undefined,
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, arrayBuffer: async () => new ArrayBuffer(0) } as Response),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.end(init.body as string | undefined);
    })) as unknown as typeof fetch;
  return { fetch: run, close };
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
  const client = opts.fetchImpl ? undefined : guardedFetch(opts.allowRemote, concurrency);
  const fetchImpl = opts.fetchImpl ?? client!.fetch;
  const latencies: number[] = [];
  const codes: Record<string, number> = {};
  let errors = 0;
  let sent = 0;
  const deadline = performance.now() + durationSec * 1000;
  const started = performance.now();
  let lastReport = 0;
  let refused: RelivaroError | undefined;
  const worker = async () => {
    while (!refused && performance.now() < deadline && sent < maxRequests) {
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
        if (e instanceof RelivaroError && e.code === 'TARGET_NOT_ALLOWED') {
          refused = e;
          break;
        }
        errors++;
        const err = e as Error & { cause?: Error };
        const key =
          err.name === 'TimeoutError' || err.cause?.name === 'TimeoutError' ? 'timeout' : 'network-error';
        codes[key] = (codes[key] ?? 0) + 1;
      }
      const now = performance.now();
      if (now - lastReport > 1000) {
        lastReport = now;
        opts.onProgress?.(`${sent} requests, ${errors} errors, ${((now - started) / 1000).toFixed(0)}s`);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
  } finally {
    client?.close();
  }
  if (refused) throw refused;
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
