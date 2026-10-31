import { parse as parseYaml } from 'yaml';
import { RelivaroError } from '../core/errors.js';

/** OpenAPI 3.x / Swagger 2.0 structural validation and breaking-change detection between two versions. */

type Obj = Record<string, any>;

export interface SpecIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface ContractChange {
  kind: string;
  location: string;
  message: string;
  breaking: boolean;
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export function loadSpec(text: string, name = 'spec'): Obj {
  let doc: unknown;
  try {
    doc = /^\s*\{/.test(text) ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 100 });
  } catch (e) {
    throw new RelivaroError('PARSE_FAILED', `${name} is not valid JSON/YAML: ${(e as Error).message}`);
  }
  if (!doc || typeof doc !== 'object')
    throw new RelivaroError('PARSE_FAILED', `${name} is not an OpenAPI document.`);
  return doc as Obj;
}

function resolveRef(doc: Obj, ref: string): Obj | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let cur: any = doc;
  for (const seg of ref.slice(2).split('/')) {
    cur = cur?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
    if (cur === undefined) return undefined;
  }
  return cur;
}

function deref(doc: Obj, node: any, seen = new Set<string>()): any {
  if (node && typeof node === 'object' && typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) return {};
    seen.add(node.$ref);
    return deref(doc, resolveRef(doc, node.$ref) ?? {}, seen);
  }
  return node;
}

export function validateSpec(doc: Obj): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const add = (path: string, message: string, severity: SpecIssue['severity'] = 'error') =>
    issues.push({ path, message, severity });
  const v3 = typeof doc.openapi === 'string';
  const v2 = doc.swagger === '2.0';
  if (!v3 && !v2) add('$', 'Missing `openapi` (3.x) or `swagger: "2.0"` version field.');
  if (v3 && !/^3\.\d+\.\d+$/.test(doc.openapi))
    add('openapi', `Unsupported OpenAPI version "${doc.openapi}".`, 'warning');
  if (!doc.info?.title) add('info.title', 'Missing info.title.');
  if (!doc.info?.version) add('info.version', 'Missing info.version.');
  if (!doc.paths || typeof doc.paths !== 'object') add('paths', 'Missing paths object.');
  // All internal $refs must resolve.
  const walkRefs = (node: any, path: string, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 60) return;
    if (typeof node.$ref === 'string') {
      if (node.$ref.startsWith('#/') && resolveRef(doc, node.$ref) === undefined)
        add(path, `Unresolved $ref ${node.$ref}.`);
      return;
    }
    for (const [k, v] of Object.entries(node)) walkRefs(v, `${path}.${k}`, depth + 1);
  };
  walkRefs(doc, '$');
  const opIds = new Map<string, string>();
  const schemes = new Set(
    Object.keys((v3 ? doc.components?.securitySchemes : doc.securityDefinitions) ?? {}),
  );
  for (const [p, item] of Object.entries((doc.paths ?? {}) as Obj)) {
    if (!p.startsWith('/')) add(`paths.${p}`, 'Path must start with "/".');
    const templ = [...p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const pathLevel = ((item?.parameters ?? []) as any[]).map((x) => deref(doc, x));
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      const loc = `paths.${p}.${m}`;
      if (!op.responses || !Object.keys(op.responses).length) add(loc, 'Operation has no responses.');
      if (op.operationId) {
        if (opIds.has(op.operationId))
          add(loc, `Duplicate operationId "${op.operationId}" (also ${opIds.get(op.operationId)}).`);
        opIds.set(op.operationId, loc);
      }
      const params = [...pathLevel, ...((op.parameters ?? []) as any[]).map((x) => deref(doc, x))];
      for (const t of templ)
        if (!params.some((x) => x?.in === 'path' && x?.name === t))
          add(loc, `Path parameter {${t}} is not declared.`);
      for (const x of params) {
        if (!x?.name || !x?.in) add(loc, 'Parameter without name or in.');
        if (x?.in === 'path' && x.required !== true) add(loc, `Path parameter "${x.name}" must be required.`);
      }
      for (const req of (op.security ?? doc.security ?? []) as Obj[])
        for (const s of Object.keys(req))
          if (!schemes.has(s)) add(loc, `Security scheme "${s}" is not defined.`);
      if (!op.security && !doc.security && /^(?:post|put|patch|delete)$/.test(m) && schemes.size)
        add(loc, 'Write operation without security requirement.', 'warning');
    }
  }
  return issues;
}

function schemaType(s: any): string {
  if (!s || typeof s !== 'object') return 'any';
  if (s.type) return Array.isArray(s.type) ? s.type.join('|') : String(s.type);
  if (s.properties) return 'object';
  if (s.items) return 'array';
  if (s.oneOf || s.anyOf) return 'union';
  return 'any';
}

function compareSchemas(
  oldDoc: Obj,
  newDoc: Obj,
  a: any,
  b: any,
  loc: string,
  direction: 'request' | 'response',
  out: ContractChange[],
  depth = 0,
) {
  if (depth > 12) return;
  a = deref(oldDoc, a);
  b = deref(newDoc, b);
  if (!a || !b) return;
  const ta = schemaType(a);
  const tb = schemaType(b);
  if (
    ta !== 'any' &&
    tb !== 'any' &&
    ta !== tb &&
    !(ta === 'integer' && tb === 'number' && direction === 'request')
  ) {
    out.push({
      kind: 'type-changed',
      location: loc,
      message: `Type changed from ${ta} to ${tb}.`,
      breaking: true,
    });
    return;
  }
  if (Array.isArray(a.enum) && Array.isArray(b.enum)) {
    const removed = a.enum.filter((x: unknown) => !b.enum.includes(x));
    const added = b.enum.filter((x: unknown) => !a.enum.includes(x));
    if (removed.length)
      out.push({
        kind: 'enum-value-removed',
        location: loc,
        message: `Enum values removed: ${removed.join(', ')}.`,
        breaking: direction === 'request',
      });
    if (added.length)
      out.push({
        kind: 'enum-value-added',
        location: loc,
        message: `Enum values added: ${added.join(', ')}.`,
        breaking: direction === 'response',
      });
  }
  const pa = (a.properties ?? {}) as Obj;
  const pb = (b.properties ?? {}) as Obj;
  const ra = new Set<string>(a.required ?? []);
  const rb = new Set<string>(b.required ?? []);
  for (const k of Object.keys(pa)) {
    if (!(k in pb))
      out.push({
        kind: 'property-removed',
        location: `${loc}.${k}`,
        message: `Property "${k}" removed.`,
        breaking: direction === 'response',
      });
    else compareSchemas(oldDoc, newDoc, pa[k], pb[k], `${loc}.${k}`, direction, out, depth + 1);
  }
  for (const k of Object.keys(pb)) {
    if (!(k in pa))
      out.push({
        kind: 'property-added',
        location: `${loc}.${k}`,
        message: `Property "${k}" added${rb.has(k) ? ' as required' : ''}.`,
        breaking: direction === 'request' && rb.has(k),
      });
    else if (direction === 'request' && rb.has(k) && !ra.has(k))
      out.push({
        kind: 'property-became-required',
        location: `${loc}.${k}`,
        message: `Property "${k}" became required.`,
        breaking: true,
      });
    else if (direction === 'response' && ra.has(k) && !rb.has(k))
      out.push({
        kind: 'property-became-optional',
        location: `${loc}.${k}`,
        message: `Response property "${k}" is no longer guaranteed.`,
        breaking: true,
      });
  }
  if (a.items && b.items)
    compareSchemas(oldDoc, newDoc, a.items, b.items, `${loc}[]`, direction, out, depth + 1);
}

function bodySchema(doc: Obj, op: Obj, where: 'request' | 'response', status?: string): any {
  if (where === 'request') {
    const rb = deref(doc, op.requestBody);
    if (rb?.content)
      return rb.content['application/json']?.schema ?? Object.values(rb.content as Obj)[0]?.schema;
    const bodyParam = ((op.parameters ?? []) as any[])
      .map((p) => deref(doc, p))
      .find((p) => p?.in === 'body');
    return bodyParam?.schema;
  }
  const r = deref(doc, op.responses?.[status!]);
  if (r?.content) return r.content['application/json']?.schema ?? Object.values(r.content as Obj)[0]?.schema;
  return r?.schema;
}

export function diffSpecs(oldDoc: Obj, newDoc: Obj): ContractChange[] {
  const out: ContractChange[] = [];
  const oldPaths = (oldDoc.paths ?? {}) as Obj;
  const newPaths = (newDoc.paths ?? {}) as Obj;
  const norm = (p: string) => p.replace(/\{[^}]+\}/g, '{}');
  const newByNorm = new Map(Object.keys(newPaths).map((p) => [norm(p), p]));
  for (const [p, item] of Object.entries(oldPaths)) {
    const np = newPaths[p] ? p : newByNorm.get(norm(p));
    if (!np) {
      out.push({ kind: 'path-removed', location: p, message: `Path ${p} was removed.`, breaking: true });
      continue;
    }
    const nitem = newPaths[np];
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      const nop = nitem?.[m];
      const loc = `${m.toUpperCase()} ${p}`;
      if (!nop) {
        out.push({
          kind: 'operation-removed',
          location: loc,
          message: `${loc} was removed.`,
          breaking: true,
        });
        continue;
      }
      const params = (d: Obj, o: Obj, it: Obj) =>
        [...((it?.parameters ?? []) as any[]), ...((o.parameters ?? []) as any[])]
          .map((x) => deref(d, x))
          .filter((x) => x?.in !== 'body');
      const pa = params(oldDoc, op, item);
      const pb = params(newDoc, nop, nitem);
      for (const x of pb) {
        const prev = pa.find((y) => y.name === x.name && y.in === x.in);
        if (!prev && x.required)
          out.push({
            kind: 'required-parameter-added',
            location: loc,
            message: `New required ${x.in} parameter "${x.name}".`,
            breaking: true,
          });
        else if (!prev)
          out.push({
            kind: 'parameter-added',
            location: loc,
            message: `New optional ${x.in} parameter "${x.name}".`,
            breaking: false,
          });
        else {
          if (x.required && !prev.required)
            out.push({
              kind: 'parameter-became-required',
              location: loc,
              message: `${x.in} parameter "${x.name}" became required.`,
              breaking: true,
            });
          compareSchemas(
            oldDoc,
            newDoc,
            prev.schema ?? prev,
            x.schema ?? x,
            `${loc} ${x.in}:${x.name}`,
            'request',
            out,
          );
        }
      }
      for (const y of pa)
        if (!pb.some((x) => x.name === y.name && x.in === y.in))
          out.push({
            kind: 'parameter-removed',
            location: loc,
            message: `${y.in} parameter "${y.name}" removed.`,
            breaking: y.in === 'path',
          });
      const orb = deref(oldDoc, op.requestBody);
      const nrb = deref(newDoc, nop.requestBody);
      if (nrb?.required && !orb?.required)
        out.push({
          kind: 'request-body-became-required',
          location: loc,
          message: 'Request body became required.',
          breaking: true,
        });
      compareSchemas(
        oldDoc,
        newDoc,
        bodySchema(oldDoc, op, 'request'),
        bodySchema(newDoc, nop, 'request'),
        `${loc} request`,
        'request',
        out,
      );
      for (const status of Object.keys(op.responses ?? {})) {
        if (!(status in (nop.responses ?? {}))) {
          out.push({
            kind: 'response-removed',
            location: loc,
            message: `Response ${status} removed.`,
            breaking: /^2/.test(status),
          });
          continue;
        }
        if (/^2/.test(status))
          compareSchemas(
            oldDoc,
            newDoc,
            bodySchema(oldDoc, op, 'response', status),
            bodySchema(newDoc, nop, 'response', status),
            `${loc} ${status}`,
            'response',
            out,
          );
      }
      for (const status of Object.keys(nop.responses ?? {}))
        if (!(status in (op.responses ?? {})))
          out.push({
            kind: 'response-added',
            location: loc,
            message: `Response ${status} added.`,
            breaking: false,
          });
    }
    for (const m of METHODS)
      if (nitem?.[m] && !item?.[m])
        out.push({
          kind: 'operation-added',
          location: `${m.toUpperCase()} ${p}`,
          message: `${m.toUpperCase()} ${p} added.`,
          breaking: false,
        });
  }
  for (const p of Object.keys(newPaths))
    if (!oldPaths[p] && !Object.keys(oldPaths).some((o) => norm(o) === norm(p)))
      out.push({ kind: 'path-added', location: p, message: `Path ${p} added.`, breaking: false });
  return out;
}
