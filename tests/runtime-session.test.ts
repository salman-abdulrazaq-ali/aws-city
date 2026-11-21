import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ConnectionStatus, SaveState } from '@/backend/AgentBackend';
import type { ClientCommand, Progress, ServerEvent } from '@/backend/contract';
import { landmarkOf } from '@/state/cities';

/** A backend the test drives: it reports statuses on demand and records what the runtime sends. */
class FakeBackend {
  readonly kind = 'server' as const;
  readonly deployMode = 'guarded' as const;
  private statuses = new Set<(s: ConnectionStatus) => void>();
  private events = new Set<(e: ServerEvent) => void>();
  private saves = new Set<(s: SaveState) => void>();
  onSave(cb: (s: SaveState) => void) {
    this.saves.add(cb);
    return () => void this.saves.delete(cb);
  }
  save(s: SaveState) {
    for (const cb of this.saves) cb(s);
  }
  sent: ClientCommand[] = [];
  puts: Progress[] = [];
  remote: Progress | null | Error = null;
  player?: string;
  connect() {}
  disconnect() {}
  onEvent(cb: (e: ServerEvent) => void) {
    this.events.add(cb);
    return () => void this.events.delete(cb);
  }
  onStatus(cb: (s: ConnectionStatus) => void) {
    this.statuses.add(cb);
    return () => void this.statuses.delete(cb);
  }
  status(s: ConnectionStatus) {
    for (const cb of this.statuses) cb(s);
  }
  send(cmd: ClientCommand) {
    this.sent.push(cmd);
  }
  async uploadScreenshot() {
    return 'shot-1';
  }
  async getProgress() {
    if (this.remote instanceof Error) throw this.remote;
    return this.remote;
  }
  putProgress(p: Progress) {
    this.puts.push(p);
  }
  playerId() {
    return this.player;
  }
  async signOut() {
    this.status('signed-out');
  }
}

let fake: FakeBackend;
vi.mock('@/backend', () => ({ createBackend: () => fake }));
vi.mock('@/capture/screenshot', () => ({
  captureVisibleTab: async () => ({ ok: true, dataUrl: 'data:image/jpeg;base64,AAAA' }),
  hasCapturePermission: async () => true,
  requestCapturePermission: async () => true,
}));

const progress = (landmarks: Progress['landmarks'], updatedAt = new Date().toISOString()): Progress => ({ version: 1, landmarks, updatedAt });
const settle = () => vi.advanceTimersByTimeAsync(2_000);

async function boot() {
  vi.resetModules();
  const rt = await import('@/app/runtime');
  const { useCity } = await import('@/state/store');
  rt.startRuntime('panel');
  await settle();
  return { rt, useCity };
}

describe('runtime sessions', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    fake = new FakeBackend();
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never pushes progress before the account’s copy has been read, then pushes the merge', async () => {
    fake.remote = new Error('GET /progress → 503');
    const { useCity } = await boot();
    fake.status('connected');
    useCity.getState().loadProgress(progress({ lambda: { discovered: true, xp: 10 } }));
    await settle();
    expect(fake.puts).toEqual([]);
    // Saved locally all the same.
    expect(landmarkOf((await fakeBrowser.storage.local.get('progress')).progress as Progress, 'lambda')).toBeTruthy();

    fake.remote = progress({ s3: { discovered: true, xp: 40 } }, '2026-01-01T00:00:00Z');
    fake.status('disconnected');
    fake.status('connected');
    await settle();
    expect(fake.puts.length).toBeGreaterThan(0);
    expect(['lambda', 's3'].every((id) => landmarkOf(fake.puts[0]!, id))).toBe(true);
  });

  it('a refused save shows "Not saved" until a save goes through; the next player never inherits it', async () => {
    const { useCity } = await boot();
    fake.status('connected');
    await settle();
    expect(useCity.getState().saveRefused).toBe(false);
    fake.save('refused');
    expect(useCity.getState().saveRefused).toBe(true);
    fake.save('saved');
    expect(useCity.getState().saveRefused).toBe(false);
    fake.save('refused');
    fake.status('signed-out');
    await settle();
    expect(useCity.getState().saveRefused).toBe(false);
  });

  it('a session that died parks this device’s progress for the same player only', async () => {
    fake.player = 'player-a';
    const { useCity } = await boot();
    fake.status('connected');
    await settle();
    useCity.getState().loadProgress(progress({ lambda: { discovered: true, xp: 10 } }));
    await settle();
    fake.status('signed-out'); // the refresh token was rejected: not a sign-out the player asked for
    await settle();
    expect(useCity.getState().progress.landmarks).toEqual({});
    expect((await fakeBrowser.storage.local.get('progress')).progress).toBeUndefined();
    expect((await fakeBrowser.storage.local.get('progress.parked'))['progress.parked']).toMatchObject({ player: 'player-a' });

    // Someone else signs in on this device: they never see it, and it's gone.
    fake.player = 'player-b';
    fake.status('connected');
    await settle();
    expect(useCity.getState().progress.landmarks).toEqual({});
    expect((await fakeBrowser.storage.local.get('progress.parked'))['progress.parked']).toBeUndefined();
  });

  it('the same player signing back in gets the parked progress back', async () => {
    fake.player = 'player-a';
    const { useCity } = await boot();
    fake.status('connected');
    await settle();
    useCity.getState().loadProgress(progress({ lambda: { discovered: true, xp: 10 } }));
    await settle();
    fake.status('signed-out');
    await settle();
    fake.status('connected');
    await settle();
    expect(landmarkOf(useCity.getState().progress, 'lambda')).toBeTruthy();
    expect((await fakeBrowser.storage.local.get('progress.parked'))['progress.parked']).toBeUndefined();
  });

  it('a copy saved by player A with a dead token at startup never reaches player B', async () => {
    await fakeBrowser.storage.local.set({ progress: progress({ lambda: { discovered: true, xp: 10 } }), 'progress.owner': 'player-a' });
    fake.remote = new Error('GET /progress → 401 (not signed in yet)');
    const { useCity } = await boot();
    fake.status('signed-out'); // the refresh token died while the browser was closed
    await settle();
    expect(useCity.getState().progress.landmarks).toEqual({});

    fake.player = 'player-b';
    fake.remote = null; // B is new here
    fake.status('connected');
    await settle();
    useCity.getState().loadProgress({ ...useCity.getState().progress, landmarks: { s3: { discovered: true, xp: 5 } }, updatedAt: new Date().toISOString() });
    await settle();
    expect(landmarkOf(useCity.getState().progress, 'lambda')).toBeUndefined();
    expect(fake.puts.length).toBeGreaterThan(0);
    expect(fake.puts.some((p) => p.landmarks.lambda)).toBe(false);
    expect(JSON.stringify(await fakeBrowser.storage.local.get(null))).not.toMatch(/lambda/);
    expect((await fakeBrowser.storage.local.get('progress.owner'))['progress.owner']).toBe('player-b');
  });

  it('player A signing back in after a dead token gets their copy back', async () => {
    await fakeBrowser.storage.local.set({ progress: progress({ lambda: { discovered: true, xp: 10 } }), 'progress.owner': 'player-a' });
    fake.remote = new Error('GET /progress → 401 (not signed in yet)');
    const { useCity } = await boot();
    fake.status('signed-out');
    await settle();
    fake.player = 'player-a';
    fake.remote = progress({}, '2026-01-01T00:00:00Z');
    fake.status('connected');
    await settle();
    expect(landmarkOf(useCity.getState().progress, 'lambda')).toBeTruthy();
    expect(landmarkOf(fake.puts.at(-1)!, 'lambda')).toBeTruthy();
    expect((await fakeBrowser.storage.local.get('progress.parked'))['progress.parked']).toBeUndefined();
  });

  it('a copy earned before anyone signed in still merges into the first sign-in', async () => {
    await fakeBrowser.storage.local.set({ progress: progress({ lambda: { discovered: true, xp: 10 } }), 'progress.owner': '' });
    fake.remote = new Error('GET /progress → 401 (not signed in yet)');
    const { useCity } = await boot();
    expect(landmarkOf(useCity.getState().progress, 'lambda')).toBeTruthy();
  });

  it('an explicit sign-out keeps nothing on the device', async () => {
    fake.player = 'player-a';
    const { rt, useCity } = await boot();
    fake.status('connected');
    await settle();
    useCity.getState().loadProgress(progress({ lambda: { discovered: true, xp: 10 } }));
    await settle();
    rt.signOut();
    await settle();
    expect(useCity.getState().progress.landmarks).toEqual({});
    expect(await fakeBrowser.storage.local.get(['progress', 'progress.parked', 'progress.owner'])).toEqual({});
  });

  it('a surface that hasn’t read the account’s copy keeps the other surface’s owner tag when it absorbs its progress', async () => {
    fake.remote = new Error('GET /progress → 503'); // this surface never manages to pull
    const { useCity } = await boot();
    fake.status('connected');
    await settle();
    // The other surface (signed in as player-a, pulled) saves its copy.
    await fakeBrowser.storage.local.set({ progress: progress({ lambda: { discovered: true, xp: 10 } }), 'progress.owner': 'player-a' });
    await settle();
    expect(landmarkOf(useCity.getState().progress, 'lambda')).toBeTruthy();
    // This surface earns something too: its save must keep player-a's tag, not strip it to ''.
    useCity.getState().loadProgress({ ...useCity.getState().progress, landmarks: { ...useCity.getState().progress.landmarks, s3: { discovered: true, xp: 5 } } });
    await settle();
    const saved = await fakeBrowser.storage.local.get(['progress', 'progress.owner']);
    expect(landmarkOf(saved.progress as Progress, 's3')).toBeTruthy();
    expect(saved['progress.owner']).toBe('player-a');
  });

  it('the bill switch reaches a new connection only after the account’s copy is merged', async () => {
    // This device last saw the bill on; another device turned it off since (newer copy on the server).
    await fakeBrowser.storage.local.set({ progress: { ...progress({}, '2026-01-01T00:00:00Z'), bill: true }, 'progress.owner': '' });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    fake.remote = { ...progress({}, '2026-02-01T00:00:00Z'), bill: false };
    const get = fake.getProgress.bind(fake);
    fake.getProgress = async () => {
      await gate;
      return get();
    };
    const { useCity } = await boot();
    expect(useCity.getState().progress.bill).toBe(true);
    fake.status('connected');
    await settle();
    expect(fake.sent.filter((c) => c.action === 'bill.enable')).toEqual([]); // not before the pull
    release();
    await settle();
    expect(useCity.getState().progress.bill).toBe(false);
    expect(fake.sent.filter((c) => c.action === 'bill.enable')).toEqual([]); // the revoked 'on' is never replayed

    // A copy that says on (after the merge) is sent once the pull lands, and again after a reconnect's pull.
    fake.getProgress = get;
    fake.remote = { ...progress({}, new Date(Date.now() + 1000).toISOString()), bill: true };
    fake.status('disconnected');
    fake.status('connected');
    expect(fake.sent.filter((c) => c.action === 'bill.enable')).toEqual([]);
    await settle();
    expect(fake.sent.filter((c) => c.action === 'bill.enable')).toEqual([{ action: 'bill.enable', on: true }]);
  });

  it('after the authenticator is on, only a refused link or verify is resent', async () => {
    const { rt } = await boot();
    const vf = 'arn:aws:iam::123456789012:role/aws-city-player';
    expect(rt.afterMfa({ action: 'account.link', region: 'eu-west-1' }).resend).toEqual({ action: 'account.link', region: 'eu-west-1' });
    expect(rt.afterMfa({ action: 'account.verify', roleArn: vf }).resend).toEqual({ action: 'account.verify', roleArn: vf });
    expect(rt.afterMfa({ action: 'deploy.approve' })).toEqual({ message: expect.stringMatching(/Approve again/) });
    expect(rt.afterMfa({ action: 'finding.fix' })).toEqual({ message: expect.stringMatching(/Fix again/) });
    // resource.remove needs MFA too: the hint says to press Take it down again (signed in or signed out).
    expect(rt.afterMfa({ action: 'resource.remove' })).toEqual({ message: expect.stringMatching(/Take it down again/) });
    expect(rt.afterMfa({ action: 'resource.remove' }, true).message).toMatch(/then press Take it down again/);
    expect(rt.afterMfa(undefined).resend).toBeUndefined();
    const sent = new Map([['r1', { action: 'account.link', region: 'eu-west-1' } as const]]);
    expect(rt.refusedBy({ requestId: 'r1' }, sent)).toEqual({ action: 'account.link', region: 'eu-west-1' });
    expect(rt.refusedBy({}, sent)).toEqual({ action: 'deploy.approve' });
    expect(rt.refusedBy({ requestId: 'unknown' }, sent)).toBeUndefined();
  });

  it('confirming the authenticator resends a refused link in its own Region, and nothing after a refused approval', async () => {
    const { rt, useCity } = await boot();
    Object.assign(fake, { confirmTotp: async () => {} });
    fake.status('connected');
    await settle();
    const fire = (e: ServerEvent) => (fake as unknown as { events: Set<(e: ServerEvent) => void> }).events.forEach((cb) => cb(e));

    const requestId = rt.linkAccount('eu-west-1')!;
    fire({ type: 'error', requestId, code: 'mfa_required', message: 'MFA first' });
    expect(useCity.getState().account.mfaRequired).toBe(true);
    fake.sent = [];
    await rt.confirmMfaSetup('123456');
    expect(useCity.getState().account.mfaRequired).toBe(false);
    expect(fake.sent).toEqual([{ action: 'account.link', requestId: expect.any(String), region: 'eu-west-1' }]);

    rt.decideDeploy('d-1', true);
    fire({ type: 'error', code: 'mfa_required', message: 'MFA first' });
    fake.sent = [];
    await rt.confirmMfaSetup('123456');
    expect(fake.sent).toEqual([]);
    expect(useCity.getState().account.mfaRequired).toBe(false);
  });

  it('turning the authenticator on signs the hosted player out: they are told to sign in again, and nothing is resent', async () => {
    const { rt, useCity } = await boot();
    fake.status('connected');
    await settle();
    // The hosted backend ends every session once TOTP is on (src/backend/auth.ts confirmTotp).
    Object.assign(fake, { confirmTotp: async () => fake.status('signed-out') });
    const fire = (e: ServerEvent) => (fake as unknown as { events: Set<(e: ServerEvent) => void> }).events.forEach((cb) => cb(e));
    const requestId = rt.linkAccount('eu-west-1')!;
    fire({ type: 'error', requestId, code: 'mfa_required', message: 'MFA first' });
    fake.sent = [];
    useCity.getState().clearToasts(); // the refusal's error toast would hold the next one in the queue
    expect(await rt.confirmMfaSetup('123456')).toBe(true);
    expect(fake.sent).toEqual([]);
    expect(useCity.getState().toasts.map((t) => t.text)).toContainEqual(expect.stringMatching(/sign in again with your app’s code, then press Get my setup link again/));
    expect(rt.afterMfa({ action: 'deploy.approve' }, true).message).toMatch(/ask for the change again/);
  });

  it('"Your data" (sign out, delete my account) is for signed-in players only, never the local server', async () => {
    const { rt } = await boot();
    Object.assign(fake, { deleteAccount: async () => {} });
    expect(rt.canDeleteAccount()).toBe(false); // the local server: no accounts, its sign-out does nothing
    Object.assign(fake, { hosted: true });
    expect(rt.canDeleteAccount()).toBe(true);
  });

  it('v2.17: a link is made for the Region the player picked (AllowFixes when ticked), and a refused one is resent with both', async () => {
    const { rt, useCity } = await boot();
    Object.assign(fake, { confirmTotp: async () => {} });
    fake.status('connected');
    await settle();
    const fire = (e: ServerEvent) => (fake as unknown as { events: Set<(e: ServerEvent) => void> }).events.forEach((cb) => cb(e));
    const requestId = rt.linkAccount('ap-southeast-2', { allowFixes: true })!;
    expect(fake.sent.at(-1)).toEqual({ action: 'account.link', requestId, region: 'ap-southeast-2', allowFixes: true });
    // Nothing is assumed before the link arrives (a refused request leaves step 2 as it was).
    expect(useCity.getState().account.allowFixes).toBeUndefined();
    fire({ type: 'error', requestId, code: 'mfa_required', message: 'MFA first' });
    fake.sent = [];
    await rt.confirmMfaSetup('123456');
    const resent = fake.sent[0] as Extract<ClientCommand, { action: 'account.link' }>;
    expect(fake.sent).toEqual([{ action: 'account.link', requestId: expect.any(String), region: 'ap-southeast-2', allowFixes: true }]);
    fire({ type: 'account.linkUrl', requestId: resent.requestId, url: 'https://ap-southeast-2.console.aws.amazon.com/x', externalId: 'e' });
    expect(useCity.getState().account).toMatchObject({ linkRegion: 'ap-southeast-2', allowFixes: true, linkUrl: 'https://ap-southeast-2.console.aws.amazon.com/x' });
    // Unticked: no allowFixes field at all, and step 2's box clears with the new link.
    const plain = rt.linkAccount('eu-west-1')!;
    expect(fake.sent.at(-1)).toEqual({ action: 'account.link', requestId: plain, region: 'eu-west-1' });
    fire({ type: 'account.linkUrl', requestId: plain, url: 'https://eu-west-1.console.aws.amazon.com/x', externalId: 'e' });
    expect(useCity.getState().account).toMatchObject({ linkRegion: 'eu-west-1', allowFixes: false });
  });

  it('v2.17: Disconnect sends account.unlink, and Take it down sends resource.remove (the server asks for approval)', async () => {
    const { rt, useCity } = await boot();
    fake.status('connected');
    await settle();
    const requestId = rt.unlinkAccount()!;
    expect(fake.sent.at(-1)).toEqual({ action: 'account.unlink', requestId });
    expect(useCity.getState().account.unlinking).toBe(requestId);
    const remove = rt.removeResource('table', 'city-orders')!;
    expect(fake.sent.at(-1)).toEqual({ action: 'resource.remove', requestId: remove, kind: 'table', id: 'city-orders' });
  });

  it('v2.17: Check again is one read-only account.recheck (no setup link, no verify); its answer and its refusal are this tab’s own', async () => {
    const { rt, useCity } = await boot();
    fake.status('connected');
    await settle();
    const fire = (e: ServerEvent) => (fake as unknown as { events: Set<(e: ServerEvent) => void> }).events.forEach((cb) => cb(e));
    expect(rt.recheckAccount()).toBeUndefined(); // nothing linked yet
    fire({ type: 'account.status', linked: true, accountId: '111122223333', region: 'eu-west-1', fixes: false });
    fake.sent = [];
    const requestId = rt.recheckAccount()!;
    expect(fake.sent).toEqual([{ action: 'account.recheck', requestId }]);
    fire({ type: 'account.status', requestId, linked: true, accountId: '111122223333', region: 'eu-west-1', fixes: true });
    expect(useCity.getState().account).toMatchObject({ linked: true, fixes: true });
    expect(fake.sent).toHaveLength(1);
    const refused = rt.recheckAccount()!;
    fire({ type: 'error', requestId: refused, message: 'Give it a few seconds before trying that again.' });
    expect(useCity.getState().account.error).toMatch(/few seconds/);
  });

  it('v2.17: “I’ve updated the stack” asks for a fresh setup link in the linked Region, then verifies it as updated, once', async () => {
    const { rt, useCity } = await boot();
    fake.status('connected');
    await settle();
    const fire = (e: ServerEvent) => (fake as unknown as { events: Set<(e: ServerEvent) => void> }).events.forEach((cb) => cb(e));
    expect(rt.confirmRoleUpdate()).toBeUndefined(); // nothing linked yet
    fire({ type: 'account.status', linked: true, accountId: '111122223333', region: 'eu-west-1' });
    fake.sent = [];
    const requestId = rt.confirmRoleUpdate()!;
    expect(fake.sent).toEqual([{ action: 'account.link', requestId, region: 'eu-west-1' }]);
    fire({ type: 'account.linkUrl', requestId, url: 'https://eu-west-1.console.aws.amazon.com/x', externalId: 'e' });
    expect(fake.sent.at(-1)).toEqual({ action: 'account.verify', requestId: expect.any(String), roleArn: '111122223333', updated: true });
    // Once only: the same link again sends nothing more; a refused link verifies nothing.
    fire({ type: 'account.linkUrl', requestId, url: 'https://eu-west-1.console.aws.amazon.com/x', externalId: 'e' });
    expect(fake.sent.filter((c) => c.action === 'account.verify')).toHaveLength(1);
    const refused = rt.confirmRoleUpdate()!;
    fire({ type: 'error', requestId: refused, message: 'Too many requests.' });
    fire({ type: 'account.linkUrl', requestId: refused, url: 'https://eu-west-1.console.aws.amazon.com/x', externalId: 'e' });
    expect(fake.sent.filter((c) => c.action === 'account.verify')).toHaveLength(1);
    expect(useCity.getState().account.linked).toBe(true);
  });

  it('v2.17: a removal refused for MFA is known by its requestId, so turning the authenticator on says to press Take it down again', async () => {
    const { rt, useCity } = await boot();
    Object.assign(fake, { confirmTotp: async () => {} });
    fake.status('connected');
    await settle();
    const fire = (e: ServerEvent) => (fake as unknown as { events: Set<(e: ServerEvent) => void> }).events.forEach((cb) => cb(e));
    const requestId = rt.removeResource('table', 'city-orders')!;
    fire({ type: 'error', requestId, code: 'mfa_required', message: 'MFA first' });
    useCity.getState().clearToasts();
    fake.sent = [];
    await rt.confirmMfaSetup('123456');
    expect(fake.sent).toEqual([]); // a removal is pressed again, never resent
    expect(useCity.getState().toasts.map((t) => t.text)).toContainEqual(expect.stringMatching(/Take it down again/));
  });

  it('v2.17: an account reply is this tab’s own only if it asked; a refusal is said in the card', async () => {
    const { rt, useCity } = await boot();
    fake.status('connected');
    await settle();
    const fire = (e: ServerEvent) => (fake as unknown as { events: Set<(e: ServerEvent) => void> }).events.forEach((cb) => cb(e));
    useCity.getState().clearToasts();
    // Another tab of the same player verified: the broadcast reaches this tab too, quietly.
    fire({ type: 'account.status', requestId: 'someone-else', linked: true, accountId: '111122223333', region: 'eu-west-1' });
    expect(useCity.getState().account).toMatchObject({ linked: true, accountId: '111122223333' });
    expect(useCity.getState().toasts).toEqual([]);
    // This tab's own verify that failed: an error with its requestId, kept in the card (and toasted, like any error).
    const asked = rt.verifyAccount('444455556666')!;
    fire({ type: 'error', requestId: asked, message: 'Your setup link is more than a day old, so I won’t use it.' });
    expect(useCity.getState().account.error).toMatch(/more than a day old/);
    // The next try clears it, and its success is this tab's own (one toast).
    useCity.getState().clearToasts();
    const again = rt.verifyAccount('444455556666')!;
    expect(useCity.getState().account.error).toBeUndefined();
    fire({ type: 'account.status', requestId: again, linked: true, accountId: '444455556666', region: 'eu-west-1' });
    expect(useCity.getState().toasts.map((t) => t.text)).toEqual([expect.stringMatching(/444455556666 is linked/)]);
    // An authenticator refusal has its own card, not this line.
    const link = rt.linkAccount('eu-west-1')!;
    fire({ type: 'error', requestId: link, code: 'mfa_required', message: 'MFA first' });
    expect(useCity.getState().account.error).toBeUndefined();
  });

  it('the store learns at startup whether the backend is the hosted server', async () => {
    Object.assign(fake, { hosted: true });
    const { useCity } = await boot();
    fake.status('connected');
    expect(useCity.getState().hosted).toBe(true);
  });

  it('Download my data saves what the server keeps as a JSON file on this device (hosted players only)', async () => {
    const { rt, useCity } = await boot();
    Object.assign(fake, { exportMe: async () => ({ progress: { version: 1 }, account: null }) });
    expect(rt.canDownloadData()).toBe(false);
    Object.assign(fake, { hosted: true });
    expect(rt.canDownloadData()).toBe(true);
    const a = { href: '', download: '', click: vi.fn() };
    vi.stubGlobal('document', { createElement: () => a });
    try {
      await rt.downloadMyData();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(a.click).toHaveBeenCalledOnce();
    expect(a.download).toMatch(/^aws-city-my-data-\d{4}-\d{2}-\d{2}\.json$/);
    expect(a.href).toMatch(/^blob:/);
    expect(useCity.getState().toasts.at(-1)?.text).toMatch(/saved as aws-city-my-data/);
  });

  it('a failed download says a plain sentence, with no request error in it', async () => {
    const { rt, useCity } = await boot();
    Object.assign(fake, { hosted: true, exportMe: async () => Promise.reject(new Error('GET /me/export → 500')) });
    await rt.downloadMyData();
    const text = useCity.getState().toasts.at(-1)?.text ?? '';
    expect(text).toMatch(/Couldn’t download your data/);
    expect(text).not.toMatch(/500|GET/);
    // Once a minute per player (v2.17): a second download straight away says so, not "check your connection".
    useCity.getState().clearToasts();
    Object.assign(fake, { exportMe: async () => Promise.reject(Object.assign(new Error('GET /me/export → 429'), { tooSoon: true })) });
    await rt.downloadMyData();
    expect(useCity.getState().toasts.at(-1)?.text).toBe('You downloaded your data a moment ago. Try again in a minute.');
  });

  it('a failed sign-out or account deletion logs a plain sentence, with the detail only in the console', async () => {
    const { rt, useCity } = await boot();
    Object.assign(fake, { hosted: true, deleteAccount: async () => Promise.reject(new Error('DELETE /me → 500')) });
    await rt.deleteAccount();
    const text = useCity.getState().feed.at(-1)?.text ?? '';
    expect(text).toMatch(/Couldn’t delete your account/);
    expect(text).not.toMatch(/500|DELETE/);
  });

  describe('"Got it" answers on the device', () => {
    const KEY = 'awscity.findingsGotIt';
    beforeEach(() => {
      const mem = new Map<string, string>([[KEY, '["f1"]']]);
      vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('an explicit sign-out clears them', async () => {
      fake.player = 'player-a';
      const { rt } = await boot();
      fake.status('connected');
      await settle();
      rt.signOut();
      await settle();
      expect(localStorage.getItem(KEY)).toBeNull();
    });

    it('an involuntary end (expired token) keeps them', async () => {
      fake.player = 'player-a';
      await boot();
      fake.status('connected');
      await settle();
      fake.status('signed-out');
      await settle();
      expect(localStorage.getItem(KEY)).toBe('["f1"]');
    });
  });

  it('auto-snap fires on AWS pages only, and a snap of another site sends no URL or title', async () => {
    const { rt, useCity } = await boot();
    fake.status('connected');
    rt.setAutoSnap(true);
    rt.simulateFocus('https://mail.example.com/inbox/1', 'Re: my bank statement');
    await settle();
    expect(fake.sent.filter((c) => c.action === 'page.classify')).toEqual([]);

    rt.simulateFocus('https://us-west-2.console.aws.amazon.com/s3/home', 'S3');
    await settle();
    const auto = fake.sent.filter((c) => c.action === 'page.classify');
    expect(auto).toHaveLength(1);
    expect(auto[0]).toMatchObject({ context: { url: 'https://us-west-2.console.aws.amazon.com/s3/home', title: 'S3', screenshotKey: 'shot-1' } });

    rt.simulateFocus('https://mail.example.com/inbox/1', 'Re: my bank statement');
    useCity.getState().setSnap('idle');
    await rt.snap();
    const asked = fake.sent.filter((c) => c.action === 'page.classify').at(-1)!;
    expect(asked).toMatchObject({ context: { screenshotKey: 'shot-1' } });
    expect(JSON.stringify(asked)).not.toMatch(/mail\.example|bank/);
  });

  it('a screenshot is forgotten when the page changes and when the session ends', async () => {
    const { rt } = await boot();
    fake.status('connected');
    rt.simulateFocus('https://us-west-2.console.aws.amazon.com/s3/home', 'S3');
    await rt.snap();
    rt.submitPrompt('what is this?');
    expect(fake.sent.at(-1)).toMatchObject({ action: 'task.submit', context: { screenshotKey: 'shot-1' } });

    rt.simulateFocus('https://us-west-2.console.aws.amazon.com/lambda/home', 'Lambda');
    rt.submitPrompt('and this?');
    expect(fake.sent.at(-1)).toMatchObject({ action: 'task.submit', context: { screenshotKey: undefined } });

    await rt.snap();
    fake.status('signed-out');
    await settle();
    fake.status('connected');
    rt.submitPrompt('next player');
    expect(fake.sent.at(-1)).toMatchObject({ action: 'task.submit', context: { screenshotKey: undefined } });
  });

  describe('the demo in a build with sign-in (awscity.demo)', () => {
    /** The mock the demo plays on: no players, no sign-in. */
    const demoBackend = () => Object.assign(new FakeBackend(), { kind: 'mock', playerId: undefined }) as unknown as FakeBackend;
    async function bootDemo() {
      vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'awscity.demo' ? '1' : null), setItem() {}, removeItem() {} });
      fake = demoBackend();
      try {
        return await boot();
      } finally {
        vi.unstubAllGlobals();
      }
    }

    it('demo progress is saved as the demo’s, and never merges into a player who signs in later', async () => {
      const demo = await bootDemo();
      demo.useCity.getState().loadProgress(progress({ lambda: { discovered: true, xp: 10 } }));
      await settle();
      expect((await fakeBrowser.storage.local.get('progress.owner'))['progress.owner']).toBe('demo');

      // "Sign in to save your city": the page reloads on the hosted backend (the demo surface's listeners stay, like
      // the other surface still open), and player A signs in.
      fake = new FakeBackend();
      fake.player = 'player-a';
      fake.remote = progress({ s3: { discovered: true, xp: 40 } }, '2026-01-01T00:00:00Z');
      const { useCity } = await boot();
      fake.status('connected');
      await settle();
      expect(landmarkOf(useCity.getState().progress, 's3')).toBeTruthy();
      expect(landmarkOf(useCity.getState().progress, 'lambda')).toBeUndefined();
      expect(fake.puts.every((p) => !landmarkOf(p, 'lambda'))).toBe(true);
      expect((await fakeBrowser.storage.local.get('progress.parked'))['progress.parked']).toBeUndefined();

      // A demo surface still open earns more: the signed-in surface never takes it.
      demo.useCity.getState().loadProgress(progress({ lambda: { discovered: true, xp: 20 }, sqs: { discovered: true, xp: 5 } }));
      await settle();
      expect(landmarkOf(useCity.getState().progress, 'lambda')).toBeUndefined();
      expect(landmarkOf(useCity.getState().progress, 'sqs')).toBeUndefined();
      expect(fake.puts.every((p) => !p.landmarks.lambda && !p.landmarks.sqs)).toBe(true);
    });

    it('a player’s copy on this device is parked while the demo plays, not shown in it', async () => {
      await fakeBrowser.storage.local.set({ progress: progress({ lambda: { discovered: true, xp: 10 } }), 'progress.owner': 'player-a' });
      const { useCity } = await bootDemo();
      expect(useCity.getState().progress.landmarks).toEqual({});
      expect((await fakeBrowser.storage.local.get('progress.parked'))['progress.parked']).toMatchObject({ player: 'player-a' });
    });
  });
});
