// Release safety for the extension. Node built-ins only, so the release workflow can run it before `npm ci`.
//  - storeBuildProblems: wxt.config.ts refuses a store build (WXT_STORE_BUILD=true) that would ship without its backend.
//    A hosted build missing a setting falls back to the demo with only a console warning (src/backend/index.ts): fine
//    for a developer's build, wrong for a store.
//  - releaseProblems: the release workflow checks that the tag is v<package.json version> and that each built manifest
//    carries that version and no `key` (each store assigns its own id).
//
//   node scripts/release-check.mjs --tag v1.2.3 [.output/chrome-mv3/manifest.json …]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** What a hosted build needs (src/backend/index.ts reads the same four). */
export const HOSTED_VARS = ['WXT_AWS_WS_URL', 'WXT_AWS_API_URL', 'WXT_COGNITO_DOMAIN', 'WXT_COGNITO_CLIENT_ID'];

/** Why a store build with this env can't ship; empty when it can (or when it isn't a hosted store build). */
export function storeBuildProblems(env, browser = 'chrome') {
  if (env.WXT_STORE_BUILD !== 'true' || env.WXT_BACKEND !== 'hosted') return [];
  // Safari has no identity API: it signs in through the relay page (the AuthRelayUrl stack output).
  const need = browser === 'safari' ? [...HOSTED_VARS, 'WXT_COGNITO_REDIRECT_URL'] : HOSTED_VARS;
  const missing = need.filter((k) => !env[k]);
  return missing.length ? [`A hosted store build (WXT_STORE_BUILD=true, WXT_BACKEND=hosted) needs ${missing.join(', ')}: the stack outputs (npm run setup writes them to .env.production).`] : [];
}

/** The manifest version WXT writes for a package version: its leading X.Y.Z (a pre-release suffix becomes version_name). */
export const manifestVersionOf = (version) => /^\d+(?:\.\d+){0,3}/.exec(version)?.[0];

/** Why this release can't ship: the tag must be v<version>, and each manifest must carry that version and no key. */
export function releaseProblems({ tag, version, manifests = [] }) {
  const out = [];
  if (tag !== `v${version}`) out.push(`The tag ${tag || '(none)'} isn't v${version} (package.json's version): bump the version or fix the tag.`);
  const want = manifestVersionOf(version);
  for (const { file, manifest } of manifests) {
    if (manifest.version !== want) out.push(`${file}: version ${manifest.version}, expected ${want}.`);
    if ('key' in manifest) out.push(`${file} has a "key": build with WXT_STORE_BUILD=true so the store assigns the id.`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf('--tag');
  const tag = at >= 0 ? args[at + 1] : undefined;
  const files = args.filter((_, i) => at < 0 || (i !== at && i !== at + 1));
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const manifests = files.map((file) => ({ file, manifest: JSON.parse(readFileSync(file, 'utf8')) }));
  const problems = releaseProblems({ tag, version, manifests });
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  console.log(`✓ ${tag} is package.json's version${files.length ? `, and every manifest has it and no key (${files.join(', ')})` : ''}`);
}
