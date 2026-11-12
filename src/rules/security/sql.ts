import { OWASP } from '../helpers.js';
import type { Hit, ProjectRule } from '../types.js';

/**
 * Splits SQL text into statements on `;` outside string literals, quoted identifiers, dollar-quoted bodies
 * (`$$…$$`, `$tag$…$tag$`) and comments. Comments are dropped (a block comment becomes one space); `line` is the
 * 1-based line of the statement's first token.
 */
export function sqlStatements(text: string): { sql: string; line: number }[] {
  const out: { sql: string; line: number }[] = [];
  let cur = '';
  let start = 0;
  let line = 1;
  const flush = () => {
    const sql = cur.trim();
    if (sql) out.push({ sql, line: start });
    cur = '';
    start = 0;
  };
  const take = (s: string) => {
    if (!start && /\S/.test(s)) start = line + (s.slice(0, s.search(/\S/)).match(/\n/g)?.length ?? 0);
    cur += s;
    line += s.match(/\n/g)?.length ?? 0;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    const rest = text.slice(i);
    if (rest.startsWith('--')) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (text.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      line += text.slice(i, j).match(/\n/g)?.length ?? 0;
      cur += ' ';
      i = j;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      take(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const tag = ch === '$' && !/[\w$]/.test(text[i - 1] ?? '') ? /^\$(?:[A-Za-z_]\w*)?\$/.exec(rest) : null;
    if (tag) {
      const end = text.indexOf(tag[0], i + tag[0].length);
      const j = end < 0 ? text.length : end + tag[0].length;
      take(text.slice(i, j));
      i = j;
      continue;
    }
    if (ch === ';') {
      flush();
      i++;
      continue;
    }
    take(ch);
    i++;
  }
  flush();
  return out;
}

/** `"public"."ledger"`, `public.ledger` and `ledger` are the same table. */
function bareName(name: string): string {
  return (name.split('.').pop() ?? name).replace(/"/g, '').toLowerCase();
}

const FUNCTION_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(/i;
const TRIGGER_RE =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+[\w."]+\s+BEFORE\s+([\s\S]+?)\s+ON\s+([\w."]+)[\s\S]*?\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([\w."]+)/i;
const GRANT_RE =
  /^GRANT\s+([\s\S]+?)\s+ON\s+(?:TABLE\s+)?([\w."]+(?:\s*,\s*[\w."]+)*)\s+TO\s+([\s\S]+?)\s*$/i;

/** Privileges of a GRANT, split on commas outside column lists. */
function privileges(list: string): { name: string; columns: boolean }[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => ({
    name: (/^\s*(\w+)/.exec(p)?.[1] ?? '').toUpperCase(),
    columns: p.includes('('),
  }));
}

const sqlGrantAppendOnly: ProjectRule = {
  kind: 'project',
  id: 'sec/sql-grant-append-only',
  title: 'Table-wide grant on an append-only table',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  cwe: ['CWE-732'],
  owasp: [OWASP.A01],
  description:
    'A table is protected as append-only by a `BEFORE UPDATE OR DELETE` trigger that raises an exception, yet a `GRANT` gives a role table-wide `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE` or `ALL` on it.',
  impact:
    'Table-wide `INSERT` lets the role write any column (amounts, owners, timestamps); `UPDATE`/`DELETE` contradict the trigger and are one `ALTER TABLE … DISABLE TRIGGER` away for a role that owns the table; `TRUNCATE` skips row triggers altogether.',
  recommendation:
    'Grant `INSERT` only on the columns the role must write (`GRANT INSERT (col, …) ON t TO role`), or let it insert through a `SECURITY DEFINER` function, and do not grant `UPDATE`, `DELETE` or `TRUNCATE` on append-only tables.',
  verification:
    'Connect as the role and assert that `UPDATE`, `DELETE`, `TRUNCATE` and an `INSERT` of a column outside the allowed list all fail.',
  check(ctx) {
    const files = ctx.files.files.filter((f) => f.path.endsWith('.sql') && !f.isTest);
    const stmts = files.flatMap((f) =>
      sqlStatements(ctx.files.read(f.path) ?? '').map((s) => ({ ...s, file: f.path })),
    );
    const raising = new Set<string>();
    for (const s of stmts) {
      const m = FUNCTION_RE.exec(s.sql);
      if (m && /\bRAISE\s+EXCEPTION\b/i.test(s.sql)) raising.add(bareName(m[1]!));
    }
    const appendOnly = new Map<string, { file: string; line: number }>();
    for (const s of stmts) {
      const m = TRIGGER_RE.exec(s.sql);
      if (!m) continue;
      const events = m[1]!;
      if (!/\bUPDATE\b(?!\s+OF\b)/i.test(events) || !/\bDELETE\b/i.test(events)) continue;
      if (!raising.has(bareName(m[3]!))) continue;
      const table = bareName(m[2]!);
      if (!appendOnly.has(table)) appendOnly.set(table, { file: s.file, line: s.line });
    }
    if (!appendOnly.size) return [];
    const out: Hit[] = [];
    for (const s of stmts) {
      const m = GRANT_RE.exec(s.sql);
      if (!m) continue;
      const privs = privileges(m[1]!).filter((p) =>
        p.name === 'INSERT' ? !p.columns : /^(?:UPDATE|DELETE|TRUNCATE|ALL)$/.test(p.name) && !p.columns,
      );
      if (!privs.length) continue;
      const role = m[3]!.replace(/\s+WITH\s+GRANT\s+OPTION$/i, '').trim();
      for (const t of m[2]!.split(',')) {
        const trigger = appendOnly.get(bareName(t.trim()));
        if (!trigger) continue;
        const priv = privs.map((p) => p.name).join(', ');
        out.push({
          file: s.file,
          line: s.line,
          message: `Role \`${role}\` gets table-wide \`${priv}\` on append-only table \`${bareName(t.trim())}\` (${trigger.file}:${trigger.line}); limit it to the columns the role must write, or insert through a SECURITY DEFINER function.`,
          facts: { role, privileges: priv, table: bareName(t.trim()) },
        });
      }
    }
    return out;
  },
};

export const securitySqlRules: ProjectRule[] = [sqlGrantAppendOnly];
