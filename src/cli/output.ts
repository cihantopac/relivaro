import type { RunRecord } from '../audit.js';
import { type Finding, SEVERITIES, type Severity } from '../core/types.js';
import { releaseTally } from '../release/readiness.js';

export interface Out {
  json: boolean;
  quiet: boolean;
  color: boolean;
  print(s?: string): void;
  progress(s: string): void;
  warn(s: string): void;
}

export function makeOut(opts: { json?: boolean; quiet?: boolean; color?: boolean }): Out {
  const color = opts.color !== false && !process.env.NO_COLOR && !!process.stdout.isTTY && !opts.json;
  return {
    json: !!opts.json,
    quiet: !!opts.quiet,
    color,
    print: (s = '') => {
      process.stdout.write(`${s}\n`);
    },
    progress: (s) => {
      if (!opts.quiet && !opts.json && process.stderr.isTTY)
        process.stderr.write(`\r\u001b[2K${dim(color, `… ${s}`)}`);
      else if (!opts.quiet && !opts.json && process.env.RELIVARO_PROGRESS) process.stderr.write(`… ${s}\n`);
    },
    warn: (s) => {
      process.stderr.write(`${s}\n`);
    },
  };
}

export function clearProgress(): void {
  if (process.stderr.isTTY) process.stderr.write('\r\u001b[2K');
}

const CODES: Record<string, [number, number]> = {
  red: [31, 39],
  yellow: [33, 39],
  green: [32, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
  bold: [1, 22],
  dim: [2, 22],
};

export function paint(on: boolean, style: keyof typeof CODES, s: string): string {
  if (!on) return s;
  const [a, b] = CODES[style]!;
  return `\u001b[${a}m${s}\u001b[${b}m`;
}

function dim(on: boolean, s: string) {
  return paint(on, 'dim', s);
}

const SEV_STYLE: Record<Severity, keyof typeof CODES> = {
  critical: 'magenta',
  high: 'red',
  medium: 'yellow',
  low: 'blue',
  info: 'gray',
};

export function sevLabel(on: boolean, s: Severity): string {
  return paint(on, SEV_STYLE[s], s.toUpperCase().padEnd(8));
}

export function findingLine(on: boolean, f: Finding): string {
  const where = f.location ? `${f.location.file}${f.location.line ? `:${f.location.line}` : ''}` : '';
  return `${sevLabel(on, f.severity)} ${paint(on, 'bold', f.title)}${where ? `  ${paint(on, 'cyan', where)}` : ''}\n         ${f.message}  ${paint(on, 'gray', `[${f.ruleId} · ${f.confidence} confidence · ${f.id}]`)}`;
}

export function printRunSummary(
  out: Out,
  run: RunRecord,
  files: Record<string, string>,
  maxFindings = 15,
  openCommand?: (file: string) => string,
  /** The path argument as the user typed it; analysis runs without a release verdict end with the next step. */
  typedPath = '.',
): void {
  const on = out.color;
  const s = run.summary;
  out.print(
    `${paint(on, 'bold', `Relivaro ${run.command}`)} · ${run.profile.name} · ${run.metrics.files} files · ${(run.durationMs / 1000).toFixed(1)}s`,
  );
  const stack = [...new Set(run.profile.units.flatMap((u) => u.frameworks))].slice(0, 8).join(', ');
  if (stack && !out.quiet)
    out.print(
      paint(
        on,
        'gray',
        `Stack: ${stack}${run.profile.monorepo ? ` · monorepo (${run.profile.units.length} units)` : ''}`,
      ),
    );
  out.print('');
  if (run.release) {
    const r = run.release;
    const st =
      r.status === 'ready'
        ? paint(on, 'green', 'READY')
        : r.status === 'ready-with-warnings'
          ? paint(on, 'yellow', 'READY WITH WARNINGS')
          : r.status === 'needs-verification'
            ? paint(on, 'yellow', 'NEEDS VERIFICATION')
            : paint(on, 'red', 'NOT READY');
    out.print(
      `Release readiness: ${paint(on, 'bold', st)}  score ${r.score}/100${r.scoreCapped ? ' (capped by blockers)' : ''}`,
    );
    out.print(paint(on, 'gray', `  ${releaseTally(r)}`));
    const icon: Record<string, string> = {
      block: paint(on, 'red', '✖ blocker   '),
      warn: paint(on, 'yellow', '! warning   '),
      pass: paint(on, 'green', '✔ passed    '),
      unverified: paint(on, 'gray', '? unverified'),
      'n/a': paint(on, 'gray', '- n/a       '),
    };
    for (const g of r.gates)
      out.print(
        `  ${icon[g.status]} ${g.title}${g.status === 'pass' && g.basis === 'static' ? paint(on, 'gray', ' (static analysis)') : ''}${g.status !== 'pass' && g.status !== 'n/a' ? paint(on, 'gray', ` — ${g.detail.slice(0, 160)}`) : ''}`,
      );
    out.print('');
  }
  if (run.checks.length) {
    for (const c of run.checks) {
      const st =
        c.status === 'passed'
          ? paint(on, 'green', 'passed')
          : c.status === 'skipped'
            ? paint(on, 'gray', 'skipped')
            : paint(on, 'red', c.status);
      out.print(
        `  ${c.kind.padEnd(9)} ${c.unit.padEnd(16)} ${st}${c.tests ? ` (${c.tests.passed} passed, ${c.tests.failed} failed, ${c.tests.skipped} skipped)` : ''}${c.reason ? paint(on, 'gray', ` — ${c.reason}`) : ''}`,
      );
    }
    out.print('');
  }
  out.print(
    `${paint(on, 'bold', `${s.open} open findings`)}: ${
      SEVERITIES.filter((x) => s.bySeverity[x])
        .map((x) => paint(on, SEV_STYLE[x], `${s.bySeverity[x]} ${x}`))
        .join(', ') || 'none'
    }${s.suppressed ? paint(on, 'gray', ` · ${s.suppressed} suppressed`) : ''}${s.baseline ? paint(on, 'gray', ` · ${s.baseline} baseline`) : ''}`,
  );
  if (!out.quiet) {
    const open = run.findings.filter((f) => f.status === 'open');
    for (const f of open.slice(0, maxFindings)) out.print(findingLine(on, f));
    if (open.length > maxFindings)
      out.print(paint(on, 'gray', `… and ${open.length - maxFindings} more (see the report).`));
    if (run.limitations.length) {
      out.print('');
      out.print(paint(on, 'bold', 'Not verified / limitations:'));
      for (const l of run.limitations.slice(0, 8)) out.print(`  - ${l}`);
    }
  }
  out.print('');
  for (const [k, v] of Object.entries(files))
    if (k !== 'html') out.print(`${paint(on, 'gray', `${k.padEnd(9)}`)} ${v}`);
  if (files.html) {
    out.print('');
    out.print(`${paint(on, 'bold', 'HTML report')}  ${paint(on, 'cyan', files.html)}`);
    if (openCommand)
      out.print(
        paint(
          on,
          'gray',
          `Open it: ${openCommand(files.html)}  (or re-run with --open). Select findings there to generate a fix prompt.`,
        ),
      );
  }
  if (!run.release && !out.quiet) {
    const path = /[\s'"$`\\]/.test(typedPath) ? `'${typedPath.replace(/'/g, `'\\''`)}'` : typedPath;
    out.print('');
    out.print(
      `Next: relivaro release ${path} for a release verdict (add --allow-exec --online to verify more)`,
    );
  }
}
