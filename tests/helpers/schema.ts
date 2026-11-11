/**
 * A small JSON Schema subset checker for pinning the shipped schemas against real output without adding a
 * dependency. Supported: `type` (string or list), `required`, `properties`, `additionalProperties` (boolean or
 * schema), `items`, `enum`, `const`, `minimum`, `anyOf` and `$ref` to `#/$defs/<name>` within the same document.
 * Unknown keywords are ignored, so a schema may still carry `description`, `$id` and the like.
 */
export interface Schema {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  anyOf?: Schema[];
  $ref?: string;
  $defs?: Record<string, Schema>;
  [k: string]: unknown;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(actual: string, wanted: string): boolean {
  return actual === wanted || (wanted === 'number' && actual === 'integer');
}

/** Returns one message per violation, each prefixed with its JSON path; an empty list means valid. */
export function validate(value: unknown, schema: Schema, root: Schema = schema, path = '$'): string[] {
  if (schema.$ref) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m ? root.$defs?.[m[1]!] : undefined;
    if (!target) return [`${path}: unresolved $ref ${schema.$ref}`];
    return validate(value, target, root, path);
  }
  const errors: string[] = [];
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validate(value, s, root, path).length === 0);
    if (!ok) errors.push(`${path}: matches none of anyOf`);
  }
  const actual = typeOf(value);
  if (schema.type !== undefined) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wanted.some((w) => typeMatches(actual, w))) {
      errors.push(`${path}: expected ${wanted.join('|')}, got ${actual}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => e === value))
    errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if ('const' in schema && schema.const !== value)
    errors.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum)
    errors.push(`${path}: ${value} < minimum ${schema.minimum}`);
  if (actual === 'object') {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in obj)) errors.push(`${path}: missing required "${k}"`);
    for (const [k, v] of Object.entries(obj)) {
      const p = `${path}.${k}`;
      const prop = schema.properties?.[k];
      if (prop) errors.push(...validate(v, prop, root, p));
      else if (schema.additionalProperties === false) errors.push(`${p}: additional property not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        errors.push(...validate(v, schema.additionalProperties, root, p));
    }
  }
  if (actual === 'array' && schema.items)
    (value as unknown[]).forEach((v, i) => {
      errors.push(...validate(v, schema.items!, root, `${path}[${i}]`));
    });
  return errors;
}
