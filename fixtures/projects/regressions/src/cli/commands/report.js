import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

// Regression: CLI commands that take a `ctx` argument are not HTTP request handlers.
export function report(ctx) {
  if (!existsSync(ctx.dir)) mkdirSync(ctx.dir, { recursive: true });
  const data = readFileSync(ctx.input, 'utf8');
  writeFileSync(`${ctx.dir}/report.txt`, data);
}

// Regression: dynamic page functions built from internal constants are low-confidence review items, not high.
export const inPage = (src) => new Function(`return (${src})(arguments[0])`); // expect: sec/code-injection
