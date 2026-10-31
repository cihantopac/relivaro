import type { Language } from '../../core/types.js';
import {
  type CallInfo,
  collect,
  compact,
  enclosingFunction as enclosingFunctionOf,
  isJs,
  isLiteral,
  isStaticString,
  stringValue,
  walk,
} from '../../parse/ast.js';
import type { Node } from '../../parse/treesitter.js';
import {
  importsModule,
  isFalse,
  isSafePart,
  isTrue,
  OWASP,
  objectArg,
  pairs,
  pairValue,
  purposeName,
  SECRET_PURPOSE,
  unsafeDynamicParts,
} from '../helpers.js';
import { ALL_LANGS, type AstRule, type Hit, JS_LANGS } from '../types.js';

const SQL_KEYWORDS =
  /\b(?:select\s[\s\S]*\bfrom|insert\s+into|update\s+[\w`"[\].]+\s+set|delete\s+from|where\s|order\s+by|group\s+by|create\s+table|drop\s+table|alter\s+table|union\s+select|values\s*\()/i;

function sqlLike(n: Node | undefined): boolean {
  return !!n && SQL_KEYWORDS.test(n.text);
}

const JS_SQL_SINKS =
  /^(?:query|execute|raw|\$queryRawUnsafe|\$executeRawUnsafe|unsafe|exec|run|all|get|prepare|whereRaw|orWhereRaw|havingRaw|orderByRaw|joinRaw|fromRaw|sequelizeQuery)$/;
const PHP_SQL_SINKS =
  /^(?:DB::(?:select|selectOne|scalar|insert|update|delete|statement|unprepared|raw|affectingStatement|cursor)|.+(?:->|::)(?:whereRaw|orWhereRaw|havingRaw|orHavingRaw|orderByRaw|selectRaw|groupByRaw|fromRaw|joinRaw)|.+->(?:query|exec|prepare|get_results|get_row|get_var|get_col|unprepared)|mysqli_query|mysqli_multi_query|mysqli_prepare|mysql_query|pg_query|pg_prepare|sqlite_query)$/;
const PY_SQL_SINKS =
  /^(?:.+\.(?:execute|executemany|executescript|raw|extra|exec_driver_sql|mogrify)|text|RawSQL|sql\.SQL)$/;

function sqlArg(c: CallInfo, lang: Language): Node | undefined {
  if (
    lang === 'php' &&
    /^(?:mysqli_query|mysqli_multi_query|mysqli_prepare|pg_query|pg_prepare)$/.test(c.callee)
  )
    return c.args[1] ?? c.args[0];
  return c.args[0];
}

const sqlInjection: AstRule = {
  kind: 'ast',
  id: 'sec/sql-injection',
  title: 'SQL query built from dynamic strings',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-89'],
  owasp: [OWASP.A05],
  description:
    'A SQL statement is assembled with string interpolation or concatenation and passed to a raw query API instead of using bound parameters.',
  impact:
    'If any interpolated value is attacker-controlled, the attacker can read or modify arbitrary data, bypass authorization or, on some databases, execute commands.',
  recommendation:
    'Use parameter binding (placeholders such as `?`/`$1`/`:name` with a separate values array, tagged templates like Prisma `$queryRaw`, or the ORM query builder). Never interpolate request data into SQL; allowlist identifiers such as column names.',
  verification:
    "Add a test that sends a value containing `' OR 1=1 --` and assert the query is executed with bound parameters (no extra rows, no SQL error).",
  check(ctx) {
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      if (c.tagged) continue;
      const lang = ctx.lang;
      const match = isJs(lang)
        ? JS_SQL_SINKS.test(c.name)
        : lang === 'php'
          ? PHP_SQL_SINKS.test(c.callee)
          : PY_SQL_SINKS.test(c.callee);
      if (!match) continue;
      const arg = sqlArg(c, lang);
      if (!arg || isStaticString(arg, lang)) continue;
      const parts = unsafeDynamicParts(arg, lang);
      // A raw-SQL API receiving request data directly (`orderByRaw($request->input('sort'))`).
      if (
        !parts.length &&
        !isLiteral(arg, lang) &&
        ctx.tainted(arg) &&
        (lang !== 'javascript' && lang !== 'typescript' && lang !== 'tsx'
          ? true
          : /Unsafe$|^raw$|Raw$/.test(c.name))
      ) {
        out.push({
          node: c.node,
          message: `User input is passed directly as SQL to \`${c.callee}()\`.`,
          severity: 'high',
          confidence: 'high',
          facts: { sink: c.callee, userInput: true },
        });
        continue;
      }
      if (!parts.length || !sqlLike(arg)) continue;
      // `.get`, `.all`, `.run`, `.exec` are only SQL sinks when the receiver is a database handle.
      if (
        isJs(lang) &&
        /^(?:get|all|run|exec|prepare)$/.test(c.name) &&
        !/(?:db|database|sqlite|conn|connection|client|pool|knex|stmt)/i.test(c.receiver ?? '')
      )
        continue;
      const tainted = parts.some((p) => ctx.tainted(p));
      out.push({
        node: c.node,
        message: tainted
          ? `User input flows into a raw SQL statement passed to \`${c.callee}()\` via string interpolation.`
          : `Raw SQL passed to \`${c.callee}()\` is built with interpolated values (${parts.map((p) => `\`${compact(p.text).slice(0, 40)}\``).join(', ')}). Verify none of them can be controlled by a user.`,
        severity: tainted ? 'high' : 'medium',
        confidence: tainted ? 'high' : 'low',
        facts: { sink: c.callee, userInput: tainted },
      });
    }
    return out;
  },
};

function isChildProcessCall(c: CallInfo, source: string): boolean {
  if (/^(?:child_?process|cp|childProcess|proc)$/i.test(c.receiver ?? '')) return true;
  if (c.receiver) return /require\(\s*['"](?:node:)?child_process['"]\s*\)\.\w+$/.test(c.callee);
  return (
    importsModule(source, ['child_process', 'node:child_process']) &&
    new RegExp(`\\b${c.name}\\b`).test(source.slice(0, 5000))
  );
}

const commandInjection: AstRule = {
  kind: 'ast',
  id: 'sec/command-injection',
  title: 'Shell command built from dynamic strings',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-78'],
  owasp: [OWASP.A05],
  description: 'A command string that is interpreted by a shell is assembled from non-constant values.',
  impact:
    'Shell metacharacters in an interpolated value (`;`, `|`, `$()`, backticks) let an attacker run arbitrary commands with the privileges of the application.',
  recommendation:
    'Call the program directly with an argument array (`execFile`/`spawn` without `shell`, `subprocess.run([...])`, Symfony Process with an array) and validate arguments against an allowlist. If a shell is unavoidable, escape every value (`escapeshellarg`, `shlex.quote`).',
  verification:
    'Add a test that passes a value such as `x; touch /tmp/pwned` and assert no second command runs (the value is received as a single argument).',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      let arg: Node | undefined;
      if (isJs(lang)) {
        if (/^(?:exec|execSync)$/.test(c.name) && isChildProcessCall(c, ctx.source)) arg = c.args[0];
        else if (
          /^(?:spawn|spawnSync|execFile|execFileSync)$/.test(c.name) &&
          isChildProcessCall(c, ctx.source)
        ) {
          const opts = c.args.find((a) => a.type === 'object');
          if (opts && isTrue(pairValue(opts, 'shell'))) arg = c.args[0];
        }
      } else if (lang === 'php') {
        if (/^(?:exec|shell_exec|system|passthru|popen|proc_open|pcntl_exec)$/.test(c.callee))
          arg = c.args[0];
        else if (
          c.isNew &&
          /(?:^|\\)Process$/.test(c.callee) &&
          c.args[0] &&
          c.args[0].type !== 'array_creation_expression'
        )
          arg = c.args[0];
        else if (/^Process::fromShellCommandline$/.test(c.callee)) arg = c.args[0];
      } else {
        if (
          /^(?:os\.system|os\.popen|commands\.getoutput|commands\.getstatusoutput|subprocess\.getoutput|subprocess\.getstatusoutput|asyncio\.create_subprocess_shell)$/.test(
            c.callee,
          )
        )
          arg = c.args[0];
        else if (
          /^subprocess\.(?:run|call|check_call|check_output|Popen)$/.test(c.callee) &&
          isTrue(c.kwargs.get('shell'))
        )
          arg = c.args[0];
      }
      if (!arg || isStaticString(arg, lang) || arg.type === 'array' || arg.type === 'list') continue;
      const parts = unsafeDynamicParts(arg, lang);
      const plainVar =
        !parts.length &&
        !isLiteral(arg, lang) &&
        (arg.type === 'identifier' ||
          arg.type === 'variable_name' ||
          arg.type === 'member_expression' ||
          arg.type === 'attribute');
      if (!parts.length && !plainVar) continue;
      const tainted = ctx.tainted(arg);
      if (!tainted && plainVar) continue;
      out.push({
        node: c.node,
        message: tainted
          ? `User input reaches a shell command executed by \`${c.callee}()\`.`
          : `Shell command passed to \`${c.callee}()\` is built dynamically; verify interpolated values cannot contain shell metacharacters.`,
        severity: tainted ? 'critical' : 'medium',
        confidence: tainted ? 'high' : 'medium',
        facts: { sink: c.callee, userInput: tainted },
      });
    }
    if (lang === 'php')
      for (const n of collect(ctx.tree.rootNode, 'shell_command_expression'))
        if (!isStaticString(n, lang) && n.namedChildren.some((x) => x && x.type !== 'string_content')) {
          const tainted = ctx.tainted(n);
          out.push({
            node: n,
            message: 'Backtick shell execution with interpolated values.',
            severity: tainted ? 'critical' : 'medium',
            confidence: tainted ? 'high' : 'medium',
          });
        }
    return out;
  },
};

const codeInjection: AstRule = {
  kind: 'ast',
  id: 'sec/code-injection',
  title: 'Dynamic code evaluation',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-94', 'CWE-95'],
  owasp: [OWASP.A05],
  description:
    'A non-constant string is evaluated as code (`eval`, `new Function`, `vm.run*`, PHP `eval`/`assert`/`create_function`, Python `eval`/`exec`).',
  impact: 'Attacker-influenced input evaluated as code results in remote code execution.',
  recommendation:
    'Remove dynamic evaluation. Parse data with a data parser (JSON.parse, `ast.literal_eval`), dispatch through an allowlisted map of functions, or use a sandboxed expression library.',
  verification:
    'Confirm with a unit test that crafted input (e.g. `process.exit()` / `__import__("os")`) is rejected and never executed.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      let arg: Node | undefined;
      if (isJs(lang)) {
        if ((c.callee === 'eval' || c.callee === 'window.eval' || c.callee === 'globalThis.eval') && !c.isNew)
          arg = c.args[0];
        else if (c.callee === 'Function' || c.callee === 'new Function') arg = c.args[c.args.length - 1];
        else if (
          /^vm\.(?:runInNewContext|runInThisContext|runInContext|compileFunction)$/.test(c.callee) ||
          (c.isNew && /^vm\.Script$/.test(c.callee))
        )
          arg = c.args[0];
        else if (
          /^(?:setTimeout|setInterval)$/.test(c.callee) &&
          c.args[0] &&
          (c.args[0].type === 'template_string' ||
            c.args[0].type === 'binary_expression' ||
            c.args[0].type === 'string')
        )
          arg = c.args[0];
      } else if (lang === 'php') {
        if (/^(?:assert|create_function)$/.test(c.callee)) arg = c.args[0];
        else if (/^preg_replace$/.test(c.callee) && /\/[a-zA-Z]*e[a-zA-Z]*['"]$/.test(c.args[0]?.text ?? ''))
          arg = c.args[1];
      } else if (/^(?:eval|exec|compile)$/.test(c.callee)) arg = c.args[0];
      if (!arg || isLiteral(arg, lang)) continue;
      if (/^(?:setTimeout|setInterval)$/.test(c.callee) && isStaticString(arg, lang)) continue;
      const tainted = ctx.tainted(arg);
      out.push({
        node: c.node,
        message: tainted
          ? `User input is evaluated as code by \`${c.callee}()\`.`
          : `\`${c.callee}()\` evaluates a non-constant expression as code.`,
        severity: tainted ? 'critical' : 'medium',
        confidence: tainted
          ? 'high'
          : isJs(lang) && /^(?:Function|new Function)$/.test(c.callee)
            ? 'low'
            : 'medium',
        facts: { sink: c.callee, userInput: tainted },
      });
    }
    if (lang === 'php')
      for (const n of collect(ctx.tree.rootNode, 'expression_statement')) {
        const first = n.namedChildren[0];
        if (first?.type === 'function_call_expression') continue;
        if (/^eval\s*\(/.test(n.text) && !/^eval\s*\(\s*['"][^'"$]*['"]\s*\)/.test(n.text)) {
          const tainted = ctx.tainted(n);
          out.push({
            node: n,
            message: 'PHP `eval()` executes a dynamic string.',
            severity: tainted ? 'critical' : 'high',
            confidence: tainted ? 'high' : 'medium',
          });
        }
      }
    return out;
  },
};

const SANITIZE_CALL =
  /(?:DOMPurify\.sanitize|sanitize(?:Html)?|purify|xss|escapeHtml|marked\.parseInline|he\.encode|filterXSS|sanitizer)/i;

const xss: AstRule = {
  kind: 'ast',
  id: 'sec/xss',
  title: 'Unescaped HTML output',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-79'],
  owasp: [OWASP.A05],
  description:
    'Dynamic content is written as raw HTML (`dangerouslySetInnerHTML`, `innerHTML`, `document.write`, `insertAdjacentHTML`, PHP `echo` of request data, Django `mark_safe`/`Markup`).',
  impact:
    "If the content contains attacker-controlled markup, scripts run in other users' browsers (session theft, actions on their behalf).",
  recommendation:
    "Render text through the framework's escaping (JSX children, `{{ }}` in Blade/Jinja, `textContent`), or sanitize HTML with a maintained sanitizer (DOMPurify, HTML Purifier, bleach) immediately before output.",
  verification:
    'Render the component/page with a payload such as `<img src=x onerror=alert(1)>` and assert it appears escaped in the output.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    if (isJs(lang)) {
      for (const attr of collect(ctx.tree.rootNode, 'jsx_attribute')) {
        if (attr.namedChildren[0]?.text !== 'dangerouslySetInnerHTML') continue;
        const html = pairValue(attr.namedChildren[1]?.namedChildren[0], '__html');
        if (!html || isStaticString(html, lang)) continue;
        if (SANITIZE_CALL.test(html.text)) continue;
        const tainted = ctx.tainted(html);
        // JSON-LD / serialized state built by the app itself is common and low risk unless user input reaches it.
        if (
          !tainted &&
          (/^(?:JSON\.stringify|\w*(?:[jJ]son|Ld|Schema|[sS]erializ)\w*)\(/.test(html.text) ||
            (html.type === 'identifier' && !unsafeDynamicParts(html, lang).length && isSafePart(html, lang)))
        )
          continue;
        out.push({
          node: attr,
          message: tainted
            ? 'User input is rendered as raw HTML via `dangerouslySetInnerHTML`.'
            : `\`dangerouslySetInnerHTML\` renders \`${compact(html.text).slice(0, 60)}\` without sanitization.`,
          severity: tainted ? 'high' : 'medium',
          confidence: tainted ? 'high' : 'low',
        });
      }
      walk(ctx.tree.rootNode, (n) => {
        if (n.type !== 'assignment_expression') return;
        const left = n.childForFieldName('left');
        const right = n.childForFieldName('right');
        if (
          left?.type !== 'member_expression' ||
          !/^(?:innerHTML|outerHTML)$/.test(left.childForFieldName('property')?.text ?? '')
        )
          return;
        if (
          !right ||
          isStaticString(right, lang) ||
          SANITIZE_CALL.test(right.text) ||
          right.text === "''" ||
          right.text === '""'
        )
          return;
        const tainted = ctx.tainted(right);
        if (
          !tainted &&
          (right.type === 'binary_expression' || right.type === 'template_string') &&
          !unsafeDynamicParts(right, lang).length
        )
          return;
        out.push({
          node: n,
          message: tainted
            ? 'User input is assigned to `innerHTML`.'
            : `Non-constant HTML assigned to \`${left.text}\`.`,
          severity: tainted ? 'high' : 'medium',
          confidence: tainted ? 'high' : 'low',
        });
      });
      for (const c of ctx.calls) {
        const arg =
          c.name === 'insertAdjacentHTML'
            ? c.args[1]
            : /^document\.(?:write|writeln)$/.test(c.callee)
              ? c.args[0]
              : undefined;
        if (!arg || isStaticString(arg, lang) || SANITIZE_CALL.test(arg.text)) continue;
        const tainted = ctx.tainted(arg);
        out.push({
          node: c.node,
          message: `\`${c.callee}()\` writes non-constant HTML.`,
          severity: tainted ? 'high' : 'medium',
          confidence: tainted ? 'high' : 'low',
        });
      }
    } else if (lang === 'php') {
      for (const n of collect(ctx.tree.rootNode, new Set(['echo_statement', 'print_intrinsic']))) {
        if (!ctx.tainted(n)) continue;
        if (/htmlspecialchars|htmlentities|\be\(|strip_tags|json_encode|intval|\(int\)/.test(n.text))
          continue;
        out.push({
          node: n,
          message: 'Request data is echoed into the response without HTML escaping.',
          severity: 'high',
          confidence: 'high',
        });
      }
    } else {
      for (const c of ctx.calls) {
        if (!/^(?:mark_safe|Markup|markupsafe\.Markup|SafeString|format_html_join)$/.test(c.callee)) continue;
        const arg = c.args[0];
        if (!arg || isStaticString(arg, lang)) continue;
        const tainted = ctx.tainted(arg);
        out.push({
          node: c.node,
          message: `\`${c.callee}()\` marks non-constant content as safe HTML.`,
          severity: tainted ? 'high' : 'medium',
          confidence: tainted ? 'high' : 'low',
        });
      }
    }
    return out;
  },
};

const HTTP_CLIENT_JS =
  /^(?:fetch|axios|axios\.(?:get|post|put|patch|delete|head|options|request)|got|got\.(?:get|post|put|patch|delete|stream)|https?\.(?:get|request)|request|needle|superagent\.(?:get|post)|ky|ky\.(?:get|post)|undici\.(?:request|fetch)|\$fetch|ofetch)$/;
const HTTP_CLIENT_PHP =
  /^(?:Http::(?:get|post|put|patch|delete|head|send)|file_get_contents|fopen|curl_init|get_headers|getimagesize|simplexml_load_file|readfile|.+->(?:get|post|put|patch|delete|request|requestAsync|send)(?:Async)?)$/;
const HTTP_CLIENT_PY =
  /^(?:requests\.(?:get|post|put|patch|delete|head|options|request)|httpx\.(?:get|post|put|patch|delete|head|request|stream)|urllib\.request\.urlopen|urlopen|urllib3\.request|.+session\.(?:get|post|put|patch|delete|request)|client\.(?:get|post|put|patch|delete|request))$/;

/** `https://api.example.com/x/${id}` fixes the host; only the path is dynamic, which is not SSRF. */
function hostIsFixed(arg: Node, lang: Language): boolean {
  const t = arg.text.replace(/^[fFbBrR]+(?=['"])/, '');
  return (
    /^[`'"]https?:\/\/[^/$`'"{}]+\//.test(t) || (lang === 'php' && /^['"]https?:\/\/[^/$'"{}]+\//.test(t))
  );
}

const ssrf: AstRule = {
  kind: 'ast',
  id: 'sec/ssrf',
  title: 'Server-side request to a user-controlled URL',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-918'],
  owasp: [OWASP.A01],
  tags: ['api-security'],
  description:
    'Server-side code performs an HTTP request (or opens a URL) whose target is derived from request data.',
  impact:
    'Attackers can make the server call internal services, cloud metadata endpoints (credentials), or arbitrary hosts, bypassing network controls.',
  recommendation:
    'Validate the destination against an allowlist of hosts/schemes, resolve and reject private/link-local addresses, disable redirects or re-validate them, and never forward raw user URLs.',
  verification:
    'Add a test that requests `http://169.254.169.254/` and `http://127.0.0.1:22/` through the endpoint and assert both are rejected before any network call.',
  check(ctx) {
    if (!ctx.serverSide) return [];
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      const re = isJs(lang) ? HTTP_CLIENT_JS : lang === 'php' ? HTTP_CLIENT_PHP : HTTP_CLIENT_PY;
      if (!re.test(c.callee)) continue;
      if (lang === 'php' && /->/.test(c.callee) && !/(?:client|guzzle|http)/i.test(c.receiver ?? ''))
        continue;
      let arg = c.args[0];
      if (lang === 'php' && c.callee === 'curl_setopt')
        arg = /CURLOPT_URL/.test(c.args[1]?.text ?? '') ? c.args[2] : undefined;
      if (!arg || isStaticString(arg, lang) || hostIsFixed(arg, lang)) continue;
      if (!ctx.tainted(arg)) continue;
      out.push({
        node: c.node,
        message: `Request target of \`${c.callee}()\` is derived from user input.`,
        facts: { sink: c.callee },
      });
    }
    if (lang === 'php')
      for (const c of ctx.calls)
        if (
          c.callee === 'curl_setopt' &&
          /CURLOPT_URL/.test(c.args[1]?.text ?? '') &&
          c.args[2] &&
          !hostIsFixed(c.args[2], lang) &&
          ctx.tainted(c.args[2])
        )
          out.push({
            node: c.node,
            message: 'cURL URL is derived from user input.',
            facts: { sink: 'curl_setopt' },
          });
    return out;
  },
};

const FS_SINK_JS =
  /^(?:fs\.(?:promises\.)?|fsp\.|fsPromises\.)?(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|unlink|unlinkSync|rm|rmSync|readdir|readdirSync|stat|statSync|access|open|openSync|copyFile|rename)$|^res\.(?:sendFile|download|attachment)$|^(?:sendFile|download)$/;
const FS_SINK_PHP =
  /^(?:file_get_contents|file_put_contents|fopen|file|readfile|unlink|rmdir|copy|rename|parse_ini_file|highlight_file|show_source|move_uploaded_file|Storage::(?:get|put|delete|download|path|url|readStream)|response\(\)->(?:download|file)|.+->(?:download|file)|File::(?:get|put|delete))$/;
const FS_SINK_PY =
  /^(?:open|io\.open|os\.remove|os\.unlink|os\.rmdir|shutil\.(?:rmtree|copy|copyfile|move)|send_file|FileResponse|pathlib\.Path|Path|codecs\.open)$/;

const pathTraversal: AstRule = {
  kind: 'ast',
  id: 'sec/path-traversal',
  title: 'File system access with a user-controlled path',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-22'],
  owasp: [OWASP.A01],
  description: 'A file is read, written, served or deleted using a path that contains request data.',
  impact:
    'Sequences such as `../` or absolute paths let attackers read secrets (`.env`, keys), overwrite files or delete data outside the intended directory.',
  recommendation:
    'Map user input to an allowlisted identifier, or resolve the path and verify it stays inside the intended base directory (`path.resolve` + prefix check, `realpath`, `safe_join`). Strip directory components with `basename` when only a file name is expected.',
  verification:
    'Add a test requesting `../../.env` (and an absolute path) and assert a 4xx response without touching the file.',
  check(ctx) {
    if (!ctx.serverSide) return [];
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      const re = isJs(lang) ? FS_SINK_JS : lang === 'php' ? FS_SINK_PHP : FS_SINK_PY;
      if (!re.test(c.callee)) continue;
      if (
        isJs(lang) &&
        !c.receiver &&
        !/^(?:sendFile|download)$/.test(c.name) &&
        !importsModule(ctx.source, ['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'fs-extra'])
      )
        continue;
      const arg = c.args[0];
      if (!arg || isStaticString(arg, lang)) continue;
      if (!ctx.tainted(arg)) continue;
      // Joining with a base directory and normalising does not prevent traversal; basename or a containment check does.
      if (/basename|secure_filename|safe_join|realpath/.test(arg.text)) continue;
      if (pathGuarded(arg, c.node, lang)) continue;
      out.push({
        node: c.node,
        message: `Path passed to \`${c.callee}()\` contains user input.`,
        facts: { sink: c.callee },
      });
    }
    if (lang === 'php')
      for (const n of collect(
        ctx.tree.rootNode,
        new Set([
          'include_expression',
          'include_once_expression',
          'require_expression',
          'require_once_expression',
        ]),
      ))
        if (ctx.tainted(n))
          out.push({
            node: n,
            message: 'File inclusion path contains user input (local/remote file inclusion).',
            severity: 'critical',
            confidence: 'high',
          });
    return out;
  },
};

const PATH_GUARD =
  /\.startsWith\(|str_starts_with\(|\.relative\(|['"]\.\.['"]|\bresolveInside|\bisInside|\bisWithin|\bsafeJoin|\bsafe_join|realpath|is_relative_to|commonpath|Storage::disk|->exists\(/;

/** A containment check on the path variable precedes the sink in the same function. */
function pathGuarded(arg: Node, call: Node, lang: Language): boolean {
  const fn = enclosingFunctionOf(call, lang);
  if (!fn) return false;
  const vars = new Set<string>();
  walk(arg, (n) => {
    if (n.type === 'identifier' || n.type === 'variable_name') vars.add(n.text);
  });
  let guarded = false;
  walk(fn, (n) => {
    if (guarded || n.startIndex >= call.startIndex) return false;
    if (n.type === 'if_statement' || n.type === 'return_statement' || n.type === 'expression_statement') {
      const t = n.type === 'if_statement' ? (n.childForFieldName('condition')?.text ?? '') : n.text;
      if (PATH_GUARD.test(t) && [...vars].some((v) => t.includes(v))) guarded = true;
    }
  });
  return guarded;
}

const openRedirect: AstRule = {
  kind: 'ast',
  id: 'sec/open-redirect',
  title: 'Redirect to a user-controlled URL',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-601'],
  owasp: [OWASP.A01],
  description:
    'The application redirects to a location taken from request data (e.g. `?next=`, `?returnUrl=`).',
  impact:
    'Attackers craft links on your trusted domain that forward victims to phishing sites or leak OAuth codes/tokens.',
  recommendation:
    'Only redirect to relative paths (reject `//` and schemes) or to an allowlist of hosts. Laravel: `redirect()->intended()` with validated paths; Django: `url_has_allowed_host_and_scheme`.',
  verification:
    'Request the endpoint with `next=https://evil.example` and `next=//evil.example`; assert the redirect stays on your domain.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      let arg: Node | undefined;
      if (isJs(lang)) {
        if (
          /^(?:res|reply|response|ctx)\.redirect$/.test(c.callee) ||
          c.callee === 'redirect' ||
          c.callee === 'NextResponse.redirect' ||
          c.callee === 'Response.redirect'
        )
          arg = c.args[c.args.length - 1];
      } else if (lang === 'php') {
        if (/^(?:redirect|Redirect::to|Redirect::away|redirect\(\)->(?:to|away))$/.test(c.callee))
          arg = c.args[0];
        else if (c.callee === 'header' && /^['"]Location:/i.test(c.args[0]?.text ?? '')) arg = c.args[0];
      } else if (/^(?:redirect|HttpResponseRedirect|RedirectResponse|flask\.redirect)$/.test(c.callee))
        arg = c.args[0];
      if (!arg || isStaticString(arg, lang)) continue;
      if (/^new URL\(\s*['"`]\//.test(arg.text)) continue;
      if (!ctx.tainted(arg) || redirectValidated(arg, c.node) || fixedBase(arg, lang, ctx.tainted)) continue;
      out.push({ node: c.node, message: `Redirect target of \`${c.callee}()\` comes from user input.` });
    }
    if (isJs(lang))
      walk(ctx.tree.rootNode, (n) => {
        if (n.type !== 'assignment_expression') return;
        const l = compact(n.childForFieldName('left')?.text ?? '');
        if (!/^(?:window\.)?location(?:\.href)?$/.test(l)) return;
        const r = n.childForFieldName('right');
        if (r && !isStaticString(r, lang) && ctx.tainted(r))
          out.push({
            node: n,
            message:
              'Client-side navigation to a URL taken from the query string/fragment (open redirect, `javascript:` XSS).',
          });
      });
    return out;
  },
};

const REDIRECT_GUARD =
  /startsWith\(\s*['"`]\/['"`]|str_starts_with\([^)]*['"]\/['"]|url_has_allowed_host_and_scheme|is_safe_url|isSafeRedirect|isRelativeUrl|isSafeUrl|isAllowed\w*\(|ALLOWED_\w+|allowlist|whitelist|\.has\(|in_array\(|->isValidUrl|URL::isValidUrl|parse_url\(/i;

/** Leftmost operand of a concatenation / template: when it is app-controlled, user input only adds path/query. */
function fixedBase(arg: Node, lang: Language, tainted: (n: Node) => boolean): boolean {
  let left: Node | null = arg;
  while (
    left &&
    (left.type === 'binary_expression' || left.type === 'binary_operator') &&
    /^[.+]$/.test(left.childForFieldName('operator')?.text ?? '')
  )
    left = left.childForFieldName('left');
  if (!left || left === arg) {
    if (arg.type === 'template_string' || arg.type === 'encapsed_string')
      return /^[`"](?:\/[^/]|https?:\/\/[^/$`"{]+\/)/.test(arg.text);
    return false;
  }
  if (isStaticString(left, lang))
    return /^(?:\/(?!\/)|https?:\/\/[^/]+\/)/.test(stringValue(left, lang) ?? '');
  return !tainted(left);
}

/** The redirect value is chosen by a condition that validates it (ternary or enclosing `if`). */
function redirectValidated(arg: Node, call: Node): boolean {
  if (
    (arg.type === 'ternary_expression' || arg.type === 'conditional_expression') &&
    REDIRECT_GUARD.test(arg.childForFieldName('condition')?.text ?? arg.namedChildren[0]?.text ?? '')
  )
    return true;
  for (let p = call.parent; p; p = p.parent) {
    if (p.type === 'if_statement' && REDIRECT_GUARD.test(p.childForFieldName('condition')?.text ?? ''))
      return true;
    if (/function|method|arrow/.test(p.type)) break;
  }
  return false;
}

const unsafeDeserialization: AstRule = {
  kind: 'ast',
  id: 'sec/unsafe-deserialization',
  title: 'Unsafe deserialization',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-502'],
  owasp: [OWASP.A08],
  description:
    'Data is deserialized with a format that can instantiate arbitrary objects (PHP `unserialize`, Python `pickle`/`marshal`/`yaml.load` without a safe loader, `node-serialize`).',
  impact:
    'Deserializing untrusted data can lead to remote code execution through gadget chains or object injection.',
  recommendation:
    "Use a data-only format (JSON). If the format cannot change: PHP `unserialize($data, ['allowed_classes' => false])`, Python `yaml.safe_load`, never unpickle data that crosses a trust boundary.",
  verification:
    'Run the affected code path with a crafted payload (e.g. an object of an unexpected class) and assert it is rejected; for YAML confirm `!!python/object` tags fail to load.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      const arg = c.args[0];
      if (lang === 'php' && c.callee === 'unserialize') {
        if (!arg || isStaticString(arg, lang)) continue;
        const opts = c.args[1];
        if (opts && /allowed_classes['"]\s*=>\s*(?:false|\[)/.test(opts.text)) continue;
        const tainted = ctx.tainted(arg);
        out.push({
          node: c.node,
          message: tainted
            ? 'User input is passed to `unserialize()` (PHP object injection).'
            : '`unserialize()` is called without `allowed_classes => false`.',
          severity: tainted ? 'critical' : 'medium',
          confidence: tainted ? 'high' : 'medium',
          fixer: c.args.length === 1 ? 'php-unserialize-allowed-classes' : null,
        });
      } else if (lang === 'python') {
        if (/^(?:yaml\.load|yaml\.load_all)$/.test(c.callee)) {
          const loader = c.kwargs.get('Loader') ?? c.args[1];
          if (loader && /Safe|Base|CSafe/.test(loader.text)) continue;
          out.push({
            node: c.node,
            message: `\`${c.callee}()\` without \`Loader=yaml.SafeLoader\` can construct arbitrary Python objects.`,
            severity: 'high',
            confidence: 'high',
            fixer: loader ? null : 'py-yaml-safe-load',
          });
        } else if (
          /^(?:pickle|cPickle|_pickle|dill|cloudpickle|marshal|shelve|jsonpickle)\.(?:loads?|decode|Unpickler|open)$/.test(
            c.callee,
          ) ||
          /^pandas\.read_pickle|pd\.read_pickle$/.test(c.callee)
        ) {
          if (!arg || isStaticString(arg, lang)) continue;
          const tainted = ctx.tainted(arg);
          out.push({
            node: c.node,
            message: tainted
              ? `User input is unpickled by \`${c.callee}()\`.`
              : `\`${c.callee}()\` deserializes data that can execute code; ensure the source is fully trusted.`,
            severity: tainted ? 'critical' : 'medium',
            confidence: tainted ? 'high' : 'medium',
          });
        }
      } else if (isJs(lang) && /^(?:serialize|nodeSerialize|serializer)\.unserialize$/.test(c.callee)) {
        out.push({
          node: c.node,
          message: '`node-serialize` `unserialize()` evaluates functions embedded in the payload.',
          severity: 'critical',
          confidence: 'high',
        });
      }
    }
    return out;
  },
};

const PASSWORDISH = /pass(?:word|wd)?\b|\bpwd\b|password/i;

const weakHash: AstRule = {
  kind: 'ast',
  id: 'sec/weak-password-hash',
  title: 'Password hashed with a fast or broken hash',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-916', 'CWE-328'],
  owasp: [OWASP.A04],
  description: 'A password is hashed with MD5/SHA-1/SHA-256 instead of a password hashing function.',
  impact:
    'Fast hashes can be brute-forced at billions of guesses per second; a database leak exposes user passwords.',
  recommendation:
    "Use Argon2id, bcrypt or scrypt via the framework (`Hash::make`, `password_hash`, `bcrypt`/`argon2` packages, Django's `make_password`).",
  verification:
    'Check that stored hashes start with `$2y$`/`$argon2id$` (or the framework prefix) and a unit test verifies login with the new hashing.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      let fast = false;
      let subject: Node | undefined;
      if (
        isJs(lang) &&
        c.name === 'createHash' &&
        /^['"`](?:md5|sha1|sha256|sha512)['"`]$/i.test(c.args[0]?.text ?? '')
      ) {
        fast = true;
        const update = c.node.parent?.parent;
        subject =
          update?.type === 'call_expression'
            ? (update.childForFieldName('arguments') ?? undefined)
            : undefined;
      } else if (lang === 'php' && /^(?:md5|sha1|crypt|hash)$/.test(c.callee)) {
        fast = true;
        subject = c.callee === 'hash' ? c.args[1] : c.args[0];
      } else if (lang === 'python' && /^hashlib\.(?:md5|sha1|sha256|sha512|new)$/.test(c.callee)) {
        if (c.kwargs.has('usedforsecurity')) continue;
        fast = true;
        subject = c.args[c.callee === 'hashlib.new' ? 1 : 0];
      }
      if (!fast) continue;
      const context = `${subject?.text ?? ''} ${purposeName(c.node, lang)}`;
      if (!PASSWORDISH.test(context) || /reset|token|confirm/i.test(context)) continue;
      out.push({ node: c.node, message: `Password data is hashed with \`${c.callee}\` (fast hash).` });
    }
    return out;
  },
};

const weakCrypto: AstRule = {
  kind: 'ast',
  id: 'sec/weak-cipher',
  title: 'Weak or deprecated encryption',
  category: 'security',
  severity: 'medium',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-327'],
  owasp: [OWASP.A04],
  description:
    'Encryption uses a broken algorithm or mode (DES, 3DES, RC4, ECB) or a deprecated API that derives keys without an IV (`crypto.createCipher`).',
  impact: 'Encrypted data can be decrypted or manipulated by an attacker; ECB leaks plaintext patterns.',
  recommendation:
    "Use AES-256-GCM (or ChaCha20-Poly1305) with a random IV per message via `createCipheriv`, `openssl_encrypt(..., 'aes-256-gcm', ...)`, the framework encrypter (`Crypt::encrypt`), or `cryptography.Fernet`.",
  verification:
    'Unit test round-trips encryption with the new algorithm and confirms ciphertexts of equal plaintexts differ.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    const WEAK =
      /^['"`](?:des|des-ede3?(?:-cbc)?|des3|3des|rc4|rc2|bf|blowfish|[\w-]*-ecb|aes-?\d{3}-?ecb)['"`]$/i;
    for (const c of ctx.calls) {
      if (isJs(lang) && /^(?:crypto\.)?(?:createCipher|createDecipher)$/.test(c.callee))
        out.push({
          node: c.node,
          message: '`crypto.createCipher()` is deprecated and derives the key and IV insecurely.',
        });
      else if (
        isJs(lang) &&
        /createCipheriv|createDecipheriv/.test(c.name) &&
        WEAK.test(c.args[0]?.text ?? '')
      )
        out.push({ node: c.node, message: `Weak cipher ${c.args[0]!.text} used.` });
      else if (
        lang === 'php' &&
        /^openssl_(?:encrypt|decrypt)$/.test(c.callee) &&
        WEAK.test(c.args[1]?.text ?? '')
      )
        out.push({ node: c.node, message: `Weak cipher ${c.args[1]!.text} used with OpenSSL.` });
      else if (lang === 'php' && /^mcrypt_/.test(c.callee))
        out.push({ node: c.node, message: '`mcrypt` is removed since PHP 7.2 and insecure.' });
      else if (lang === 'python' && /(?:^|\.)(?:DES|DES3|ARC4|ARC2|Blowfish)\.new$/.test(c.callee))
        out.push({ node: c.node, message: `Weak cipher \`${c.callee}\`.` });
      else if (lang === 'python' && /\.new$/.test(c.callee) && c.args.some((a) => /MODE_ECB/.test(a.text)))
        out.push({ node: c.node, message: 'AES in ECB mode leaks plaintext structure.' });
      else if (lang === 'python' && /^modes\.ECB$/.test(c.callee))
        out.push({ node: c.node, message: 'ECB mode leaks plaintext structure.' });
    }
    return out;
  },
};

const insecureRandom: AstRule = {
  kind: 'ast',
  id: 'sec/insecure-random',
  title: 'Predictable random values used for secrets',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-338'],
  owasp: [OWASP.A04],
  description:
    'A non-cryptographic PRNG (`Math.random`, `rand`, `mt_rand`, `uniqid`, Python `random`) generates a token, password, OTP, nonce or similar secret.',
  impact:
    'PRNG output can be predicted from a few observed values, allowing attackers to guess reset tokens, OTPs or session ids.',
  recommendation:
    'Use a CSPRNG: `crypto.randomBytes`/`crypto.randomUUID`/`crypto.getRandomValues`, `random_bytes`/`random_int`/`Str::random`, Python `secrets`.',
  verification:
    'Confirm the generator in the code path is the CSPRNG API and add a test asserting token length/entropy.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      const weak = isJs(lang)
        ? c.callee === 'Math.random'
        : lang === 'php'
          ? /^(?:rand|mt_rand|uniqid|lcg_value|str_shuffle|array_rand|mt_srand|srand)$/.test(c.callee)
          : /^random\.(?:random|randint|randrange|choice|choices|getrandbits|sample|shuffle|uniform)$/.test(
              c.callee,
            );
      if (!weak) continue;
      const purpose = purposeName(c.node, lang);
      if (
        !SECRET_PURPOSE.test(purpose) ||
        /(?:color|colour|delay|jitter|retry|backoff|position|animation|index|sample|test|demo|mock|shuffle|order)/i.test(
          purpose,
        )
      )
        continue;
      out.push({
        node: c.node,
        message: `\`${c.callee}\` is used to produce \`${purpose}\`.`,
        facts: { purpose },
      });
    }
    return out;
  },
};

const tlsDisabled: AstRule = {
  kind: 'ast',
  id: 'sec/tls-verification-disabled',
  title: 'TLS certificate verification disabled',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-295'],
  owasp: [OWASP.A04, OWASP.A02],
  fixer: 'tls-verify-enable',
  description:
    'HTTPS certificate verification is turned off (`rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`, `CURLOPT_SSL_VERIFYPEER => false`, `withoutVerifying()`).',
  impact:
    'Any network attacker can intercept and modify traffic (credentials, tokens, payment data) with a self-signed certificate.',
  recommendation:
    "Keep verification on. For private CAs, configure the CA bundle (`ca` option, `verify='/path/ca.pem'`, `CURLOPT_CAINFO`) instead of disabling checks.",
  verification:
    'Run the integration against a host with an invalid certificate (e.g. https://self-signed.badssl.com in a test environment) and assert the request fails.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    if (isJs(lang)) {
      for (const p of collect(ctx.tree.rootNode, 'pair')) {
        const k = p.childForFieldName('key')?.text.replace(/['"]/g, '');
        if ((k === 'rejectUnauthorized' || k === 'strictSSL') && isFalse(p.childForFieldName('value')))
          out.push({ node: p, message: `\`${k}: false\` disables certificate validation.` });
      }
      walk(ctx.tree.rootNode, (n) => {
        if (
          n.type === 'assignment_expression' &&
          /NODE_TLS_REJECT_UNAUTHORIZED/.test(n.childForFieldName('left')?.text ?? '') &&
          /['"]0['"]|^0$/.test(n.childForFieldName('right')?.text ?? '')
        )
          out.push({
            node: n,
            message: '`NODE_TLS_REJECT_UNAUTHORIZED = 0` disables TLS validation for the whole process.',
            fixer: null,
          });
      });
    } else if (lang === 'php') {
      for (const c of ctx.calls) {
        if (
          c.callee === 'curl_setopt' &&
          /CURLOPT_SSL_VERIFY(?:PEER|HOST)/.test(c.args[1]?.text ?? '') &&
          isFalse(c.args[2])
        )
          out.push({ node: c.node, message: `\`${c.args[1]!.text}\` set to ${c.args[2]!.text}.` });
        if (c.name === 'withoutVerifying')
          out.push({
            node: c.node,
            message: '`Http::withoutVerifying()` disables certificate validation.',
            fixer: null,
          });
      }
      for (const el of collect(ctx.tree.rootNode, 'array_element_initializer')) {
        const kids = el.namedChildren;
        if (
          kids.length === 2 &&
          /^['"]verify['"]$|^CURLOPT_SSL_VERIFYPEER$|^RequestOptions::VERIFY$/.test(kids[0]!.text) &&
          isFalse(kids[1])
        )
          out.push({ node: el, message: `\`${kids[0]!.text} => false\` disables certificate validation.` });
      }
    } else {
      for (const c of ctx.calls) {
        const v = c.kwargs.get('verify');
        if (
          v &&
          isFalse(v) &&
          /^(?:requests|httpx|session|client|aiohttp|self\.session|s)\b|\.(?:get|post|put|patch|delete|request|Client|AsyncClient|Session)$/.test(
            c.callee,
          )
        )
          out.push({
            node: c.node,
            message: `\`verify=False\` disables certificate validation in \`${c.callee}()\`.`,
          });
        if (/^ssl\._create_unverified_context$/.test(c.callee))
          out.push({ node: c.node, message: 'Unverified SSL context.', fixer: null });
      }
      walk(ctx.tree.rootNode, (n) => {
        if (
          n.type === 'assignment' &&
          /\.verify_mode$/.test(n.childForFieldName('left')?.text ?? '') &&
          /CERT_NONE/.test(n.childForFieldName('right')?.text ?? '')
        )
          out.push({
            node: n,
            message: '`verify_mode = CERT_NONE` disables certificate validation.',
            fixer: null,
          });
      });
    }
    return out;
  },
};

const jwtInsecure: AstRule = {
  kind: 'ast',
  id: 'sec/jwt-insecure',
  title: 'JWT signature or expiry not enforced',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-347'],
  owasp: [OWASP.A07],
  description:
    'JWT handling accepts the `none` algorithm, disables signature verification or ignores expiry.',
  impact: 'Attackers can forge tokens and impersonate any user, or replay expired tokens indefinitely.',
  recommendation:
    "Always verify signatures with an explicit algorithm allowlist (e.g. `algorithms: ['HS256']`), keep expiry checks enabled, and use `verify` rather than `decode` for authentication decisions.",
  verification:
    'Add tests that submit a token with `alg: none`, a modified payload and an expired `exp`; all must be rejected.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      if (
        !/^(?:verify|decode|jwtVerify|jwtDecode|verifyJwt|decodeJwt|register|use)$/.test(c.name) &&
        !/(?:jwt|JWT|jose)/.test(c.callee)
      )
        continue;
      const txt =
        c.args.map((a) => a.text).join(',') +
        [...c.kwargs.values()].map((v) => v.parent?.text ?? '').join(',');
      if (/algorithms\s*[:=]\s*\[?[^\]]*['"]none['"]/i.test(txt))
        out.push({ node: c.node, message: 'JWT verification allows the `none` algorithm.' });
      else if (
        isJs(lang) &&
        c.name === 'verify' &&
        /jwt|jsonwebtoken/i.test(c.receiver ?? '') &&
        /ignoreExpiration\s*:\s*true/.test(txt)
      )
        out.push({
          node: c.node,
          message: '`ignoreExpiration: true` accepts expired tokens.',
          severity: 'medium',
        });
      else if (
        lang === 'python' &&
        /^jwt\.decode$/.test(c.callee) &&
        (/["']verify_signature["']\s*:\s*False/.test(txt) || isFalse(c.kwargs.get('verify')))
      )
        out.push({ node: c.node, message: 'PyJWT `decode` with signature verification disabled.' });
      else if (lang === 'php' && /^JWT::decode$/.test(c.callee) && c.args.length < 2)
        out.push({ node: c.node, message: '`JWT::decode()` called without a key.', severity: 'high' });
    }
    return out;
  },
};

const corsMisconfig: AstRule = {
  kind: 'ast',
  id: 'sec/cors-misconfiguration',
  title: 'CORS allows credentials from any origin',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-942'],
  owasp: [OWASP.A02],
  tags: ['api-security'],
  description:
    'CORS is configured to reflect or wildcard any origin while allowing credentials (cookies/authorization).',
  impact:
    'Any website the victim visits can make authenticated requests to your API and read the responses (account takeover, data theft).',
  recommendation:
    "Allow credentials only for an explicit allowlist of trusted origins; never combine `credentials: true` with `origin: '*'`, `origin: true` or a reflected `Origin` header.",
  verification:
    'Send a request with `Origin: https://evil.example` and cookies; the response must not contain `Access-Control-Allow-Origin: https://evil.example` with `Access-Control-Allow-Credentials: true`.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    if (isJs(lang)) {
      for (const c of ctx.calls) {
        if (
          !/^(?:cors|enableCors|app\.enableCors|fastifyCors|register)$/.test(c.callee) &&
          c.name !== 'enableCors'
        )
          continue;
        for (const a of c.args) {
          if (a.type !== 'object') continue;
          const origin = pairValue(a, 'origin');
          const creds = pairValue(a, 'credentials');
          if (!origin || !isTrue(creds)) continue;
          if (
            /^['"`]\*['"`]$/.test(origin.text) ||
            isTrue(origin) ||
            /\(\s*origin\s*,\s*(?:callback|cb)\s*\)\s*=>\s*(?:callback|cb)\(\s*null\s*,\s*true\s*\)/.test(
              origin.text,
            )
          )
            out.push({
              node: a,
              message: `CORS \`origin: ${origin.text.slice(0, 40)}\` combined with \`credentials: true\`.`,
            });
        }
      }
      for (const c of ctx.calls)
        if (
          /^(?:res|response|reply)\.(?:setHeader|header|set)$/.test(c.callee) &&
          /Access-Control-Allow-Origin/i.test(c.args[0]?.text ?? '') &&
          c.args[1] &&
          /headers\.origin|get\(['"]origin['"]\)/i.test(c.args[1].text) &&
          /Access-Control-Allow-Credentials/i.test(ctx.source)
        )
          out.push({
            node: c.node,
            message:
              'The request `Origin` header is reflected into `Access-Control-Allow-Origin` while credentials are allowed.',
          });
    } else if (lang === 'php') {
      if (
        /(?:^|\/)config\/cors\.php$/.test(ctx.file.path) &&
        /['"]allowed_origins['"]\s*=>\s*\[\s*['"]\*['"]\s*\]/.test(ctx.source) &&
        /['"]supports_credentials['"]\s*=>\s*true/.test(ctx.source)
      ) {
        const line = ctx.source.split('\n').findIndex((l) => /supports_credentials/.test(l)) + 1;
        out.push({ line, message: '`allowed_origins` is `*` while `supports_credentials` is `true`.' });
      }
    } else {
      for (const c of ctx.calls)
        if (/^(?:CORS|CORSMiddleware)$/.test(c.callee) || c.args.some((a) => /CORSMiddleware/.test(a.text))) {
          const origins =
            c.kwargs.get('origins') ?? c.kwargs.get('allow_origins') ?? c.kwargs.get('resources');
          const creds = c.kwargs.get('supports_credentials') ?? c.kwargs.get('allow_credentials');
          if (origins && /['"]\*['"]/.test(origins.text) && isTrue(creds))
            out.push({ node: c.node, message: 'CORS allows `*` origins with credentials.' });
        }
      if (
        /CORS_(?:ORIGIN_)?ALLOW_ALL(?:_ORIGINS)?\s*=\s*True/.test(ctx.source) &&
        /CORS_ALLOW_CREDENTIALS\s*=\s*True/.test(ctx.source)
      ) {
        const line = ctx.source.split('\n').findIndex((l) => /CORS_(?:ORIGIN_)?ALLOW_ALL/.test(l)) + 1;
        out.push({ line, message: 'django-cors-headers allows all origins with credentials.' });
      }
    }
    return out;
  },
};

const massAssignment: AstRule = {
  kind: 'ast',
  id: 'sec/mass-assignment',
  title: 'Mass assignment of request data',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-915'],
  owasp: [OWASP.A01],
  tags: ['api-security'],
  description:
    'An entire request payload is written into a model/record (`create($request->all())`, `create({ data: req.body })`, `Model(**request.data)`), or a Laravel model disables mass-assignment protection with `$guarded = []`.',
  impact:
    'Attackers can set fields they should not control (e.g. `is_admin`, `role`, `tenant_id`, `price`), leading to privilege escalation or tenant isolation bypass (OWASP API3:2023).',
  recommendation:
    'Pass only validated, explicitly allowlisted fields (`$request->validated()`, `$request->only([...])`, a Zod/DTO schema, serializer fields). Keep `$fillable` explicit on models.',
  verification:
    'Send the request with an extra privileged field (e.g. `"role":"admin"`) and assert it is not persisted.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    const WRITE =
      /^(?:create|update|fill|forceFill|forceCreate|updateOrCreate|firstOrCreate|insert|upsert|save|findByIdAndUpdate|findOneAndUpdate|updateOne|updateMany|insertOne|insertMany|build|bulkCreate|set|merge|assign)$/;
    for (const c of ctx.calls) {
      if (!WRITE.test(c.name) && !(c.isNew && lang !== 'python')) continue;
      for (const a of c.args) {
        let raw: Node | undefined = a;
        if (isJs(lang) && a.type === 'object') raw = pairValue(a, 'data') ?? pairValue(a, '$set');
        if (!raw) continue;
        const t = compact(raw.text);
        const whole = isJs(lang)
          ? /^(?:req|request|ctx\.request)\.body$|^await(?:req|request)\.json\(\)$/.test(t)
          : lang === 'php'
            ? /^(?:\$(?:this->)?request->all\(\)|request\(\)->all\(\)|Request::all\(\)|\$_(?:POST|REQUEST|GET))$/.test(
                t,
              )
            : /^\*\*(?:self\.)?request\.(?:data|POST|GET|json|form)(?:\.dict\(\))?$/.test(t);
        if (whole) {
          if (isJs(lang) && c.name === 'assign' && c.args[0] === a) continue;
          out.push({
            node: c.node,
            message: `The whole request payload (\`${t.slice(0, 40)}\`) is written by \`${c.callee}()\`.`,
          });
          break;
        }
      }
    }
    if (lang === 'python')
      for (const c of ctx.calls)
        if (
          /\.objects\.(?:create|update|update_or_create|get_or_create)$|^\w+$/.test(c.callee) &&
          c.node.text.match(/\*\*(?:self\.)?request\.(?:data|POST|GET|json)\b/)
        )
          if (!out.some((h) => h.node?.id === c.node.id))
            out.push({ node: c.node, message: 'Request data is unpacked into model fields with `**`.' });
    if (lang === 'php')
      for (const prop of collect(ctx.tree.rootNode, 'property_declaration'))
        if (/\$guarded\s*=\s*\[\s*\]/.test(prop.text) && !/(?:^|\/)tests?\//i.test(ctx.file.path))
          out.push({
            node: prop,
            message: 'Model sets `$guarded = []`, disabling mass-assignment protection for every attribute.',
            severity: 'medium',
            confidence: 'medium',
          });
    return out;
  },
};

const hardcodedSigningSecret: AstRule = {
  kind: 'ast',
  id: 'sec/hardcoded-signing-secret',
  title: 'Hard-coded signing or session secret',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-798', 'CWE-321'],
  owasp: [OWASP.A07, OWASP.A04],
  description:
    'A JWT signing key, session secret or framework secret key is a string literal in source code.',
  impact: 'Anyone with access to the code (or a leaked copy) can forge sessions and tokens for any user.',
  recommendation:
    'Load the secret from the environment or a secrets manager, rotate the exposed value, and fail fast at startup when it is missing.',
  verification:
    'Search the codebase for the literal after the change; confirm the application refuses to start without the environment variable.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    const literal = (n: Node | undefined) =>
      !!n && isStaticString(n, lang) && (stringValue(n, lang)?.length ?? 0) >= 6;
    for (const c of ctx.calls) {
      if (isJs(lang)) {
        if (/^(?:jwt|jsonwebtoken|JWT)\.(?:sign|verify)$/.test(c.callee) && literal(c.args[1]))
          out.push({ node: c.args[1]!, message: `JWT key passed to \`${c.callee}()\` is a string literal.` });
        if (/^(?:session|expressSession|cookieSession|cookieParser)$/.test(c.callee)) {
          const obj = objectArg(c, 0);
          const s = obj
            ? (pairValue(obj, 'secret') ?? pairValue(obj, 'keys'))
            : c.callee === 'cookieParser'
              ? c.args[0]
              : undefined;
          if (
            s &&
            (literal(s) || (s.type === 'array' && s.namedChildren.every((x) => literal(x ?? undefined))))
          )
            out.push({ node: s, message: `\`${c.callee}\` secret is hard-coded.` });
        }
        if (
          /^(?:new\s+)?TextEncoder\(\)\.encode$/.test(c.callee) &&
          literal(c.args[0]) &&
          /secret|jwt|key/i.test(purposeName(c.node, lang))
        )
          out.push({ node: c.args[0]!, message: 'JWT secret encoded from a string literal.' });
      } else if (lang === 'python' && /^jwt\.(?:encode|decode)$/.test(c.callee) && literal(c.args[1]))
        out.push({ node: c.args[1]!, message: `JWT key passed to \`${c.callee}()\` is a string literal.` });
      else if (lang === 'php' && /^JWT::(?:encode|decode)$/.test(c.callee) && literal(c.args[1]))
        out.push({ node: c.args[1]!, message: 'JWT key is a string literal.' });
    }
    if (lang === 'python')
      walk(ctx.tree.rootNode, (n) => {
        if (n.type !== 'assignment') return;
        const l = n.childForFieldName('left')?.text ?? '';
        const r = n.childForFieldName('right');
        if (
          /^(?:SECRET_KEY|app\.secret_key|app\.config\[['"]SECRET_KEY['"]\]|JWT_SECRET(?:_KEY)?)$/.test(l) &&
          r &&
          literal(r)
        )
          out.push({ node: n, message: `\`${l}\` is a hard-coded string.` });
      });
    return out;
  },
};

const debugMode: AstRule = {
  kind: 'ast',
  id: 'sec/debug-mode-enabled',
  title: 'Debug mode enabled in code',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  languages: ['php', 'python'],
  cwe: ['CWE-489', 'CWE-215'],
  owasp: [OWASP.A02],
  description:
    "Framework debug mode is hard-coded on (Laravel `'debug' => true`, Django `DEBUG = True` in a production settings module, Flask `app.run(debug=True)`).",
  impact:
    'Debug pages expose stack traces, configuration, environment variables and sometimes an interactive console (remote code execution with Werkzeug).',
  recommendation:
    "Read the flag from the environment with a safe default of `false` (`env('APP_DEBUG', false)`, `DEBUG = os.environ.get('DEBUG') == '1'`).",
  verification:
    'Start the app with production settings and trigger an error; the response must be a generic error page.',
  check(ctx) {
    const out: Hit[] = [];
    if (ctx.lang === 'php') {
      if (!/(?:^|\/)config\/app\.php$/.test(ctx.file.path)) return out;
      for (const el of collect(ctx.tree.rootNode, 'array_element_initializer')) {
        const kids = el.namedChildren;
        if (kids.length === 2 && /^['"]debug['"]$/.test(kids[0]!.text) && isTrue(kids[1]))
          out.push({ node: el, message: "`'debug' => true` is hard-coded in config/app.php." });
      }
    } else {
      const settingsLike =
        /(?:^|\/)(?:settings|config)(?:\/(?:base|prod|production|common))?\.py$|(?:^|\/)settings\/(?:base|prod|production|common)\.py$/.test(
          ctx.file.path,
        );
      walk(ctx.tree.rootNode, (n) => {
        if (
          settingsLike &&
          n.type === 'assignment' &&
          n.childForFieldName('left')?.text === 'DEBUG' &&
          isTrue(n.childForFieldName('right')) &&
          n.parent?.type === 'expression_statement' &&
          n.parent.parent?.type === 'module'
        )
          out.push({ node: n, message: '`DEBUG = True` in a settings module.' });
      });
      for (const c of ctx.calls)
        if (
          /(?:^|\.)run$/.test(c.callee) &&
          /^(?:app|application|server)\.run$/.test(c.callee) &&
          isTrue(c.kwargs.get('debug'))
        )
          out.push({
            node: c.node,
            message:
              '`app.run(debug=True)` enables the Werkzeug debugger (remote code execution if reachable).',
            fixer: 'py-flask-debug-off',
          });
    }
    return out;
  },
};

const csrfDisabled: AstRule = {
  kind: 'ast',
  id: 'sec/csrf-disabled',
  title: 'CSRF protection disabled',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  languages: ['php', 'python'],
  cwe: ['CWE-352'],
  owasp: [OWASP.A01],
  description:
    "CSRF protection is disabled for a view (`@csrf_exempt`) or for all routes (`$except = ['*']`).",
  impact: 'Malicious sites can submit state-changing requests on behalf of logged-in users.',
  recommendation:
    'Keep CSRF protection on for cookie-authenticated endpoints. Exempt only webhook endpoints that verify a signature (e.g. Stripe `constructEvent`).',
  verification:
    'Submit a cross-site form POST without the CSRF token and assert it is rejected (HTTP 403/419).',
  check(ctx) {
    const out: Hit[] = [];
    if (ctx.lang === 'python') {
      for (const d of collect(ctx.tree.rootNode, 'decorator'))
        if (/^@csrf_exempt\b/.test(d.text)) {
          const fn = d.parent?.childForFieldName('definition');
          const name = fn?.childForFieldName('name')?.text ?? '';
          if (
            /webhook|callback|stripe|hook/i.test(name) &&
            /signature|construct_event|hmac/i.test(fn?.text ?? '')
          )
            continue;
          out.push({ node: d, message: `View \`${name || 'anonymous'}\` is exempt from CSRF protection.` });
        }
      if (/WTF_CSRF_ENABLED\s*=\s*False/.test(ctx.source) && !ctx.file.isTest)
        out.push({
          line: ctx.source.split('\n').findIndex((l) => /WTF_CSRF_ENABLED/.test(l)) + 1,
          message: 'Flask-WTF CSRF protection disabled globally.',
        });
    } else {
      for (const prop of collect(ctx.tree.rootNode, 'property_declaration'))
        if (/\$except\s*=\s*\[[^\]]*['"]\*['"]/.test(prop.text))
          out.push({ node: prop, message: 'CSRF middleware excludes every route (`*`).', severity: 'high' });
      for (const c of ctx.calls)
        if (c.name === 'validateCsrfTokens' && /except\s*:\s*\[[^\]]*['"]\*['"]/.test(c.node.text))
          out.push({
            node: c.node,
            message: 'CSRF validation excludes every route (`*`).',
            severity: 'high',
          });
    }
    return out;
  },
};

const xxe: AstRule = {
  kind: 'ast',
  id: 'sec/xxe',
  title: 'XML parser resolves external entities',
  category: 'security',
  severity: 'high',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-611'],
  owasp: [OWASP.A02],
  description: 'An XML parser is configured to resolve external entities or DTDs.',
  impact: 'XML External Entity attacks read local files, perform SSRF or exhaust resources (billion laughs).',
  recommendation:
    'Disable entity resolution and DTD loading (`LIBXML_NOENT` must not be set; Python: use `defusedxml`; libxmljs: `noent: false`).',
  verification:
    'Parse a document containing `<!ENTITY x SYSTEM "file:///etc/passwd">` in a test; the entity must not be expanded.',
  check(ctx) {
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      const t = c.node.text;
      if (
        ctx.lang === 'php' &&
        (/LIBXML_NOENT|LIBXML_DTDLOAD/.test(t) ||
          (c.callee === 'libxml_disable_entity_loader' && isFalse(c.args[0])))
      )
        out.push({ node: c.node, message: 'libxml configured to substitute external entities.' });
      else if (
        ctx.lang === 'python' &&
        /XMLParser$/.test(c.callee) &&
        isTrue(c.kwargs.get('resolve_entities'))
      )
        out.push({ node: c.node, message: 'lxml `XMLParser(resolve_entities=True)`.' });
      else if (
        ctx.lang === 'python' &&
        c.name === 'setFeature' &&
        /feature_external_ges|feature_external_pes/.test(t) &&
        isTrue(c.args[1])
      )
        out.push({ node: c.node, message: 'SAX parser enables external entities.' });
      else if (isJs(ctx.lang) && /parseXml(?:String)?$/.test(c.callee) && /noent\s*:\s*true/.test(t))
        out.push({ node: c.node, message: 'libxmljs parses with `noent: true`.' });
    }
    return out;
  },
};

const regexInjection: AstRule = {
  kind: 'ast',
  id: 'sec/regex-injection',
  title: 'Regular expression built from user input',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-1333', 'CWE-730'],
  owasp: [OWASP.A05],
  tags: ['api-security'],
  description: 'User input is compiled into a regular expression.',
  impact:
    'Crafted patterns cause catastrophic backtracking (ReDoS) that blocks the event loop/worker, or alter matching logic.',
  recommendation:
    'Escape the input (`escapeRegExp`/`_.escapeRegExp`, `preg_quote`, `re.escape`) or use plain string matching.',
  verification:
    'Send a pattern like `(a+)+$` with a long input and assert the request completes quickly or is rejected.',
  check(ctx) {
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      const isRe = isJs(ctx.lang)
        ? c.callee === 'RegExp'
        : ctx.lang === 'php'
          ? /^preg_(?:match|match_all|replace|split|grep)$/.test(c.callee)
          : /^re\.(?:compile|match|search|findall|fullmatch|sub|split)$/.test(c.callee);
      if (!isRe) continue;
      const arg = c.args[0];
      if (!arg || isStaticString(arg, ctx.lang) || /escape|preg_quote/i.test(arg.text)) continue;
      if (ctx.tainted(arg))
        out.push({ node: c.node, message: `Pattern passed to \`${c.callee}\` contains user input.` });
    }
    return out;
  },
};

const nosqlInjection: AstRule = {
  kind: 'ast',
  id: 'sec/nosql-injection',
  title: 'NoSQL query built from raw request objects',
  category: 'security',
  severity: 'medium',
  confidence: 'low',
  languages: [...JS_LANGS, 'python'],
  cwe: ['CWE-943'],
  owasp: [OWASP.A05],
  description:
    'A MongoDB query uses request values directly as filter values or uses `$where` with dynamic JavaScript.',
  impact:
    'Operators such as `{"$ne": null}` or `{"$gt": ""}` in JSON bodies bypass authentication checks or dump collections; `$where` executes JavaScript.',
  recommendation:
    'Cast filter values to the expected primitive type (`String(x)`), validate payloads with a schema, enable `sanitizeFilter`/`express-mongo-sanitize`, never use `$where` with input.',
  verification: 'Send `{"password": {"$ne": null}}` to the endpoint and assert authentication fails.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    for (const c of ctx.calls) {
      if (
        !/^(?:find|findOne|findOneAndUpdate|findOneAndDelete|updateOne|updateMany|deleteOne|deleteMany|countDocuments|find_one|delete_one|delete_many|update_one|update_many|count_documents)$/.test(
          c.name,
        )
      )
        continue;
      const filter = c.args[0];
      if (!filter) continue;
      if (
        /\$where/.test(filter.text) &&
        !isStaticString(pairValue(filter, '$where') ?? pairValue(filter, "'$where'") ?? filter, lang)
      ) {
        out.push({
          node: c.node,
          message: '`$where` with a dynamic expression.',
          severity: 'high',
          confidence: 'medium',
        });
        continue;
      }
      const direct = isJs(lang)
        ? /^(?:req|request)\.(?:body|query)$/.test(compact(filter.text))
        : /^request\.(?:json|get_json\(\)|args|form)$/.test(compact(filter.text));
      const rawValues = pairs(filter).filter((p) =>
        /^(?:req|request)\.(?:body|query)\.\w+$|^request\.(?:json|args|form)\[/.test(compact(p.value.text)),
      );
      if (direct || rawValues.length)
        out.push({
          node: c.node,
          message: direct
            ? 'The request object is used as a query filter.'
            : `Filter value \`${compact(rawValues[0]!.value.text)}\` is used without type coercion.`,
        });
    }
    return out;
  },
};

const ssti: AstRule = {
  kind: 'ast',
  id: 'sec/template-injection',
  title: 'Server-side template built from user input',
  category: 'security',
  severity: 'high',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-1336'],
  owasp: [OWASP.A05],
  description:
    'User input is compiled as a template (`render_template_string`, `jinja2.Template`, `ejs.render`, `Handlebars.compile`, `Blade::render`).',
  impact: 'Template expressions give attackers code execution on the server.',
  recommendation: 'Keep templates static and pass user input only as context variables.',
  verification:
    'Submit `{{7*7}}` / `<%= 7*7 %>` and assert the response contains the literal text, not `49`.',
  check(ctx) {
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      const sink =
        ctx.lang === 'python'
          ? /^(?:render_template_string|flask\.render_template_string|jinja2\.Template|Template|Environment\(\)\.from_string|env\.from_string|mako\.template\.Template)$/.test(
              c.callee,
            )
          : ctx.lang === 'php'
            ? /^(?:Blade::render|\$twig->createTemplate|.+->createTemplate)$/.test(c.callee)
            : /^(?:ejs\.render|ejs\.compile|pug\.render|pug\.compile|Handlebars\.compile|handlebars\.compile|nunjucks\.renderString|_\.template|lodash\.template|Mustache\.render|doT\.template)$/.test(
                c.callee,
              );
      if (!sink) continue;
      const arg = c.args[0];
      if (!arg || isStaticString(arg, ctx.lang)) continue;
      if (ctx.tainted(arg))
        out.push({ node: c.node, message: `Template source passed to \`${c.callee}\` contains user input.` });
    }
    return out;
  },
};

const sensitiveLogging: AstRule = {
  kind: 'ast',
  id: 'sec/sensitive-data-in-logs',
  title: 'Sensitive data written to logs',
  category: 'security',
  severity: 'low',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-532'],
  owasp: [OWASP.A09],
  description: 'A log statement includes passwords, tokens, secrets, card data or the full request payload.',
  impact:
    'Logs are widely accessible and retained; leaked credentials or personal data enable account takeover and create compliance exposure.',
  recommendation:
    'Log identifiers, not secrets. Redact sensitive fields centrally (logger redaction paths, Monolog processors) and avoid logging entire request bodies.',
  verification:
    'Exercise the code path and inspect the emitted log line; it must not contain the secret value.',
  check(ctx) {
    const out: Hit[] = [];
    const lang = ctx.lang;
    const LOGGER = isJs(lang)
      ? /^(?:console\.(?:log|info|warn|error|debug)|(?:logger|log|this\.logger|fastify\.log|req\.log)\.(?:info|warn|error|debug|trace|fatal|log))$/
      : lang === 'php'
        ? /^(?:Log::(?:info|debug|warning|error|critical|notice|alert|emergency)|logger|error_log|\$this->logger->\w+|\$logger->\w+|info)$/
        : /^(?:print|logging\.(?:info|debug|warning|error|exception|critical)|(?:logger|log|self\.logger|app\.logger)\.(?:info|debug|warning|error|exception|critical))$/;
    const SENSITIVE =
      /\b(?:password|passwd|secret|api_?key|apiKey|access_?token|accessToken|refresh_?token|refreshToken|authorization|credit_?card|creditCard|card_?number|cardNumber|cvv|ssn)\b/i;
    for (const c of ctx.calls) {
      if (!LOGGER.test(c.callee)) continue;
      for (const a of c.args) {
        if (isStaticString(a, lang)) continue;
        const ids: string[] = [];
        walk(a, (n) => {
          if (
            n.type === 'identifier' ||
            n.type === 'property_identifier' ||
            n.type === 'variable_name' ||
            n.type === 'name' ||
            n.type === 'shorthand_property_identifier'
          )
            ids.push(n.text.replace(/^\$/, ''));
          if (n.type === 'string' || n.type === 'template_string' || n.type === 'encapsed_string') {
            if (n.type === 'template_string' || n.type === 'encapsed_string') return;
            return false;
          }
        });
        const hit = ids.find(
          (id) =>
            SENSITIVE.test(id) &&
            !/(?:length|count|exists|valid|reset|changed|expires|hash|has|is)/i.test(id),
        );
        const allInput = lang === 'php' && /\$request->all\(\)|request\(\)->all\(\)/.test(a.text);
        if (hit || allInput) {
          out.push({
            node: c.node,
            message: hit
              ? `\`${hit}\` is included in a log statement.`
              : 'The full request payload (including passwords) is logged.',
          });
          break;
        }
      }
    }
    return out;
  },
};

const insecureCookie: AstRule = {
  kind: 'ast',
  id: 'sec/insecure-cookie',
  title: 'Cookie without HttpOnly/Secure protection',
  category: 'security',
  severity: 'low',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-1004', 'CWE-614'],
  owasp: [OWASP.A02, OWASP.A07],
  description: 'A session or auth cookie explicitly disables `HttpOnly` or `Secure`.',
  impact: 'Scripts (XSS) can read the cookie, or it is sent over plain HTTP where it can be intercepted.',
  recommendation:
    "Set `httpOnly: true`, `secure: true` (in production) and `sameSite: 'lax'` or stricter for session cookies.",
  verification: 'Inspect the `Set-Cookie` header in a production-mode response.',
  check(ctx) {
    const out: Hit[] = [];
    if (isJs(ctx.lang)) {
      for (const p of collect(ctx.tree.rootNode, 'pair')) {
        const k = p.childForFieldName('key')?.text.replace(/['"]/g, '');
        if ((k === 'httpOnly' || k === 'httponly') && isFalse(p.childForFieldName('value')))
          out.push({ node: p, message: 'Cookie sets `httpOnly: false`.' });
      }
    } else if (ctx.lang === 'php' && /(?:^|\/)config\/session\.php$/.test(ctx.file.path)) {
      for (const el of collect(ctx.tree.rootNode, 'array_element_initializer')) {
        const kids = el.namedChildren;
        if (kids.length === 2 && /^['"]http_only['"]$/.test(kids[0]!.text) && isFalse(kids[1]))
          out.push({ node: el, message: "Session cookie `'http_only' => false`." });
      }
    } else if (ctx.lang === 'python') {
      walk(ctx.tree.rootNode, (n) => {
        if (
          n.type === 'assignment' &&
          /^(?:SESSION_COOKIE_HTTPONLY|CSRF_COOKIE_HTTPONLY)$/.test(
            n.childForFieldName('left')?.text ?? '',
          ) &&
          isFalse(n.childForFieldName('right')) &&
          /SESSION_COOKIE_HTTPONLY/.test(n.text)
        )
          out.push({ node: n, message: '`SESSION_COOKIE_HTTPONLY = False`.' });
      });
    }
    return out;
  },
};

const permissiveChmod: AstRule = {
  kind: 'ast',
  id: 'sec/world-writable-permissions',
  title: 'World-writable file permissions',
  category: 'security',
  severity: 'medium',
  confidence: 'high',
  languages: ALL_LANGS,
  cwe: ['CWE-732'],
  owasp: [OWASP.A02],
  description: 'Files or directories are created/changed with mode 0777/0666.',
  impact:
    'Any local user or compromised process can modify application files, leading to code execution or data tampering.',
  recommendation: 'Use the least permissive mode needed (e.g. 0750 for directories, 0640 for files).',
  verification: 'Check the resulting mode with `stat` after running the code path.',
  check(ctx) {
    const out: Hit[] = [];
    for (const c of ctx.calls) {
      if (
        !/^(?:fs\.)?(?:chmod|chmodSync|mkdir|mkdirSync|writeFile|writeFileSync)$|^os\.(?:chmod|mkdir|makedirs)$|^(?:chmod|mkdir)$/.test(
          c.callee,
        )
      )
        continue;
      const modeArg =
        c.args.find((a) => /^(?:0o?777|0o?666|511|438)$/.test(a.text.trim())) ?? c.kwargs.get('mode');
      const objMode = c.args.find((a) => a.type === 'object' && /mode\s*:\s*0o?(?:777|666)/.test(a.text));
      if ((modeArg && /^(?:0o?777|0o?666|511|438)$/.test(modeArg.text.trim())) || objMode)
        out.push({ node: c.node, message: `\`${c.callee}\` uses world-writable mode.` });
    }
    return out;
  },
};

const timingUnsafe: AstRule = {
  kind: 'ast',
  id: 'sec/timing-unsafe-comparison',
  title: 'Secret compared with a non-constant-time operator',
  category: 'security',
  severity: 'medium',
  confidence: 'medium',
  languages: ALL_LANGS,
  cwe: ['CWE-208'],
  owasp: [OWASP.A07],
  description:
    'A request-supplied signature, token or API key is compared to the expected value with `==`/`===`.',
  impact:
    'Response-time differences let attackers recover the expected secret byte by byte (e.g. webhook signatures, API keys).',
  recommendation:
    'Use a constant-time comparison: `crypto.timingSafeEqual`, `hash_equals`, `hmac.compare_digest`.',
  verification:
    'Confirm the comparison uses the constant-time API and that a unit test covers valid and invalid signatures.',
  check(ctx) {
    const out: Hit[] = [];
    const types = new Set(['binary_expression', 'comparison_operator']);
    for (const n of collect(ctx.tree.rootNode, types)) {
      const op =
        n.childForFieldName('operator')?.text ??
        n.children.find((c) => c && /^(?:==|===|!=|!==)$/.test(c.type))?.text;
      if (!op || !/^(?:==|===|!=|!==)$/.test(op)) continue;
      const kids = n.namedChildren.filter((x): x is Node => !!x);
      if (kids.length !== 2) continue;
      const [a, b] = kids as [Node, Node];
      const secretName = (x: Node) =>
        /(?:signature|hmac|digest|api_?key|apiKey|webhook_?secret|secret|token)$/i.test(
          compact(x.text)
            .split(/[.>\]['"$]/)
            .filter(Boolean)
            .pop() ?? '',
        );
      const oneSecret = secretName(a) || secretName(b);
      const oneInput =
        ctx.tainted(a) ||
        ctx.tainted(b) ||
        /headers?\[|headers?\.get\(|->header\(|getHeader|HTTP_X_/i.test(n.text);
      if (!oneSecret || !oneInput) continue;
      if (isLiteral(a, ctx.lang) || isLiteral(b, ctx.lang)) continue;
      out.push({ node: n, message: `\`${compact(n.text).slice(0, 60)}\` compares a secret with \`${op}\`.` });
    }
    return out;
  },
};

const buffer: AstRule = {
  kind: 'ast',
  id: 'sec/deprecated-buffer-constructor',
  title: 'Deprecated `new Buffer()` constructor',
  category: 'security',
  severity: 'medium',
  confidence: 'high',
  languages: JS_LANGS,
  cwe: ['CWE-665'],
  description:
    '`new Buffer(x)` is deprecated (DEP0005); with a numeric argument older runtimes returned uninitialized memory.',
  impact: 'Can disclose memory contents and behaves differently depending on argument type.',
  recommendation: 'Use `Buffer.from(value)` for data or `Buffer.alloc(size)` for zero-filled buffers.',
  verification:
    'Run the code path and unit tests; `node --pending-deprecation` must print no DEP0005 warning.',
  check(ctx) {
    return ctx.calls
      .filter((c) => c.isNew && c.callee === 'Buffer')
      .map((c) => ({
        node: c.node,
        message: '`new Buffer()` is deprecated; use `Buffer.from()` or `Buffer.alloc()`.',
      }));
  },
};

export const securityCodeRules: AstRule[] = [
  sqlInjection,
  commandInjection,
  codeInjection,
  xss,
  ssrf,
  pathTraversal,
  openRedirect,
  unsafeDeserialization,
  weakHash,
  weakCrypto,
  insecureRandom,
  tlsDisabled,
  jwtInsecure,
  corsMisconfig,
  massAssignment,
  hardcodedSigningSecret,
  debugMode,
  csrfDisabled,
  xxe,
  regexInjection,
  nosqlInjection,
  ssti,
  sensitiveLogging,
  insecureCookie,
  permissiveChmod,
  timingUnsafe,
  buffer,
];
