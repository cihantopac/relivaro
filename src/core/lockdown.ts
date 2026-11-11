import { RelivaroError } from './errors.js';

/**
 * Process-wide execution policy, resolved once per CLI invocation before the command runs (`--lockdown`,
 * `RELIVARO_LOCKDOWN=1`, `--ignore-repo-config`). Lockdown is for hosted scanners that audit untrusted uploads:
 * no child process, no network, no writes into the audited tree, no repository config or inline suppressions.
 * The guards below are defence in depth; the CLI already refuses forbidden commands and flags up front.
 */
const state = { lockdown: false, ignoreRepoConfig: false };

export function configureProcess(opts: { lockdown: boolean; ignoreRepoConfig: boolean }): void {
  state.lockdown = opts.lockdown;
  state.ignoreRepoConfig = opts.lockdown || opts.ignoreRepoConfig;
}

export function isLockedDown(): boolean {
  return state.lockdown;
}

export function repoConfigIgnored(): boolean {
  return state.ignoreRepoConfig;
}

/** Throws the usage error every lockdown refusal uses. */
export function lockdownForbids(what: string): never {
  throw new RelivaroError(
    'USAGE',
    `--lockdown forbids ${what}.`,
    'Lockdown is for hosted scanning of untrusted code; run without --lockdown (and RELIVARO_LOCKDOWN) to allow it.',
  );
}

export function assertNotLockedDown(what: string): void {
  if (state.lockdown) lockdownForbids(what);
}
