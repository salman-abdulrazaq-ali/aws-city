import { describe, expect, it, vi } from 'vitest';
import type { AccountLinker } from '../src/accounts/link.js';
import { type AwsClients, clientsFor } from '../src/aws.js';
import { loadConfig } from '../src/config.js';
import { createApprovals } from '../src/contract/approvals.js';
import { createUploadStore } from '../src/contract/uploads.js';
import { BROKEN_AFTER, emptyWorld } from '../src/tenants.js';
import { localStores } from '../src/store/local.js';
import { today } from '../src/store/types.js';
import type { ServerEvent } from '../src/world.js';
import { fakeLlm, message, text, toolUse } from './fakes.js';
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
    // The card was cancelled the moment the account went away: its own deploy.status says why, and nothing else follows.
    expect(events.filter((e) => e.type === 'deploy.status').at(-1)).toMatchObject({ status: 'rejected', message: 'That account was disconnected, so nothing changed.' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
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

describe('a disconnected or changed account changes nothing (v2.17)', () => {
  const ACCOUNT = '123456789012';
  const record = { status: 'linked' as const, externalId: 'x'.repeat(32), region: 'us-west-2', roleArn: 'arn', accountId: ACCOUNT, roleVersion: 4, fixes: true };
  /** One server task's tenant hub: hosted-like (a linker for unlink and recheck), acting only for a linked record. */
  const hubOn = (stores: ReturnType<typeof localStores>, clients: AwsClients, opts: { llm?: ReturnType<typeof fakeLlm>['llm']; accountCheckMs?: number; recheck?: AccountLinker['recheck'] } = {}) =>
    createTenants({
      config: loadConfig({ AWS_CITY_AGENT_ENGINE: 'classic' }),
      stores,
      uploads: createUploadStore('http://127.0.0.1:1'),
      llm: opts.llm ?? fakeLlm([]).llm,
      enabled: async () => true,
      awsFor: (_sub, r) => (r?.status === 'linked' && r.accountId ? { clients, accountId: r.accountId, region: r.region } : undefined),
      linker: { templateUrl: 'https://templates.example/player-role/v5.yaml', latestRoleVersion: 5, recheck: opts.recheck } as unknown as AccountLinker,
      walkMs: 0,
      accountCheckMs: opts.accountCheckMs,
    });
  /** A linked player, real gated clients whose requests land in `sent` (never the network), and a table City care can fix. */
  const setupWorld = async () => {
    pollers.length = 0;
    const sent: string[] = [];
    const WRITE = /^(Delete|Terminate|Create|Run|Put|Update|Enable|Modify|Revoke)/;
    /** While set, a write waits here (in flight, holding the account lock) until released. */
    let held: Promise<void> | undefined;
    const requestHandler = {
      async handle(r: { headers: Record<string, string>; body?: unknown }) {
        const body = typeof r.body === 'string' ? r.body : '';
        const op = r.headers['x-amz-target']?.split('.')[1] ?? /(?:^|&)Action=(\w+)/.exec(body)?.[1] ?? 'other';
        sent.push(op);
        if (held && WRITE.test(op)) await held;
        return { response: { statusCode: 200, headers: {}, body: new TextEncoder().encode('') } };
      },
    };
    const clients = clientsFor({ region: 'us-west-2', credentials: async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-secret' }), accountId: () => ACCOUNT, requestHandler: requestHandler as never });
    /** Every request that would change AWS (the inventory's and the fix's reads go to the same recorder). */
    const writes = () => sent.filter((op) => WRITE.test(op));
    /** Holds every write until the returned function is called. */
    const hold = () => {
      let release!: () => void;
      held = new Promise((r) => (release = r));
      return () => ((held = undefined), release());
    };
    // A table the city built, without point-in-time recovery (a fix City care offers), and room for one more.
    reading.snap = { ...emptyWorld('us-west-2'), accountId: ACCOUNT, resources: [{ ...table('city-quest'), meta: { pitr: false } }] };
    const stores = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-retire-${Date.now()}-${Math.random()}/progress.json`);
    await stores.accounts.put('u1', record);
    await stores.progress.put('u1', { version: 2, landmarks: {}, updatedAt: '2026-11-21T10:00:00.000Z', citizens: { 'citizen:reliability': { xp: 25 } } });
    return { stores, clients, writes, hold };
  };
  const previews = (events: ServerEvent[]) => events.filter((e): e is Extract<ServerEvent, { type: 'deploy.preview' }> => e.type === 'deploy.preview');
  const statusOf = (events: ServerEvent[], deployId: string) => events.filter((e) => e.type === 'deploy.status' && e.deployId === deployId).at(-1);

  it('an agent write and a finding.fix waiting for approval: unlink cancels both cards, and approving them sends nothing', async () => {
    const plan = message([toolUse('p1', 'plan_task', { agentId: 'dynamodb', steps: ['Make a table'], reply: 'A job for the library!' })], 'tool_use');
    const llm = fakeLlm([plan, message([toolUse('t1', 'create_table', { name: 'city-orders' })], 'tool_use'), message([text('Done')], 'end_turn')]).llm;
    const { stores, clients, writes } = await setupWorld();
    const tenants = hubOn(stores, clients, { llm });
    const tenant = await tenants.acquire({ sub: 'u1' });
    pollers[0]!.poll(reading.snap!);
    const events: ServerEvent[] = [];
    const emit = (e: ServerEvent) => events.push(e);
    const approvals = createApprovals({ region: 'us-west-2' });
    const finding = tenant.care()!.open().find((f) => f.ruleId === 'dynamodb-no-pitr')!;
    const fixing = tenant.care()!.fix('f1', finding.id, emit, approvals);
    await vi.waitFor(() => expect(previews(events)).toHaveLength(1));
    const task = tenant.orchestrator().submitTask({ taskId: 't1', prompt: 'make me a table', context: {} }, emit, approvals);
    await vi.waitFor(() => expect(previews(events)).toHaveLength(2));
    expect(writes()).toEqual([]);

    await tenant.unlink('r-unlink', () => {});
    for (const p of previews(events)) {
      expect(statusOf(events, p.deployId)).toMatchObject({ status: 'rejected', message: 'That account was disconnected, so nothing changed.' });
      expect(approvals.answer(p.deployId, true)).toBe(false); // nothing left to approve
    }
    await Promise.all([fixing, task]);
    expect(writes()).toEqual([]);
    expect(approvals.size).toBe(0);
    tenants.closeAll();
  });

  it('another server task unlinked: an approval here re-reads the link inside the lock and changes nothing', async () => {
    const { stores, clients, writes } = await setupWorld();
    const here = hubOn(stores, clients);
    const there = hubOn(stores, clients);
    const tenant = await here.acquire({ sub: 'u1' });
    const elsewhere = await there.acquire({ sub: 'u1' });
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    const events: ServerEvent[] = [];
    const approvals = createApprovals({ region: 'us-west-2' });
    const job = tenant.remove({ requestId: 'rm1', kind: 'table', id: 'city-quest' }, (e) => events.push(e), approvals);
    await vi.waitFor(() => expect(previews(events)).toHaveLength(1));
    await elsewhere.unlink('r-unlink', () => {}); // the other task: this one's world doesn't know yet
    approvals.answer(previews(events)[0]!.deployId, true);
    await job;
    expect(writes()).toEqual([]);
    expect(statusOf(events, previews(events)[0]!.deployId)).toMatchObject({ status: 'failed', message: expect.stringMatching(/disconnected or changed meanwhile/) });
    // The stale world is rebuilt from the store: every tab here hears the account went.
    await vi.waitFor(() => expect(tab).toContainEqual(expect.objectContaining({ type: 'account.status', linked: false })));
    expect(await tenant.snapshot()).toBeUndefined();
    here.closeAll();
    there.closeAll();
  });

  it('an open city re-reads its account record about once a minute: an unlink on another task stops its poller', async () => {
    const { stores, clients } = await setupWorld();
    const here = hubOn(stores, clients, { accountCheckMs: 20 });
    const there = hubOn(stores, clients);
    const tenant = await here.acquire({ sub: 'u1' });
    const elsewhere = await there.acquire({ sub: 'u1' });
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    expect(running()).toBe(2);
    await elsewhere.unlink('r-unlink', () => {});
    await vi.waitFor(() => expect(tab).toContainEqual(expect.objectContaining({ type: 'account.status', linked: false })));
    expect(running()).toBe(0);
    // A link and then a broken mark written by another task reach this one too.
    await stores.accounts.put('u1', record);
    await vi.waitFor(() => expect(tab.filter((e) => e.type === 'account.status').at(-1)).toMatchObject({ linked: true }));
    await stores.accounts.put('u1', { ...record, brokenAt: '2026-11-21T10:00:00.000Z' });
    await vi.waitFor(() => expect(tab.filter((e) => e.type === 'account.status').at(-1)).toMatchObject({ linked: false, broken: true }));
    here.closeAll();
    there.closeAll();
  });

  it('a warm city with no tab open still re-reads its record: a Disconnect on another task stops its poller within a minute', async () => {
    const { stores, clients } = await setupWorld();
    const here = hubOn(stores, clients, { accountCheckMs: 20 });
    const there = hubOn(stores, clients);
    await here.acquire({ sub: 'u1' });
    here.release({ sub: 'u1' }); // the last tab closed: the city stays warm (and polling) for a while
    const elsewhere = await there.acquire({ sub: 'u1' });
    expect(running()).toBe(2);
    await elsewhere.unlink('r-unlink', () => {});
    await vi.waitFor(() => expect(running()).toBe(0));
    here.closeAll();
    there.closeAll();
  });

  it('a disconnect and a new link of the same account and Region on another task: this task rebuilds, and never marks the new link broken', async () => {
    const { stores, clients } = await setupWorld();
    await stores.accounts.put('u1', { ...record, linkedAt: '2026-11-21T10:00:00.000Z' });
    const here = hubOn(stores, clients);
    const there = hubOn(stores, clients);
    const tenant = await here.acquire({ sub: 'u1' });
    const elsewhere = await there.acquire({ sub: 'u1' });
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    const old = pollers[0]!;
    // Another task: Disconnect, then a new stack (a new ExternalId) for the same account and Region, verified.
    await elsewhere.unlink('r-unlink', () => {});
    const relinked = { ...record, externalId: 'z'.repeat(32), linkedAt: '2026-11-21T11:00:00.000Z' };
    await stores.accounts.put('u1', relinked);
    // This task's world still uses the old ExternalId, which the new stack refuses.
    const refused: Snap = { ...emptyWorld('us-west-2'), accountId: ACCOUNT, roleRefused: true };
    for (let i = 0; i < BROKEN_AFTER; i++) old.poll(refused);
    await vi.waitFor(() => expect(tab).toContainEqual(expect.objectContaining({ type: 'account.status', linked: true, accountId: ACCOUNT })));
    expect(await stores.accounts.get('u1')).toEqual(relinked); // no brokenAt written onto the new link
    expect(old.running).toBe(false);
    expect(pollers.at(-1)!.running).toBe(true); // rebuilt on the new link
    here.closeAll();
    there.closeAll();
  });

  it('a link that broke is marked only if it is still the same link when the mark is written', async () => {
    const { stores, clients } = await setupWorld();
    await stores.accounts.put('u1', { ...record, linkedAt: '2026-11-21T10:00:00.000Z' });
    const relinked = { ...record, externalId: 'z'.repeat(32), linkedAt: '2026-11-21T11:00:00.000Z' };
    // Another task relinks right after this one reads the record for the mark (between its read and its write).
    let reads = 0;
    const get = stores.accounts.get.bind(stores.accounts);
    stores.accounts.get = async (sub) => {
      const r = await get(sub);
      if (++reads === 2) await stores.accounts.put(sub, relinked); // read 1 builds the world; read 2 is the mark's
      return r;
    };
    const here = hubOn(stores, clients);
    const tenant = await here.acquire({ sub: 'u1' });
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    const refused: Snap = { ...emptyWorld('us-west-2'), accountId: ACCOUNT, roleRefused: true };
    for (let i = 0; i < BROKEN_AFTER; i++) pollers[0]!.poll(refused);
    await vi.waitFor(() => expect(tab).toContainEqual(expect.objectContaining({ type: 'account.status', linked: true })));
    expect(await get('u1')).toEqual(relinked);
    here.closeAll();
  });

  it('refusals the breaker took for our side (many players at once) never count toward breaking the link', async () => {
    const { stores, clients } = await setupWorld();
    const tenants = hubOn(stores, clients);
    const tenant = await tenants.acquire({ sub: 'u1' });
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    const ours: Snap = { ...emptyWorld('us-west-2'), accountId: ACCOUNT, roleRefused: true, refusedOurSide: true };
    for (let i = 0; i < BROKEN_AFTER + 2; i++) pollers[0]!.poll(ours);
    await new Promise((r) => setTimeout(r, 20));
    expect(pollers[0]!.running).toBe(true);
    expect(await stores.accounts.get('u1')).not.toHaveProperty('brokenAt');
    // And nothing is said for those polls (nothing was read): only the first inventory read, from before them.
    expect(tab.filter((e) => e.type !== 'city.inventory')).toEqual([]);
    tenants.closeAll();
  });

  it('Disconnect waits for a write already past the live check (it holds the account lock): once it returns, nothing more changes', async () => {
    const { stores, clients, writes, hold } = await setupWorld();
    const tenants = hubOn(stores, clients);
    const tenant = await tenants.acquire({ sub: 'u1' });
    const events: ServerEvent[] = [];
    const approvals = createApprovals({ region: 'us-west-2' });
    const release = hold();
    const job = tenant.remove({ requestId: 'rm1', kind: 'table', id: 'city-quest' }, (e) => events.push(e), approvals);
    await vi.waitFor(() => expect(previews(events)).toHaveLength(1));
    approvals.answer(previews(events)[0]!.deployId, true);
    await vi.waitFor(() => expect(writes()).toEqual(['DeleteTable'])); // in flight
    let unlinked = false;
    const unlinking = tenant.unlink('r-unlink', () => {}).then(() => void (unlinked = true));
    await new Promise((r) => setTimeout(r, 40));
    expect(unlinked).toBe(false);
    expect(await stores.accounts.get('u1')).toBeDefined(); // not forgotten while the write runs
    release();
    await Promise.all([job, unlinking]);
    expect(await stores.accounts.get('u1')).toBeUndefined();
    expect(statusOf(events, previews(events)[0]!.deployId)).toMatchObject({ status: 'complete' });
    tenants.closeAll();
  });

  it('Check again (account.recheck) refreshes fixes on every tab, keeps the role version and the same world (pending cards stand)', async () => {
    const { stores, clients } = await setupWorld();
    await stores.accounts.put('u1', { ...record, fixes: false });
    const recheck = vi.fn(async (sub: string) => {
      const r = { ...(await stores.accounts.get(sub))!, status: 'linked' as const, fixes: true };
      await stores.accounts.put(sub, r);
      return r;
    });
    const tenants = hubOn(stores, clients, { recheck });
    const tenant = await tenants.acquire({ sub: 'u1' });
    const tab: ServerEvent[] = [];
    tenant.subscribe((e) => tab.push(e));
    const events: ServerEvent[] = [];
    const approvals = createApprovals({ region: 'us-west-2' });
    void tenant.remove({ requestId: 'rm1', kind: 'table', id: 'city-quest' }, (e) => events.push(e), approvals);
    await vi.waitFor(() => expect(previews(events)).toHaveLength(1));
    await tenant.recheck('r-check', () => {});
    expect(tab.filter((e) => e.type === 'account.status')).toEqual([expect.objectContaining({ requestId: 'r-check', linked: true, fixes: true, roleVersion: 4 })]);
    expect(pollers).toHaveLength(1); // not rebuilt
    expect(approvals.size).toBe(1); // the removal's card still waits
    expect(statusOf(events, previews(events)[0]!.deployId)).toBeUndefined();
    tenants.closeAll();
  });

  it('GET /me/export has every stored row the privacy policy lists: the bill, the AI counts, the first AI day, the MFA time, the link times', async () => {
    const { stores } = await setupWorld();
    await stores.accounts.put('u1', { ...record, linkIssuedAt: '2026-11-20T09:00:00.000Z', linkRoleVersion: 5, brokenAt: '2026-11-21T09:00:00.000Z' });
    await stores.bills.setOn('u1', true);
    await stores.quota.consume('u1', today(), 10);
    await stores.quota.firstSeen('u1', '2026-11-19');
    await stores.mfa.since('u1', Date.parse('2026-11-18T08:00:00.000Z'));
    const tenants = hubOn(stores, {} as AwsClients);
    const out = await tenants.data({ sub: 'u1' }).exportMe();
    expect(out).toMatchObject({
      account: { linkIssuedAt: '2026-11-20T09:00:00.000Z', linkRoleVersion: 5, roleVersion: 4, broken: true, brokenAt: '2026-11-21T09:00:00.000Z' },
      bill: { on: true },
      aiCalls: [{ day: today(), calls: 1 }],
      firstSeenDay: '2026-11-19',
      mfaOnSince: '2026-11-18T08:00:00.000Z',
    });
    // Reading it saved nothing new: a player with no rows gets none.
    const none = await tenants.data({ sub: 'u2' }).exportMe();
    for (const k of ['bill', 'aiCalls', 'firstSeenDay', 'mfaOnSince', 'account']) expect(none).not.toHaveProperty(k);
    expect(await stores.quota.firstDay('u2')).toBeUndefined();
    expect(await stores.mfa.get('u2')).toBeUndefined();
    tenants.closeAll();
  });
});
