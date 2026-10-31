import { isTestPath } from '../fs/files.js';
import { collect, compact, enclosingFunction, isJs } from '../parse/ast.js';
import type { Node } from '../parse/treesitter.js';
import { OWASP, objectArg, pairValue } from './helpers.js';
import { ALL_LANGS, type AstRule, type FileRule, type Hit, JS_LANGS, type ProjectRule } from './types.js';

const pyRequestsTimeout: AstRule = {
  kind: 'ast',
  id: 'rel/http-call-without-timeout',
  title: 'Outbound HTTP call without a timeout',
  category: 'reliability',
  severity: 'medium',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-400', 'CWE-1088'],
  owasp: [OWASP.A10],
  description:
    'An HTTP client that has no default timeout (Python `requests`, axios, Guzzle) is called without one.',
  impact:
    'A slow or unresponsive dependency blocks the worker/request indefinitely, exhausting threads or connections and turning a partial outage into a full one.',
  recommendation:
    "Always pass an explicit timeout (`requests.get(url, timeout=10)`, `axios.create({ timeout: 10000 })`, `new Client(['timeout' => 10])`) sized to the caller's own deadline, combined with retries with backoff where safe.",
  verification:
    'Point the dependency at a non-responding endpoint (e.g. a blackhole port) in a test and assert the call fails within the timeout.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    if (lang === 'python') {
      for (const c of ctx.calls)
        if (
          /^requests\.(?:get|post|put|patch|delete|head|options|request)$/.test(c.callee) &&
          !c.kwargs.has('timeout') &&
          !c.node.text.includes('**')
        )
          out.push({
            node: c.node,
            message: `\`${c.callee}()\` has no \`timeout\`; requests waits forever by default.`,
            fixer: 'py-requests-timeout',
          });
    } else if (isJs(lang)) {
      const hasGlobalTimeout = /axios\.defaults\.timeout\s*=/.test(ctx.source);
      for (const c of ctx.calls) {
        if (c.callee === 'axios.create') {
          const cfg = objectArg(c, 0);
          if (!cfg || !pairValue(cfg, 'timeout'))
            out.push({
              node: c.node,
              message: '`axios.create()` without `timeout` (axios default is no timeout).',
              severity: 'low',
            });
        } else if (
          ctx.serverSide &&
          !hasGlobalTimeout &&
          /^axios(?:\.(?:get|post|put|patch|delete|request))?$/.test(c.callee)
        ) {
          if (!c.args.some((a) => a.type === 'object' && pairValue(a, 'timeout') !== undefined))
            out.push({
              node: c.node,
              message: `\`${c.callee}()\` without \`timeout\` in server-side code.`,
              severity: 'low',
              confidence: 'medium',
            });
        }
      }
    } else if (lang === 'php') {
      for (const c of ctx.calls) {
        if (
          c.isNew &&
          /(?:^|\\)(?:GuzzleHttp\\)?Client$/.test(c.callee) &&
          /Guzzle|use GuzzleHttp/.test(ctx.source)
        ) {
          const cfg = c.args[0];
          if (!cfg || !/['"](?:timeout|connect_timeout)['"]|RequestOptions::TIMEOUT/.test(cfg.text))
            out.push({
              node: c.node,
              message: 'Guzzle client created without `timeout` (Guzzle default is 0 = wait forever).',
            });
        }
        if (c.callee === 'curl_init') {
          const fn = enclosingFunction(c.node, lang) ?? ctx.tree.rootNode;
          if (!/CURLOPT_TIMEOUT|CURLOPT_CONNECTTIMEOUT/.test(fn.text))
            out.push({ node: c.node, message: 'cURL handle without `CURLOPT_TIMEOUT`.', severity: 'low' });
        }
      }
    }
    return out;
  },
};

const swallowed: AstRule = {
  kind: 'ast',
  id: 'rel/swallowed-exception',
  title: 'Exception silently swallowed',
  category: 'reliability',
  severity: 'low',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-390', 'CWE-1069'],
  owasp: [OWASP.A10],
  description:
    'A `catch`/`except` block is empty (or only `pass`), so failures disappear without logging, metrics or recovery.',
  impact: 'Errors go unnoticed, data can be left half-written, and incidents take much longer to diagnose.',
  recommendation:
    'Handle the error explicitly: log it with context, rethrow/wrap it, or document with a comment why ignoring it is safe.',
  verification: 'Force the failing branch in a test and assert it is logged or propagated.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    if (isJs(lang) || lang === 'php') {
      for (const c of collect(ctx.tree.rootNode, 'catch_clause')) {
        const body = c.childForFieldName('body');
        if (!body) continue;
        // tree-sitter attaches a trailing `// comment` after `}` to the block, so only count nodes before the brace.
        const close = body.children.find((x) => x?.type === '}');
        const inner = body.namedChildren.filter((x) => x && (!close || x.startIndex < close.startIndex));
        if (inner.length === 0) out.push({ node: c, message: 'Empty catch block discards the error.' });
      }
    } else {
      for (const e of collect(ctx.tree.rootNode, 'except_clause')) {
        const block = e.namedChildren.find((x) => x?.type === 'block');
        if (!block) continue;
        const stmts = block.namedChildren.filter((x) => x && x.type !== 'comment');
        const explained = collect(e, 'comment').some((x) => x.startPosition.row !== e.startPosition.row);
        const benign =
          /^except\s+\(?\s*(?:ImportError|ModuleNotFoundError|FileNotFoundError|FileExistsError|ProcessLookupError|StopIteration|StopAsyncIteration|asyncio\.CancelledError)\b(?:\s*,\s*(?:ImportError|ModuleNotFoundError|FileNotFoundError|FileExistsError|ProcessLookupError))*\s*\)?\s*(?:as\s+\w+)?\s*:/.test(
            e.text,
          );
        if (stmts.length === 1 && /^(?:pass|\.\.\.)$/.test(stmts[0]!.text.trim()) && !explained && !benign)
          out.push({
            node: e,
            message: `\`${e.text.split('\n')[0]!.trim()}\` followed only by \`pass\` discards the error.`,
          });
      }
    }
    return out;
  },
};

const bareExcept: AstRule = {
  kind: 'ast',
  id: 'rel/bare-except',
  title: 'Bare `except:` catches system exits',
  category: 'reliability',
  severity: 'medium',
  confidence: 'high',
  languages: ['python'],
  cwe: ['CWE-396'],
  owasp: [OWASP.A10],
  fixer: 'py-bare-except',
  description: 'A bare `except:` also catches `KeyboardInterrupt`, `SystemExit` and `GeneratorExit`.',
  impact:
    'Processes cannot be stopped cleanly (graceful shutdown, Ctrl-C, worker termination) and programming errors are hidden.',
  recommendation: 'Catch `Exception` (or the specific exceptions you expect).',
  verification: 'Run the tests; send SIGINT to a running process and confirm it exits.',
  check(ctx) {
    return collect(ctx.tree.rootNode, 'except_clause')
      .filter((e) => /^except\s*:/.test(e.text))
      .map((e) => ({ node: e, message: 'Bare `except:` clause.' }));
  },
};

const stripeIdempotency: AstRule = {
  kind: 'ast',
  id: 'rel/payment-without-idempotency-key',
  title: 'Payment API call without an idempotency key',
  category: 'reliability',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-837'],
  owasp: [OWASP.A06],
  description:
    'A Stripe charge, payment intent, refund, transfer or payout is created without an idempotency key.',
  impact:
    'Network retries, timeouts or double submissions create duplicate charges/refunds that must be reversed manually.',
  recommendation:
    "Pass a deterministic idempotency key derived from your own order/operation id (`{ idempotencyKey }`, `['idempotency_key' => …]`, `idempotency_key=…`).",
  verification:
    'Call the code path twice with the same order id in a test (Stripe test mode/mocks) and assert a single object is created.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    const PAY =
      /(?:paymentIntents|charges|refunds|transfers|payouts|PaymentIntent|Charge|Refund|Transfer|Payout)/;
    for (const c of ctx.calls) {
      if (
        c.name !== 'create' ||
        !PAY.test(c.callee) ||
        !/stripe|Stripe/.test(c.callee + ctx.source.slice(0, 3000))
      )
        continue;
      const hasKey = isJs(lang)
        ? c.args.length >= 2 && /idempotencyKey/.test(c.args[1]!.text)
        : lang === 'php'
          ? c.args.length >= 2 && /idempotency_key/.test(c.args[1]!.text)
          : c.kwargs.has('idempotency_key');
      if (!hasKey)
        out.push({ node: c.node, message: `\`${c.callee}()\` is called without an idempotency key.` });
    }
    return out;
  },
};

const RMW_FIELD =
  /(?:balance|credit|credits|stock|quantity|qty|inventory|points|seats|remaining|wallet|amount|count|counter|available|limit|usage|quota)$/i;

const readModifyWrite: AstRule = {
  kind: 'ast',
  id: 'rel/race-condition-read-modify-write',
  title: 'Non-atomic read-modify-write of a counter or balance',
  category: 'reliability',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-362', 'CWE-367'],
  owasp: [OWASP.A06],
  description:
    'A balance/stock/counter field is computed from its previously loaded value and saved back without a row lock, transaction or atomic update.',
  impact:
    "Concurrent requests overwrite each other's updates: double spending, overselling inventory, lost credits.",
  recommendation:
    "Use an atomic update (`increment`/`decrement`, `F('field') - n`, Prisma `{ decrement: n }`, `UPDATE … SET x = x - ? WHERE x >= ?`) or lock the row (`lockForUpdate`, `select_for_update`) inside a transaction.",
  verification:
    'Run two concurrent requests against the code path in an integration test and assert the final value reflects both.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    const assignTypes = new Set([
      'assignment_expression',
      'augmented_assignment_expression',
      'assignment',
      'augmented_assignment',
    ]);
    for (const n of collect(ctx.tree.rootNode, assignTypes)) {
      const left = n.childForFieldName('left');
      const right = n.childForFieldName('right');
      if (!left || !/member_expression|member_access_expression|attribute/.test(left.type)) continue;
      const l = compact(left.text);
      const field = l.split(/->|\./).pop() ?? '';
      if (!RMW_FIELD.test(field)) continue;
      const isAug = n.type.startsWith('augmented') && /[-+]=/.test(n.text);
      const selfRef = right && compact(right.text).includes(l) && /[-+]/.test(right.text);
      if (!isAug && !selfRef) continue;
      const fn = enclosingFunction(n, lang) ?? ctx.tree.rootNode;
      const body = fn.text;
      const saves = /->save\(|\.save\(|\.update\(|->update\(|\.commit\(/.test(body);
      if (!saves) continue;
      if (
        /lockForUpdate|sharedLock|select_for_update|FOR UPDATE|DB::transaction|\$transaction|transaction\.atomic|atomic\(|->increment\(|->decrement\(|F\(\s*['"]|\{\s*(?:increment|decrement)\s*:/.test(
          body,
        )
      )
        continue;
      out.push({
        node: n,
        message: `\`${compact(n.text).slice(0, 60)}\` updates \`${field}\` from a previously read value without a lock or atomic update.`,
      });
    }
    // Prisma: data: { balance: user.balance - amount }
    if (isJs(lang))
      for (const c of ctx.calls) {
        if (c.name !== 'update' && c.name !== 'updateMany') continue;
        const data = pairValue(objectArg(c, 0), 'data');
        if (!data) continue;
        for (const p of data.namedChildren) {
          if (p?.type !== 'pair') continue;
          const k = p.childForFieldName('key')?.text ?? '';
          const v = compact(p.childForFieldName('value')?.text ?? '');
          if (RMW_FIELD.test(k) && new RegExp(`\\.${k}[-+]`).test(v)) {
            const fn = enclosingFunction(c.node, lang) ?? ctx.tree.rootNode;
            if (!/\$transaction|FOR UPDATE/.test(fn.text))
              out.push({
                node: p,
                message: `\`${k}\` is written as \`${v.slice(0, 40)}\` (read-then-write); use \`{ decrement: … }\`/\`{ increment: … }\`.`,
              });
          }
        }
      }
    return out;
  },
};

const laravelJob: AstRule = {
  kind: 'ast',
  id: 'rel/queue-job-without-retry-policy',
  title: 'Queued job without retry/timeout policy',
  category: 'reliability',
  severity: 'low',
  confidence: 'medium',
  languages: ['php'],
  cwe: ['CWE-400'],
  description:
    'A Laravel job implementing `ShouldQueue` does not declare `$tries`/`$backoff`/`retryUntil()` nor `$timeout`, relying on worker defaults.',
  impact:
    'Failing jobs are retried without backoff (hammering dependencies) or never retried, and hung jobs block workers until the global timeout.',
  recommendation:
    'Declare `public $tries`, `public $backoff` (or `retryUntil()`) and `public $timeout` per job; implement `failed()` for alerting/compensation.',
  verification:
    'Throw inside the job in a test (`Queue::fake` / sync driver) and assert the retry/backoff behaviour and `failed()` handling.',
  check(ctx) {
    const out: Hit[] = [];
    for (const cls of collect(ctx.tree.rootNode, 'class_declaration')) {
      if (!/implements[^{]*\bShouldQueue\b/.test(cls.text.split('{')[0] ?? '')) continue;
      const t = cls.text;
      const retry = /\$tries\b|\$backoff\b|function\s+retryUntil|function\s+backoff|\$maxExceptions/.test(t);
      const timeout = /\$timeout\b|\$failOnTimeout/.test(t);
      if (!retry && !timeout)
        out.push({
          node: cls.childForFieldName('name') ?? cls,
          message: `Job \`${cls.childForFieldName('name')?.text}\` relies on worker defaults for retries and timeout.`,
        });
    }
    return out;
  },
};

const LARAVEL_COLUMN =
  /^(?:string|text|mediumText|longText|integer|bigInteger|smallInteger|tinyInteger|unsignedInteger|unsignedBigInteger|boolean|date|dateTime|dateTimeTz|timestamp|timestampTz|time|decimal|float|double|json|jsonb|uuid|ulid|char|enum|foreignId|foreignUuid|foreignUlid|year|binary|ipAddress|macAddress)$/;

function laravelUpMethod(root: Node): Node | null {
  return collect(root, 'method_declaration').find((m) => m.childForFieldName('name')?.text === 'up') ?? null;
}

const migrationDestructive: AstRule = {
  kind: 'ast',
  id: 'rel/destructive-migration',
  title: 'Destructive or breaking database migration',
  category: 'reliability',
  severity: 'medium',
  confidence: 'high',
  languages: ['php', 'python'],
  cwe: ['CWE-1265'],
  description:
    'A migration drops or renames tables/columns, or adds a NOT NULL column without a default to an existing table.',
  impact:
    'Dropping data is irreversible without a backup; renames and drops break the previous application version during rolling deploys; NOT NULL without default fails on tables that already contain rows.',
  recommendation:
    'Use expand/contract: add new columns as nullable or with a default, backfill, deploy code that stops using old columns, and drop them in a later release after a verified backup.',
  verification:
    'Run the migration against a production-sized copy (with existing rows) and run the previous app version against the migrated schema.',
  check(ctx) {
    const out: Hit[] = [];
    if (ctx.file.kind !== 'migration') return out;
    if (ctx.lang === 'php') {
      const up = laravelUpMethod(ctx.tree.rootNode);
      if (!up) return out;
      for (const c of ctx.calls) {
        if (c.node.startIndex < up.startIndex || c.node.endIndex > up.endIndex) continue;
        if (/^Schema::(?:drop|dropIfExists|dropColumns|rename)$/.test(c.callee))
          out.push({ node: c.node, message: `\`${c.callee}()\` in \`up()\` removes or renames a table.` });
        else if (
          /^\$table->(?:dropColumn|renameColumn|dropColumns|dropMorphs|dropTimestamps|dropSoftDeletes|dropRememberToken)$/.test(
            c.callee,
          )
        )
          out.push({ node: c.node, message: `\`${c.callee}()\` in \`up()\` removes or renames a column.` });
      }
      // NOT NULL column added to an existing table.
      for (const c of ctx.calls) {
        if (
          c.callee !== 'Schema::table' ||
          c.node.startIndex < up.startIndex ||
          c.node.endIndex > up.endIndex
        )
          continue;
        const closure = c.args[1];
        if (!closure) continue;
        for (const stmt of collect(closure, 'expression_statement')) {
          const chain = compact(stmt.text);
          const m = /^\$table->(\w+)\(/.exec(chain);
          if (!m || !LARAVEL_COLUMN.test(m[1]!)) continue;
          if (/->(?:nullable|default|useCurrent|change|storedAs|virtualAs|autoIncrement)\(/.test(chain))
            continue;
          out.push({
            node: stmt,
            message: `\`${chain.slice(0, 70)}\` adds a NOT NULL column without a default to an existing table.`,
            confidence: 'medium',
          });
        }
      }
    } else {
      for (const c of ctx.calls)
        if (/^migrations\.(?:RemoveField|DeleteModel|RenameField|RenameModel)$/.test(c.callee))
          out.push({ node: c.node, message: `\`${c.callee}\` drops or renames schema objects.` });
        else if (
          c.callee === 'migrations.AddField' &&
          /null\s*=\s*False|models\.\w+Field\((?![^)]*(?:null=True|default=))/.test(c.node.text) &&
          !/null\s*=\s*True|default\s*=/.test(c.node.text)
        )
          out.push({
            node: c.node,
            message: '`AddField` adds a NOT NULL column without a default.',
            confidence: 'medium',
          });
    }
    return out;
  },
};

const sqlMigration: FileRule = {
  kind: 'file',
  id: 'rel/destructive-sql-migration',
  title: 'Destructive SQL migration',
  category: 'reliability',
  severity: 'medium',
  confidence: 'high',
  cwe: ['CWE-1265'],
  description:
    'A SQL migration drops, truncates or renames tables/columns, changes column types, or adds NOT NULL columns without defaults.',
  impact:
    'Data loss and downtime during deployment; the previous application version breaks against the new schema.',
  recommendation:
    'Apply expand/contract migrations, take and verify a backup first, and avoid type changes that rewrite large tables during peak load.',
  verification: 'Run the migration on a production-sized copy and verify rollback/restore.',
  appliesTo: (f) => f.kind === 'migration' && f.path.endsWith('.sql'),
  check(ctx) {
    const out: Hit[] = [];
    ctx.lines.forEach((l, i) => {
      if (/^\s*--/.test(l)) return;
      if (/\bDROP\s+(?:TABLE|COLUMN|SCHEMA|DATABASE)\b/i.test(l))
        out.push({ line: i + 1, message: `\`${l.trim().slice(0, 80)}\` drops data.` });
      else if (/\bTRUNCATE\b/i.test(l) || /\bDELETE\s+FROM\s+\S+\s*;/i.test(l))
        out.push({
          line: i + 1,
          message: `\`${l.trim().slice(0, 80)}\` deletes all rows.`,
          severity: 'high',
        });
      else if (/\bRENAME\s+(?:COLUMN|TO)\b/i.test(l))
        out.push({
          line: i + 1,
          message: `\`${l.trim().slice(0, 80)}\` renames a schema object (breaks running code).`,
        });
      else if (/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i.test(l))
        out.push({
          line: i + 1,
          message: `\`${l.trim().slice(0, 80)}\` changes a column type (may rewrite/lock the table).`,
          severity: 'low',
        });
      else if (/\bADD\s+COLUMN\b[^;]*\bNOT\s+NULL\b/i.test(l) && !/\bDEFAULT\b/i.test(l))
        out.push({
          line: i + 1,
          message: `\`${l.trim().slice(0, 80)}\` adds a NOT NULL column without a default.`,
        });
    });
    return out;
  },
};

const migrationNoDown: AstRule = {
  kind: 'ast',
  id: 'rel/migration-without-rollback',
  title: 'Migration cannot be rolled back',
  category: 'reliability',
  severity: 'low',
  confidence: 'medium',
  languages: ['php'],
  description: 'A Laravel migration has no `down()` method or an empty one while `up()` changes the schema.',
  impact:
    'A failed deployment cannot be reverted with `migrate:rollback`; recovery requires manual SQL under pressure.',
  recommendation:
    'Implement `down()` to reverse `up()` (or document explicitly that the migration is irreversible and rely on tested backups).',
  verification: 'Run `php artisan migrate` followed by `php artisan migrate:rollback` on a test database.',
  check(ctx) {
    if (ctx.file.kind !== 'migration') return [];
    const methods = collect(ctx.tree.rootNode, 'method_declaration');
    const up = methods.find((m) => m.childForFieldName('name')?.text === 'up');
    if (!up) return [];
    const down = methods.find((m) => m.childForFieldName('name')?.text === 'down');
    const body = down?.childForFieldName('body');
    const empty = !down || !body || body.namedChildren.filter((x) => x && x.type !== 'comment').length === 0;
    return empty
      ? [{ node: down ?? up, message: down ? '`down()` is empty.' : 'Migration has no `down()` method.' }]
      : [];
  },
};

/** Units that ship: test fixtures, examples and benchmark scenarios inside a repository are not deployed. */
function shippedUnits(ctx: Parameters<ProjectRule['check']>[0]) {
  return ctx.profile.units.filter((u) => u.path === '.' || !isTestPath(`${u.path}/`));
}

function serverUnits(ctx: Parameters<ProjectRule['check']>[0]) {
  return shippedUnits(ctx).filter((u) => u.kind === 'web-backend' || u.kind === 'fullstack');
}

const noGracefulShutdown: ProjectRule = {
  kind: 'project',
  id: 'rel/no-graceful-shutdown',
  title: 'Node.js server without graceful shutdown',
  category: 'reliability',
  severity: 'low',
  confidence: 'medium',
  cwe: ['CWE-404'],
  description:
    'A long-running Node.js server (Express, Fastify, Koa, NestJS, Hono, http) never handles `SIGTERM`.',
  impact:
    'During deploys and autoscaling the process is killed mid-request: in-flight requests fail and DB/queue connections are not drained.',
  recommendation:
    'On `SIGTERM`, stop accepting connections (`server.close()`, `app.close()`, `app.enableShutdownHooks()`), finish in-flight work, close pools, then exit.',
  verification:
    'Send SIGTERM while a slow request is running and confirm it completes before the process exits.',
  check(ctx) {
    const out: Hit[] = [];
    for (const u of serverUnits(ctx)) {
      const techs = ctx.profile.technologies.filter((t) => t.unit === u.path).map((t) => t.name);
      if (!techs.some((t) => /^(?:Express|Fastify|Koa|NestJS|Hono|hapi|Socket\.IO)$/.test(t))) continue;
      const files = ctx.files.files.filter(
        (f) =>
          !f.isTest && /\.[cm]?[jt]s$/.test(f.path) && (u.path === '.' || f.path.startsWith(`${u.path}/`)),
      );
      const handles = files.some((f) =>
        /SIGTERM|enableShutdownHooks|lightship|terminus|close-with-grace|graceful/i.test(
          ctx.files.read(f.path) ?? '',
        ),
      );
      if (!handles)
        out.push({
          file: u.manifests[0],
          message: `Server unit \`${u.path}\` (${techs.join(', ')}) has no SIGTERM handling.`,
          anchor: u.path,
        });
    }
    return out;
  },
};

const noHealthCheck: ProjectRule = {
  kind: 'project',
  id: 'rel/no-health-check',
  title: 'No health check endpoint',
  category: 'reliability',
  severity: 'low',
  confidence: 'medium',
  description:
    'A deployed backend service exposes no health/readiness endpoint (e.g. `/health`, `/healthz`, `/up`, `/ready`).',
  impact:
    'Load balancers and orchestrators cannot detect a broken instance or wait for readiness, so failures surface as user-facing errors.',
  recommendation:
    'Add a cheap liveness endpoint and a readiness endpoint that checks critical dependencies; wire them into the load balancer/orchestrator and container `HEALTHCHECK`.',
  verification:
    '`curl -f http://localhost:<port>/health` returns 200 and fails when the database is down (readiness).',
  check(ctx) {
    const out: Hit[] = [];
    const deployed = ctx.profile.containers.dockerfiles.length || ctx.profile.deploy.length;
    if (!deployed) return out;
    for (const u of serverUnits(ctx)) {
      if (
        u.frameworks.every((f) => /^(?:Next\.js|Nuxt|Astro|SvelteKit|Remix)$/.test(f)) &&
        !ctx.profile.containers.dockerfiles.length
      )
        continue;
      const files = ctx.files.files.filter(
        (f) =>
          !f.isTest &&
          (f.kind === 'source' || f.kind === 'config' || f.kind === 'dockerfile') &&
          (u.path === '.' || f.path.startsWith(`${u.path}/`)),
      );
      const has = files.some((f) =>
        /['"`]\/?(?:api\/)?(?:health|healthz|healthcheck|health-check|livez|readyz|ready|readiness|liveness|up)['"`]|health:\s*['"]\/up['"]|HEALTHCHECK|healthcheck|actuator\/health/i.test(
          ctx.files.read(f.path) ?? '',
        ),
      );
      if (!has)
        out.push({
          file: u.manifests[0],
          message: `Service \`${u.path}\` (${u.frameworks.join(', ') || u.kind}) has no detectable health endpoint.`,
          anchor: u.path,
        });
    }
    return out;
  },
};

const noErrorTracking: ProjectRule = {
  kind: 'project',
  id: 'rel/no-error-monitoring',
  title: 'No error monitoring or tracing',
  category: 'reliability',
  severity: 'low',
  confidence: 'low',
  owasp: [OWASP.A09],
  description:
    'A deployable application has no error tracking/APM/tracing integration (Sentry, Bugsnag, Datadog, New Relic, OpenTelemetry, Crashlytics, …).',
  impact:
    'Production errors are discovered by users instead of alerts; incidents take longer to detect and diagnose.',
  recommendation:
    'Integrate an error tracker or OpenTelemetry exporter with release tagging and alert routing.',
  verification:
    'Trigger a test exception in staging and confirm it reaches the monitoring tool with the release version.',
  check(ctx) {
    const out: Hit[] = [];
    for (const u of shippedUnits(ctx)) {
      if (!['web-backend', 'fullstack', 'mobile'].includes(u.kind)) continue;
      const obs = ctx.profile.technologies.some(
        (t) =>
          t.unit === u.path &&
          t.kind === 'observability' &&
          !/^(?:pino|winston|Monolog|structlog|zap|tracing|Laravel Telescope)$/.test(t.name),
      );
      if (!obs)
        out.push({
          file: u.manifests[0],
          message: `\`${u.path}\` (${u.frameworks.join(', ') || u.kind}) has no error monitoring integration.`,
          anchor: u.path,
        });
    }
    return out;
  },
};

const unhandledPromise: AstRule = {
  kind: 'ast',
  id: 'rel/async-foreach',
  title: 'Async callback passed to `forEach`',
  category: 'reliability',
  severity: 'medium',
  confidence: 'high',
  languages: JS_LANGS,
  cwe: ['CWE-755'],
  owasp: [OWASP.A10],
  description:
    '`array.forEach(async …)` does not await the callbacks: errors become unhandled rejections and the caller continues before the work is done.',
  impact:
    'Partial writes, operations finishing after the response was sent, and process crashes on unhandled rejections.',
  recommendation:
    'Use `for … of` with `await` (sequential) or `await Promise.all(items.map(async …))` (parallel, bounded with p-limit if large).',
  verification: 'Add a test where one callback throws and assert the caller observes the error.',
  check(ctx) {
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      if (c.name !== 'forEach') continue;
      const cb = c.args[0];
      if (
        cb &&
        (cb.type === 'arrow_function' || cb.type === 'function_expression' || cb.type === 'function') &&
        /^async\b/.test(cb.text)
      )
        out.push({
          node: c.node,
          message: '`forEach` with an async callback does not wait for it or surface its errors.',
        });
    }
    return out;
  },
};

const httpNoRetry: AstRule = {
  kind: 'ast',
  id: 'rel/process-exit-in-request-path',
  title: '`process.exit()` / `exit()` in request-handling code',
  category: 'reliability',
  severity: 'medium',
  confidence: 'medium',
  languages: [...JS_LANGS, 'php'],
  cwe: ['CWE-705'],
  description:
    'Server-side request or library code terminates the whole process (`process.exit`, PHP `exit`/`die` in controllers/services).',
  impact:
    'One bad request takes down all concurrent requests on the instance (Node) or skips framework cleanup, logging and transactions (PHP).',
  recommendation:
    'Throw an error/return an error response and let the framework handle it; reserve process exit for CLI entry points.',
  verification: 'Exercise the failing path in a test and assert an error response instead of termination.',
  check(ctx) {
    if (!ctx.serverSide) return [];
    if (
      /(?:^|\/)(?:bin|scripts?|cli|commands?|console|tools?)\//.test(ctx.file.path) ||
      /(?:^|\/)(?:cli|main|index|server)\.[cm]?[jt]s$/.test(ctx.file.path)
    )
      return [];
    const out: Hit[] = [];
    if (isJs(ctx.lang)) {
      for (const c of ctx.calls) {
        if (c.callee !== 'process.exit') continue;
        const fn = enclosingFunction(c.node, ctx.lang);
        if (!fn) continue;
        const params = fn.childForFieldName('parameters')?.text ?? '';
        if (/\b(?:req|request|ctx|res|reply)\b/.test(params))
          out.push({ node: c.node, message: '`process.exit()` inside a request handler.' });
      }
    } else if (/(?:^|\/)app\/(?:Http|Services|Models|Jobs|Actions)\//.test(ctx.file.path)) {
      for (const n of collect(ctx.tree.rootNode, 'exit_statement'))
        out.push({
          node: n,
          message: '`exit`/`die` in application code bypasses the framework response lifecycle.',
        });
    }
    return out;
  },
};

export const reliabilityAstRules: AstRule[] = [
  pyRequestsTimeout,
  swallowed,
  bareExcept,
  stripeIdempotency,
  readModifyWrite,
  laravelJob,
  migrationDestructive,
  migrationNoDown,
  unhandledPromise,
  httpNoRetry,
];
export const reliabilityFileRules: FileRule[] = [sqlMigration];
export const reliabilityProjectRules: ProjectRule[] = [noGracefulShutdown, noHealthCheck, noErrorTracking];
