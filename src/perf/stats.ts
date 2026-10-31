export interface Stats {
  n: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  medianMs: number;
  p90Ms: number;
  p95Ms: number;
  p99Ms: number;
  stddevMs: number;
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  const mean = n ? s.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const r = (x: number) => Math.round(x * 100) / 100;
  return { n, minMs: r(s[0] ?? 0), maxMs: r(s[n - 1] ?? 0), meanMs: r(mean), medianMs: r(quantile(s, 0.5)), p90Ms: r(quantile(s, 0.9)), p95Ms: r(quantile(s, 0.95)), p99Ms: r(quantile(s, 0.99)), stddevMs: r(Math.sqrt(variance)) };
}

export interface Comparison {
  baselineMeanMs: number;
  currentMeanMs: number;
  changePct: number;
  /** Welch's t-test style significance: change larger than combined noise (≈95%). */
  significant: boolean;
  verdict: 'faster' | 'slower' | 'no significant change';
}

export function compareStats(base: Stats, cur: Stats): Comparison {
  const changePct = base.meanMs ? ((cur.meanMs - base.meanMs) / base.meanMs) * 100 : 0;
  const se = Math.sqrt((base.stddevMs ** 2) / Math.max(base.n, 1) + (cur.stddevMs ** 2) / Math.max(cur.n, 1));
  const diff = cur.meanMs - base.meanMs;
  const significant = se === 0 ? Math.abs(changePct) > 5 : Math.abs(diff) > 1.96 * se && Math.abs(changePct) > 2;
  return { baselineMeanMs: base.meanMs, currentMeanMs: cur.meanMs, changePct: Math.round(changePct * 10) / 10, significant, verdict: !significant ? 'no significant change' : diff < 0 ? 'faster' : 'slower' };
}
