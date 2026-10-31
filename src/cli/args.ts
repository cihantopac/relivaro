import { RelivaroError } from '../core/errors.js';

export type OptType = 'boolean' | 'string' | 'number' | 'list';

export interface OptSpec {
  name: string;
  type: OptType;
  short?: string;
  description: string;
  default?: string | number | boolean;
  /** Placeholder shown in help, e.g. `<severity>`. */
  value?: string;
  choices?: readonly string[];
}

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  description?: string;
  options: OptSpec[];
  examples?: string[];
  /** Positional arguments (names for help). */
  positionals?: string[];
  hidden?: boolean;
  subcommands?: string[];
}

export interface Parsed {
  positionals: string[];
  opts: Record<string, string | number | boolean | string[] | undefined>;
}

export const GLOBAL_OPTIONS: OptSpec[] = [
  { name: 'json', type: 'boolean', description: 'Print machine-readable JSON to stdout (errors as JSON on stderr).' },
  { name: 'quiet', type: 'boolean', short: 'q', description: 'Only print the essential result (no progress).' },
  { name: 'no-color', type: 'boolean', description: 'Disable colored output (also honours NO_COLOR).' },
  { name: 'help', type: 'boolean', short: 'h', description: 'Show help for the command.' },
];

export function parseArgs(argv: string[], spec: CommandSpec): Parsed {
  const all = [...spec.options, ...GLOBAL_OPTIONS];
  const byName = new Map(all.map((o) => [o.name, o]));
  const byShort = new Map(all.filter((o) => o.short).map((o) => [o.short!, o]));
  const opts: Parsed['opts'] = {};
  const positionals: string[] = [];
  for (const o of all) if (o.default !== undefined) opts[o.name] = o.default;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let spec2: OptSpec | undefined;
    let inline: string | undefined;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      inline = eq > 0 ? a.slice(eq + 1) : undefined;
      spec2 = byName.get(name);
      if (!spec2 && name.startsWith('no-') && byName.get(name.slice(3))?.type === 'boolean') {
        opts[name.slice(3)] = false;
        continue;
      }
      if (!spec2) throw new RelivaroError('USAGE', `Unknown option --${name} for "${spec.name}".`, `Run \`relivaro ${spec.name} --help\`.`);
    } else if (/^-[a-zA-Z]$/.test(a)) {
      spec2 = byShort.get(a.slice(1));
      if (!spec2) throw new RelivaroError('USAGE', `Unknown option ${a} for "${spec.name}".`);
    } else {
      positionals.push(a);
      continue;
    }
    if (spec2.type === 'boolean') {
      if (inline !== undefined && !/^(?:true|false|1|0)$/.test(inline)) throw new RelivaroError('USAGE', `--${spec2.name} is a flag and takes no value.`);
      opts[spec2.name] = inline === undefined ? true : /^(?:true|1)$/.test(inline);
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || (inline === undefined && value.startsWith('--'))) throw new RelivaroError('USAGE', `--${spec2.name} requires a value${spec2.value ? ` ${spec2.value}` : ''}.`);
    if (spec2.type === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new RelivaroError('USAGE', `--${spec2.name} expects a number, got "${value}".`);
      opts[spec2.name] = n;
    } else if (spec2.type === 'list') {
      const prev = Array.isArray(opts[spec2.name]) && opts[spec2.name] !== spec2.default ? (opts[spec2.name] as string[]) : [];
      const items = value.split(',').map((x) => x.trim()).filter(Boolean);
      if (spec2.choices) for (const it of items) if (!spec2.choices.includes(it)) throw new RelivaroError('USAGE', `--${spec2.name}: "${it}" is not one of ${spec2.choices.join(', ')}.`);
      opts[spec2.name] = [...prev, ...items];
    } else {
      if (spec2.choices && !spec2.choices.includes(value)) throw new RelivaroError('USAGE', `--${spec2.name} must be one of ${spec2.choices.join(', ')} (got "${value}").`);
      opts[spec2.name] = value;
    }
  }
  return { positionals, opts };
}

export function helpText(spec: CommandSpec): string {
  const lines = [`relivaro ${spec.name} — ${spec.summary}`, '', `Usage: ${spec.usage}`, ''];
  if (spec.description) lines.push(spec.description, '');
  const opts = [...spec.options, ...GLOBAL_OPTIONS];
  if (opts.length) {
    lines.push('Options:');
    for (const o of opts) {
      const flag = `${o.short ? `-${o.short}, ` : '    '}--${o.name}${o.type === 'boolean' ? '' : ` ${o.value ?? `<${o.type}>`}`}`;
      lines.push(`  ${flag.padEnd(34)} ${o.description}${o.default !== undefined && o.type !== 'boolean' ? ` (default: ${o.default})` : ''}`);
    }
    lines.push('');
  }
  if (spec.examples?.length) {
    lines.push('Examples:');
    for (const e of spec.examples) lines.push(`  ${e}`);
    lines.push('');
  }
  return lines.join('\n');
}
