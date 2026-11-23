// Real-AWS mode, as functions: how the local server recognises each browser's build, and starting the server with
// its output captured. Used by `npm start` (dashboard) and `npm run live` (plain output).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, createWriteStream, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_EXTENSION_ID, FIREFOX_ADDON_ID } from '../extension-id.mjs';
import { track } from './cleanup.mjs';
import { modelEnv } from './lib.mjs';
import { browserById } from './open-browser.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SERVER_LOG = path.join(ROOT, '.cache/server.log');

// Every build carries a one-off token for this run (WXT_AWS_TOKEN): the local server lets nothing in without it (the dev
// extension's id is public, so an Origin header proves nothing). Origins stay its browser check: Chrome's pinned id,
// Firefox's UUID (random per install, pinned here with a Firefox pref) and Safari's scheme (can't be pinned).
const FIREFOX_DEV_UUID = '6a1c0b5e-3c2d-4f7a-9b8e-a5c17c17c117';

/**
 * A token kept for this computer in .cache/local-token, readable only by you (the server never accepts an Origin alone:
 * any program on the computer can forge one). The launcher doesn't use it: liveConfig mints a fresh token every run.
 */
export function localToken(root = ROOT) {
  const file = path.join(root, '.cache', 'local-token');
  mkdirSync(path.dirname(file), { recursive: true });
  const saved = readOwnSecret(file);
  if (saved && /^[\w-]{32,}$/.test(saved)) return saved;
  // Missing, not ours, readable by others, or not a token: replace it. 'wx' creates only if nothing is there (no
  // following a symlink planted in between), already readable only by you.
  try {
    unlinkSync(file);
  } catch {
    // nothing there
  }
  const token = randomBytes(32).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  return token;
}

/**
 * A secret file's contents, only if it is a regular file owned by you that nobody else can read. Opened without
 * following symlinks and checked on the open file itself, so it can't be swapped between the check and the read.
 */
function readOwnSecret(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = fstatSync(fd);
    const mine = st.isFile() && (process.platform === 'win32' || ((st.mode & 0o077) === 0 && st.uid === process.getuid?.()));
    return mine ? readFileSync(fd, 'utf8').trim() : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Everything that ties one browser's build to the local server: origin, token, build env, Firefox prefs.
 * `allowFixes`: the citizens may fix findings (AWS_CITY_ALLOW_FIXES=true; each fix is still approved).
 */
export function liveConfig(browser, { port = process.env.PORT ?? '8787', allowFixes = false } = {}) {
  const kind = browserById(browser).build;
  const token = randomBytes(24).toString('base64url');
  const origin = {
    chrome: `chrome-extension://${process.env.AWS_CITY_EXTENSION_ID ?? DEV_EXTENSION_ID}`,
    firefox: `moz-extension://${FIREFOX_DEV_UUID}`,
    safari: 'safari-web-extension://*',
  }[kind];
  return {
    port,
    origin,
    token,
    allowFixes,
    url: `http://127.0.0.1:${port}`,
    extEnv: { WXT_BACKEND: 'aws', WXT_AWS_WS_URL: `ws://127.0.0.1:${port}/ws`, WXT_AWS_API_URL: `http://127.0.0.1:${port}`, WXT_AWS_TOKEN: token },
    firefoxPrefs: [`extensions.webextensions.uuids=${JSON.stringify({ [FIREFOX_ADDON_ID]: FIREFOX_DEV_UUID })}`],
  };
}

/** Is something already listening on this local port (e.g. an AWS City server left running elsewhere)? */
export const portBusy = (port, host = '127.0.0.1') =>
  new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(Number(port), host);
  });

/**
 * Starts the AWS City server with the player's AWS profile. Its output goes to .cache/server.log and to `onLog`
 * line by line. `ready` resolves true once /health answers (false if it exits or takes over a minute).
 * `models` is the Region's Claude pair (`modelsFor`); without it the server keeps its own `us.` defaults.
 */
export function startServer({ profile, region, models, env = {}, cfg, onLog = () => {} }) {
  mkdirSync(path.dirname(SERVER_LOG), { recursive: true });
  // Only you can read the server's log (it names your AWS account and resources).
  const file = createWriteStream(SERVER_LOG, { flags: 'w', mode: 0o600 });
  file.on('open', (fd) => fchmodSync(fd, 0o600)); // on the open file, not the path (an existing log keeps its old mode)
  // Its own process group (not on Windows), so stopping it stops npm, tsx and the server under them together.
  const group = process.platform !== 'win32';
  const child = spawn('npm', ['start'], {
    cwd: path.join(ROOT, 'server'),
    shell: !group,
    detached: group,
    env: {
      ...process.env,
      AWS_CITY_PROFILE: profile,
      ...(region ? { AWS_CITY_REGION: region } : {}),
      ...(models ? modelEnv(models, process.env) : {}),
      ...env,
      EXTENSION_ORIGIN: cfg.origin,
      PORT: cfg.port,
      AWS_CITY_TOKEN: cfg.token,
      ...(cfg.allowFixes ? { AWS_CITY_ALLOW_FIXES: 'true' } : {}),
    },
  });
  let partial = '';
  const read = (chunk) => {
    file.write(chunk);
    const lines = (partial + chunk).split('\n');
    partial = lines.pop() ?? '';
    // eslint-disable-next-line no-control-regex
    for (const l of lines) if (l.trim()) onLog(l.replace(/\x1b\[[0-9;]*m/g, '').trim());
  };
  child.stdout.on('data', read);
  child.stderr.on('data', read);
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const ready = (async () => {
    let gone = false;
    void exited.then(() => (gone = true));
    for (let i = 0; i < 60 && !gone; i++) {
      try {
        if ((await fetch(`${cfg.url}/health`)).ok) return true;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  })();
  const stop = () => {
    try {
      if (group) process.kill(-child.pid, 'SIGTERM');
      else child.kill();
    } catch {
      child.kill();
    }
  };
  track(child, stop);
  return { child, ready, exited, stop };
}
