import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { CognitoAuth } from '@/backend/auth';
import { bearerSubprotocols, CLOSE_CODES, compareContract, CONTRACT_HEADER, CONTRACT_VERSION, parseContract, type ClientCommand, type ServerEvent } from '@/backend/contract';
import { GUARDED_EQUIV, isPracticeDeploy, ServerBackend, subOf } from '@/backend/ServerBackend';

/** A WebSocket stand-in: the test opens and closes it; close() fires onclose asynchronously like the real one. */
class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: (ev: { code: number }) => void;
  onmessage?: (ev: { data: string }) => void;
  onerror?: () => void;
  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  close(code = 1000) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }
}

const auth = (token: () => Promise<string | undefined>, extra: Partial<Record<keyof CognitoAuth, unknown>> = {}) =>
  ({ token, signOut: async () => {}, signIn: async () => {}, forgetAccessToken: async () => {}, onChange: () => () => {}, ...extra }) as unknown as CognitoAuth;

describe('ServerBackend connection status', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('signing out ends on signed-out, not disconnected', async () => {
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => 't') });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    await backend.signOut();
    await new Promise((r) => setTimeout(r, 0));
    expect(statuses.at(-1)).toBe('signed-out');
  });

  it('commands queued while offline are dropped on sign-out', async () => {
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => 't') });
    backend.send({ action: 'chat.ask', requestId: 'r1', question: 'hi' } as never);
    await backend.signOut();
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    expect(FakeSocket.all[0]!.sent).toEqual([]);
  });

  it('a session that dies (no token) drops queued commands and unsaved progress before the next player signs in', async () => {
    const puts: string[] = [];
    vi.stubGlobal('fetch', async (_u: URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(String(init.headers && (init.headers as Record<string, string>).authorization));
      return new Response('', { status: 503 });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let token: string | undefined = 'player-a';
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => token) });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    backend.send({ action: 'chat.ask', requestId: 'r1', question: 'hi' } as never);
    backend.putProgress({ version: 1, landmarks: {}, updatedAt: '2026-01-01T00:00:00Z' });
    await vi.waitFor(() => expect(puts).toHaveLength(1));
    token = undefined; // the refresh token died
    backend.connect();
    await vi.waitFor(() => expect(statuses.at(-1)).toBe('signed-out'));
    token = 'player-b';
    backend.reconnect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeSocket.all[0]!.sent).toEqual([]);
    expect(puts).toHaveLength(1);
  });

  it('a failing token refresh reports an error and retries instead of hanging on connecting', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const backend = new ServerBackend({
      wsUrl: 'wss://x/ws',
      apiUrl: 'https://x',
      auth: auth(async () => {
        if (calls++ === 0) throw new Error('network');
        return 't';
      }),
    });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    backend.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['connecting', 'error']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('a double Retry while the token is loading opens one socket, not two', async () => {
    let release!: (t: string) => void;
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(() => new Promise((r) => (release = r))) });
    backend.reconnect();
    backend.reconnect();
    release('t');
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('signing out while the token loads never opens a socket', async () => {
    let release!: (t: string) => void;
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(() => new Promise((r) => (release = r))) });
    backend.connect();
    await backend.signOut();
    release('t');
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('signing out or disconnecting while the token loads never leaves the status on connecting', async () => {
    for (const [stop, final] of [
      [(b: ServerBackend) => void b.signOut(), 'signed-out'],
      [(b: ServerBackend) => b.disconnect(), 'disconnected'],
    ] as const) {
      let release!: (t: string) => void;
      const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(() => new Promise((r) => (release = r))) });
      const statuses: string[] = [];
      backend.onStatus((s) => statuses.push(s));
      backend.connect();
      stop(backend);
      await new Promise((r) => setTimeout(r, 0));
      release('t');
      await new Promise((r) => setTimeout(r, 0));
      expect(statuses.at(-1)).toBe(final);
    }
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('signing out in the other surface signs this one out too', async () => {
    let fire!: (c: 'signed-in' | 'signed-out') => void;
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => 't', { onChange: (cb: typeof fire) => ((fire = cb), () => {}) }) });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    fire('signed-out');
    expect(statuses.at(-1)).toBe('signed-out');
  });

  it('turning the authenticator on tells the server (POST /me/mfa) before every session ends, then shows signed-out', async () => {
    const calls: string[] = [];
    let status = 204;
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push(`${init.method} ${url.pathname} ${(init.headers as Record<string, string>).authorization}`);
      return new Response(null, { status });
    });
    // Like CognitoAuth.confirmTotp: noted only when POST /me/mfa landed (it throws otherwise).
    const confirmTotp = vi.fn(async (_code: string, beforeSignOut?: () => Promise<void>) => {
      calls.push('enrolled');
      const noted = await beforeSignOut!().then(
        () => true,
        () => false,
      );
      calls.push('signed out everywhere');
      return { noted };
    });
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => 't', { confirmTotp }) });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    expect(await backend.confirmTotp('123456')).toEqual({ signInTwice: false });
    expect(calls).toEqual(['enrolled', 'POST /me/mfa Bearer t', 'signed out everywhere']);
    expect(statuses.at(-1)).toBe('signed-out');
    // The server didn't hear (a 5xx): the player may have to sign in twice. An older server's 404 isn't retried.
    status = 503;
    expect(await backend.confirmTotp('123456')).toEqual({ signInTwice: true });
    status = 404;
    expect(await backend.confirmTotp('123456')).toEqual({ signInTwice: false });
  });

  it('a POST /me/mfa that is refused (409 not seen yet, 429 too many, 503) is tried three times, then reported as sign in twice', async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    for (const [status, posts, signInTwice] of [
      [409, 3, true],
      [429, 3, true],
      [503, 3, true],
      [204, 1, false],
    ] as const) {
      fakeBrowser.reset();
      await fakeBrowser.storage.session.set({ 'auth.tokens': { accessToken: 'a1', expiresAt: Date.now() + 3_600_000 } });
      let noted = 0;
      vi.stubGlobal('fetch', async (url: URL | string, init: RequestInit) => {
        if (new URL(url).pathname === '/me/mfa') return (noted++, new Response(status === 204 ? null : JSON.stringify({ error: 'x' }), { status }));
        // The user pool API (cognito-idp): the code matches, TOTP goes on, every session ends.
        const op = (init.headers as Record<string, string>)['x-amz-target'];
        return json(op?.endsWith('VerifySoftwareToken') ? { Status: 'SUCCESS' } : {});
      });
      const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: new CognitoAuth({ domain: 'https://city.auth.us-west-2.amazoncognito.com', clientId: 'c' }) });
      expect(await backend.confirmTotp('123456'), String(status)).toEqual({ signInTwice });
      expect(noted, String(status)).toBe(posts);
    }
  });

  it('a 401 from GET /progress is "unknown", never "no progress"', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 401 }));
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => undefined) });
    await expect(backend.getProgress()).rejects.toThrow(/401/);
  });

  it('two refused handshakes ask the REST API why, and explain a 403 instead of retrying forever', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 403 }));
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local' });
    const errors: string[] = [];
    backend.onEvent((e) => e.type === 'error' && errors.push(e.message));
    vi.useFakeTimers();
    backend.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.close(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors[0]).toMatch(/EXTENSION_ORIGIN/);
  });

  it('an account deleted elsewhere (close 4403) signs out and never reconnects; 4401 reconnects', async () => {
    vi.useFakeTimers();
    const signOut = vi.fn(async () => {});
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => 't', { signOut }) });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    backend.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.open();
    FakeSocket.all[0]!.close(CLOSE_CODES.reauth);
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.all).toHaveLength(2); // a fresh token, a new socket
    FakeSocket.all[1]!.open();
    FakeSocket.all[1]!.close(CLOSE_CODES.deleted);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe('signed-out');
  });

  it('a handshake refused with 410 (account deleted) signs out instead of retrying', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 410 }));
    const signOut = vi.fn(async () => {});
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => 't', { signOut }) });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    vi.useFakeTimers();
    backend.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    FakeSocket.all[1]!.close(1006);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(statuses.at(-1)).toBe('signed-out');
  });

  it('progress the server refused is re-sent on the next open', async () => {
    const puts: number[] = [];
    let ok = false;
    vi.stubGlobal('fetch', async (_u: URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(ok ? 200 : 503);
      return new Response('', { status: ok ? 200 : 503 });
    });
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    backend.putProgress({ version: 1, landmarks: {}, updatedAt: '2026-01-01T00:00:00Z' });
    await vi.waitFor(() => expect(puts).toEqual([503]));
    ok = true;
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    await vi.waitFor(() => expect(puts).toEqual([503, 200]));
  });
});

describe('the version handshake (v2.19)', () => {
  const [major, minor] = parseContract(CONTRACT_VERSION)!;
  const older = `${major}.${minor - 1}`;
  const newer = `${major}.${minor + 1}`;
  const p = (n: number) => ({ version: 1 as const, landmarks: {}, updatedAt: `2026-01-0${n}T00:00:00Z` });
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A server that refuses this extension's version: GET /progress answers 409 naming `speaks`; PUTs are counted. */
  const refusing = (speaks: string | undefined) => {
    const puts: string[] = [];
    let serves = false;
    vi.stubGlobal('fetch', async (u: URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(u.searchParams.get('contract') ?? '');
      if (serves) return new Response(null, { status: 204 });
      return new Response(JSON.stringify({ error: 'x' }), { status: 409, headers: speaks ? { [CONTRACT_HEADER]: speaks } : {} });
    });
    return { puts, serve: () => (serves = true) };
  };
  /** Connects and lets two upgrades fail (1006), as a refused handshake looks to a browser: the second asks GET /progress why. */
  const refusedTwice = async (backend: ServerBackend) => {
    backend.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.all[0]!.close(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    FakeSocket.all[1]!.close(1006);
    await vi.advanceTimersByTimeAsync(0);
  };

  it('compares major.minor as numbers (the contract version is a string)', () => {
    expect(compareContract('2.10', '2.9')).toBeGreaterThan(0);
    expect(compareContract('2.9', '2.10')).toBeLessThan(0);
    expect(compareContract('3.0', '2.17')).toBeGreaterThan(0);
    expect(compareContract('2.17', '2.17')).toBe(0);
    for (const bad of [undefined, null, '', '2', 'v2.17', '2.17.0']) expect(compareContract(bad, '2.17')).toBeUndefined();
  });

  it('every socket and REST call names this extension’s contract version; the bearer subprotocols are untouched', async () => {
    const urls: URL[] = [];
    vi.stubGlobal('fetch', async (u: URL) => (urls.push(u), new Response(null, { status: 404 })));
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => 'jwt') });
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    const url = new URL(FakeSocket.all[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe('wss://x/ws');
    expect(url.searchParams.get('contract')).toBe(CONTRACT_VERSION);
    expect(FakeSocket.all[0]!.protocols).toEqual(bearerSubprotocols('jwt'));
    await backend.getProgress();
    await backend.exportMe().catch(() => undefined);
    expect(urls.map((u) => `${u.pathname}?${u.search.slice(1)}`)).toEqual([`/progress?contract=${CONTRACT_VERSION}`, `/me/export?contract=${CONTRACT_VERSION}`]);
  });

  it('a server older than the extension: one calm "updating" status, saves wait on this device, asked again about a minute later, and all resumes on the next open', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = refusing(older);
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local' });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    await refusedTwice(backend);
    expect(statuses.at(-1)).toBe('updating');
    const from = statuses.length - 1;
    backend.putProgress(p(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(server.puts).toEqual([]); // held here, not sent to be refused
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(FakeSocket.all).toHaveLength(3); // asked again, quietly
    FakeSocket.all[2]!.close(1006); // still being updated
    await vi.advanceTimersByTimeAsync(91_000);
    expect(FakeSocket.all).toHaveLength(4);
    server.serve();
    FakeSocket.all[3]!.open();
    await vi.advanceTimersByTimeAsync(0);
    // Never "Offline" or "Connecting…" in between: the line stays until the server serves this version.
    expect(statuses.slice(from)).toEqual(['updating', 'updating', 'updating', 'updating', 'connected']);
    expect(server.puts).toEqual([CONTRACT_VERSION]); // the held copy, sent on the open
  });

  it('a server that no longer serves this version: "outdated", and no retries (the extension needs its update)', async () => {
    vi.useFakeTimers();
    refusing(newer);
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local' });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    await refusedTwice(backend);
    expect(statuses.at(-1)).toBe('outdated');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('a 409 that doesn’t name a version reads as the server being updated', async () => {
    vi.useFakeTimers();
    refusing(undefined);
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local' });
    const statuses: string[] = [];
    backend.onStatus((s) => statuses.push(s));
    await refusedTwice(backend);
    expect(statuses.at(-1)).toBe('updating');
  });

  it('unknown events from a newer server are dropped; the rest of the frame still arrives', async () => {
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local' });
    const events: ServerEvent[] = [];
    backend.onEvent((e) => events.push(e));
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    const hi = { type: 'agent.message', from: 'concierge', to: 'user', text: 'hi' };
    FakeSocket.all[0]!.onmessage?.({ data: JSON.stringify([{ type: 'city.weather', rain: true }, hi]) });
    expect(events).toEqual([hi]);
  });
});

describe('a save the server refuses', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** PUT /progress answers `status.now`; each PUT's answer is recorded. */
  const server = (first: number) => {
    const status = { now: first };
    const puts: number[] = [];
    vi.stubGlobal('fetch', async (_u: URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(status.now);
      return new Response(null, { status: status.now });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local' });
    const saves: string[] = [];
    backend.onSave((s) => saves.push(s));
    const open = async () => {
      backend.connect();
      await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
      FakeSocket.all[0]!.open();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { backend, status, puts, saves, open };
  };
  const copy = (day: number) => ({ version: 1 as const, landmarks: {}, updatedAt: `2026-01-0${day}T00:00:00Z` });

  it('a 4xx refusal isn’t re-sent on every open: it says "refused" until a later save goes through', async () => {
    const { backend, status, puts, saves, open } = server(400);
    backend.putProgress(copy(1));
    await vi.waitFor(() => expect(saves).toEqual(['refused']));
    await open();
    expect(puts).toEqual([400]); // the refused copy isn't sent again on the open
    // The next change tries afresh (each save is the whole progress); once one goes through, the line clears.
    status.now = 204;
    backend.putProgress(copy(2));
    await vi.waitFor(() => expect(saves).toEqual(['refused', 'saved']));
  });

  it.each([401, 409, 503])('a %i keeps the copy for the next open, and isn’t a refusal (a stale token, the version handshake, the server’s own trouble)', async (kept) => {
    const { backend, status, puts, saves, open } = server(kept);
    backend.putProgress(copy(1));
    await vi.waitFor(() => expect(puts).toEqual([kept]));
    await new Promise((r) => setTimeout(r, 0));
    expect(saves).toEqual([]);
    status.now = 204;
    await open();
    await vi.waitFor(() => expect(puts).toEqual([kept, 204]));
    expect(saves).toEqual(['saved']);
  });
});

describe('ServerBackend forwards city care unchanged', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends finding.explain / finding.fix / finding.undo and deploy.approve with confirm as-is', async () => {
    const backend = new ServerBackend({ wsUrl: 'ws://127.0.0.1:1/ws', apiUrl: 'http://127.0.0.1:1' });
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    const cmds = [
      { action: 'finding.explain', requestId: 'r1', findingId: 'f' },
      { action: 'finding.fix', requestId: 'r2', findingId: 'f' },
      { action: 'finding.undo', requestId: 'r3', findingId: 'f' },
      { action: 'deploy.approve', deployId: 'd', confirm: 'build-runner' },
    ] as const;
    for (const c of cmds) backend.send(c);
    expect(FakeSocket.all[0]!.sent.map((s) => JSON.parse(s))).toEqual(cmds);
  });
});

describe('the player tag on this device', () => {
  const jwt = (claims: object) => `h.${btoa(JSON.stringify(claims)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;
  it('reads the sub of an access token, and nothing from junk', () => {
    expect(subOf(jwt({ sub: 'abc-123', token_use: 'access' }))).toBe('abc-123');
    expect(subOf('not-a-jwt')).toBeUndefined();
    expect(subOf(jwt({ token_use: 'access' }))).toBeUndefined();
  });

  it('only a hosted backend has players, and a REST call tags the player even before the socket', async () => {
    expect(new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local' }).playerId).toBeUndefined();
    vi.stubGlobal('fetch', async () => new Response('null', { status: 404 }));
    const hosted = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', auth: auth(async () => jwt({ sub: 'player-a' })) });
    expect(hosted.playerId?.()).toBeUndefined();
    await hosted.getProgress();
    expect(hosted.playerId?.()).toBe('player-a');
    vi.unstubAllGlobals();
  });
});

describe('ServerBackend sends every socket command in the contract (v2.19)', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  type Way = 'socket' | 'rest' | 'local';
  /**
   * One of each command, and how it travels. Keyed by every action in ClientCommand: a command added to the contract
   * fails to compile here until it's listed (and ServerBackend.send's `never` default fails until it's handled).
   */
  const ALL: { [A in ClientCommand['action']]: { cmd: ClientCommand & { action: A }; way: Way } } = {
    'task.submit': { cmd: { action: 'task.submit', taskId: 't1', prompt: 'hi', context: {} }, way: 'socket' },
    'chat.ask': { cmd: { action: 'chat.ask', requestId: 'r1', districtId: 'storage', question: 'q', context: {} }, way: 'socket' },
    'page.classify': { cmd: { action: 'page.classify', requestId: 'r2', context: { url: 'https://x', title: 't' } }, way: 'socket' },
    'screenshot.presign': { cmd: { action: 'screenshot.presign', requestId: 'r3', contentType: 'image/jpeg' }, way: 'rest' },
    'progress.get': { cmd: { action: 'progress.get', requestId: 'r4' }, way: 'rest' },
    'progress.put': { cmd: { action: 'progress.put', progress: { version: 2, landmarks: {}, updatedAt: '2026-11-21T00:00:00Z' } }, way: 'rest' },
    'account.link': { cmd: { action: 'account.link', requestId: 'r5', region: 'eu-west-1', allowFixes: true }, way: 'socket' },
    'account.verify': { cmd: { action: 'account.verify', requestId: 'r6', roleArn: '111122223333' }, way: 'socket' },
    'account.unlink': { cmd: { action: 'account.unlink', requestId: 'r7' }, way: 'socket' },
    'account.recheck': { cmd: { action: 'account.recheck', requestId: 'r7b' }, way: 'socket' },
    'account.cleanup': { cmd: { action: 'account.cleanup', requestId: 'r7c', on: true }, way: 'socket' },
    'resource.remove': { cmd: { action: 'resource.remove', requestId: 'r8', kind: 'table', id: 'city-quest-library' }, way: 'socket' },
    'quest.start': { cmd: { action: 'quest.start', questId: 'q', taskId: 't2' }, way: 'local' },
    // A guarded build becomes the agent's prompt (task.submit); a template with none is a local practice build (below).
    'deploy.plan': { cmd: { action: 'deploy.plan', requestId: 'r9', templateId: 'hello-api' }, way: 'local' },
    'deploy.approve': { cmd: { action: 'deploy.approve', deployId: 'd1', confirm: 'x' }, way: 'socket' },
    'deploy.reject': { cmd: { action: 'deploy.reject', deployId: 'd2' }, way: 'socket' },
    'deploy.teardown': { cmd: { action: 'deploy.teardown', deployId: 'unknown' }, way: 'local' },
    'console.start': { cmd: { action: 'console.start', taskId: 'c1', goal: 'g', context: {}, snapshot: { url: 'https://x', title: 't', items: [] } }, way: 'socket' },
    'console.observe': { cmd: { action: 'console.observe', taskId: 'c1', index: 0, ok: true, snapshot: { url: 'https://x', title: 't', items: [] } }, way: 'socket' },
    'console.stop': { cmd: { action: 'console.stop', taskId: 'c1' }, way: 'socket' },
    'finding.explain': { cmd: { action: 'finding.explain', requestId: 'f1', findingId: 'f' }, way: 'socket' },
    'finding.fix': { cmd: { action: 'finding.fix', requestId: 'f2', findingId: 'f' }, way: 'socket' },
    'finding.undo': { cmd: { action: 'finding.undo', requestId: 'f3', findingId: 'f' }, way: 'socket' },
    'bill.enable': { cmd: { action: 'bill.enable', on: true }, way: 'socket' },
    'flow.enable': { cmd: { action: 'flow.enable', on: true }, way: 'socket' },
    'workshop.verify': { cmd: { action: 'workshop.verify', workshopId: 'w', stepId: 's', values: { table: 'orders' } }, way: 'socket' },
    'presence.beat': { cmd: { action: 'presence.beat', region: 'us-west-2', rank: 'Town' }, way: 'socket' },
    'score.submit': { cmd: { action: 'score.submit', board: 'shield', score: 10 }, way: 'socket' },
    'leaderboard.get': { cmd: { action: 'leaderboard.get', board: 'shield' }, way: 'socket' },
    // v2.17: a fresh sign-in on the open socket (step-up), forwarded as it is.
    'auth.renew': { cmd: { action: 'auth.renew', token: 'fresh-access-token' }, way: 'socket' },
  };

  it('forwards each socket command as-is (flow.enable, account.unlink, resource.remove and allowFixes included), and nothing else', async () => {
    vi.stubGlobal('fetch', async () => new Response('', { status: 204 }));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const backend = new ServerBackend({ wsUrl: 'ws://127.0.0.1:1/ws', apiUrl: 'http://127.0.0.1:1' });
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    for (const { cmd } of Object.values(ALL)) backend.send(cmd);
    const sent = FakeSocket.all[0]!.sent.map((s) => JSON.parse(s) as ClientCommand);
    const socket = Object.values(ALL)
      .filter((c) => c.way === 'socket')
      .map((c) => c.cmd);
    expect(sent).toEqual(socket);
    expect(sent.map((c) => c.action)).toEqual(expect.arrayContaining(['flow.enable', 'account.unlink', 'account.recheck', 'resource.remove']));
    expect(sent.find((c) => c.action === 'account.link')).toEqual({ action: 'account.link', requestId: 'r5', region: 'eu-west-1', allowFixes: true });
  });

  it('strips the questId of a task (the server schema refuses unknown fields)', async () => {
    const backend = new ServerBackend({ wsUrl: 'ws://127.0.0.1:1/ws', apiUrl: 'http://127.0.0.1:1' });
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    backend.send({ action: 'task.submit', taskId: 't9', prompt: 'p', context: {}, questId: 'q' });
    expect(JSON.parse(FakeSocket.all[0]!.sent[0]!)).toEqual({ action: 'task.submit', taskId: 't9', prompt: 'p', context: {} });
  });
});

describe('quest deploy steps on the server (v2.19)', () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal('WebSocket', FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  const opened = async () => {
    const backend = new ServerBackend({ wsUrl: 'ws://127.0.0.1:1/ws', apiUrl: 'http://127.0.0.1:1' });
    const events: ServerEvent[] = [];
    backend.onEvent((e) => events.push(e));
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.open();
    return { backend, events, sent: () => FakeSocket.all[0]!.sent.map((s) => JSON.parse(s) as ClientCommand) };
  };

  it('serverless templates never become an EC2 house or a table', () => {
    expect(GUARDED_EQUIV['hello-api']).toBeUndefined();
    expect(GUARDED_EQUIV['queue-worker']).toBeUndefined();
    expect(GUARDED_EQUIV['static-site']).toBe('warehouse');
  });

  for (const templateId of ['hello-api', 'queue-worker']) {
    it(`${templateId}: a practice build like the demo: preview, approve, complete under its own template id; nothing sent, nothing created`, async () => {
      const { backend, events, sent } = await opened();
      backend.send({ action: 'deploy.plan', requestId: `p-${templateId}`, templateId });
      await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.preview')).toBe(true));
      const preview = events.find((e) => e.type === 'deploy.preview') as Extract<ServerEvent, { type: 'deploy.preview' }>;
      // The store counts the quest's deploy step when a deploy.status complete arrives for a preview of this templateId.
      expect(preview).toMatchObject({ requestId: `p-${templateId}`, templateId, costNote: expect.stringMatching(/^Practice: free, nothing is created/) });
      expect(preview.changes.length).toBeGreaterThan(0);
      expect(isPracticeDeploy(preview.deployId)).toBe(true);
      backend.send({ action: 'deploy.approve', deployId: preview.deployId });
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'deploy.status')).toHaveLength(2));
      expect(events.filter((e) => e.type === 'deploy.status')).toEqual([
        { type: 'deploy.status', deployId: preview.deployId, status: 'creating' },
        { type: 'deploy.status', deployId: preview.deployId, status: 'complete', message: expect.stringMatching(/Nothing was created in your AWS account/) },
      ]);
      expect(sent()).toEqual([]); // no task.submit (no EC2 house), no deploy.approve to the server
    });
  }

  it('a practice build can be turned down; a guarded template still asks its agent', async () => {
    const { backend, events, sent } = await opened();
    backend.send({ action: 'deploy.plan', requestId: 'p1', templateId: 'queue-worker' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.preview')).toBe(true));
    const { deployId } = events.find((e) => e.type === 'deploy.preview') as { deployId: string };
    backend.send({ action: 'deploy.reject', deployId });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.status')).toBe(true));
    expect(events.filter((e) => e.type === 'deploy.status')).toEqual([{ type: 'deploy.status', deployId, status: 'rejected', message: 'Nothing was created.' }]);
    backend.send({ action: 'deploy.plan', requestId: 'p2', templateId: 'static-site' });
    expect(sent()).toEqual([{ action: 'task.submit', taskId: 'p2', prompt: expect.stringMatching(/S3 bucket/), context: {} }]);
  });
});

describe('Download my data (v2.19)', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('GET /me/export with the bearer token; a refusal is an error, never an empty export', async () => {
    const calls: string[] = [];
    let status = 200;
    vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
      calls.push(`${init.method ?? 'GET'} ${url.pathname} ${(init.headers as Record<string, string>).authorization}`);
      return new Response(JSON.stringify({ exportedAt: 'now', contract: '2.17', progress: null, social: [] }), { status });
    });
    const backend = new ServerBackend({ wsUrl: 'wss://x/ws', apiUrl: 'https://x', token: 'local-token' });
    expect(await backend.exportMe()).toEqual({ exportedAt: 'now', contract: '2.17', progress: null, social: [] });
    expect(calls).toEqual(['GET /me/export Bearer local-token']);
    status = 410;
    await expect(backend.exportMe()).rejects.toThrow(/410/);
    await expect(backend.exportMe()).rejects.not.toHaveProperty('tooSoon');
    // Once a minute per player (v2.19): marked, so the UI can say so.
    status = 429;
    await expect(backend.exportMe()).rejects.toMatchObject({ tooSoon: true });
  });
});
