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
  const tagRe = /\$(?:[A-Za-z_]\w*)?\$/y;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (text.startsWith('--', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith('/*', i)) {
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
      // `E'…'` strings take backslash escapes (`E'Don\'t'`).
      const escapes = ch === "'" && /[eE]/.test(text[i - 1] ?? '') && !/\w/.test(text[i - 2] ?? '');
      let j = i + 1;
      while (j < text.length) {
        if (escapes && text[j] === '\\') j += 2;
        else if (text[j] === ch) {
          if (text[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      take(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    tagRe.lastIndex = i;
    const tag = ch === '$' && !/[\w$]/.test(text[i - 1] ?? '') ? tagRe.exec(text) : null;
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

interface TableRef {
  schema?: string;
  name: string;
}

/** `"public"."ledger"`, `public.ledger` and `ledger` are one table; `audit.ledger` is another. */
function tableRef(raw: string): TableRef {
  const parts = raw.trim().replace(/"/g, '').toLowerCase().split('.');
  const name = parts[parts.length - 1] ?? '';
  const schema = parts.length > 1 ? parts[parts.length - 2] : undefined;
  return schema && schema !== 'public' ? { schema, name } : { name };
}

function sameTable(a: TableRef, b: TableRef): boolean {
  return a.name === b.name && (!a.schema || !b.schema || a.schema === b.schema);
}

function bareName(name: string): string {
  return (name.split('.').pop() ?? name).replace(/"/g, '').trim().toLowerCase();
}

const FUNCTION_RE = /^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)\s*\(/i;
const DROP_FUNCTION_RE = /^DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?$/i;
const TRIGGER_RE =
  /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+([\w."]+)\s+BEFORE\s+([\s\S]+?)\s+ON\s+([\w."]+)([\s\S]*?)\bEXECUTE\s+(?:FUNCTION|PROCEDURE)\s+([\w."]+)/i;
const DROP_TRIGGER_RE = /^DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?([\w."]+)\s+ON\s+([\w."]+)/i;
const TOGGLE_TRIGGER_RE =
  /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?([\w."]+)\s+(ENABLE|DISABLE)\s+(?:ALWAYS\s+|REPLICA\s+)?TRIGGER\s+([\w."]+)/i;
const GRANT_RE =
  /^GRANT\s+([\s\S]+?)\s+ON\s+(?:TABLE\s+)?([\w."]+(?:\s*,\s*[\w."]+)*)\s+TO\s+([\s\S]+?)\s*$/i;
const REVOKE_RE =
  /^REVOKE\s+(?:GRANT\s+OPTION\s+FOR\s+)?([\s\S]+?)\s+ON\s+(?:TABLE\s+)?(ALL\s+TABLES\s+IN\s+SCHEMA\s+[\s\S]+?|[\w."]+(?:\s*,\s*[\w."]+)*)\s+FROM\s+([\s\S]+?)(?:\s+(?:CASCADE|RESTRICT))?\s*$/i;
/** `ALTER FUNCTION … OWNER TO role`, also inside a `format()` string of a DO block. */
const FUNCTION_OWNER_RE = /\bALTER\s+FUNCTION\b[^;]*?\bOWNER\s+TO\s+("?[\w]+"?)/gi;
/** Rollback scripts: `down.sql`, `0002_x.down.sql`, `down/` or `rollback/` folders, Flyway undo `U2__x.sql`. */
const DOWN_MIGRATION =
  /(?:^|\/)(?:down|rollbacks?|undo)(?:\.sql$|\/)|[._-](?:down|rollback|undo)\.sql$|(?:^|\/)U\d+(?:[._]\d+)*__[^/]*\.sql$/i;
const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];

function bareRole(name: string): string {
  return name.replace(/"/g, '').trim().toLowerCase();
}

/** Grantees of a GRANT or REVOKE (`GROUP`, `WITH GRANT OPTION` and `GRANTED BY` dropped). */
function roles(list: string): string[] {
  return list
    .replace(/\s+WITH\s+GRANT\s+OPTION\b/i, '')
    .replace(/\s+GRANTED\s+BY\s+\S+/i, '')
    .split(',')
    .map((r) => bareRole(r.replace(/^\s*GROUP\s+/i, '')))
    .filter(Boolean);
}

/** Table-wide write privileges of a GRANT or REVOKE (`ALL` expanded); column lists are left out. */
function writePrivileges(list: string): string[] {
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
  const out = new Set<string>();
  for (const p of parts) {
    if (p.includes('(')) continue;
    const name = (/^\s*(\w+)/.exec(p)?.[1] ?? '').toUpperCase();
    if (name === 'ALL') for (const w of WRITE_PRIVILEGES) out.add(w);
    else if (WRITE_PRIVILEGES.includes(name)) out.add(name);
  }
  return [...out];
}

/** A trigger function that always raises: it never hands a row back, so every row change is refused. */
function alwaysRaises(sql: string): boolean {
  return /\bRAISE\s+EXCEPTION\b/i.test(sql) && !/\bRETURN\s+(?!NULL\b)\S/i.test(sql);
}

function advice(privs: string[]): string {
  if (privs.every((p) => p === 'INSERT'))
    return 'limit it to the columns the role must write, or insert through a SECURITY DEFINER function.';
  if (!privs.includes('INSERT'))
    return 'remove the grant: the trigger forbids UPDATE and DELETE, and TRUNCATE skips row triggers.';
  return 'grant at most INSERT on the columns the role must write; UPDATE, DELETE and TRUNCATE contradict the trigger.';
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
    // Rollback scripts do not describe the deployed state; migrations apply in (numeric) path order.
    const files = ctx.files.files
      .filter((f) => f.path.endsWith('.sql') && !f.isTest && !DOWN_MIGRATION.test(f.path))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    const raising = new Map<string, boolean>();
    const definers = new Set<string>();
    const triggers = new Map<
      string,
      { name: string; table: TableRef; fn: string; on: boolean; file: string; line: number }
    >();
    const grants: {
      table: TableRef;
      role: string;
      priv: string;
      file: string;
      line: number;
      active: boolean;
    }[] = [];
    for (const f of files)
      for (const s of sqlStatements(ctx.files.read(f.path) ?? '')) {
        for (const o of s.sql.matchAll(FUNCTION_OWNER_RE)) definers.add(bareRole(o[1]!));
        let m = FUNCTION_RE.exec(s.sql);
        if (m) {
          raising.set(bareName(m[1]!), alwaysRaises(s.sql));
          continue;
        }
        m = DROP_FUNCTION_RE.exec(s.sql);
        if (m) {
          for (const fn of m[1]!.replace(/\([^)]*\)/g, '').split(',')) raising.delete(bareName(fn));
          continue;
        }
        m = TRIGGER_RE.exec(s.sql);
        if (m) {
          const [, name, events, table, between, fn] = m;
          const key = `${bareName(name!)}\0${tableRef(table!).name}`;
          // A WHEN clause locks only some rows; `UPDATE OF col` only some columns.
          const lock =
            /\bUPDATE\b(?!\s+OF\b)/i.test(events!) &&
            /\bDELETE\b/i.test(events!) &&
            !/\bWHEN\s*\(/i.test(between!);
          if (lock)
            triggers.set(key, {
              name: bareName(name!),
              table: tableRef(table!),
              fn: bareName(fn!),
              on: true,
              file: f.path,
              line: s.line,
            });
          else triggers.delete(key);
          continue;
        }
        m = DROP_TRIGGER_RE.exec(s.sql);
        if (m) {
          triggers.delete(`${bareName(m[1]!)}\0${tableRef(m[2]!).name}`);
          continue;
        }
        m = TOGGLE_TRIGGER_RE.exec(s.sql);
        if (m) {
          const table = tableRef(m[1]!);
          const which = bareName(m[3]!);
          for (const t of triggers.values())
            if (sameTable(t.table, table) && (which === 'all' || which === 'user' || which === t.name))
              t.on = m[2]!.toUpperCase() === 'ENABLE';
          continue;
        }
        m = GRANT_RE.exec(s.sql);
        if (m) {
          const privs = writePrivileges(m[1]!);
          for (const t of m[2]!.split(','))
            for (const role of roles(m[3]!))
              for (const priv of privs)
                grants.push({ table: tableRef(t), role, priv, file: f.path, line: s.line, active: true });
          continue;
        }
        m = REVOKE_RE.exec(s.sql);
        if (m) {
          const privs = writePrivileges(m[1]!);
          const tables = /^ALL\s+TABLES\s+IN\s+SCHEMA\b/i.test(m[2]!)
            ? undefined
            : m[2]!.split(',').map(tableRef);
          const from = new Set(roles(m[3]!));
          for (const g of grants)
            if (
              g.active &&
              from.has(g.role) &&
              privs.includes(g.priv) &&
              (!tables || tables.some((t) => sameTable(t, g.table)))
            )
              g.active = false;
        }
      }
    const appendOnly = [...triggers.values()].filter((t) => t.on && raising.get(t.fn) === true);
    if (!appendOnly.length) return [];
    const sites = new Map<string, { grants: typeof grants; trigger: (typeof appendOnly)[number] }>();
    for (const g of grants) {
      if (!g.active || definers.has(g.role)) continue;
      const trigger = appendOnly.find((t) => sameTable(t.table, g.table));
      if (!trigger) continue;
      const key = `${g.file}\0${g.line}\0${g.table.schema ?? ''}.${g.table.name}`;
      const site = sites.get(key) ?? { grants: [], trigger };
      site.grants.push(g);
      sites.set(key, site);
    }
    const out: Hit[] = [];
    for (const { grants: list, trigger } of sites.values()) {
      const { file, line, table } = list[0]!;
      const role = [...new Set(list.map((g) => g.role))].join(', ');
      const privs = WRITE_PRIVILEGES.filter((p) => list.some((g) => g.priv === p));
      out.push({
        file,
        line,
        message: `Role \`${role}\` gets table-wide \`${privs.join(', ')}\` on append-only table \`${table.name}\` (${trigger.file}:${trigger.line}); ${advice(privs)}`,
        facts: { role, privileges: privs.join(', '), table: table.name },
      });
    }
    return out;
  },
};

export const securitySqlRules: ProjectRule[] = [sqlGrantAppendOnly];
