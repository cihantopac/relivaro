import { describe, expect, it } from 'vitest';
import { parsePhpstan, parseTestSummary, parseTsc } from '../../src/checks/exec.js';
import { parseLockfile, pinnedRequirements } from '../../src/deps/lockfiles.js';
import { parseManifest } from '../../src/deps/manifests.js';
import { cspOf, headerDirectives } from '../../src/intel/webserver.js';

describe('manifests', () => {
  it('package.json', () => {
    const m = parseManifest(
      'package.json',
      JSON.stringify({
        name: 'a',
        dependencies: { x: '^1', g: 'github:u/r#main', l: 'file:../l', w: 'workspace:*' },
        devDependencies: { y: '2' },
        engines: { node: '>=22' },
        workspaces: ['packages/*'],
        scripts: { test: 'vitest' },
      }),
    )!;
    expect(m.deps.map((d) => [d.name, d.source, d.dev])).toEqual([
      ['x', 'registry', false],
      ['g', 'git', false],
      ['l', 'path', false],
      ['w', 'workspace', false],
      ['y', 'registry', true],
    ]);
    expect(m.runtime.node).toBe('>=22');
    expect(m.workspaces).toEqual(['packages/*']);
  });
  it('composer.json', () => {
    const m = parseManifest(
      'composer.json',
      JSON.stringify({
        require: { php: '^8.3', 'laravel/framework': '^12', 'ext-json': '*' },
        'require-dev': { 'phpunit/phpunit': '^11' },
      }),
    )!;
    expect(m.runtime.php).toBe('^8.3');
    expect(m.deps.map((d) => d.name)).toEqual(['laravel/framework', 'phpunit/phpunit']);
  });
  it('pyproject (PEP 621 + poetry) and requirements', () => {
    const p = parseManifest(
      'pyproject.toml',
      '[project]\nname="x"\nrequires-python=">=3.11"\ndependencies=["Django>=5.0", "requests[socks]==2.32.0 ; python_version>\'3\'"]\n[tool.poetry.dependencies]\npython="^3.11"\ncelery="^5"\n',
    )!;
    expect(p.deps.map((d) => d.name)).toEqual(['django', 'requests', 'celery']);
    expect(p.runtime.python).toBe('^3.11');
    const r = parseManifest(
      'requirements-dev.txt',
      '# c\nflask==3.0.0\npytest\n-r base.txt\ngit+https://github.com/x/y.git#egg=y\n',
    )!;
    expect(r.deps.map((d) => [d.name, d.spec, d.dev, d.source])).toEqual([
      ['flask', '==3.0.0', true, 'registry'],
      ['pytest', '', true, 'registry'],
      ['y', 'git+https://github.com/x/y.git#egg=y', true, 'git'],
    ]);
  });
  it('go.mod, Cargo.toml, Gemfile, pubspec, gradle', () => {
    expect(
      parseManifest(
        'go.mod',
        'module a\n\ngo 1.23\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgolang.org/x/text v0.14.0 // indirect\n)\n',
      )!.deps.map((d) => d.name),
    ).toEqual(['github.com/gin-gonic/gin', 'golang.org/x/text']);
    expect(
      parseManifest(
        'Cargo.toml',
        '[package]\nname="a"\nversion="0.1.0"\n[dependencies]\naxum="0.7"\nserde={version="1",features=["derive"]}\n',
      )!.deps.map((d) => d.spec),
    ).toEqual(['0.7', '1']);
    expect(
      parseManifest(
        'Gemfile',
        "ruby '3.3.0'\ngem 'rails', '~> 7.1'\ngroup :test do\n  gem 'rspec'\nend\n",
      )!.deps.map((d) => [d.name, d.dev]),
    ).toEqual([
      ['rails', false],
      ['rspec', true],
    ]);
    expect(
      parseManifest(
        'pubspec.yaml',
        'name: app\nenvironment:\n  sdk: ">=3.4.0 <4.0.0"\ndependencies:\n  flutter:\n    sdk: flutter\n  dio: ^5.0.0\ndev_dependencies:\n  flutter_test:\n    sdk: flutter\n',
      )!.deps.map((d) => [d.name, d.spec]),
    ).toEqual([
      ['flutter', 'sdk'],
      ['dio', '^5.0.0'],
      ['flutter_test', 'sdk'],
    ]);
    expect(
      parseManifest(
        'build.gradle.kts',
        'plugins { id("com.android.application") }\ndependencies { implementation("com.squareup.okhttp3:okhttp:4.12.0")\n testImplementation("junit:junit:4.13.2") }',
      )!.deps.map((d) => d.name),
    ).toEqual(['com.android.application', 'com.squareup.okhttp3:okhttp', 'junit:junit']);
  });
  it('reports malformed manifests instead of throwing', () => {
    expect(parseManifest('package.json', '{ nope')!.error).toBeTruthy();
    expect(parseManifest('pyproject.toml', '[[[')!.error).toBeTruthy();
  });
});

describe('lockfiles', () => {
  it('package-lock v3', () => {
    const l = parseLockfile(
      'package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { a: '1' } },
          'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
          'node_modules/b': {
            version: '2.0.0',
            dev: true,
            hasInstallScript: true,
            resolved: 'http://evil.example/b.tgz',
          },
        },
      }),
    )!;
    expect(l.packages).toEqual([
      {
        name: 'a',
        version: '1.0.0',
        ecosystem: 'npm',
        dev: false,
        hasInstallScript: false,
        nonRegistry: undefined,
      },
      {
        name: 'b',
        version: '2.0.0',
        ecosystem: 'npm',
        dev: true,
        hasInstallScript: true,
        nonRegistry: 'http://evil.example/b.tgz',
      },
    ]);
    expect([...l.rootDeps!]).toEqual(['a']);
  });
  it('pnpm 12: two YAML documents, env lock skipped, project lock parsed', () => {
    const text = [
      '---',
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '  .:',
      '    configDependencies: {}',
      '    packageManagerDependencies:',
      '      pnpm:',
      '        specifier: 12.16.1',
      '        version: 12.16.1',
      '',
      'packages:',
      "  '@pnpm/exe.darwin-arm64@12.16.1':",
      '    resolution: {integrity: sha512-x}',
      '---',
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '  .:',
      '    devDependencies:',
      "      '@biomejs/biome':",
      '        specifier: 2.6.4',
      '        version: 2.6.4',
      '',
      'packages:',
      "  '@biomejs/biome@2.6.4':",
      '    resolution: {integrity: sha512-y}',
    ].join('\n');
    const info = parseLockfile('pnpm-lock.yaml', text)!;
    expect(info.error).toBeUndefined();
    expect(info.packages.map((p) => `${p.name}@${p.version}`)).toEqual(['@biomejs/biome@2.6.4']);
    expect([...info.rootDeps!]).toEqual(['@biomejs/biome']);
  });
  it('pnpm: a broken second document is an error, not the env packages', () => {
    const info = parseLockfile(
      'pnpm-lock.yaml',
      "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies: {}\n---\nimporters: [\n",
    )!;
    expect(info.error).toBeTruthy();
    expect(info.packages).toEqual([]);
  });
  it('pnpm: a lock cut at a line boundary or missing its project document is incomplete, not clean', () => {
    const env = "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies: {}\n";
    const noPackages = `${env}---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      left-pad:\n        specifier: 1.3.0\n        version: 1.3.0\n`;
    for (const text of [noPackages, env, `${env}---\n`]) {
      const info = parseLockfile('pnpm-lock.yaml', text)!;
      expect(info.error).toMatch(/incomplete/);
      expect(info.packages).toEqual([]);
    }
    const linksOnly =
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: workspace:*\n        version: link:packages/a\n";
    expect(parseLockfile('pnpm-lock.yaml', linksOnly)!.error).toBeUndefined();
  });
  it('pnpm v9, yarn v1, composer, poetry, go.sum, Gemfile.lock, pubspec.lock', () => {
    expect(
      parseLockfile(
        'pnpm-lock.yaml',
        "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      next:\n        specifier: 15.1.0\n        version: 15.1.0(react@19.0.0)\npackages:\n  next@15.1.0:\n    resolution: {integrity: x}\n  '@types/node@22.0.0':\n    resolution: {integrity: y}\n",
      )!.packages.map((p) => `${p.name}@${p.version}`),
    ).toEqual(['next@15.1.0', '@types/node@22.0.0']);
    expect(
      parseLockfile(
        'yarn.lock',
        '# yarn lockfile v1\n\n"@babel/core@^7.0.0", "@babel/core@^7.1.0":\n  version "7.24.0"\n\nleft-pad@^1.0.0:\n  version "1.3.0"\n',
      )!.packages.map((p) => `${p.name}@${p.version}`),
    ).toEqual(['@babel/core@7.24.0', 'left-pad@1.3.0']);
    expect(
      parseLockfile(
        'composer.lock',
        JSON.stringify({
          packages: [{ name: 'laravel/framework', version: 'v12.1.0' }],
          'packages-dev': [{ name: 'phpunit/phpunit', version: '11.0.0' }],
        }),
      )!.packages.map((p) => [p.name, p.version, p.dev]),
    ).toEqual([
      ['laravel/framework', '12.1.0', false],
      ['phpunit/phpunit', '11.0.0', true],
    ]);
    expect(
      parseLockfile('poetry.lock', '[[package]]\nname = "Django"\nversion = "5.1.2"\ncategory = "main"\n')!
        .packages[0],
    ).toMatchObject({ name: 'django', version: '5.1.2' });
    expect(
      parseLockfile('go.sum', 'github.com/a/b v1.2.3 h1:x=\ngithub.com/a/b v1.2.3/go.mod h1:y=\n')!.packages,
    ).toHaveLength(1);
    expect(
      parseLockfile(
        'Gemfile.lock',
        'GEM\n  remote: https://rubygems.org/\n  specs:\n    rails (7.1.3)\n      actionpack (= 7.1.3)\n    rack (3.0.9)\n\nPLATFORMS\n',
      )!.packages.map((p) => p.name),
    ).toEqual(['rails', 'rack']);
    expect(
      parseLockfile(
        'pubspec.lock',
        'packages:\n  dio:\n    dependency: "direct main"\n    source: hosted\n    version: "5.4.0"\n  flutter:\n    source: sdk\n    version: "0.0.0"\n',
      )!.packages.map((p) => p.name),
    ).toEqual(['dio']);
    expect(
      pinnedRequirements('requirements.txt', 'Flask==3.0.0\nrequests>=2\n').packages.map((p) => p.name),
    ).toEqual(['flask']);
  });
});

describe('tool output parsers', () => {
  it.each([
    [
      'vitest',
      ' Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed | 1 skipped (43)\n',
      { passed: 40, failed: 2, skipped: 1, total: 43 },
    ],
    [
      'jest',
      'Tests:       1 failed, 1 skipped, 10 passed, 12 total\n',
      { passed: 10, failed: 1, skipped: 1, total: 12 },
    ],
    ['phpunit ok', 'OK (12 tests, 30 assertions)\n', { passed: 12, failed: 0, total: 12 }],
    [
      'phpunit fail',
      'Tests: 12, Assertions: 30, Failures: 2, Skipped: 1.\n',
      { passed: 9, failed: 2, skipped: 1, total: 12 },
    ],
    ['pest', '  Tests:    2 failed, 40 passed (120 assertions)\n', { passed: 40, failed: 2 }],
    [
      'pytest',
      '==== 3 failed, 10 passed, 1 skipped in 0.52s ====\n',
      { passed: 10, failed: 3, skipped: 1, total: 14 },
    ],
    ['mocha', '  12 passing (30ms)\n  2 failing\n', { passed: 12, failed: 2 }],
    ['cargo', 'test result: FAILED. 3 passed; 1 failed; 0 ignored; 0 measured\n', { passed: 3, failed: 1 }],
    ['flutter', '00:05 +12 ~1 -2: Some tests failed.\n', { passed: 12, skipped: 1, failed: 2 }],
    ['node:test', '# tests 5\n# pass 4\n# fail 1\n', { passed: 4, failed: 1 }],
    ['go', 'ok  \tgithub.com/a/b\t0.1s\nFAIL\tgithub.com/a/c\t0.2s\n', { passed: 1, failed: 1 }],
  ])('%s', (_n, out, expected) => expect(parseTestSummary(out)).toMatchObject(expected));
  it('returns undefined for unknown output', () => expect(parseTestSummary('hello')).toBeUndefined());
  it('parses tsc and phpstan diagnostics', () => {
    expect(
      parseTsc("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n"),
    ).toEqual([
      {
        file: 'src/a.ts',
        line: 3,
        column: 7,
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
    ]);
    expect(
      parsePhpstan(
        'noise {"totals":{},"files":{"/r/app/A.php":{"messages":[{"message":"Undefined variable $x","line":4,"identifier":"variable.undefined"}]}}}',
      ),
    ).toEqual([
      {
        file: '/r/app/A.php',
        line: 4,
        column: 1,
        code: 'variable.undefined',
        message: 'Undefined variable $x',
      },
    ]);
  });
});

describe('web server headers', () => {
  const names = (file: string, text: string) => headerDirectives(file, text).map((d) => d.name);

  it('Caddy: header blocks, inline headers and +/>/- prefixes', () => {
    const block = [
      'example.com {',
      '  header {',
      '    # security headers',
      `    Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'"`,
      '    -Server',
      '    +X-Content-Type-Options nosniff',
      '    >Referrer-Policy strict-origin',
      '  }',
      '  header /assets/* Cache-Control "max-age=31536000"',
      '}',
    ].join('\n');
    const d = headerDirectives('Caddyfile', block);
    expect(d.map((x) => [x.name, x.line, x.server])).toEqual([
      ['Content-Security-Policy', 4, 'caddy'],
      ['X-Content-Type-Options', 6, 'caddy'],
      ['Referrer-Policy', 7, 'caddy'],
      ['Cache-Control', 9, 'caddy'],
    ]);
    expect(d[0]!.value).toBe("default-src 'self'; script-src 'self' 'unsafe-inline'");
    expect(d[1]!.value).toBe('nosniff');
  });

  it('Caddy: a backtick value may span lines', () => {
    const d = headerDirectives(
      'site.caddy',
      "header {\n  Content-Security-Policy `default-src 'self';\n    img-src data:`\n}\n",
    );
    expect(d).toHaveLength(1);
    expect(d[0]!.line).toBe(2);
    expect(d[0]!.value.replace(/\s+/g, ' ')).toBe("default-src 'self'; img-src data:");
  });

  it('nginx add_header and _headers files', () => {
    const n = headerDirectives(
      'nginx/site.conf',
      'server {\n  # add_header X-Old 1;\n  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;\n}\n',
    );
    expect(n.map((x) => [x.name, x.value, x.line, x.server])).toEqual([
      ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains', 3, 'nginx'],
    ]);
    expect(names('public/_headers', '/*\n  X-Frame-Options: DENY\n  # Note: x\n')).toEqual([
      'X-Frame-Options',
    ]);
    expect(headerDirectives('public/_headers', '/*\n  X-Frame-Options: DENY\n')[0]!.server).toBe(
      'static-headers',
    );
  });

  it('cspOf splits directives with lower-cased names', () => {
    const c = cspOf("default-src 'self'; Script-Src 'self' 'unsafe-inline' ;");
    expect(c.get('script-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(c.get('default-src')).toEqual(["'self'"]);
  });
});
