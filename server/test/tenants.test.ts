import { describe, expect, it, vi } from 'vitest';
import type { AccountLinker } from '../src/accounts/link.js';
import { type AwsClients, clientsFor } from '../src/aws.js';
import { loadConfig } from '../src/config.js';
import { createApprovals } from '../src/contract/approvals.js';
import { createUploadStore } from '../src/contract/uploads.js';
import { BROKEN_AFTER, emptyWorld } from '../src/tenants.js';
import { localStores } from '../src/store/local.js';
import type { ServerEvent } from '../src/world.js';
import { fakeLlm } from './fakes.js';
import { table } from './fixtures.js';

// Every poller the tenant builds is recorded, so a test can see which ones are still running and feed it polls.
type Snap = import('../src/state/model.js').WorldSnapshot;
const pollers = vi.hoisted(() => [] as { running: boolean; poll: (next: Snap) => void }[]);
/** What every mocked poller reads (a test sets it; default: an empty account). */
const reading = vi.hoisted(() => ({ snap: undefined as Snap | undefined }));
vi.mock('../src/state/poller.js', () => ({
  createPoller: (opts: { onSnapshot: (prev: Snap | null, next: Snap) => void }) => {
    let last: Snap | null = null;
    const p = {
      running: false,
      poll: (next: Snap) => {
        opts.onSnapshot(last, next);
        last = next;
      },
    };
    pollers.push(p);
    return {
      current: () => reading.snap ?? null,
      refresh: async () => reading.snap ?? emptyWorld('us-west-2'),
      start: () => void (p.running = true),
      stop: () => void (p.running = false),
    };
  },
}));

const { createTenants } = await import('../src/tenants.js');

const linked = (accountId: string) => ({ status: 'linked' as const, externalId: 'x', region: 'us-west-2', roleArn: `arn:aws:iam::${accountId}:role/r`, accountId });

const setup = (verify: AccountLinker['verify']) => {
  pollers.length = 0;
  const linker = { link: async () => ({ url: '', externalId: '' }), verify } as unknown as AccountLinker;
  const tenants = createTenants({
    config: loadConfig({}),
    stores: localStores(`/tmp/aws-city-tenants-${Date.now()}.json`),
    uploads: createUploadStore('http://127.0.0.1:1'),
    llm: fakeLlm([]).llm,
    enabled: async () => true,
    awsFor: (_sub, record) => (record?.accountId ? { clients: {} as AwsClients, accountId: record.accountId, region: record.region } : undefined),
    linker,
    walkMs: 0,
  });
  return tenants;
};

const running = () => pollers.filter((p) => p.running).length;

describe('tenant account changes', () => {
  it('two verifies at once leave exactly one poller running', async () => {
    let n = 0;
    const tenants = setup(async () => linked(String(111122223333 + n++)));
    const tenant = await tenants.acquire({ sub: 'u1' });
    await Promise.all([tenant.verify('a', 'x', () => {}), tenant.verify('b', 'x', () => {})]);
    expect(pollers).toHaveLength(2);
    expect(running()).toBe(1);
    tenants.closeAll();
    expect(running()).toBe(0);
  });

  it('a verify that finishes after the tenant was stopped does not leave a poller behind', async () => {
    let release!: () => void;
    const tenants = setup(() => new Promise((r) => (release = () => r(linked('111122223333')))));
    const tenant = await tenants.acquire({ sub: 'u1' });
    const verifying = tenant.verify('a', 'x', () => {});
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    tenants.closeAll();
    release();
    await verifying;
    expect(running()).toBe(0);
  });

  it('delete after link stops the linked poller', async () => {
    const tenants = setup(async () => linked('111122223333'));
    const tenant = await tenants.acquire({ sub: 'u1' });
    await tenant.verify('a', 'x', () => {});
    expect(running()).toBe(1);
    await tenant.deleteMe();
    expect(running()).toBe(0);
  });

  it('REST data for a player with no open city never assumes their role or polls AWS', async () => {
    const tenants = setup(async () => linked('111122223333'));
    expect(await tenants.data({ sub: 'u9' }).progress.get()).toBeNull();
    await tenants.data({ sub: 'u9' }).deleteMe();
    expect(pollers).toHaveLength(0);
  });
});

describe('AWS public status for every player (v2.6)', () => {
  it('an unlinked player gets the shared feed on connect and on change, and stops listening when evicted', async () => {
    const listeners = new Set<(e: import('../src/world.js').ServerEvent[]) => void>();
    const health = { type: 'aws.health' as const, asOf: '2026-10-11T00:00:00.000Z', incidents: [] };
    const news = { welcome: () => [health], subscribe: (fn: (e: import('../src/world.js').ServerEvent[]) => void) => (listeners.add(fn), () => listeners.delete(fn)), tick: async () => {}, stop: () => {} };
    const tenants = createTenants({
      config: loadConfig({}),
      stores: localStores(`/tmp/aws-city-tenants-news-${Date.now()}.json`),
      uploads: createUploadStore('http://127.0.0.1:1'),
      llm: fakeLlm([]).llm,
      enabled: async () => true,
      awsFor: () => undefined,
      news,
      walkMs: 0,
    });
    const tenant = await tenants.acquire({ sub: 'u1' });
    expect((await tenant.welcome()).map((e) => e.type)).toContain('aws.health');
    const got: string[] = [];
    tenant.subscribe((e) => got.push(e.type));
    for (const fn of listeners) fn([{ ...health, asOf: '2026-10-11T00:03:00.000Z' }]);
    expect(got).toEqual(['aws.health']);
    tenants.closeAll();
    expect(listeners.size).toBe(0);
  });
});

describe('the account lifecycle (v2.17)', () => {
  const ACCOUNT = '111122223333';
  const linkedRecord = { status: 'linked' as const, externalId: 'x'.repeat(32), region: 'us-west-2', roleArn: `arn:aws:iam::${ACCOUNT}:role/AWSCityPlayerRole-us-west-2`, accountId: ACCOUNT, roleVersion: 4, fixes: false };
  /** A hosted-like hub: a linker that hands out links and verifies, and awsFor that acts only for a linked record. */
  const hub = (opts: { verify?: AccountLinker['verify'] } = {}) => {
    pollers.length = 0;
    reading.snap = undefined;
    const stores = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-lifecycle-${Date.now()}-${Math.random()}/progress.json`);
    const link = vi.fn(async (sub: string, region: string) => {
      const was = await stores.accounts.get(sub);
      await stores.accounts.put(sub, { status: 'pending', externalId: was?.externalId ?? 'x'.repeat(32), region, linkIssuedAt: new Date().toISOString() });
      return { url: 'https://example/quickcreate', externalId: 'x'.repeat(32) };
    });
    const linker = {
      templateUrl: 'https://templates.example/player-role/v5.yaml',
      latestRoleVersion: 5,
      link,
      verify:
        opts.verify ??
        (async (sub: string) => {
          const rec = { ...linkedRecord, roleVersion: 5, fixes: true, linkedAt: new Date().toISOString() };
          await stores.accounts.put(sub, rec);
          return rec;
        }),
    } as unknown as AccountLinker;
    const tenants = createTenants({
      config: loadConfig({}),
      stores,
      uploads: createUploadStore('http://127.0.0.1:1'),
      llm: fakeLlm([]).llm,
      enabled: async () => true,
      awsFor: (_sub, record) => (record?.status === 'linked' && record.accountId ? { clients: {} as AwsClients, accountId: record.accountId, region: record.region } : undefined),
      linker,
      walkMs: 0,
    });
    return { tenants, stores, link };
  };
  const refused = (): Snap => ({ ...emptyWorld('us-west-2'), accountId: ACCOUNT, roleRefused: true });
  const statuses = (events: ServerEvent[]) => events.filter((e): e is Extract<ServerEvent, { type: 'account.status' }> => e.type === 'account.status');

  it('account.unlink forgets the link, stops the poller and tells every tab (the reply carries the requestId)', async () => {
    const { tenants, stores } = hub();
    await stores.accounts.put('u1', linkedRecord);
    const tenant = await tenants.acquire({ sub: 'u1' });
    expect(running()).toBe(1);
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    await tenant.unlink('r-unlink', () => {});
    expect(running()).toBe(0);
    expect(await stores.accounts.get('u1')).toBeUndefined();
    expect(statuses(tab)).toEqual([expect.objectContaining({ requestId: 'r-unlink', linked: false, message: expect.stringMatching(/delete the AWSCity stack/) })]);
    expect(await tenant.snapshot()).toBeUndefined();
    tenants.closeAll();
  });

  it(`${BROKEN_AFTER} refused AssumeRoles in a row break the link: polling stops, the record says so, every tab hears it`, async () => {
    const { tenants, stores } = hub();
    await stores.accounts.put('u1', linkedRecord);
    const tenant = await tenants.acquire({ sub: 'u1' });
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    const poller = pollers[0]!;
    // One refused poll, then a good one: the count starts over (a passing STS hiccup isn't a deleted stack).
    poller.poll(refused());
    poller.poll({ ...emptyWorld('us-west-2'), accountId: ACCOUNT });
    poller.poll(refused());
    poller.poll(refused());
    await new Promise((r) => setTimeout(r, 10));
    expect(running()).toBe(1);
    expect(statuses(tab)).toEqual([]);
    poller.poll(refused());
    await vi.waitFor(() => expect(statuses(tab)).toHaveLength(1));
    expect(running()).toBe(0);
    expect(await stores.accounts.get('u1')).toMatchObject({ status: 'linked', accountId: ACCOUNT, brokenAt: expect.any(String) });
    expect(statuses(tab)[0]).toEqual({
      type: 'account.status',
      linked: false,
      broken: true,
      accountId: ACCOUNT,
      region: 'us-west-2',
      message: `I can’t use the AWSCity role in ${ACCOUNT} (us-west-2) any more. Was the stack deleted? Link again, or disconnect.`,
      roleVersion: 4,
      latestRoleVersion: 5,
      templateUrl: 'https://templates.example/player-role/v5.yaml',
    });
    // A refused poll says nothing else to the player (no "IAM locked" lesson per service, no findings resolved).
    expect(tab.filter((e) => e.type !== 'account.status')).toEqual([]);
    tenants.closeAll();
  });

  it('a broken link stays broken after a restart; a new link clears it, and so does a verify', async () => {
    const { tenants, stores, link } = hub();
    await stores.accounts.put('u1', { ...linkedRecord, brokenAt: '2026-11-21T10:00:00.000Z' });
    const tenant = await tenants.acquire({ sub: 'u1' });
    expect(running()).toBe(0);
    const welcome = statuses(await tenant.welcome())[0];
    expect(welcome).toMatchObject({ linked: false, broken: true, accountId: ACCOUNT });
    expect(welcome?.requestId).toBeUndefined(); // the welcome is no reply
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    const asker: ServerEvent[] = [];
    await tenant.link('r-link', 'us-west-2', (e) => asker.push(e), true);
    expect(link).toHaveBeenCalledWith('u1', 'us-west-2', { label: 'Player u1', allowFixes: true });
    expect(asker).toEqual([expect.objectContaining({ type: 'account.linkUrl', requestId: 'r-link' })]);
    expect(statuses(tab).at(-1)).toMatchObject({ linked: false });
    expect(statuses(tab).at(-1)).not.toHaveProperty('broken');
    await tenant.verify('r-verify', ACCOUNT, () => {});
    expect(statuses(tab).at(-1)).toMatchObject({ requestId: 'r-verify', linked: true, fixes: true, roleVersion: 5, latestRoleVersion: 5 });
    expect(running()).toBe(1);
    tenants.closeAll();
  });

  it('a refused verify is an error for the request (never an account.status), and a linked account stays linked', async () => {
    const { LinkError } = await import('../src/accounts/link.js');
    const { tenants, stores } = hub({
      verify: async () => {
        throw new LinkError('Your setup link is more than a day old.');
      },
    });
    await stores.accounts.put('u1', linkedRecord);
    const tenant = await tenants.acquire({ sub: 'u1' });
    const got: ServerEvent[] = [];
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    await tenant.verify('r1', ACCOUNT, (e) => got.push(e));
    expect(got).toEqual([{ type: 'error', requestId: 'r1', message: 'Your setup link is more than a day old.' }]);
    expect(statuses([...got, ...tab])).toEqual([]);
    // Still linked and polling: the last status stands.
    expect(running()).toBe(1);
    expect(statuses(await tenant.welcome())[0]).toMatchObject({ linked: true, accountId: ACCOUNT });
    tenants.closeAll();
  });

  it('GET /me/export: progress, the link as metadata (never the ExternalId or role ARN), and only this player', async () => {
    const { tenants, stores } = hub();
    await stores.accounts.put('u1', { ...linkedRecord, linkedAt: '2026-11-20T10:00:00.000Z' });
    await stores.accounts.put('u2', { ...linkedRecord, accountId: '999988887777', externalId: 'y'.repeat(32) });
    await stores.progress.put('u1', { version: 2, landmarks: {}, updatedAt: '2026-11-21T10:00:00.000Z', profile: { public: true, name: 'Kind Otter' } });
    await stores.progress.put('u2', { version: 2, landmarks: { s3: { discovered: true, xp: 77 } }, updatedAt: '2026-11-21T10:00:00.000Z' });
    await stores.social.submit('shield', '2026-W47', 'u1', 'Kind Otter', 120);
    await stores.social.submit('shield', '2026-W47', 'u2', 'Brave Heron', 999);
    await stores.social.beat('us-west-2', 'u2', { name: 'Brave Heron', rank: 'Town' });
    const out = await tenants.data({ sub: 'u1' }).exportMe();
    expect(out).toMatchObject({
      contract: '2.17',
      progress: { profile: { name: 'Kind Otter' } },
      account: { status: 'linked', accountId: ACCOUNT, region: 'us-west-2', linkedAt: '2026-11-20T10:00:00.000Z', roleVersion: 4, fixes: false },
    });
    expect(out.social).toEqual([{ kind: 'leaderboard', board: 'shield', week: '2026-W47', name: 'Kind Otter', score: 120 }]);
    const text = JSON.stringify(out);
    for (const secret of ['x'.repeat(32), 'y'.repeat(32), 'arn:aws:iam', '999988887777', 'Brave Heron', '"xp":77']) expect(text).not.toContain(secret);
    // The same from a live city.
    expect((await (await tenants.acquire({ sub: 'u1' })).exportMe()).account).toEqual(out.account);
    tenants.closeAll();
  });
});

describe('resource.remove (v2.17): no model, the ActionService, the gate and the player approval', () => {
  const ACCOUNT = '123456789012';
  /** Real gated clients whose requests land in `sent` (signed, so past the gate), never the network. */
  const recording = () => {
    const sent: string[] = [];
    const requestHandler = {
      async handle(r: { headers: Record<string, string>; body?: unknown }) {
        const body = typeof r.body === 'string' ? r.body : '';
        sent.push(r.headers['x-amz-target']?.split('.')[1] ?? /(?:^|&)Action=(\w+)/.exec(body)?.[1] ?? 'other');
        return { response: { statusCode: 200, headers: {}, body: new TextEncoder().encode('') } };
      },
    };
    const clients = clientsFor({ region: 'us-west-2', credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-secret' }), accountId: () => ACCOUNT, requestHandler: requestHandler as never });
    return { sent, clients };
  };
  const setupRemove = async () => {
    pollers.length = 0;
    const { sent, clients } = recording();
    reading.snap = { ...emptyWorld('us-west-2'), accountId: ACCOUNT, resources: [table('city-quest'), table('orders')] };
    const stores = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-remove-${Date.now()}-${Math.random()}/progress.json`);
    await stores.accounts.put('u1', { status: 'linked', externalId: 'x'.repeat(32), region: 'us-west-2', roleArn: 'arn', accountId: ACCOUNT });
    const tenants = createTenants({
      config: loadConfig({}),
      stores,
      uploads: createUploadStore('http://127.0.0.1:1'),
      llm: fakeLlm([]).llm,
      enabled: async () => true,
      awsFor: (_sub, record) => (record?.accountId ? { clients, accountId: record.accountId, region: record.region } : undefined),
      walkMs: 0,
    });
    const tenant = await tenants.acquire({ sub: 'u1' });
    const events: ServerEvent[] = [];
    const approvals = createApprovals({ region: 'us-west-2' });
    /** Every request that would change AWS (the inventory's reads go to the same recorder). */
    const writes = () => sent.filter((op) => /^(Delete|Terminate|Create|Run|Put)/.test(op));
    return { tenants, tenant, events, emit: (e: ServerEvent) => events.push(e), approvals, writes };
  };

  it('approve: one gated DeleteTable, reported on the preview’s deployId', async () => {
    const { tenants, tenant, events, emit, approvals, writes } = await setupRemove();
    const job = tenant.remove({ requestId: 'rm1', kind: 'table', id: 'city-quest' }, emit, approvals);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.preview')).toBe(true));
    const preview = events.find((e) => e.type === 'deploy.preview') as Extract<ServerEvent, { type: 'deploy.preview' }>;
    expect(preview).toMatchObject({ requestId: 'rm1', templateId: 'delete_table', changes: [expect.objectContaining({ action: 'Remove', logicalId: 'city-quest' })] });
    expect(writes()).toEqual([]); // nothing goes out before the player says yes
    approvals.answer(preview.deployId, true);
    await job;
    expect(writes()).toEqual(['DeleteTable']);
    expect(events.filter((e) => e.type === 'deploy.status').map((e) => (e as { status: string }).status)).toEqual(['creating', 'complete']);
    tenants.closeAll();
  });

  it('reject: nothing sent, and the preview says so', async () => {
    const { tenants, tenant, events, emit, approvals, writes } = await setupRemove();
    const job = tenant.remove({ requestId: 'rm2', kind: 'table', id: 'city-quest' }, emit, approvals);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.preview')).toBe(true));
    approvals.answer((events.find((e) => e.type === 'deploy.preview') as { deployId: string }).deployId, false);
    await job;
    expect(writes()).toEqual([]);
    expect(events.filter((e) => e.type === 'deploy.status')).toEqual([expect.objectContaining({ status: 'rejected' })]);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    tenants.closeAll();
  });

  it('an approval that lands after the account went away changes nothing in it', async () => {
    const { tenants, tenant, events, emit, approvals, writes } = await setupRemove();
    const job = tenant.remove({ requestId: 'rm5', kind: 'table', id: 'city-quest' }, emit, approvals);
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.preview')).toBe(true));
    await tenant.deleteMe(); // the account link is gone (as after account.unlink) while the card was open
    approvals.answer((events.find((e) => e.type === 'deploy.preview') as { deployId: string }).deployId, true);
    await job;
    expect(writes()).toEqual([]);
    expect(events.filter((e) => e.type === 'deploy.status').at(-1)).toMatchObject({ status: 'failed', message: expect.stringMatching(/disconnected or changed meanwhile/) });
    tenants.closeAll();
  });

  it('something the city didn’t build, or that isn’t there, is refused before any preview', async () => {
    const { tenants, tenant, events, emit, approvals, writes } = await setupRemove();
    await tenant.remove({ requestId: 'rm3', kind: 'table', id: 'orders' }, emit, approvals);
    await tenant.remove({ requestId: 'rm4', kind: 'bucket', id: 'aws-city-123456789012-gone' }, emit, approvals);
    expect(events).toEqual([
      { type: 'error', requestId: 'rm3', message: expect.stringMatching(/wasn’t built by the city/) },
      { type: 'error', requestId: 'rm4', message: expect.stringMatching(/no warehouse/) },
    ]);
    expect(approvals.size).toBe(0);
    expect(writes()).toEqual([]);
    tenants.closeAll();
  });
});
