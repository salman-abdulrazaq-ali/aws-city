// Builds the demo (the in-browser mock backend) whatever the .env files say: `npm run setup` writes .env.production
// for a deployment, which a plain `wxt build` reads, and process env beats .env files (WXT's and Vite's loadEnv).
// `npm run smoke` and `npm run smoke:copilot` build with it.   node scripts/build-demo.mjs [wxt build options]
import { spawnSync } from 'node:child_process';

// One command string through a shell: npx is a .cmd script on Windows (as in the launcher, WIN_SHELL), and a string
// rather than an argument list avoids Node's DEP0190 warning.
const r = spawnSync(['npx', 'wxt', 'build', ...process.argv.slice(2)].join(' '), { stdio: 'inherit', shell: true, env: { ...process.env, WXT_BACKEND: 'mock' } });
if (r.error) console.error(`Couldn't run WXT: ${r.error.message}`);
process.exit(r.status ?? 1);
