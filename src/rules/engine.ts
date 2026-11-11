import { matchesAny } from '../core/glob.js';
import { findingId, fingerprint } from '../core/hash.js';
import { redact } from '../core/secrets.js';
import { type Category, type Finding, type ProjectFile, SEVERITIES, type Severity } from '../core/types.js';
import { collect, calls as collectCalls, FUNCTION_TYPES, forgetTree, taintedAt } from '../parse/ast.js';
import { parse } from '../parse/treesitter.js';
import { cyclomaticComplexity } from './quality.js';
import type { AstContext, AstRule, FileRule, Hit, ProjectContext, ProjectRule, Rule } from './types.js';

export interface AnalysisOptions {
  categories?: Category[];
  rules?: string[];
}

export interface AnalysisResult {
  findings: Finding[];
  rulesRun: string[];
  filesParsed: number;
  parseErrors: { file: string; message: string }[];
  ruleErrors: { rule: string; file?: string; message: string }[];
  durationMs: number;
  /** Per-file maximum cyclomatic complexity (parsed files only). */
  complexity: Map<string, number>;
  functions: number;
}

const SERVER_PATH =
  /(?:^|\/)(?:api|server|servers|routes?|controllers?|handlers?|middlewares?|services?|jobs?|workers?|queues?|lambdas?|functions|backend|actions|webhooks?|resolvers?|cron|commands?|console|listeners?|app\/Http|app\/Models|app\/Jobs|app\/Services|app\/Console|app\/Listeners|src\/main)\//i;
const CLIENT_PATH = /(?:^|\/)(?:components?|ui|hooks|styles|public|assets|stories|pages(?!\/api)|views)\//i;

function isServerSide(file: ProjectFile, source: string, project: ProjectContext): boolean {
  if (file.language === 'php' || file.language === 'python') return !file.isTest;
  if (/^\s*['"]use client['"]/m.test(source.slice(0, 500))) return false;
  if (/^\s*['"]use server['"]/m.test(source.slice(0, 500))) return true;
  if (
    /(?:^|\/)(?:app\/.*\/)?route\.[cm]?[jt]s$|(?:^|\/)pages\/api\/|(?:^|\/)middleware\.[cm]?[jt]s$|\.server\.[cm]?[jt]sx?$/.test(
      file.path,
    )
  )
    return true;
  if (
    /\bfrom\s+['"](?:express|fastify|koa|hono|@nestjs\/[\w-]+|next\/server|@hapi\/hapi|node:http|http|pg|mysql2?|mongoose|@prisma\/client|bullmq|ioredis)['"]|require\(\s*['"](?:express|fastify|koa|http|pg|mysql2?|mongoose)['"]\s*\)/.test(
      source,
    )
  )
    return true;
  if (SERVER_PATH.test(file.path) && !CLIENT_PATH.test(file.path)) return true;
  // Plain Node projects without a frontend framework are server-side by default.
  const frontend = project.profile.technologies.some(
    (t) => t.kind === 'frontend' || t.kind === 'fullstack' || t.kind === 'mobile',
  );
  return !frontend && !file.path.endsWith('.tsx') && !file.path.endsWith('.jsx');
}

/** For a call that spans several lines (fluent chains), point at the called method rather than the chain start. */
function callSite(n: import('../parse/treesitter.js').Node): import('../parse/treesitter.js').Node {
  if (n.startPosition.row === n.endPosition.row) return n;
  if (
    n.type === 'member_call_expression' ||
    n.type === 'scoped_call_expression' ||
    n.type === 'nullsafe_member_call_expression'
  )
    return n.childForFieldName('name') ?? n;
  if (n.type === 'call_expression') {
    const fn = n.childForFieldName('function');
    if (fn?.type === 'member_expression' && fn.startPosition.row !== fn.endPosition.row)
      return fn.childForFieldName('property') ?? n;
  }
  if (n.type === 'call') {
    const fn = n.childForFieldName('function');
    if (fn?.type === 'attribute' && fn.startPosition.row !== fn.endPosition.row)
      return fn.childForFieldName('attribute') ?? n;
  }
  return n;
}

const DOWNGRADE: Record<Severity, Severity> = {
  critical: 'high',
  high: 'medium',
  medium: 'low',
  low: 'low',
  info: 'info',
};

interface Suppressions {
  file: { all: boolean; rules: Set<string> };
  lines: Map<number, { all: boolean; rules: Set<string>; reason?: string }>;
  /** Inline acceptances by line: the rule ids accepted on that line and the stated reason. */
  accept: Map<number, { rules: Set<string>; reason: string }>;
  /** Malformed acceptance annotations: 1-based line numbers. */
  invalidAccept: number[];
}

const SUPPRESS_RE =
  /relivaro-ignore(-next-line|-file)?(?:\s+([\w/,.-]+(?:\s*,\s*[\w/.-]+)*))?(?:\s*[:—-]\s*(.*))?/;
/** `relivaro-accept[-next-line] <rule-id>[,<rule-id>]: <reason>`, only inside a comment. */
const ACCEPT_RE = /(?:\/\/|#|\/\*|<!--|\{\{--|^\s*\*)\s*relivaro-accept(-next-line)?(?![\w-])(.*)$/;
const ACCEPT_BODY_RE = /^\s+([\w/.-]+(?:\s*,\s*[\w/.-]+)*)\s*:\s*(.*)$/;
const COMMENT_END = /\s*(?:\*\/|-->|--\}\}|#}}|\?>)\s*$/;

/** True when position `at` of a source line lies inside a '…', "…" or template string opened on that line. */
function insideQuotes(line: string, at: number): boolean {
  let q = '';
  for (let i = 0; i < at; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = '';
    } else if (c === "'" || c === '"' || c === '`') q = c;
  }
  return q !== '';
}

export function parseSuppressions(lines: string[]): Suppressions {
  const s: Suppressions = {
    file: { all: false, rules: new Set() },
    lines: new Map(),
    accept: new Map(),
    invalidAccept: [],
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.includes('relivaro-accept')) {
      const a = ACCEPT_RE.exec(l);
      if (a && !insideQuotes(l, a.index)) {
        const body = ACCEPT_BODY_RE.exec(a[2] ?? '');
        const rules = new Set(
          (body?.[1] ?? '')
            .split(',')
            .map((r) => r.trim())
            .filter((r) => r.includes('/')),
        );
        const reason = (body?.[2] ?? '').replace(COMMENT_END, '').trim();
        if (!rules.size || reason.length < 3) s.invalidAccept.push(i + 1);
        else {
          const entry = { rules, reason };
          if (a[1] !== '-next-line') s.accept.set(i + 1, entry);
          s.accept.set(i + 2, entry);
        }
      }
    }
    if (!l.includes('relivaro-ignore')) continue;
    const m = SUPPRESS_RE.exec(l);
    if (!m) continue;
    const rules = new Set(
      (m[2] ?? '')
        .split(',')
        .map((r) => r.trim())
        .filter((r) => r.includes('/')),
    );
    const entry = {
      all: rules.size === 0,
      rules,
      reason: m[3]?.trim().replace(/\s*(?:\*\/|-->|#}}|\?>)\s*$/, '') || undefined,
    };
    if (m[1] === '-file') {
      if (entry.all) s.file.all = true;
      for (const r of rules) s.file.rules.add(r);
      continue;
    }
    // `relivaro-ignore` applies to its own line and the next line; `-next-line` only to the next line.
    if (m[1] !== '-next-line') s.lines.set(i + 1, entry);
    s.lines.set(i + 2, entry);
  }
  return s;
}

function suppressedBy(
  s: Suppressions | undefined,
  ruleId: string,
  line?: number,
): { reason?: string } | null {
  if (!s) return null;
  if (s.file.all || s.file.rules.has(ruleId)) return {};
  if (line === undefined) return null;
  const e = s.lines.get(line);
  if (e && (e.all || e.rules.has(ruleId))) return { reason: e.reason };
  return null;
}

export function snippetAround(lines: string[], line: number, context = 1): string {
  const from = Math.max(1, line - context);
  const to = Math.min(lines.length, line + context);
  const out: string[] = [];
  for (let i = from; i <= to; i++) {
    let l = lines[i - 1] ?? '';
    if (l.length > 220) l = `${l.slice(0, 220)}…`;
    out.push(`${String(i).padStart(4)} | ${l}`);
  }
  return redact(out.join('\n'));
}

/**
 * Fixers whose change would break what tests usually do on purpose: round-tripping objects through `unserialize()`
 * and talking to local servers with self-signed certificates. In test files these findings stay review items.
 */
const TEST_UNSAFE_FIXERS = new Set(['php-unserialize-allowed-classes', 'tls-verify-enable']);

export class FindingBuilder {
  private readonly occurrences = new Map<string, number>();
  readonly findings: Finding[] = [];
  private readonly lineCache = new Map<string, string[]>();
  private readonly suppressionCache = new Map<string, Suppressions>();
  /** Malformed inline annotations, reported in `errors.rules`. */
  readonly annotationErrors: { rule: string; file: string; message: string }[] = [];

  constructor(
    private readonly project: ProjectContext,
    private readonly opts: { inlineSuppressions?: boolean } = {},
  ) {}

  /** Parses (once) the inline annotations of a file; malformed acceptances are recorded as errors. */
  annotations(file: string, lines: string[]): Suppressions | undefined {
    if (this.opts.inlineSuppressions === false) return undefined;
    let s = this.suppressionCache.get(file);
    if (!s) {
      s = parseSuppressions(lines);
      this.suppressionCache.set(file, s);
      for (const line of s.invalidAccept)
        this.annotationErrors.push({
          rule: 'relivaro-accept',
          file,
          message: `Invalid relivaro-accept at ${file}:${line}: a rule id and a reason are required`,
        });
    }
    return s;
  }

  private linesOf(file: string): string[] | undefined {
    let l = this.lineCache.get(file);
    if (!l) {
      const text = this.project.files.read(file) ?? this.project.files.readAny(file);
      if (text === undefined) return undefined;
      l = text.split(/\r?\n/);
      this.lineCache.set(file, l);
    }
    return l;
  }

  add(
    rule: Rule | Omit<Rule, 'check' | 'kind'>,
    hit: Hit,
    provenance: Finding['provenance'] = 'static',
  ): Finding | null {
    const cfg = this.project.config.rules[rule.id];
    if (cfg === 'off') return null;
    const file = hit.file;
    if (file && cfg?.exclude?.length && matchesAny(file, cfg.exclude)) return null;
    let line = hit.line;
    let column = hit.column;
    let endLine = hit.endLine;
    if (hit.node) {
      const at = callSite(hit.node);
      line ??= at.startPosition.row + 1;
      column ??= at.startPosition.column + 1;
      endLine ??= hit.node.endPosition.row + 1;
    }
    const lines = file ? this.linesOf(file) : undefined;
    const anchor = hit.anchor ?? (lines && line ? (lines[line - 1] ?? '') : `${file ?? ''}:${hit.message}`);
    const occKey = `${rule.id}\u0000${file ?? ''}\u0000${anchor}`;
    const occ = this.occurrences.get(occKey) ?? 0;
    this.occurrences.set(occKey, occ + 1);
    const fp = fingerprint(rule.id, file ?? '', anchor, occ);

    let severity = cfg?.severity ?? hit.severity ?? rule.severity;
    let confidence = hit.confidence ?? rule.confidence;
    const pf = file ? this.project.files.get(file) : undefined;
    if (pf?.isTest && rule.category !== 'testing' && !rule.tags?.includes('test-aware')) {
      confidence = 'low';
      if (!cfg?.severity) severity = DOWNGRADE[severity];
    }
    if (!SEVERITIES.includes(severity)) severity = rule.severity;

    let suppression: Finding['suppression'];
    let accepted: Finding['accepted'];
    const notes = file && lines ? this.annotations(file, lines) : undefined;
    if (notes) {
      const sup = suppressedBy(notes, rule.id, line);
      if (sup) suppression = { kind: 'inline', reason: sup.reason };
      const acc = line !== undefined ? notes.accept.get(line) : undefined;
      if (!suppression && acc?.rules.has(rule.id)) accepted = { reason: acc.reason, source: 'inline' };
    }

    const finding: Finding = {
      id: findingId(fp),
      ruleId: rule.id,
      title: rule.title,
      message: redact(hit.message),
      severity,
      confidence,
      category: rule.category,
      provenance,
      evidence: {
        snippet:
          hit.snippet !== undefined
            ? redact(hit.snippet)
            : lines && line
              ? snippetAround(lines, line)
              : undefined,
        facts: hit.facts,
      },
      impact: rule.impact,
      recommendation: rule.recommendation,
      verification: rule.verification,
      fingerprint: fp,
      status: suppression ? 'suppressed' : 'open',
    };
    if (file) finding.location = { file, line, column, endLine };
    if (rule.cwe?.length) finding.cwe = rule.cwe;
    if (rule.owasp?.length) finding.owasp = rule.owasp;
    if (rule.tags?.length) finding.tags = rule.tags;
    const fixer = hit.fixer === null ? undefined : (hit.fixer ?? rule.fixer);
    if (fixer && !(pf?.isTest && TEST_UNSAFE_FIXERS.has(fixer))) finding.fixer = fixer;
    if (suppression) finding.suppression = suppression;
    if (accepted) finding.accepted = accepted;
    this.findings.push(finding);
    return finding;
  }
}

export function selectRules(rules: Rule[], opts: AnalysisOptions, config: ProjectContext['config']): Rule[] {
  return rules.filter(
    (r) =>
      config.rules[r.id] !== 'off' &&
      (!opts.categories?.length || opts.categories.includes(r.category)) &&
      (!opts.rules?.length ||
        opts.rules.some((id) => r.id === id || (id.endsWith('*') && r.id.startsWith(id.slice(0, -1))))),
  );
}

export async function analyze(
  project: ProjectContext,
  allRules: Rule[],
  opts: AnalysisOptions = {},
  builder = new FindingBuilder(project),
): Promise<AnalysisResult> {
  const started = performance.now();
  const rules = selectRules(allRules, opts, project.config);
  const astRules = rules.filter((r): r is AstRule => r.kind === 'ast');
  const fileRules = rules.filter((r): r is FileRule => r.kind === 'file');
  const projectRules = rules.filter((r): r is ProjectRule => r.kind === 'project');
  const parseErrors: AnalysisResult['parseErrors'] = [];
  const ruleErrors: AnalysisResult['ruleErrors'] = [];
  let filesParsed = 0;
  let functions = 0;
  const complexity = new Map<string, number>();

  for (const file of project.files.files) {
    const applicableFileRules = fileRules.filter((r) => r.appliesTo(file));
    const lang = file.language;
    const applicableAst = lang ? astRules.filter((r) => r.languages.includes(lang)) : [];
    if (!applicableFileRules.length && !applicableAst.length) continue;
    const text = project.files.read(file.path);
    if (text === undefined) continue;
    if (text.includes('relivaro-accept')) builder.annotations(file.path, text.split(/\r?\n/));
    if (applicableFileRules.length) {
      // One context per file, shared by its rules, so per-file parse caches (e.g. workflows) are reused.
      const fctx = { project, file, text, lines: text.split(/\r?\n/) };
      for (const rule of applicableFileRules) {
        try {
          for (const hit of rule.check(fctx)) builder.add(rule, { ...hit, file: hit.file ?? file.path });
        } catch (e) {
          ruleErrors.push({ rule: rule.id, file: file.path, message: (e as Error).message });
        }
      }
    }
    if (lang && applicableAst.length) {
      let tree: Awaited<ReturnType<typeof parse>>;
      try {
        tree = await parse(lang, text);
      } catch (e) {
        parseErrors.push({ file: file.path, message: (e as Error).message });
        continue;
      }
      if (!tree) {
        parseErrors.push({ file: file.path, message: 'parser returned no tree' });
        continue;
      }
      filesParsed++;
      const taintCache = new Map<number, Set<string>>();
      const ctx: AstContext = {
        project,
        file,
        lang,
        source: text,
        tree,
        calls: collectCalls(tree, lang),
        tainted: (expr) => taintedAt(expr, lang, taintCache),
        serverSide: isServerSide(file, text, project),
      };
      for (const rule of applicableAst) {
        try {
          for (const hit of rule.check(ctx)) builder.add(rule, { ...hit, file: hit.file ?? file.path });
        } catch (e) {
          ruleErrors.push({ rule: rule.id, file: file.path, message: (e as Error).message });
        }
      }
      let maxCc = 0;
      for (const fn of collect(tree.rootNode, FUNCTION_TYPES[lang])) {
        functions++;
        const cc = cyclomaticComplexity(fn, lang);
        if (cc > maxCc) maxCc = cc;
      }
      complexity.set(file.path, maxCc);
      forgetTree(tree);
      tree.delete();
    }
  }

  for (const rule of projectRules) {
    try {
      for (const hit of rule.check(project)) builder.add(rule, hit);
    } catch (e) {
      ruleErrors.push({ rule: rule.id, message: (e as Error).message });
    }
  }

  ruleErrors.push(...builder.annotationErrors);
  return {
    findings: builder.findings,
    rulesRun: rules.map((r) => r.id),
    filesParsed,
    parseErrors,
    ruleErrors,
    durationMs: Math.round(performance.now() - started),
    complexity,
    functions,
  };
}
