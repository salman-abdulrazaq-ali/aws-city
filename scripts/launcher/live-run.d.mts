// Types for scripts/launcher/live-run.mjs (used by tests/launcher.test.ts).
export interface LiveConfig {
  port: string;
  origin: string;
  /** A fresh random token each run, for every browser: the server's AWS_CITY_TOKEN and the build's WXT_AWS_TOKEN. */
  token: string;
  allowFixes: boolean;
  url: string;
  extEnv: Record<string, string>;
  firefoxPrefs: string[];
}
export declare function liveConfig(browser: string, o?: { port?: string; allowFixes?: boolean }): LiveConfig;
export declare const SERVER_LOG: string;
/** A token kept in <root>/.cache/local-token (mode 0600), made once, then reused. liveConfig mints its own each run. */
export declare function localToken(root?: string): string;
