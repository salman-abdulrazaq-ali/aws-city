// Opens a real (headed) Chromium window with AWS City loaded — branded Chrome ignores --load-extension.
// Usage: npm run open [-- --console]   (keeps progress in .cache/chrome-profile between runs)
//        npm run open:hosted [-- --console]   the live city your setup deployed: built for it (--mode production,
//        from .env.production; --no-build when setup just built it), in its own profile (.cache/chrome-profile-hosted)
// `npm run open` passes --build: the extension is built first, quietly (one line; WXT's own output only if it fails).
// Opens the city and the practice console (practice.html inside the extension: it looks like the AWS console, and
// nothing there touches AWS). The real AWS console sign-in opens only with --console, or the stdin command `console`
// (the `a` key in npm start).
import './launcher/require-node.mjs';
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readlinkSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ALREADY_OPEN, HOSTED_PROFILE, hostedBuildProblem, lockPid } from './launcher/lib.mjs';

const hosted = process.argv.includes('--hosted');
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);
if (hosted) {
  const problem = hostedBuildProblem({ envProduction: read('.env.production') });
  if (problem) {
    console.error(`\n✗ ${problem}\n`);
    process.exit(1);
  }
}

// `npm install` doesn't download Playwright's browser: fetch it the first time instead of failing with a stack trace.
if (!existsSync(chromium.executablePath())) {
  console.log('▶ Downloading the AWS City browser (Chrome for Testing, one time)…');
  const ok = spawnSync('npx', ['playwright', 'install', 'chromium'], { stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
  if (!ok) {
    console.error('\n✗ The download failed. Run  npx playwright install chromium  to see why, then  npm run open  again.\n');
    process.exit(1);
  }
}

// The build prints a few hundred lines a newcomer doesn't need: a one-line summary, and everything only on failure.
// The live city is always built for it (seconds), so a demo build left in .output/chrome-mv3 is never opened by mistake.
if (process.argv.includes('--build') || (hosted && !process.argv.includes('--no-build'))) {
  console.log(hosted ? '▶ Building your live AWS City (a few seconds)…' : '▶ Building AWS City (under a minute)…');
  const started = Date.now();
  const r = spawnSync('npx', hosted ? ['wxt', 'build', '--mode', 'production'] : ['wxt', 'build', '-b', 'chrome'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  if (r.status !== 0) {
    process.stdout.write(r.stdout ?? '');
    process.stderr.write(r.stderr ?? '');
    console.error(`\n✗ The build failed${r.error ? ` (${r.error.message})` : ''}: its output is above. Fix it, then run  npm run ${hosted ? 'open:hosted' : 'open'}  again.\n`);
    process.exit(1);
  }
  console.log(`✓ Built in ${Math.round((Date.now() - started) / 1000)} s.`);
}

const ext = path.resolve('.output/chrome-mv3');
const profile = path.resolve(hosted ? HOSTED_PROFILE : '.cache/chrome-profile');
if (hosted) {
  const problem = hostedBuildProblem({ envProduction: read('.env.production'), manifest: read(path.join(ext, 'manifest.json')) });
  if (problem) {
    console.error(`\n✗ ${problem}\n`);
    process.exit(1);
  }
}

// One Chrome per profile folder: if another AWS City window already holds this one, a second launch would just hand
// over to it and exit. Say so plainly (npm start reads the marker line and offers to close it).
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
let holder;
try {
  holder = lockPid(readlinkSync(path.join(profile, 'SingletonLock')));
} catch {
  holder = undefined;
}
if (holder && holder !== process.pid && alive(holder)) {
  console.error(`AWS City is already open in another Chrome for Testing window (pid ${holder}). Close that window, then run this again.`);
  console.log(`${ALREADY_OPEN} ${holder}`);
  process.exit(3);
}
// A lock left by a browser that crashed: clear it so this launch can take the profile.
if (holder) for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) rmSync(path.join(profile, f), { force: true });

let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: false,
    viewport: null,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--window-size=1500,950'],
  });
} catch (e) {
  const msg = String(e?.message ?? e);
  if (/existing browser session|ProcessSingleton|has been closed/i.test(msg)) {
    console.error('AWS City is already open in another Chrome for Testing window. Close it, then run this again.');
    process.exit(3);
  }
  console.error(`The browser did not start: ${msg.split('\n')[0]}`);
  process.exit(1);
}
let [sw] = ctx.serviceWorkers();
sw ??= await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;

// The safe practice console for the Copilot and the Lookout: the extension's own page (src/entrypoints/practice/),
// with S3, EC2, DynamoDB, Lambda, RDS, CloudFront, SQS and IAM. Every console.aws.amazon.com URL is the real console.
const PRACTICE = `chrome-extension://${id}/practice.html`;
const DEMO = `${PRACTICE}#/s3`;
const CONSOLE = 'https://console.aws.amazon.com/s3/home';
const cityUrl = `chrome-extension://${id}/city.html`;
// A first install opens the city itself (runtime.onInstalled): give it a moment, then reuse that tab.
const isCity = (p) => p.url().startsWith(cityUrl);
const cityTab = ctx.pages().find(isCity) ?? (await ctx.waitForEvent('page', { predicate: isCity, timeout: 1500 }).catch(() => undefined));
const blank = ctx.pages().find((p) => p !== cityTab && (p.url() === 'about:blank' || p.url() === ''));
// The live city has no practice console: its agents work in your real AWS account, after your approval.
if (!hosted) await (blank ?? (await ctx.newPage())).goto(DEMO).catch(() => {});
if (process.argv.includes('--console')) await (await ctx.newPage()).goto(CONSOLE).catch(() => {});
const city = cityTab ?? (hosted ? blank : undefined) ?? (await ctx.newPage());
if (!city.url().startsWith(cityUrl)) await city.goto(cityUrl);
await city.bringToFront();
city.on('pageerror', (e) => console.log('page error:', e.message));
// Say plainly what just opened: a new window with two tabs, and which one is which.
console.log(
  (hosted
    ? [
        '',
        '✓ Your live AWS City is open in a new browser window (Chrome for Testing).',
        '  • Sign in: ⋯ → Sign in (your password and authenticator code, or Google). Progress is saved to your account.',
        '  • This window keeps its own profile, so the demo’s practice progress never mixes in.',
        '  Close the window to stop; open it again with  npm run open:hosted',
        '',
      ]
    : [
        '',
        '✓ AWS City is open in a new browser window (Chrome for Testing).',
        '  • The tab in front is your city. It starts in Demo mode: a practice account, nothing real is created or charged.',
        '  • The other tab is the practice console: it looks like the AWS console, and nothing there touches AWS.',
        '  Close the window to stop.',
        '',
      ]
  ).join('\n'),
);
// `npm start` waits for this line, then drives the window with one-word commands on stdin.
console.log(`READY ${id}`);

/** Brings an open tab to the front, or opens it. */
const focus = async (url, match = url) => {
  const page = ctx.pages().find((p) => p.url().startsWith(match)) ?? (await ctx.newPage());
  if (!page.url().startsWith(match)) await page.goto(url).catch(() => {});
  await page.bringToFront();
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  for (const cmd of chunk.split('\n').map((c) => c.trim())) {
    if (cmd === 'city') void focus(cityUrl);
    else if (cmd === 'practice') void focus(DEMO, PRACTICE);
    else if (cmd === 'console') void focus(CONSOLE, 'https://console.aws.amazon.com');
    else if (cmd === 'quit') void ctx.close();
  }
});

await new Promise((resolve) => ctx.on('close', resolve));
process.exit(0);
