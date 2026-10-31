#!/usr/bin/env node
// Release-scope guard: no unfinished-work markers in shipped source.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', 'src');
const MARKER = /\b(?:TODO|FIXME|HACK)\b|XXX:|not implemented|NotImplementedError/;
const hits = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts'))
      readFileSync(p, 'utf8')
        .split('\n')
        .forEach((l, i) => {
          // Rule text that *detects* such markers (e.g. Python NotImplementedError handling) is allowed.
          if (MARKER.test(l) && !/relivaro-allow-marker/.test(l)) hits.push(`${p}:${i + 1}: ${l.trim()}`);
        });
  }
};
walk(root);
if (hits.length) {
  console.error(`Unfinished-work markers in src/:\n${hits.join('\n')}`);
  process.exit(1);
}
console.log('no unfinished-work markers in src/');
