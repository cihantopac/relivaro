import type { Language } from '../core/types.js';
import type { Node, Tree } from './treesitter.js';

/**
 * Language-neutral helpers over tree-sitter syntax trees. Rules are written against these helpers so that the
 * same concept (a call, a string literal, a user-input source) is recognised consistently across JavaScript,
 * TypeScript, PHP and Python.
 */

export interface CallInfo {
  node: Node;
  /** Whitespace-free callee text, e.g. `db.query`, `DB::select`, `$pdo->query`, `subprocess.run`. */
  callee: string;
  /** Last segment of the callee (`query`, `select`, `run`). */
  name: string;
  /** Receiver text (`db`, `DB`, `$pdo`, `subprocess`), if any. */
  receiver?: string;
  /** Positional and keyword argument expression nodes in order. */
  args: Node[];
  /** Keyword / named arguments (Python `k=v`, PHP `name: v`). */
  kwargs: Map<string, Node>;
  isNew: boolean;
  /** JS tagged template call (sql`...`): the template is parameterised by the tag function. */
  tagged: boolean;
}

const CALL_TYPES: Record<Language, Set<string>> = {
  javascript: new Set(['call_expression', 'new_expression']),
  typescript: new Set(['call_expression', 'new_expression']),
  tsx: new Set(['call_expression', 'new_expression']),
  php: new Set([
    'function_call_expression',
    'member_call_expression',
    'nullsafe_member_call_expression',
    'scoped_call_expression',
    'object_creation_expression',
  ]),
  python: new Set(['call']),
};

export const FUNCTION_TYPES: Record<Language, Set<string>> = {
  javascript: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'generator_function_declaration',
    'function',
  ]),
  typescript: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'generator_function_declaration',
    'function',
  ]),
  tsx: new Set([
    'function_declaration',
    'function_expression',
    'arrow_function',
    'method_definition',
    'generator_function_declaration',
    'function',
  ]),
  php: new Set([
    'function_definition',
    'method_declaration',
    'anonymous_function',
    'arrow_function',
    'anonymous_function_creation_expression',
  ]),
  python: new Set(['function_definition', 'lambda']),
};

export const LOOP_TYPES: Record<Language, Set<string>> = {
  javascript: new Set(['for_statement', 'for_in_statement', 'while_statement', 'do_statement']),
  typescript: new Set(['for_statement', 'for_in_statement', 'while_statement', 'do_statement']),
  tsx: new Set(['for_statement', 'for_in_statement', 'while_statement', 'do_statement']),
  php: new Set(['for_statement', 'foreach_statement', 'while_statement', 'do_statement']),
  python: new Set(['for_statement', 'while_statement']),
};

export function isJs(lang: Language): boolean {
  return lang === 'javascript' || lang === 'typescript' || lang === 'tsx';
}

/** Depth-first pre-order traversal using a cursor (fast, no recursion). Return false from `visit` to skip children. */
export function walk(root: Node, visit: (n: Node) => unknown): void {
  const cursor = root.walk();
  let descend = true;
  for (;;) {
    if (descend) {
      const keep = visit(cursor.currentNode);
      if (keep !== false && cursor.gotoFirstChild()) continue;
    }
    if (cursor.gotoNextSibling()) {
      descend = true;
      continue;
    }
    if (!cursor.gotoParent()) break;
    if (cursor.nodeId === root.id) break;
    descend = false;
  }
  cursor.delete();
}

export function collect(root: Node, types: Set<string> | string): Node[] {
  const set = typeof types === 'string' ? new Set([types]) : types;
  const out: Node[] = [];
  walk(root, (n) => {
    if (set.has(n.type)) out.push(n);
  });
  return out;
}

export function line(n: Node): number {
  return n.startPosition.row + 1;
}

export function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

export function ancestors(n: Node): Node[] {
  const out: Node[] = [];
  let p = n.parent;
  while (p) {
    out.push(p);
    p = p.parent;
  }
  return out;
}

export function enclosing(n: Node, types: Set<string>): Node | null {
  let p = n.parent;
  while (p) {
    if (types.has(p.type)) return p;
    p = p.parent;
  }
  return null;
}

export function enclosingFunction(n: Node, lang: Language): Node | null {
  return enclosing(n, FUNCTION_TYPES[lang]);
}

/** The part of a loop that runs once per iteration (excludes `foreach ($items …)` / `for x of items` headers). */
function loopBody(loop: Node, lang: Language): Node | null {
  const body = loop.childForFieldName('body');
  if (body) return body;
  if (lang === 'php' && loop.type === 'foreach_statement') {
    const kids = loop.namedChildren.filter((c): c is Node => !!c);
    return kids[kids.length - 1] ?? null;
  }
  return null;
}

/** Loop whose body contains `n` without a function boundary in between. */
export function enclosingLoop(n: Node, lang: Language): Node | null {
  let p = n.parent;
  const loops = LOOP_TYPES[lang];
  const fns = FUNCTION_TYPES[lang];
  while (p) {
    if (loops.has(p.type)) {
      const body = loopBody(p, lang);
      const inBody = !body || (n.startIndex >= body.startIndex && n.endIndex <= body.endIndex);
      // `while (await next())` re-evaluates its condition each iteration; `for … of`/`foreach` headers run once.
      if (inBody || p.type === 'while_statement' || p.type === 'do_statement') return p;
    }
    if (fns.has(p.type)) {
      // `items.forEach(async (x) => …)` / `.map(async …)`: the callback body behaves like a loop body.
      const call = p.parent?.parent;
      if (isJs(lang) && call?.type === 'call_expression' && p.parent?.type === 'arguments') {
        const callee = call.childForFieldName('function');
        if (
          callee?.type === 'member_expression' &&
          /^(?:forEach|map|flatMap|reduce|filter|some|every)$/.test(
            callee.childForFieldName('property')?.text ?? '',
          )
        )
          return call;
      }
      return null;
    }
    p = p.parent;
  }
  return null;
}

export function calls(tree: Tree | Node, lang: Language): CallInfo[] {
  const root = 'rootNode' in tree ? tree.rootNode : tree;
  const out: CallInfo[] = [];
  const types = CALL_TYPES[lang];
  walk(root, (n) => {
    if (types.has(n.type)) {
      const info = callInfo(n, lang);
      if (info) out.push(info);
    }
  });
  return out;
}

export function callInfo(n: Node, lang: Language): CallInfo | null {
  let calleeNode: Node | null = null;
  let argsNode: Node | null = null;
  let isNew = false;
  let callee = '';
  let name = '';
  let receiver: string | undefined;
  if (isJs(lang)) {
    isNew = n.type === 'new_expression';
    calleeNode = n.childForFieldName(isNew ? 'constructor' : 'function');
    argsNode = n.childForFieldName('arguments');
    if (!calleeNode) return null;
    callee = compact(calleeNode.text).replace(/\?\./g, '.');
    if (calleeNode.type === 'member_expression') {
      name = calleeNode.childForFieldName('property')?.text ?? '';
      receiver = compact(calleeNode.childForFieldName('object')?.text ?? '');
    } else name = callee;
  } else if (lang === 'php') {
    argsNode =
      n.childForFieldName('arguments') ?? n.namedChildren.find((c) => c?.type === 'arguments') ?? null;
    if (n.type === 'function_call_expression') {
      calleeNode = n.childForFieldName('function');
      callee = compact(calleeNode?.text ?? '').replace(/^\\/, '');
      name = callee;
    } else if (n.type === 'object_creation_expression') {
      isNew = true;
      const cls = n.namedChildren.find((c) => c && (c.type === 'name' || c.type === 'qualified_name'));
      callee = compact(cls?.text ?? '').replace(/^\\/, '');
      name = callee.split('\\').pop() ?? callee;
    } else {
      const obj = n.childForFieldName(n.type === 'scoped_call_expression' ? 'scope' : 'object');
      name = n.childForFieldName('name')?.text ?? '';
      receiver = compact(obj?.text ?? '').replace(/^\\/, '');
      callee = `${receiver}${n.type === 'scoped_call_expression' ? '::' : '->'}${name}`;
    }
  } else {
    calleeNode = n.childForFieldName('function');
    argsNode = n.childForFieldName('arguments');
    if (!calleeNode) return null;
    callee = compact(calleeNode.text);
    if (calleeNode.type === 'attribute') {
      name = calleeNode.childForFieldName('attribute')?.text ?? '';
      receiver = compact(calleeNode.childForFieldName('object')?.text ?? '');
    } else name = callee;
  }
  const args: Node[] = [];
  const kwargs = new Map<string, Node>();
  if (argsNode?.type === 'template_string')
    return { node: n, callee, name, receiver, args: [argsNode], kwargs, isNew, tagged: true };
  if (argsNode) {
    for (const c of argsNode.namedChildren) {
      if (!c || c.type === 'comment') continue;
      if (lang === 'python' && c.type === 'keyword_argument') {
        const k = c.childForFieldName('name')?.text;
        const v = c.childForFieldName('value');
        if (k && v) kwargs.set(k, v);
        continue;
      }
      if (lang === 'php' && c.type === 'argument') {
        const nm = c.childForFieldName('name');
        const v = c.namedChildren.filter((x) => x && x.id !== nm?.id).pop();
        if (nm && v) {
          kwargs.set(nm.text, v);
          continue;
        }
        if (v) args.push(v);
        continue;
      }
      args.push(c);
    }
  }
  return { node: n, callee, name, receiver, args, kwargs, isNew, tagged: false };
}

/** True for a string literal with no interpolation (or a concatenation of such literals). */
export function isStaticString(n: Node | null | undefined, lang: Language): boolean {
  if (!n) return false;
  switch (n.type) {
    case 'string':
      if (lang === 'python') return !n.namedChildren.some((c) => c?.type === 'interpolation');
      return true;
    case 'template_string':
      return !n.namedChildren.some((c) => c?.type === 'template_substitution');
    case 'encapsed_string':
    case 'heredoc':
      return n.namedChildren.every(
        (c) =>
          !c ||
          c.type === 'string_content' ||
          c.type === 'escape_sequence' ||
          c.type === 'heredoc_start' ||
          c.type === 'heredoc_end' ||
          c.type === 'heredoc_body',
      );
    case 'nowdoc':
      return true;
    case 'concatenated_string':
      return n.namedChildren.every((c) => isStaticString(c, lang));
    case 'binary_expression':
    case 'binary_operator': {
      const op = n.childForFieldName('operator')?.text;
      if (op !== '+' && op !== '.') return false;
      return (
        isStaticString(n.childForFieldName('left'), lang) &&
        isStaticString(n.childForFieldName('right'), lang)
      );
    }
    case 'parenthesized_expression':
      return isStaticString(n.namedChildren[0], lang);
    default:
      return false;
  }
}

export function isLiteral(n: Node | null | undefined, lang: Language): boolean {
  if (!n) return false;
  if (isStaticString(n, lang)) return true;
  return /^(?:number|integer|float|true|false|null|none|boolean|undefined)$/.test(n.type);
}

/**
 * Builds a string dynamically from non-literal parts: template/f-string with substitutions, concatenation with a
 * non-literal operand, `%`/`.format()` formatting, PHP interpolated strings.
 */
export function isDynamicString(n: Node | null | undefined, lang: Language): boolean {
  if (!n) return false;
  switch (n.type) {
    case 'template_string':
      return n.namedChildren.some((c) => c?.type === 'template_substitution');
    case 'string':
      return lang === 'python' && n.namedChildren.some((c) => c?.type === 'interpolation');
    case 'encapsed_string':
    case 'heredoc':
      return !isStaticString(n, lang);
    case 'binary_expression':
    case 'binary_operator': {
      const op = n.childForFieldName('operator')?.text;
      const l = n.childForFieldName('left');
      const r = n.childForFieldName('right');
      if (op === '%' && lang === 'python') return isStaticString(l, lang) && !isLiteral(r, lang);
      if (op !== '+' && op !== '.') return false;
      const hasString = containsStringLiteral(l, lang) || containsStringLiteral(r, lang);
      return hasString && !(isLiteral(l, lang) && isLiteral(r, lang));
    }
    case 'call':
      if (lang === 'python') {
        const fn = n.childForFieldName('function');
        return (
          fn?.type === 'attribute' &&
          fn.childForFieldName('attribute')?.text === 'format' &&
          fn.childForFieldName('object')?.type === 'string'
        );
      }
      return false;
    case 'parenthesized_expression':
      return isDynamicString(n.namedChildren[0], lang);
    default:
      return false;
  }
}

function containsStringLiteral(n: Node | null | undefined, lang: Language): boolean {
  if (!n) return false;
  if (n.type === 'string' || n.type === 'template_string' || n.type === 'encapsed_string') return true;
  if (n.type === 'binary_expression' || n.type === 'binary_operator')
    return (
      containsStringLiteral(n.childForFieldName('left'), lang) ||
      containsStringLiteral(n.childForFieldName('right'), lang)
    );
  return false;
}

/** Text of a static string literal without quotes. */
export function stringValue(n: Node | null | undefined, lang: Language): string | undefined {
  if (!n || !isStaticString(n, lang)) return undefined;
  if (n.type === 'binary_expression' || n.type === 'binary_operator')
    return (
      (stringValue(n.childForFieldName('left'), lang) ?? '') +
      (stringValue(n.childForFieldName('right'), lang) ?? '')
    );
  if (n.type === 'concatenated_string')
    return n.namedChildren.map((c) => stringValue(c, lang) ?? '').join('');
  const parts = n.namedChildren.filter(
    (c) => c && (c.type === 'string_content' || c.type === 'string_fragment' || c.type === 'escape_sequence'),
  );
  if (parts.length) return parts.map((c) => c!.text).join('');
  // Single-quoted PHP strings and empty strings have no content child.
  return n.text.replace(/^[a-zA-Z]*(['"`]{1,3})([\s\S]*)\1$/, '$2');
}

// ---------------------------------------------------------------------------------------------------------------
// User-input sources and intra-procedural taint.

const JS_SOURCES = [
  /^(?:req|request|ctx\.request|ctx|context\.req)\.(?:query|body|params|headers|cookies|signedCookies|files?|url|originalUrl|path|hostname|ip)\b/,
  /^event\.(?:body|queryStringParameters|multiValueQueryStringParameters|pathParameters|headers)\b/,
  /\.searchParams\.get(?:All)?\(/,
  /^(?:await)?(?:req|request)\.(?:json|text|formData)\(\)/,
  /\bformData\.get(?:All)?\(/,
  /^(?:window\.|document\.)?location\.(?:search|hash|href|pathname)\b/,
  /^document\.(?:URL|documentURI|referrer|cookie)\b/,
  /^(?:useSearchParams\(\)|searchParams)\.get\(/,
];

const PHP_SOURCES = [
  /^\$_(?:GET|POST|REQUEST|COOKIE|FILES|SERVER)\b/,
  /^\$(?:this->)?request->(?:input|get|query|post|all|only|except|json|cookie|header|route(?=\(\s*['"$])|file|files|validated|safe|string|str|keys|collect|getContent|getQueryString|server|fullUrl|url|path)\(/,
  /^request\(\)->(?:input|get|query|post|all|only|except|json|cookie|header|route|file|validated|string|str|collect)\(/,
  /^request\(['"]/,
  /^Request::(?:input|get|query|post|all|only|except|json|cookie|header|route|file)\(/,
  /^Input::(?:get|all|only)\(/,
];

const PY_SOURCES = [
  /^(?:self\.)?request\.(?:args|form|values|json|data|files|cookies|headers|GET|POST|body|query_params|path_params|get_json|FILES|COOKIES|META|stream)\b/,
  /^(?:await)?request\.(?:json|form|body)\(\)/,
];

const SANITIZERS = new Set([
  // JS
  'parseInt',
  'parseFloat',
  'Number',
  'Boolean',
  'encodeURIComponent',
  'encodeURI',
  'escape',
  'escapeHtml',
  'DOMPurify.sanitize',
  'sanitize',
  'sanitizeHtml',
  'xss',
  'validator.escape',
  'path.basename',
  'basename',
  'mysql.escape',
  'connection.escape',
  'pool.escape',
  'sqlstring.escape',
  'SqlString.escape',
  'Prisma.sql',
  'sql',
  'z.parse',
  'Math.floor',
  'Math.round',
  'isNaN',
  'shellescape',
  'shellQuote.quote',
  'quote',
  // PHP
  'intval',
  'floatval',
  'boolval',
  'abs',
  'htmlspecialchars',
  'htmlentities',
  'e',
  'strip_tags',
  'escapeshellarg',
  'escapeshellcmd',
  'addslashes',
  'mysqli_real_escape_string',
  'filter_var',
  'filter_input',
  'urlencode',
  'rawurlencode',
  'is_numeric',
  'ctype_digit',
  'count',
  'strlen',
  'md5',
  'sha1',
  'hash',
  'json_encode',
  'Str::slug',
  'Str::limit',
  'preg_quote',
  'realpath',
  'route',
  'action',
  'to_route',
  // Python
  'int',
  'float',
  'bool',
  'len',
  'str.isdigit',
  'shlex.quote',
  'quote',
  'escape',
  'html.escape',
  'markupsafe.escape',
  'secure_filename',
  'werkzeug.utils.secure_filename',
  'os.path.basename',
  'uuid.UUID',
  'bleach.clean',
]);

const PHP_REQUEST_NON_INPUT =
  /^(?:user|session|route|method|isMethod|ip|ajax|wantsJson|expectsJson|has|filled|missing|boolean|integer|float|date|enum|hasFile|isJson|accepts|bearerToken|fingerprint|signature|validate)$/;

export function isSourceText(text: string, lang: Language): boolean {
  const t = compact(text);
  const pats = isJs(lang) ? JS_SOURCES : lang === 'php' ? PHP_SOURCES : PY_SOURCES;
  if (pats.some((p) => p.test(t))) return true;
  // Laravel dynamic request properties: `$request->email`.
  if (lang === 'php') {
    const m = /^\$(?:this->)?request->([A-Za-z_]\w*)$/.exec(t);
    if (m && !PHP_REQUEST_NON_INPUT.test(m[1]!)) return true;
  }
  return false;
}

/** Functions whose name says they validate/allowlist their input; their result is treated as checked. */
const VALIDATOR_NAME =
  /^(?:is_?)?(?:allowed|permitted|safe|trusted|whitelisted|allowlisted)\w*$|^(?:validate|sanitize|sanitise|check|verify|guard|assert|ensure|clean|escape|normalize)[A-Z_]\w*$|^(?:resolveInside|safeJoin|safe_join|secure_filename)\w*$/;

function isSanitizerCall(n: Node, lang: Language): boolean {
  if (lang === 'php' && n.type === 'cast_expression')
    return /\(\s*(?:int|integer|float|double|bool|boolean)\s*\)/.test(n.text);
  const info = CALL_TYPES[lang].has(n.type) ? callInfo(n, lang) : null;
  if (!info) return false;
  if (SANITIZERS.has(info.callee) || SANITIZERS.has(info.name) || VALIDATOR_NAME.test(info.name)) return true;
  if (
    lang === 'php' &&
    /^\$(?:this->)?request->(?:integer|boolean|float|date|enum|has|filled|boolean)$/.test(info.callee)
  )
    return true;
  return false;
}

/** Variables in `fn` that (transitively, within the function) hold user input. */
export function taintedNames(fn: Node | null, lang: Language): Set<string> {
  const tainted = new Set<string>();
  if (!fn) return tainted;
  // Framework handler parameters that are user input as a whole.
  for (let iter = 0; iter < 4; iter++) {
    const before = tainted.size;
    walk(fn, (n) => {
      if (n.id !== fn.id && FUNCTION_TYPES[lang].has(n.type) && !isJs(lang)) return false;
      const pair = assignmentParts(n, lang);
      if (!pair) return;
      const [target, value] = pair;
      if (value && isTaintedExpr(value, lang, tainted))
        for (const name of boundNames(target, lang)) tainted.add(name);
    });
    if (tainted.size === before) break;
  }
  return tainted;
}

function assignmentParts(n: Node, lang: Language): [Node, Node | null] | null {
  if (isJs(lang)) {
    if (n.type === 'variable_declarator') {
      const name = n.childForFieldName('name');
      return name ? [name, n.childForFieldName('value')] : null;
    }
    if (n.type === 'assignment_expression' || n.type === 'augmented_assignment_expression') {
      const l = n.childForFieldName('left');
      return l ? [l, n.childForFieldName('right')] : null;
    }
    if (n.type === 'for_in_statement') {
      const l = n.childForFieldName('left');
      return l ? [l, n.childForFieldName('right')] : null;
    }
  } else if (lang === 'php') {
    if (n.type === 'assignment_expression' || n.type === 'augmented_assignment_expression') {
      const l = n.childForFieldName('left');
      return l ? [l, n.childForFieldName('right')] : null;
    }
    if (n.type === 'foreach_statement') {
      const kids = n.namedChildren.filter((c): c is Node => !!c);
      const src = kids[0];
      const val = kids[kids.length - 2];
      return src && val && val !== src ? [val, src] : null;
    }
  } else {
    if (n.type === 'assignment' || n.type === 'augmented_assignment') {
      const l = n.childForFieldName('left');
      return l ? [l, n.childForFieldName('right')] : null;
    }
    if (n.type === 'for_statement') {
      const l = n.childForFieldName('left');
      return l ? [l, n.childForFieldName('right')] : null;
    }
  }
  return null;
}

function boundNames(target: Node, lang: Language): string[] {
  const out: string[] = [];
  if (target.type === 'identifier' || target.type === 'shorthand_property_identifier_pattern')
    return [target.text];
  if (lang === 'php' && target.type === 'variable_name') return [target.text];
  walk(target, (n) => {
    if (
      n.type === 'identifier' ||
      n.type === 'shorthand_property_identifier_pattern' ||
      (lang === 'php' && n.type === 'variable_name')
    ) {
      // Skip object-pattern keys (`{ x: y }` binds y, not x).
      if (n.parent?.type === 'pair_pattern' && n.parent.childForFieldName('key')?.id === n.id) return;
      out.push(n.text);
    }
    if (n.type === 'member_expression' || n.type === 'subscript_expression' || n.type === 'attribute') {
      out.push(compact(n.text));
      return false;
    }
  });
  return out;
}

/** True if the expression contains user input that is not passed through a sanitizer. */
export function isTaintedExpr(expr: Node | null | undefined, lang: Language, tainted: Set<string>): boolean {
  if (!expr) return false;
  let found = false;
  walk(expr, (n) => {
    if (found) return false;
    if (isSanitizerCall(n, lang)) return false;
    // Comparisons and type checks yield booleans, not the user's value.
    if (
      (n.type === 'binary_expression' || n.type === 'comparison_operator' || n.type === 'boolean_operator') &&
      /^(?:===|!==|==|!=|<|>|<=|>=|instanceof|in|not in|is|is not|<=>|and|or|&&|\|\|)$/.test(
        n.childForFieldName('operator')?.text ??
          n.children.find((c) => c && /^(?:==|!=|<|>|<=|>=|in|is|and|or)$/.test(c.type))?.text ??
          '',
      )
    )
      return n.childForFieldName('operator')?.text === '&&' ||
        n.childForFieldName('operator')?.text === '||' ||
        n.childForFieldName('operator')?.text === '??'
        ? undefined
        : false;
    if (n.type === 'unary_expression' && /^!/.test(n.text)) return false;
    if (n.type === 'ternary_expression' || n.type === 'conditional_expression') {
      // Only the branches carry a value; the condition does not.
      const branches =
        isJs(lang) || lang === 'php'
          ? [
              n.childForFieldName('consequence') ?? n.childForFieldName('body'),
              n.childForFieldName('alternative'),
            ]
          : [n.namedChildren[0], n.namedChildren[2]];
      if (branches.some((b) => b && isTaintedExpr(b, lang, tainted))) found = true;
      return false;
    }
    // Arguments to the key of a property read are not the value itself: `obj[userKey]` is still a lookup.
    if (n.type === 'identifier' || (lang === 'php' && n.type === 'variable_name')) {
      if (tainted.has(n.text) && !isPropertyName(n)) found = true;
      return;
    }
    if (
      n.type === 'member_expression' ||
      n.type === 'subscript_expression' ||
      n.type === 'attribute' ||
      n.type === 'call_expression' ||
      n.type === 'call' ||
      n.type === 'member_call_expression' ||
      n.type === 'member_access_expression' ||
      n.type === 'function_call_expression' ||
      n.type === 'scoped_call_expression' ||
      n.type === 'await_expression' ||
      n.type === 'variable_name'
    ) {
      if (isSourceText(n.text, lang)) {
        found = true;
        return false;
      }
      if (tainted.has(compact(n.text))) {
        found = true;
        return false;
      }
    }
  });
  return found;
}

function isPropertyName(n: Node): boolean {
  const p = n.parent;
  return !!p && (p.type === 'pair' || p.type === 'pair_pattern') && p.childForFieldName('key')?.id === n.id;
}

/** Convenience: is `expr` tainted in the context of its enclosing function (or the module for top-level code)? */
export function taintedAt(
  expr: Node | null | undefined,
  lang: Language,
  cache: Map<number, Set<string>>,
): boolean {
  if (!expr) return false;
  const fn = enclosingFunction(expr, lang) ?? rootOf(expr);
  let names = cache.get(fn.id);
  if (!names) {
    names = taintedNames(fn, lang);
    cache.set(fn.id, names);
  }
  return isTaintedExpr(expr, lang, names);
}

export function rootOf(n: Node): Node {
  let p: Node = n;
  while (p.parent) p = p.parent;
  return p;
}

/** Comments in the file, for inline suppressions. */
export function hasCommentContaining(root: Node, re: RegExp): boolean {
  let found = false;
  walk(root, (n) => {
    if (found) return false;
    if (n.type === 'comment' && re.test(n.text)) found = true;
  });
  return found;
}

export function functionName(fn: Node | null): string | undefined {
  if (!fn) return undefined;
  const nm = fn.childForFieldName('name');
  if (nm) return nm.text;
  const p = fn.parent;
  if (p?.type === 'variable_declarator') return p.childForFieldName('name')?.text;
  if (p?.type === 'pair') return p.childForFieldName('key')?.text;
  return undefined;
}

export function parameterNames(fn: Node | null, lang: Language): string[] {
  if (!fn) return [];
  const params = fn.childForFieldName('parameters') ?? fn.childForFieldName('parameter');
  if (!params) return [];
  if (params.type === 'identifier') return [params.text];
  const out: string[] = [];
  walk(params, (n) => {
    if (n.type === 'identifier' || (lang === 'php' && n.type === 'variable_name')) {
      out.push(n.text);
      return false;
    }
    if (n.type.includes('type')) return false;
  });
  return out;
}
