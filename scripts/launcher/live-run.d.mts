// Types for scripts/launcher/live-run.mjs (used by tests/launcher.test.ts).
/** The local server's token: made once per computer in <root>/.cache/local-token (mode 0600), then reused. */
export declare function localToken(root?: string): string;
