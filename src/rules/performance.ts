import type { Language } from '../core/types.js';
import {
  type CallInfo,
  callInfo,
  collect,
  compact,
  enclosingFunction,
  enclosingLoop,
  functionName,
  isJs,
  parameterNames,
  stringValue,
  walk,
} from '../parse/ast.js';
import type { Node } from '../parse/treesitter.js';
import { API, isConstantExpression } from './helpers.js';
import { ALL_LANGS, type AstRule, type Hit, JS_LANGS } from './types.js';

const JS_DB_ROOT =
  /^(?:this\.)?(?:prisma|db|database|knex|sql|pool|client|conn|connection|repo|repository|\w+Repository|\w+Repo|model|redis|cache|supabase|mongoose|collection|em|entityManager|dataSource|tx|trx|drizzle|sequelize|\w+Model|\w+Service|api|http|axios)\b/;
const JS_DB_METHOD =
  /^(?:findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|findOne|findById|findAll|findByPk|findOneBy|findBy|countDocuments|aggregate|query|execute|\$queryRaw|\$executeRaw|raw|upsert|create|update|delete|insert|select|save|get|set|hget|exists)$/;
const ORM_FIND =
  /^(?:findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|findOne|findById|findAll|findByPk|findOneBy|findBy|countDocuments|aggregate|query)$/;

const PHP_FACADES =
  /^(?:Str|Arr|Carbon|CarbonImmutable|Cache|Log|Config|Http|Storage|Collection|Validator|Auth|Gate|Hash|Crypt|Session|Lang|URL|Route|View|Event|Queue|Mail|Notification|Response|Request|File|Date|Number|Js|App|Artisan|Bus|Cookie|Process|RateLimiter|Redirect|Schema|Blade|Broadcast|Password|Vite|Sleep|Context|Concurrency|Pipeline|Illuminate|parent|self|static|Inertia|Livewire|Filament|Notification|Exception|DateTime|DateTimeImmutable|Uuid|Ulid|Money|Carbon\\\w+)$/;
const PHP_QUERY_TERMINAL =
  /^(?:get|first|firstOrFail|firstWhere|find|findOrFail|findMany|count|exists|doesntExist|sum|avg|max|min|pluck|paginate|simplePaginate|cursorPaginate|value|sole|update|delete|increment|decrement|insert|create|firstOrCreate|updateOrCreate)$/;

const NOT_RELATIONSHIP =
  /^(?:toArray|get|all|values|keys|collect|fresh|refresh|errors|messages|getMessages|failed|items|toBase|getCollection|lazy|cursor|sortBy|filter|map|unique|flatten|reverse|session|user|attributes|getAttributes|getChanges|getDirty|jsonSerialize|toJson)$/;

function phpQueryInLoop(c: CallInfo): string | null {
  // Model::find($id) / Model::where(...)->first() / DB::table(...)->get() / $item->relation()->get()
  if (/^DB::(?:table|select|selectOne|insert|update|delete|statement|scalar)$/.test(c.callee))
    return c.callee;
  if (/::/.test(c.callee) && !c.node.parent?.type.includes('member_call')) {
    const scope = c.receiver ?? '';
    if (
      /^[A-Z]\w*$/.test(scope) &&
      !PHP_FACADES.test(scope) &&
      /^(?:find|findOrFail|findMany|where\w*|first|firstWhere|all|create|firstOrCreate|updateOrCreate|count|exists|query|with|whereIn)$/.test(
        c.name,
      )
    )
      return c.callee;
  }
  if (c.node.type === 'member_call_expression' && PHP_QUERY_TERMINAL.test(c.name)) {
    // Walk down the receiver chain.
    let obj = c.node.childForFieldName('object');
    while (
      obj &&
      (obj.type === 'member_call_expression' ||
        obj.type === 'scoped_call_expression' ||
        obj.type === 'nullsafe_member_call_expression')
    ) {
      if (obj.type === 'scoped_call_expression') {
        const scope = obj.childForFieldName('scope')?.text ?? '';
        if (/^[A-Z]\w*$/.test(scope) && !PHP_FACADES.test(scope)) return compact(c.node.text).slice(0, 60);
        if (scope === 'DB') return compact(c.node.text).slice(0, 60);
        return null;
      }
      // `$post->comments()->get()`: relationship method with no args returns a query builder.
      const inner = obj.childForFieldName('object');
      const args = obj.childForFieldName('arguments');
      if (
        inner?.type === 'variable_name' &&
        args &&
        args.namedChildren.length === 0 &&
        /^[a-z]\w*$/.test(obj.childForFieldName('name')?.text ?? '') &&
        !NOT_RELATIONSHIP.test(obj.childForFieldName('name')?.text ?? '') &&
        !/^\$(?:validator|errors|bag|page|response|collection|items|request)$/.test(inner.text)
      )
        return compact(c.node.text).slice(0, 60);
      obj = inner;
    }
  }
  return null;
}

/** At most this many literal elements make a bounded loop; a longer literal list is a data table. */
const SHORT_LITERAL_LIST = 10;

/** `for (const k of ['a', 'b'])`, `['a', 'b'].forEach(…)`, `for k in ('a', 'b'):` over at most 10 constants. */
function overShortLiteralList(loop: Node, lang: Language): boolean {
  let iter: Node | null = null;
  if (loop.type === 'for_in_statement' || (lang === 'python' && loop.type === 'for_statement'))
    iter = loop.childForFieldName('right');
  else if (loop.type === 'call_expression') {
    const fn = loop.childForFieldName('function');
    if (fn?.type === 'member_expression' && fn.childForFieldName('property')?.text === 'forEach')
      iter = fn.childForFieldName('object');
  }
  while (iter?.type === 'parenthesized_expression') iter = iter.namedChildren[0] ?? null;
  if (!iter || !/^(?:array|list|tuple)$/.test(iter.type)) return false;
  const els = iter.namedChildren.filter((e): e is Node => !!e && e.type !== 'comment');
  return els.length <= SHORT_LITERAL_LIST && els.every((e) => isConstantExpression(e, lang));
}

const queryInLoop: AstRule = {
  kind: 'ast',
  id: 'perf/query-in-loop',
  title: 'Database or network call inside a loop (N+1)',
  category: 'performance',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-1050'],
  owasp: [API.API4],
  description: 'A query or remote call is executed once per loop iteration.',
  impact:
    'Latency and database load grow linearly with the number of items (N+1 queries): fine in development, slow pages and exhausted connection pools in production.',
  recommendation:
    'Load related data in one query (eager loading `with()`, `include`, `select_related`/`prefetch_related`, `WHERE id IN (...)`), batch writes (`createMany`, `insert`, `bulk_create`), or run independent calls concurrently with a bounded pool.',
  verification:
    'Count queries for the code path in a test (query log, `DB::getQueryLog`, `assertNumQueries`, Prisma query events) with 1 vs. 50 items; the count must stay constant.',
  check(ctx) {
    // Tests run a handful of fixed iterations against a test database: not a production N+1.
    if (ctx.file.isTest) return [];
    const out: Hit[] = [];
    const lang = ctx.lang;
    const reported = new Set<number>();
    for (const c of ctx.calls) {
      const loop = enclosingLoop(c.node, lang);
      if (!loop || overShortLiteralList(loop, lang)) continue;
      let what: string | null = null;
      if (isJs(lang)) {
        const awaited = c.node.parent?.type === 'await_expression';
        if (!awaited) continue;
        const isCallbackLoop = loop.type === 'call_expression';
        const callbackKind = isCallbackLoop ? (callInfo(loop, lang)?.name ?? '') : '';
        const dbLike = ORM_FIND.test(c.name) || (JS_DB_ROOT.test(c.callee) && JS_DB_METHOD.test(c.name));
        const http = c.callee === 'fetch' || /^axios/.test(c.callee);
        if (isCallbackLoop) {
          // Callbacks run concurrently: only repeated ORM lookups are N+1 problems there.
          if (dbLike && ORM_FIND.test(c.name) && callbackKind !== 'reduce') what = c.callee;
        } else if (dbLike || http) what = c.callee;
      } else if (lang === 'php') {
        what = phpQueryInLoop(c);
        if (what && c.node.parent && /member_call|nullsafe/.test(c.node.parent.type)) continue;
      } else {
        if (
          /\.objects\.(?:get|create|get_or_create|update_or_create)$/.test(c.callee) ||
          /\.objects\.[\s\S]*\.(?:first|last|count|exists|get|values_list|update|delete)$/.test(c.callee)
        )
          what = c.callee;
        else if (
          /^(?:self\.)?(?:session|db\.session|cursor|conn|connection)\.(?:execute|query|get|scalar|scalars)$/.test(
            c.callee,
          )
        )
          what = c.callee;
        if (what && c.node.parent?.type === 'attribute') continue;
      }
      if (!what) continue;
      // Report once per loop + callee to avoid duplicate chained calls.
      const key = loop.id * 31 + what.length;
      if (reported.has(key)) continue;
      reported.add(key);
      // Seeders, console commands and scripts run offline: N+1 there costs time, not user latency.
      const offline =
        /(?:^|\/)(?:database\/(?:seeders|factories)|routes\/console\.php|app\/Console|scripts?|tools?|bin|management\/commands)\//.test(
          ctx.file.path,
        ) || /(?:^|\/)routes\/console\.php$/.test(ctx.file.path);
      out.push({
        node: c.node,
        message: `\`${what}\` runs on every iteration of the enclosing loop (line ${loop.startPosition.row + 1}).`,
        facts: { call: what },
        ...(offline ? { severity: 'low' as const, confidence: 'low' as const } : {}),
      });
    }
    return out;
  },
};

const inefficientCount: AstRule = {
  kind: 'ast',
  id: 'perf/load-all-to-count',
  title: 'Rows loaded into memory only to count or test them',
  category: 'performance',
  severity: 'medium',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-1046'],
  owasp: [API.API4],
  description:
    'All matching rows are fetched and hydrated just to count them, check emptiness or take the first one (`->get()->count()`, `::all()->count()`, `len(qs)`, `(await findMany()).length`).',
  impact: 'Memory and query time grow with table size; large tables cause timeouts and out-of-memory errors.',
  recommendation:
    'Let the database do it: `->count()`, `->exists()`, `->first()`, `qs.count()`/`qs.exists()`, `prisma.x.count()`.',
  verification:
    'Inspect the generated SQL (query log) — it must be `SELECT COUNT(*)`/`EXISTS` instead of selecting all columns.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      if (
        lang === 'php' &&
        /^(?:count|isEmpty|isNotEmpty|first)$/.test(c.name) &&
        c.node.type === 'member_call_expression'
      ) {
        const obj = c.node.childForFieldName('object');
        const inner = obj ? callInfo(obj, lang) : null;
        if (!inner) continue;
        const loadsAll =
          (inner.name === 'get' && inner.args.length === 0 && /->|::/.test(inner.callee)) ||
          (inner.name === 'all' &&
            /::all$/.test(inner.callee) &&
            /^[A-Z]/.test(inner.receiver ?? '') &&
            !PHP_FACADES.test(inner.receiver ?? ''));
        if (!loadsAll) continue;
        // `$request->get()` / collections built in memory are not queries.
        if (/^\$(?:request|this->request|collection|items|data)\b/.test(inner.receiver ?? '')) continue;
        const fixable = c.name === 'count' && c.args.length === 0;
        out.push({
          node: c.node,
          message: `\`${compact(c.node.text).slice(0, 70)}\` loads every row to call \`${c.name}()\`.`,
          fixer: fixable ? 'php-count-query' : null,
        });
      } else if (
        lang === 'php' &&
        c.callee === 'count' &&
        c.args[0] &&
        /(?:->get\(\)|::all\(\))$/.test(compact(c.args[0].text))
      ) {
        out.push({
          node: c.node,
          message: `\`${compact(c.node.text).slice(0, 70)}\` loads every row to count it.`,
        });
      } else if (
        lang === 'python' &&
        c.callee === 'len' &&
        c.args[0] &&
        /\.objects\.(?:all|filter|exclude)\(/.test(c.args[0].text) &&
        !/\.(?:values_list|values)\(/.test(c.args[0].text)
      ) {
        out.push({
          node: c.node,
          message: `\`${compact(c.node.text).slice(0, 70)}\` evaluates the whole queryset to count it.`,
          fixer: 'py-queryset-count',
        });
      }
    }
    if (isJs(lang))
      walk(ctx.tree.rootNode, (n) => {
        if (n.type !== 'member_expression' || n.childForFieldName('property')?.text !== 'length') return;
        const obj = n.childForFieldName('object');
        const inner = obj?.type === 'parenthesized_expression' ? obj.namedChildren[0] : null;
        if (inner?.type === 'await_expression' && /\.(?:findMany|find|findAll)\(/.test(inner.text))
          out.push({
            node: n,
            message: `\`${compact(n.text).slice(0, 70)}\` loads all records only to count them.`,
          });
      });
    return out;
  },
};

const unboundedQuery: AstRule = {
  kind: 'ast',
  id: 'perf/unbounded-query',
  title: 'Unbounded query in request path',
  category: 'performance',
  severity: 'low',
  confidence: 'medium',
  languages: [...JS_LANGS, 'php'],
  cwe: ['CWE-770'],
  owasp: [API.API4],
  description:
    'A request handler loads an entire table (`Model::all()`, `findMany()` without `take`) without pagination or a limit.',
  impact:
    'Response time and memory grow without bound as data grows; a single request can exhaust the server (OWASP API4:2023 Unrestricted Resource Consumption).',
  recommendation:
    'Paginate (`paginate()`, `cursorPaginate()`, `take`/`skip`, cursor-based pagination) or apply an explicit upper limit.',
  verification:
    'Seed a large table in a test environment and confirm the endpoint returns a bounded page quickly.',
  check(ctx) {
    if (!ctx.serverSide) return [];
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      if (ctx.lang === 'php') {
        if (
          c.name !== 'all' ||
          !/::all$/.test(c.callee) ||
          !/^[A-Z]\w*$/.test(c.receiver ?? '') ||
          PHP_FACADES.test(c.receiver ?? '')
        )
          continue;
        if (!/(?:Controller|Http\/|Livewire|Resources)/.test(ctx.file.path)) continue;
        if (c.node.parent?.type === 'member_call_expression') continue;
        out.push({ node: c.node, message: `\`${c.callee}()\` loads the whole table in request code.` });
      } else if (c.name === 'findMany' && /prisma|db|tx/.test(c.receiver ?? '')) {
        const arg = c.args[0];
        if (arg && /\b(?:take|first|cursor)\s*:/.test(arg.text)) continue;
        if (arg && /\bwhere\s*:/.test(arg.text)) continue;
        out.push({
          node: c.node,
          message: `\`${c.callee}()\` without \`take\` or a filter returns every row.`,
          confidence: 'low',
        });
      }
    }
    return out;
  },
};

const ROUTE_EXPORT =
  /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|loader|action|getServerSideProps|handler|middleware)$/;

function isRequestHandler(fn: Node, lang: Parameters<typeof enclosingFunction>[1], source: string): boolean {
  const params = parameterNames(fn, lang);
  if (params.some((p) => /^(?:req|request|res|response|reply)$/.test(p))) return true;
  if (
    params.some((p) => /^(?:ctx|c|context)$/.test(p)) &&
    /from\s+['"](?:koa|hono|@hapi\/hapi|@oak|elysia)['"]/.test(source)
  )
    return true;
  const name = functionName(fn);
  if (name && ROUTE_EXPORT.test(name)) return true;
  // app.get('/x', (…) => …)
  const call = fn.parent?.parent;
  if (call?.type === 'call_expression') {
    const info = callInfo(call, lang);
    if (
      info &&
      /^(?:get|post|put|patch|delete|all|use|route|handle)$/.test(info.name) &&
      /^(?:app|router|server|fastify|api|r)$/.test(info.receiver ?? '')
    )
      return true;
  }
  return false;
}

const syncIo: AstRule = {
  kind: 'ast',
  id: 'perf/sync-io-in-request-handler',
  title: 'Blocking synchronous I/O in a request handler',
  category: 'performance',
  severity: 'medium',
  confidence: 'medium',
  languages: JS_LANGS,
  cwe: ['CWE-1050'],
  description:
    'A request handler uses synchronous file system or child-process APIs (`readFileSync`, `execSync`, …).',
  impact:
    'Synchronous calls block the Node.js event loop: every concurrent request waits, so throughput collapses under load.',
  recommendation:
    'Use the async variants (`fs.promises.readFile`, `execFile` with `await`), or move the work to startup/caching.',
  verification:
    'Load-test the endpoint (`relivaro load`) before and after; p95 latency under concurrency must improve.',
  check(ctx) {
    if (!ctx.serverSide || /(?:^|\/)(?:cli|bin|scripts?|tools?|commands?)\//.test(ctx.file.path)) return [];
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      if (
        !/Sync$/.test(c.name) ||
        !/^(?:fs|fse|child_process|cp|zlib|crypto)\.|^(?:readFileSync|writeFileSync|existsSync|readdirSync|statSync|execSync|spawnSync|mkdirSync|appendFileSync|copyFileSync|unlinkSync|pbkdf2Sync|scryptSync|gzipSync|gunzipSync)$/.test(
          c.callee,
        )
      )
        continue;
      const fn = enclosingFunction(c.node, ctx.lang);
      if (!fn || !isRequestHandler(fn, ctx.lang, ctx.source)) continue;
      out.push({
        node: c.node,
        message: `\`${c.callee}()\` blocks the event loop inside a request handler.`,
      });
    }
    return out;
  },
};

/** Characters an atom can match: a positive set, a negated set (`[^…]`, `\\D`, `.`), or `null` = unknown/anything. */
type CharSet = { neg: boolean; set: Set<number> } | null;

const pos = (codes: Iterable<number>): CharSet => ({ neg: false, set: new Set(codes) });
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const DIGIT = range(48, 57);
const WORD = [...DIGIT, ...range(65, 90), ...range(97, 122), 95];
const SPACE = [9, 10, 11, 12, 13, 32];

function escapeSet(ch: string): CharSet {
  switch (ch) {
    case 'd':
      return pos(DIGIT);
    case 'w':
      return pos(WORD);
    case 's':
      return pos(SPACE);
    case 'D':
      return { neg: true, set: new Set(DIGIT) };
    case 'W':
      return { neg: true, set: new Set(WORD) };
    case 'S':
      return { neg: true, set: new Set(SPACE) };
    case 'p':
    case 'P':
      return null;
    default: {
      const map: Record<string, number> = { n: 10, r: 13, t: 9, f: 12, v: 11, '0': 0 };
      return pos([map[ch] ?? ch.charCodeAt(0)]);
    }
  }
}

function classSet(raw: string): CharSet {
  const neg = raw.startsWith('^');
  const body = neg ? raw.slice(1) : raw;
  const set = new Set<number>();
  for (let i = 0; i < body.length; i++) {
    let c: number;
    if (body[i] === '\\') {
      const e = escapeSet(body[i + 1] ?? '');
      i++;
      if (e === null || e.neg) return null;
      if (e.set.size !== 1) {
        for (const x of e.set) set.add(x);
        continue;
      }
      c = [...e.set][0]!;
    } else c = body.charCodeAt(i);
    if (body[i + 1] === '-' && i + 2 < body.length) {
      const endEsc = body[i + 2] === '\\';
      const end = endEsc
        ? ([...(escapeSet(body[i + 3] ?? '')?.set ?? new Set([0]))][0] ?? 0)
        : body.charCodeAt(i + 2);
      for (let x = c; x <= end && x < 0x3000; x++) set.add(x);
      i += endEsc ? 3 : 2;
    } else set.add(c);
  }
  return { neg, set };
}

function subset(a: Set<number>, b: Set<number>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function disjoint(a: CharSet, b: CharSet): boolean {
  if (a === null || b === null) return false;
  if (!a.neg && !b.neg) {
    for (const x of a.set) if (b.set.has(x)) return false;
    return true;
  }
  if (!a.neg && b.neg) return subset(a.set, b.set);
  if (a.neg && !b.neg) return subset(b.set, a.set);
  return false;
}

function union(a: CharSet, b: CharSet): CharSet {
  if (a === null || b === null) return null;
  if (!a.neg && !b.neg) return pos([...a.set, ...b.set]);
  if (a.neg && b.neg) return { neg: true, set: new Set([...a.set].filter((x) => b.set.has(x))) };
  const [n, p] = a.neg ? [a, b] : [b, a];
  return { neg: true, set: new Set([...n.set].filter((x) => !p.set.has(x))) };
}

/**
 * Detects nested unbounded quantifiers whose inner part can match the same text in more than one way:
 * `(a+)+`, `(\w+\s?)*`, `(.*,)+`. A group is unambiguous when it contains a mandatory atom whose characters cannot be
 * matched by the group's repeated atoms (e.g. `([a-z]+\.)+`, `(?:[_-][a-z]+)*`).
 */
export function redosRisk(pattern: string): boolean {
  interface Frame {
    unbounded: boolean;
    repeated: CharSet;
    separators: CharSet[];
    alternation: boolean;
    /** First-character set of each alternative (undefined = unknown, e.g. starts with a group). */
    altFirst: (CharSet | undefined)[];
    atAltStart: boolean;
  }
  const newFrame = (): Frame => ({
    unbounded: false,
    repeated: pos([]),
    separators: [],
    alternation: false,
    altFirst: [],
    atAltStart: true,
  });
  const stack: Frame[] = [newFrame()];
  const isUnboundedAt = (j: number) => {
    const ch = pattern[j];
    if (ch === '*' || ch === '+') return true;
    if (ch === '{') return /^\{\d*,\}/.test(pattern.slice(j)) || /^\{\d+,\d{2,}\}/.test(pattern.slice(j));
    return false;
  };
  const quantLen = (j: number) => {
    const ch = pattern[j];
    if (ch === '*' || ch === '+' || ch === '?')
      return 1 + (pattern[j + 1] === '?' || pattern[j + 1] === '+' ? 1 : 0);
    if (ch === '{') {
      const m = /^\{\d*(?:,\d*)?\}/.exec(pattern.slice(j));
      return m ? m[0].length : 0;
    }
    return 0;
  };
  const mandatory = (j: number) =>
    quantLen(j) === 0 || /^\{[1-9]\d*(?:,\d*)?\}/.test(pattern.slice(j)) || pattern[j] === '+';
  let i = 0;
  const groupSets: CharSet[] = [];
  while (i < pattern.length) {
    const ch = pattern[i]!;
    const top = stack[stack.length - 1]!;
    let atomEnd = i + 1;
    let set: CharSet;
    if (ch === '\\') {
      atomEnd = i + 2;
      if (/[bB]/.test(pattern[i + 1] ?? '')) {
        i = atomEnd;
        continue;
      }
      set = escapeSet(pattern[i + 1] ?? '');
    } else if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      set = classSet(pattern.slice(i + 1, j));
      atomEnd = j + 1;
    } else if (ch === '(') {
      if (top.atAltStart) {
        top.altFirst.push(undefined);
        top.atAltStart = false;
      }
      stack.push(newFrame());
      groupSets.push(null);
      const rest = pattern.slice(i);
      i += /^\(\?<[=!]/.test(rest)
        ? 4
        : /^\(\?[:=!>]/.test(rest)
          ? 3
          : /^\(\?<\w+>/.test(rest)
            ? rest.indexOf('>') + 1
            : /^\(\?P<\w+>/.test(rest)
              ? rest.indexOf('>') + 1
              : 1;
      continue;
    } else if (ch === ')') {
      const frame = stack.length > 1 ? stack.pop()! : top;
      const parent = stack[stack.length - 1]!;
      const outerUnbounded = isUnboundedAt(i + 1);
      const unambiguous = !frame.alternation && frame.separators.some((sep) => disjoint(sep, frame.repeated));
      if (outerUnbounded && frame.unbounded && !unambiguous) return true;
      // `(a|aa)+`: alternatives that can start with the same character make the repetition ambiguous.
      if (outerUnbounded && frame.alternation) {
        const firsts = frame.altFirst;
        for (let x = 0; x < firsts.length; x++)
          for (let y = x + 1; y < firsts.length; y++) {
            const fx = firsts[x];
            const fy = firsts[y];
            if (fx !== undefined && fy !== undefined && !disjoint(fx, fy)) return true;
          }
      }
      const frameSet = union(
        frame.repeated,
        frame.separators.reduce<CharSet>((acc, s) => union(acc, s), pos([])),
      );
      if (frame.unbounded || outerUnbounded) {
        parent.unbounded = true;
        parent.repeated = union(parent.repeated, frameSet);
      } else if (mandatory(i + 1) && frame.separators.length) parent.separators.push(...frame.separators);
      i += 1 + quantLen(i + 1);
      continue;
    } else if (ch === '|') {
      top.alternation = true;
      top.atAltStart = true;
      i++;
      continue;
    } else if (ch === '^' || ch === '$') {
      i++;
      continue;
    } else set = ch === '.' ? { neg: true, set: new Set([10]) } : pos([ch.charCodeAt(0)]);
    if (top.atAltStart) {
      top.altFirst.push(set);
      top.atAltStart = false;
    }
    if (isUnboundedAt(atomEnd)) {
      top.unbounded = true;
      top.repeated = union(top.repeated, set);
    } else if (mandatory(atomEnd)) top.separators.push(set);
    else top.repeated = union(top.repeated, set);
    i = atomEnd + quantLen(atomEnd);
  }
  return false;
}

const redos: AstRule = {
  kind: 'ast',
  id: 'perf/regex-catastrophic-backtracking',
  title: 'Regular expression vulnerable to catastrophic backtracking',
  category: 'performance',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-1333'],
  owasp: [API.API4],
  description:
    'A regular expression nests unbounded quantifiers without a separator (e.g. `(a+)+`, `(\\w+\\s?)*$`), which backtracks exponentially on non-matching input.',
  impact:
    'A short crafted string can pin a CPU core for seconds to hours (ReDoS); in Node.js this blocks all requests.',
  recommendation:
    'Rewrite the pattern without nested quantifiers (make the inner part unambiguous), use atomic groups/possessive quantifiers where supported, limit input length before matching, or use a linear-time engine (RE2).',
  verification:
    'Time the regex against a 50-character near-match (e.g. `"a".repeat(50) + "!"`) in a unit test; it must finish in milliseconds.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    const check = (node: Node, pattern: string | undefined) => {
      if (pattern && pattern.length < 2000 && redosRisk(pattern))
        out.push({
          node,
          message: `Pattern \`${pattern.slice(0, 80)}\` contains nested unbounded quantifiers.`,
          facts: { pattern: pattern.slice(0, 200) },
        });
    };
    if (isJs(lang)) {
      for (const r of collect(ctx.tree.rootNode, 'regex')) check(r, r.childForFieldName('pattern')?.text);
      for (const c of ctx.calls) if (c.callee === 'RegExp') check(c.node, stringValue(c.args[0], lang));
    } else if (lang === 'php') {
      for (const c of ctx.calls)
        if (/^preg_(?:match|match_all|replace|replace_callback|split|grep)$/.test(c.callee)) {
          const raw = stringValue(c.args[0], lang);
          const m = raw ? /^(.)([\s\S]*)\1[a-zA-Z]*$/.exec(raw) : null;
          check(c.node, m?.[2]);
        }
    } else {
      for (const c of ctx.calls)
        if (/^re\.(?:compile|match|search|fullmatch|findall|finditer|sub|subn|split)$/.test(c.callee))
          check(c.node, stringValue(c.args[0], lang));
    }
    return out;
  },
};

const missingFkIndex: AstRule = {
  kind: 'ast',
  id: 'perf/foreign-key-without-index',
  title: 'Foreign-key-like column without an index',
  category: 'performance',
  severity: 'low',
  confidence: 'medium',
  languages: ['php'],
  description:
    'A Laravel migration adds a `*_id` column with a plain integer/uuid type and no index, foreign key constraint or `constrained()`.',
  impact:
    'Joins and lookups by this column (relationship loading, cascades) become full table scans as data grows.',
  recommendation: "Use `foreignId('x_id')->constrained()` or add `->index()` / `$table->index('x_id')`.",
  verification: '`EXPLAIN` the relationship query on a production-sized copy; it should use an index.',
  check(ctx) {
    if (ctx.file.kind !== 'migration') return [];
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      if (c.callee !== 'Schema::create' && c.callee !== 'Schema::table') continue;
      const closure = c.args[1];
      if (!closure) continue;
      const body = compact(closure.text);
      for (const stmt of collect(closure, 'expression_statement')) {
        const chain = compact(stmt.text);
        const m =
          /^\$table->(?:unsignedBigInteger|bigInteger|unsignedInteger|integer|uuid|ulid)\(['"](\w+_id)['"]/.exec(
            chain,
          );
        if (!m) continue;
        const col = m[1]!;
        if (/->(?:index|unique|primary|constrained|references)\(/.test(chain)) continue;
        const indexed = new RegExp(
          `\\$table->(?:index|unique|primary|foreign)\\((?:\\[[^\\]]*)?['"]${col}['"]`,
        ).test(body);
        if (!indexed)
          out.push({ node: stmt, message: `Column \`${col}\` has no index or foreign key constraint.` });
      }
    }
    return out;
  },
};

export const performanceRules: AstRule[] = [
  queryInLoop,
  inefficientCount,
  unboundedQuery,
  syncIo,
  redos,
  missingFkIndex,
];
