// Runs one Relivaro command in-process and reports wall time and peak RSS (used by scripts/bench.mjs).
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [, , cli, outFile, ...args] = process.argv;
const chunks = [];
process.stdout.write = (c) => {
  chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString());
  return true;
};
const { main } = await import(pathToFileURL(cli).href);
const t0 = performance.now();
const code = await main(args);
const ms = performance.now() - t0;
writeFileSync(
  outFile,
  JSON.stringify({ code, ms, maxRssKb: process.resourceUsage().maxRSS, stdout: chunks.join('') }),
);
