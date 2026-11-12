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

const REVOKE_RE =
  /^REVOKE\s+(?:GRANT\s+OPTION\s+FOR\s+)?([\s\S]+?)\s+ON\s+(?:TABLE\s+)?(ALL\s+TABLES\s+IN\s+SCHEMA\s+[\s\S]+?|[\w."]+(?:\s*,\s*[\w."]+)*)\s+FROM\s+([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?\s*$/i;
/** `ALTER FUNCTION … OWNER TO role`, also inside a `format()` string of a DO block. */
const FUNCTION_OWNER_RE = /\bALTER\s+FUNCTION\b[^;]*?\bOWNER\s+TO\s+("?[\w]+"?)/gi;
/** Rollback scripts: `down.sql`, `0002_x.down.sql`, `down/0002.sql`. */
const DOWN_MIGRATION = /(?:^|\/)down(?:\.sql$|\/)|[._-]down\.sql$/i;

function bareRole(name: string): string {
  return name.replace(/"/g, '').trim().toLowerCase();
}

/** Grantees of a GRANT or REVOKE (`GROUP` keywords dropped). */
function roles(list: string): string[] {
  return list
    .split(',')
    .map((r) => bareRole(r.replace(/^\s*GROUP\s+/i, '')))
    .filter(Boolean);
}

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
    // Rollback scripts do not describe the deployed state; migrations apply in path order.
    const files = ctx.files.files
      .filter((f) => f.path.endsWith('.sql') && !f.isTest && !DOWN_MIGRATION.test(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    const stmts = files.flatMap((f) =>
      sqlStatements(ctx.files.read(f.path) ?? '').map((s) => ({ ...s, file: f.path })),
    );
    // A function that always raises: it never hands the row back, so the trigger blocks every row.
    const raising = new Set<string>();
    const definers = new Set<string>();
    for (const s of stmts) {
      const m = FUNCTION_RE.exec(s.sql);
      if (m && /\bRAISE\s+EXCEPTION\b/i.test(s.sql) && !/\bRETURN\s+(?:NEW|OLD)\b/i.test(s.sql))
        raising.add(bareName(m[1]!));
      for (const o of s.sql.matchAll(FUNCTION_OWNER_RE)) definers.add(bareRole(o[1]!));
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
    // Grants still in force after the later REVOKEs, one record per table, role and privilege.
    const grants: {
      table: string;
      role: string;
      priv: string;
      file: string;
      line: number;
      active: boolean;
    }[] = [];
    for (const s of stmts) {
      const g = GRANT_RE.exec(s.sql);
      if (g) {
        const privs = privileges(g[1]!).filter(
          (p) => !p.columns && /^(?:INSERT|UPDATE|DELETE|TRUNCATE|ALL)$/.test(p.name),
        );
        for (const t of g[2]!.split(','))
          for (const role of roles(g[3]!.replace(/\s+WITH\s+GRANT\s+OPTION$/i, '')))
            for (const p of privs)
              grants.push({
                table: bareName(t.trim()),
                role,
                priv: p.name,
                file: s.file,
                line: s.line,
                active: true,
              });
        continue;
      }
      const r = REVOKE_RE.exec(s.sql);
      if (!r) continue;
      const privs = privileges(r[1]!)
        .filter((p) => !p.columns)
        .map((p) => p.name);
      const tables = /^ALL\s+TABLES\s+IN\s+SCHEMA\b/i.test(r[2]!)
        ? undefined
        : new Set(r[2]!.split(',').map((t) => bareName(t.trim())));
      const from = new Set(roles(r[3]!));
      for (const g2 of grants)
        if (
          g2.active &&
          from.has(g2.role) &&
          (!tables || tables.has(g2.table)) &&
          (privs.includes('ALL') || privs.includes(g2.priv))
        )
          g2.active = false;
    }
    const out: Hit[] = [];
    const sites = new Map<string, typeof grants>();
    for (const g of grants) {
      if (!g.active || !appendOnly.has(g.table) || definers.has(g.role)) continue;
      const key = `${g.file}\0${g.line}\0${g.table}`;
      sites.set(key, [...(sites.get(key) ?? []), g]);
    }
    for (const list of sites.values()) {
      const { file, line, table } = list[0]!;
      const trigger = appendOnly.get(table)!;
      const role = [...new Set(list.map((g) => g.role))].join(', ');
      const priv = [...new Set(list.map((g) => g.priv))].join(', ');
      out.push({
        file,
        line,
        message: `Role \`${role}\` gets table-wide \`${priv}\` on append-only table \`${table}\` (${trigger.file}:${trigger.line}); limit it to the columns the role must write, or insert through a SECURITY DEFINER function.`,
        facts: { role, privileges: priv, table },
      });
    }
    return out;
  },
};

export const securitySqlRules: ProjectRule[] = [sqlGrantAppendOnly];
