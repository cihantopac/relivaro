/** Minimal unified diff (LCS over the changed middle section; fixes are small so this stays fast). */
export function unifiedDiff(path: string, before: string, after: string, context = 3): string {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA + 1);
  const midB = b.slice(start, endB + 1);
  // LCS table on the middle part.
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  if (midA.length * midB.length > 4_000_000) {
    for (const s of midA) ops.push({ t: '-', s });
    for (const s of midB) ops.push({ t: '+', s });
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i]![j] = midA[i] === midB[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: ' ', s: midA[i]! });
        i++;
        j++;
      } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ops.push({ t: '-', s: midA[i++]! });
      else ops.push({ t: '+', s: midB[j++]! });
    }
    while (i < n) ops.push({ t: '-', s: midA[i++]! });
    while (j < m) ops.push({ t: '+', s: midB[j++]! });
  }
  const full: { t: ' ' | '-' | '+'; s: string }[] = [
    ...a.slice(0, start).map((s) => ({ t: ' ' as const, s })),
    ...ops,
    ...a.slice(endA + 1).map((s) => ({ t: ' ' as const, s })),
  ];
  // Group into hunks.
  const out = [`--- a/${path}`, `+++ b/${path}`];
  let idx = 0;
  let lineA = 1;
  let lineB = 1;
  const posA: number[] = [];
  const posB: number[] = [];
  for (const op of full) {
    posA.push(lineA);
    posB.push(lineB);
    if (op.t !== '+') lineA++;
    if (op.t !== '-') lineB++;
  }
  while (idx < full.length) {
    while (idx < full.length && full[idx]!.t === ' ') idx++;
    if (idx >= full.length) break;
    const hs = Math.max(0, idx - context);
    let he = idx;
    let lastChange = idx;
    while (he < full.length && (full[he]!.t !== ' ' || he - lastChange <= context * 2)) {
      if (full[he]!.t !== ' ') lastChange = he;
      he++;
    }
    he = Math.min(full.length, lastChange + context + 1);
    const chunk = full.slice(hs, he);
    const countA = chunk.filter((o) => o.t !== '+').length;
    const countB = chunk.filter((o) => o.t !== '-').length;
    out.push(
      `@@ -${countA ? posA[hs] : posA[hs]! - 1},${countA} +${countB ? posB[hs] : posB[hs]! - 1},${countB} @@`,
    );
    for (const o of chunk) out.push(`${o.t}${o.s}`);
    idx = he;
  }
  return `${out.join('\n')}\n`;
}
