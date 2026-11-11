declare const __RELIVARO_VERSION__: string | undefined;

/** Injected by the bundler; falls back to package.json when running from source (tests). */
export const VERSION: string =
  typeof __RELIVARO_VERSION__ === 'string'
    ? __RELIVARO_VERSION__
    : (process.env.RELIVARO_VERSION_OVERRIDE ?? '1.5.0');
