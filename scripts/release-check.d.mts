// Types for scripts/release-check.mjs (imported by wxt.config.ts).
export declare const HOSTED_VARS: string[];
export declare const PRIVACY_VAR: string;
export declare const isHttpsUrl: (raw: string | undefined) => boolean;
export declare function storeBuildProblems(env: Record<string, string | undefined>, browser?: string): string[];
export declare const manifestVersionOf: (version: string) => string | undefined;
export declare function releaseProblems(o: { tag?: string; version: string; manifests?: { file: string; manifest: Record<string, unknown> }[] }): string[];
