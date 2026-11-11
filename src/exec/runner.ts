import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { RelivaroError } from '../core/errors.js';
import { assertNotLockedDown } from '../core/lockdown.js';
import { redact } from '../core/secrets.js';

/**
 * Restricted subprocess execution for project tools (tests, builds, type checkers).
 *
 * Guarantees:
 * - no shell: argv is passed directly, so shell metacharacters in arguments are inert;
 * - scrubbed environment: only an allowlist of variables is inherited, secrets/tokens never are;
 * - hard timeout with process-tree termination;
 * - bounded output capture, redacted before it is returned;
 * - stdin closed (no interactive prompts).
 *
 * Not guaranteed (documented in docs/SECURITY_MODEL.md): network isolation and filesystem isolation. Project
 * commands run with the user's permissions; that is why every execution requires `--allow-exec`.
 */
export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Extra environment variables (merged after scrubbing). */
  env?: Record<string, string>;
  maxOutputBytes?: number;
  /** Required acknowledgement that project code may run. */
  allowExec: boolean;
  /** Aborting kills the command's process tree (SIGTERM/SIGINT of the CLI). */
  signal?: AbortSignal;
}

export interface RunResult {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  /** Spawn error (e.g. command not found). */
  error?: string;
}

const ENV_ALLOW = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'ProgramFiles',
  'ProgramData',
  'NVM_DIR',
  'NVM_BIN',
  'VOLTA_HOME',
  'FNM_DIR',
  'PNPM_HOME',
  'COREPACK_HOME',
  'JAVA_HOME',
  'ANDROID_HOME',
  'ANDROID_SDK_ROOT',
  'FLUTTER_ROOT',
  'GOPATH',
  'GOROOT',
  'GOCACHE',
  'GOMODCACHE',
  'CARGO_HOME',
  'RUSTUP_HOME',
  'PYENV_ROOT',
  'VIRTUAL_ENV',
  'CONDA_PREFIX',
  'COMPOSER_HOME',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'DEVELOPER_DIR',
  'SDKROOT',
];

const SECRETISH =
  /(?:TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY|SESSION|COOKIE|AUTH)/i;

export function scrubbedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOW) {
    const v = process.env[k];
    if (v !== undefined && !SECRETISH.test(k)) env[k] = v;
  }
  env.CI = 'true';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.NO_UPDATE_NOTIFIER = '1';
  env.NPM_CONFIG_UPDATE_NOTIFIER = 'false';
  env.NPM_CONFIG_FUND = 'false';
  env.NPM_CONFIG_AUDIT = 'false';
  env.GIT_TERMINAL_PROMPT = '0';
  env.RELIVARO = '1';
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}

/** Splits a command string into argv without invoking a shell. Supports quotes and backslash escapes. */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else if (c === '\\' && i + 1 < cmd.length && process.platform !== 'win32') cur += cmd[++i];
    else {
      cur += c;
      has = true;
    }
  }
  if (quote) throw new RelivaroError('USAGE', `Unterminated quote in command: ${cmd}`);
  if (cur || has) out.push(cur);
  if (out.some((a) => /^(?:&&|\|\||;|\||>|>>|<)$/.test(a)))
    throw new RelivaroError(
      'USAGE',
      `Shell operators are not supported in commands: ${cmd}`,
      'Relivaro runs commands without a shell. Put composite commands in a package.json script or a script file.',
    );
  return out;
}

/** Resolves an executable on PATH (and Windows PATHEXT) so we can spawn without `shell: true`. */
export function whichSync(cmd: string, pathEnv = process.env.PATH ?? process.env.Path ?? ''): string | null {
  if (cmd.includes('/') || cmd.includes('\\')) return existsSync(cmd) ? cmd : null;
  const exts =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';') : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, cmd + ext.toLowerCase());
      if (existsSync(p)) return p;
      const p2 = join(dir, cmd + ext);
      if (existsSync(p2)) return p2;
    }
  }
  return null;
}

export async function runCommand(argv: string[], opts: RunOptions): Promise<RunResult> {
  assertNotLockedDown('running project commands');
  if (!opts.allowExec)
    throw new RelivaroError(
      'EXEC_NOT_ALLOWED',
      `Running "${argv.join(' ')}" executes project code and requires --allow-exec.`,
      'Re-run with --allow-exec if you trust this project, ideally inside a container or VM.',
    );
  const [cmd, ...args] = argv;
  if (!cmd) throw new RelivaroError('USAGE', 'Empty command');
  const display = argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  const env = scrubbedEnv(opts.env);
  const resolved = whichSync(cmd, env.PATH ?? env.Path) ?? cmd;
  const maxBytes = opts.maxOutputBytes ?? 2 * 1024 * 1024;
  // Windows .cmd/.bat shims (npm, pnpm, yarn) cannot be spawned without a shell. Route them through cmd.exe
  // with every argument quoted; arguments come from Relivaro or the project's own configuration.
  const isWinShim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(resolved);
  const file = isWinShim ? (process.env.COMSPEC ?? 'cmd.exe') : resolved;
  const fileArgs = isWinShim ? ['/d', '/s', '/c', `"${[resolved, ...args].map(winQuote).join(' ')}"`] : args;

  return new Promise((resolvePromise) => {
    const started = performance.now();
    let stdout = '';
    let stderr = '';
    let size = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(file, fileArgs, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: isWinShim,
      detached: process.platform !== 'win32',
    });
    const append = (which: 'out' | 'err', chunk: Buffer) => {
      if (size >= maxBytes) {
        truncated = true;
        return;
      }
      const room = maxBytes - size;
      const s = chunk.subarray(0, room).toString('utf8');
      size += Math.min(chunk.length, room);
      if (chunk.length > room) truncated = true;
      if (which === 'out') stdout += s;
      else stderr += s;
    };
    child.stdout?.on('data', (c: Buffer) => append('out', c));
    child.stderr?.on('data', (c: Buffer) => append('err', c));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, opts.timeoutMs);
    const onAbort = () => killTree(child.pid);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const finish = (exitCode: number | null, signal: string | null, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolvePromise({
        command: display,
        exitCode,
        signal,
        timedOut,
        durationMs: Math.round(performance.now() - started),
        stdout: redact(stripAnsi(stdout)),
        stderr: redact(stripAnsi(stderr)),
        truncated,
        error,
      });
    };
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function winQuote(a: string): string {
  return /[\s"&|<>^%]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');
}

/** Last `n` lines of output, for evidence. */
export function tail(s: string, n = 40): string {
  const lines = s.trimEnd().split('\n');
  return lines.slice(-n).join('\n');
}
