import type { Language } from '../core/types.js';
import {
  type CallInfo,
  callInfo,
  enclosingFunction,
  functionName,
  isJs,
  isLiteral,
  isStaticString,
  stringValue,
  walk,
} from '../parse/ast.js';
import type { Node } from '../parse/treesitter.js';

export const OWASP = {
  A01: 'A01:2025 Broken Access Control',
  A02: 'A02:2025 Security Misconfiguration',
  A03: 'A03:2025 Software Supply Chain Failures',
  A04: 'A04:2025 Cryptographic Failures',
  A05: 'A05:2025 Injection',
  A06: 'A06:2025 Insecure Design',
  A07: 'A07:2025 Authentication Failures',
  A08: 'A08:2025 Software or Data Integrity Failures',
  A09: 'A09:2025 Logging & Alerting Failures',
  A10: 'A10:2025 Mishandling of Exceptional Conditions',
} as const;

export const API = {
  API1: 'API1:2023 Broken Object Level Authorization',
  API3: 'API3:2023 Broken Object Property Level Authorization',
  API4: 'API4:2023 Unrestricted Resource Consumption',
  API7: 'API7:2023 Server Side Request Forgery',
  API8: 'API8:2023 Security Misconfiguration',
  API10: 'API10:2023 Unsafe Consumption of APIs',
} as const;

/** Expressions interpolated into a dynamic string (template substitutions, concatenated operands, f-string fields). */
export function dynamicParts(n: Node | null | undefined, lang: Language): Node[] {
  if (!n) return [];
  const out: Node[] = [];
  const visit = (x: Node | null | undefined) => {
    if (!x) return;
    switch (x.type) {
      case 'template_string':
        for (const c of x.namedChildren)
          if (c?.type === 'template_substitution' && c.namedChildren[0]) out.push(c.namedChildren[0]);
        return;
      case 'string':
        if (lang === 'python')
          for (const c of x.namedChildren)
            if (c?.type === 'interpolation' && c.namedChildren[0]) out.push(c.namedChildren[0]);
        return;
      case 'encapsed_string':
      case 'heredoc':
        for (const c of x.namedChildren)
          if (
            c &&
            c.type !== 'string_content' &&
            c.type !== 'escape_sequence' &&
            !c.type.startsWith('heredoc')
          )
            out.push(c);
        return;
      case 'binary_expression':
      case 'binary_operator': {
        const op = x.childForFieldName('operator')?.text;
        if (op === '+' || op === '.') {
          for (const side of [x.childForFieldName('left'), x.childForFieldName('right')]) {
            if (!side) continue;
            if (
              side.type === 'binary_expression' ||
              side.type === 'binary_operator' ||
              side.type === 'template_string' ||
              side.type === 'encapsed_string' ||
              side.type === 'string'
            )
              visit(side);
            else if (!isLiteral(side, lang)) out.push(side);
          }
        } else if (op === '%' && lang === 'python') {
          const r = x.childForFieldName('right');
          if (r && !isLiteral(r, lang)) out.push(r);
        }
        return;
      }
      case 'call': {
        const fn = x.childForFieldName('function');
        if (
          lang === 'python' &&
          fn?.type === 'attribute' &&
          fn.childForFieldName('attribute')?.text === 'format'
        )
          for (const a of x.childForFieldName('arguments')?.namedChildren ?? [])
            if (a) out.push(a.type === 'keyword_argument' ? (a.childForFieldName('value') ?? a) : a);
        return;
      }
      case 'parenthesized_expression':
        visit(x.namedChildren[0]);
        return;
      default:
        return;
    }
  };
  visit(n);
  return out;
}

const SAFE_PART_CALL =
  /^(?:parseInt|parseFloat|Number|String\(\w+\.length|encodeURIComponent|escapeshellarg|escapeshellcmd|intval|floatval|int|float|shlex\.quote|quote|PDO::quote|\$\w+->quote|mysqli_real_escape_string|addslashes|esc_sql|json_encode|JSON\.stringify|count|len|abs|Math\.\w+|\(int\)|\(float\))/;

/** A dynamic part is "safe" when it is a numeric literal, a constant-looking identifier, or wrapped in an escaping/casting call. */
export function isSafePart(part: Node, lang: Language): boolean {
  const t = part.text.trim();
  if (isLiteral(part, lang) || isConstantExpression(part, lang)) return true;
  if (/^[A-Z][A-Z0-9_]*$/.test(t) || /^(?:self|static)::[A-Z][A-Z0-9_]*$/.test(t)) return true;
  if (
    lang === 'php' &&
    part.type === 'cast_expression' &&
    /\(\s*(?:int|integer|float|double|bool)\s*\)/.test(t)
  )
    return true;
  if (SAFE_PART_CALL.test(t.replace(/\s+/g, ''))) return true;
  if (/\.(?:length|size|count)\s*$/.test(t)) return true;
  // `String(x).replace(/[^a-z0-9-]/g, '')`: allowlist filtering that removes markup and quote characters.
  if (/\.replace\(\s*\/\[\^[^\]<>"'&`]*\]\+?\/g\w*\s*,\s*(['"`])\1\s*\)$/.test(t)) return true;
  if ((part.type === 'identifier' || part.type === 'variable_name') && boundToLiteral(part, lang))
    return true;
  return false;
}

/**
 * Literal, template without substitutions, `[…literals].join(…)`, concatenation of those, a ternary whose two
 * branches are constant, number arithmetic over literals and `.length`/`.size`/`.count`, or
 * `CONST.map((x) => `…${x}…`).join(…)` over a constant array.
 */
export function isConstantExpression(n: Node | null | undefined, lang: Language): boolean {
  if (!n) return false;
  if (isLiteral(n, lang)) return true;
  if (n.type === 'parenthesized_expression') return isConstantExpression(n.namedChildren[0], lang);
  if (isNumericExpression(n)) return true;
  if (n.type === 'ternary_expression')
    return (
      isConstantExpression(n.childForFieldName('consequence'), lang) &&
      isConstantExpression(n.childForFieldName('alternative'), lang)
    );
  if (n.type === 'conditional_expression') {
    // PHP: fields `body`/`alternative`; Python: `<body> if <condition> else <alternative>` without field names.
    const body = n.childForFieldName('body') ?? (lang === 'python' ? n.namedChildren[0] : null);
    const alt = n.childForFieldName('alternative') ?? (lang === 'python' ? n.namedChildren[2] : null);
    return !!body && !!alt && isConstantExpression(body, lang) && isConstantExpression(alt, lang);
  }
  if (
    (n.type === 'binary_expression' || n.type === 'binary_operator') &&
    /^[.+]$/.test(n.childForFieldName('operator')?.text ?? '')
  )
    return (
      isConstantExpression(n.childForFieldName('left'), lang) &&
      isConstantExpression(n.childForFieldName('right'), lang)
    );
  if (n.type === 'array' || n.type === 'list' || n.type === 'array_creation_expression')
    return n.namedChildren.every(
      (c) =>
        !c ||
        c.type === 'comment' ||
        isConstantExpression(
          c.type === 'array_element_initializer' ? c.namedChildren[c.namedChildren.length - 1] : c,
          lang,
        ),
    );
  if (n.type === 'call_expression') {
    const fn = n.childForFieldName('function');
    if (fn?.type === 'member_expression' && fn.childForFieldName('property')?.text === 'join') {
      const obj = fn.childForFieldName('object');
      return isConstantExpression(obj, lang) || isConstantMap(obj, lang);
    }
  }
  return false;
}

/** Number literals, `.length`/`.size`/`.count` and `+ - * /` arithmetic over them: never a string to inject. */
function isNumericExpression(n: Node | null | undefined): boolean {
  if (!n) return false;
  if (n.type === 'number' || n.type === 'integer' || n.type === 'float') return true;
  if (n.type === 'parenthesized_expression') return isNumericExpression(n.namedChildren[0]);
  if (n.type === 'member_expression')
    return /^(?:length|size|count)$/.test(n.childForFieldName('property')?.text ?? '');
  if (n.type === 'binary_expression' || n.type === 'binary_operator') {
    if (!/^[-+*/]$/.test(n.childForFieldName('operator')?.text ?? '')) return false;
    const l = n.childForFieldName('left');
    const r = n.childForFieldName('right');
    return isNumericExpression(l) && isNumericExpression(r);
  }
  return false;
}

/** `X.map((c) => `"${c}"`)` where `X` is a constant array and the callback only formats its own parameter. */
function isConstantMap(n: Node | null | undefined, lang: Language): boolean {
  if (n?.type !== 'call_expression') return false;
  const fn = n.childForFieldName('function');
  if (fn?.type !== 'member_expression' || fn.childForFieldName('property')?.text !== 'map') return false;
  const recv = fn.childForFieldName('object');
  if (
    !recv ||
    !(
      isConstantExpression(recv, lang) ||
      (recv.type === 'identifier' && (/^[A-Z][A-Z0-9_]*$/.test(recv.text) || boundToLiteral(recv, lang)))
    )
  )
    return false;
  const args = n.childForFieldName('arguments')?.namedChildren.filter((c) => c && c.type !== 'comment') ?? [];
  const cb = args[0];
  if (args.length !== 1 || cb?.type !== 'arrow_function') return false;
  const params = cb.childForFieldName('parameters');
  const single = cb.childForFieldName('parameter');
  const names = single
    ? [single.text]
    : (params?.namedChildren ?? []).map((p) => (p?.childForFieldName('pattern') ?? p)?.text ?? '');
  if (names.length !== 1 || !/^[A-Za-z_$][\w$]*$/.test(names[0]!)) return false;
  const param = names[0]!;
  const body = cb.childForFieldName('body');
  const formatsParam = (e: Node | null | undefined): boolean => {
    if (!e) return false;
    if (e.type === 'identifier') return e.text === param;
    if (isLiteral(e, lang)) return true;
    if (e.type === 'parenthesized_expression') return formatsParam(e.namedChildren[0]);
    if (e.type === 'template_string')
      return e.namedChildren.every(
        (c) => c?.type !== 'template_substitution' || formatsParam(c.namedChildren[0]),
      );
    if (e.type === 'binary_expression' && e.childForFieldName('operator')?.text === '+')
      return formatsParam(e.childForFieldName('left')) && formatsParam(e.childForFieldName('right'));
    return false;
  };
  return formatsParam(body);
}

/** `const limit = 50` / `$table = 'users'` / `$cond = cond ? 'a' : 'b'`: every assignment in scope is a constant. */
function boundToLiteral(id: Node, lang: Language): boolean {
  const name = id.text;
  let scope: Node | null = id.parent;
  while (scope && !FUNCTION_SCOPE.has(scope.type) && scope.parent) scope = scope.parent;
  for (let s: Node | null = scope; s; s = s.parent) {
    let allConstant = true;
    let assignments = 0;
    walk(s, (n) => {
      if (n.id !== s.id && FUNCTION_SCOPE.has(n.type)) return false;
      if (n.type === 'variable_declarator' && n.childForFieldName('name')?.text === name) {
        assignments++;
        if (!isConstantExpression(n.childForFieldName('value'), lang)) allConstant = false;
      } else if (
        (n.type === 'assignment_expression' ||
          n.type === 'assignment' ||
          n.type === 'augmented_assignment_expression') &&
        n.childForFieldName('left')?.text === name
      ) {
        assignments++;
        if (n.type.startsWith('augmented') || !isConstantExpression(n.childForFieldName('right'), lang))
          allConstant = false;
      }
    });
    if (assignments) return allConstant;
    if (!s.parent) break;
  }
  return false;
}

const FUNCTION_SCOPE = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'method_definition',
  'function_definition',
  'method_declaration',
  'anonymous_function',
  'program',
  'module',
]);

export function unsafeDynamicParts(n: Node | null | undefined, lang: Language): Node[] {
  return dynamicParts(n, lang).filter((p) => !isSafePart(p, lang));
}

/** Key/value pairs of an object/array/dict literal (JS object, PHP array, Python dict) plus Python kwargs. */
export function pairs(n: Node | null | undefined): { key: string; value: Node; node: Node }[] {
  if (!n) return [];
  const out: { key: string; value: Node; node: Node }[] = [];
  for (const c of n.namedChildren) {
    if (!c) continue;
    if (c.type === 'pair') {
      const k = c.childForFieldName('key');
      const v = c.childForFieldName('value');
      if (k && v) out.push({ key: k.text.replace(/^['"`]|['"`]$/g, ''), value: v, node: c });
    } else if (c.type === 'array_element_initializer') {
      const kids = c.namedChildren.filter((x): x is Node => !!x);
      if (kids.length === 2)
        out.push({ key: kids[0]!.text.replace(/^['"]|['"]$/g, ''), value: kids[1]!, node: c });
    } else if (c.type === 'keyword_argument') {
      const k = c.childForFieldName('name');
      const v = c.childForFieldName('value');
      if (k && v) out.push({ key: k.text, value: v, node: c });
    } else if (c.type === 'shorthand_property_identifier') {
      out.push({ key: c.text, value: c, node: c });
    }
  }
  return out;
}

export function objectArg(info: CallInfo, index: number): Node | undefined {
  const a = info.args[index];
  return a && /^(?:object|array_creation_expression|dictionary)$/.test(a.type) ? a : undefined;
}

export function pairValue(obj: Node | null | undefined, key: string): Node | undefined {
  return pairs(obj).find((p) => p.key === key)?.value;
}

/** Name that best describes what a value is used for: assigned variable, property key, or enclosing function name. */
export function purposeName(n: Node, lang: Language): string {
  let p: Node | null = n.parent;
  for (let depth = 0; p && depth < 6; depth++, p = p.parent) {
    if (p.type === 'variable_declarator') return p.childForFieldName('name')?.text ?? '';
    if (
      p.type === 'assignment_expression' ||
      p.type === 'assignment' ||
      p.type === 'augmented_assignment_expression'
    )
      return p.childForFieldName('left')?.text ?? '';
    if (p.type === 'pair' || p.type === 'keyword_argument')
      return (p.childForFieldName('key') ?? p.childForFieldName('name'))?.text ?? '';
    if (p.type === 'array_element_initializer') return p.namedChildren[0]?.text ?? '';
    if (p.type === 'return_statement') return functionName(enclosingFunction(p, lang)) ?? '';
  }
  return functionName(enclosingFunction(n, lang)) ?? '';
}

export const SECRET_PURPOSE =
  /(?:token|secret|password|passwd|otp|nonce|salt|api_?key|apikey|session|csrf|reset|verif|invite|auth|credential|private|signature)/i;

export function isFalse(n: Node | null | undefined): boolean {
  return !!n && /^(?:false|False|FALSE|0)$/.test(n.text.trim());
}

export function isTrue(n: Node | null | undefined): boolean {
  return !!n && /^(?:true|True|TRUE|1)$/.test(n.text.trim());
}

/** Does the file import/require one of the given modules? Cheap text check used to disambiguate callee names. */
export function importsModule(source: string, modules: string[]): boolean {
  return modules.some((m) => {
    const q = m.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return new RegExp(
      `(?:from\\s+['"]${q}['"]|require\\(\\s*['"]${q}['"]\\s*\\)|import\\s+['"]${q}['"]|import\\(\\s*['"]${q}['"]\\s*\\))`,
    ).test(source);
  });
}

export function staticArg(info: CallInfo, i: number, lang: Language): string | undefined {
  return stringValue(info.args[i], lang);
}

export function firstArgIsStatic(info: CallInfo, lang: Language): boolean {
  return isStaticString(info.args[0], lang);
}

export function containsCall(root: Node, lang: Language, pred: (c: CallInfo) => boolean): boolean {
  let found = false;
  walk(root, (n) => {
    if (found) return false;
    const c = /call|new_expression|object_creation/.test(n.type) ? callInfo(n, lang) : null;
    if (c && pred(c)) found = true;
  });
  return found;
}

export function isJsLang(lang: Language): boolean {
  return isJs(lang);
}
