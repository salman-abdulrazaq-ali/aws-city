import { describe, expect, it, vi } from 'vitest';
import { DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import { type AwsClients, classifyAwsError, clientsFor, createRefusalBreaker, isRoleRefused, refusalsMarked, REFUSAL_WINDOW_MS, RoleRefusedError } from '../src/aws.js';
import { log } from '../src/log.js';
import { createPoller, mapLimit } from '../src/state/poller.js';

describe('poller helpers', () => {
  it('mapLimit keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, n));
      running--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70]);
    expect(peak).toBe(3);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});

describe('poller caps', () => {
  /** Every client answers by command name; anything unhandled is an empty page. */
  const fakeClients = (handle: (cmd: string, input: Record<string, unknown>) => unknown) => {
    const calls: string[] = [];
    const client = { send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => (calls.push(c.constructor.name), handle(c.constructor.name, c.input) ?? {}) };
    const clients = new Proxy({}, { get: (_t, k) => (k === 's3' ? { ...client, config: { region: async () => 'us-east-1' } } : client) }) as unknown as AwsClients;
    return { clients, calls };
  };

  it('stops paging EC2 and describing DynamoDB tables at 200, game tables first', async () => {
    const tables = [...Array.from({ length: 300 }, (_, i) => `app-${String(i).padStart(3, '0')}`), 'city-orders', 'city-users'];
    const { clients, calls } = fakeClients((cmd, input) => {
      if (cmd === 'DescribeInstancesCommand') {
        const page = Number(input.NextToken ?? 0);
        const Instances = Array.from({ length: 100 }, (_, i) => ({ InstanceId: `i-${page}-${i}` }));
        return { Reservations: [{ Instances }], NextToken: String(page + 1) }; // never ends
      }
      if (cmd === 'ListTablesCommand') {
        const start = input.ExclusiveStartTableName ? tables.indexOf(input.ExclusiveStartTableName as string) + 1 : 0;
        const TableNames = tables.slice(start, start + (input.Limit as number));
        return { TableNames, LastEvaluatedTableName: start + TableNames.length < tables.length ? TableNames.at(-1) : undefined };
      }
      if (cmd === 'DescribeTableCommand') return { Table: { TableName: input.TableName, TableStatus: 'ACTIVE' } };
      return undefined;
    });
    const poller = createPoller({ clients, accountId: '123456789012', region: 'us-east-1', intervalMs: 60_000, onSnapshot: () => {} });
    const snap = await poller.refresh();
    expect(snap.resources.filter((r) => r.kind === 'instance')).toHaveLength(200);
    expect(calls.filter((c) => c === 'DescribeInstancesCommand')).toHaveLength(2);
    const described = snap.resources.filter((r) => r.kind === 'table').map((r) => r.id);
    expect(described).toHaveLength(200);
    expect(described.slice(0, 2)).toEqual(['city-orders', 'city-users']);
    expect(calls.filter((c) => c === 'DescribeTableCommand')).toHaveLength(200);
  });

  // Seen 22 Nov 2026: a table listed and then not yet found failed the whole DynamoDB read three polls running.
  it('a table that is listed but not found a moment later is skipped, and DynamoDB still reads ok', async () => {
    const { clients } = fakeClients((cmd, input) => {
      if (cmd === 'ListTablesCommand') return { TableNames: ['city-new', 'city-old'] };
      if (cmd === 'DescribeTableCommand') {
        if (input.TableName === 'city-new') throw Object.assign(new Error('Requested resource not found'), { name: 'ResourceNotFoundException' });
        return { Table: { TableName: input.TableName, TableStatus: 'ACTIVE' } };
      }
      return undefined;
    });
    const poller = createPoller({ clients, accountId: '123456789012', region: 'us-west-2', intervalMs: 60_000, onSnapshot: () => {} });
    const snap = await poller.refresh();
    expect(snap.services.dynamodb).toBe('ok');
    expect(snap.resources.filter((r) => r.kind === 'table').map((r) => r.id)).toEqual(['city-old']);
  });

  it('caches a denied setting read as unknown instead of re-reading it every poll', async () => {
    const denied = () => Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    const { clients, calls } = fakeClients((cmd, input) => {
      if (cmd === 'ListTablesCommand') return { TableNames: ['app-a', 'app-b'] };
      if (cmd === 'DescribeTableCommand') return { Table: { TableName: input.TableName, TableStatus: 'ACTIVE' } };
      if (cmd === 'DescribeContinuousBackupsCommand' || cmd === 'GetEbsEncryptionByDefaultCommand') throw denied();
      return undefined;
    });
    const poller = createPoller({ clients, accountId: '123456789012', region: 'us-east-1', intervalMs: 60_000, onSnapshot: () => {} });
    await poller.refresh();
    const snap = await poller.refresh();
    expect(calls.filter((c) => c === 'DescribeContinuousBackupsCommand')).toHaveLength(2); // once per table, not once per poll
    expect(calls.filter((c) => c === 'GetEbsEncryptionByDefaultCommand')).toHaveLength(1);
    // Unreadable stays unknown (null), never "off": no finding is raised from it.
    expect(snap.resources.filter((r) => r.kind === 'table').map((r) => r.meta.pitr)).toEqual([null, null]);
    expect(snap.account?.ebsEncryptionByDefault).toBeUndefined();
  });
});

describe('a refused role (v2.17)', () => {
  const fakeClients = (handle: (cmd: string) => unknown) => {
    const client = { send: async (c: { constructor: { name: string } }) => handle(c.constructor.name) ?? {} };
    return new Proxy({}, { get: (_t, k) => (k === 's3' ? { ...client, config: { region: async () => 'us-east-1' } } : client) }) as unknown as AwsClients;
  };

  it('refusalsMarked: STS refusing the role becomes RoleRefusedError (same name, same kind); anything else passes as it was', async () => {
    const ROLE = 'arn:aws:iam::111122223333:role/AWSCityPlayerRole-us-west-2';
    const failing = (name: string, message = name) => refusalsMarked(async () => Promise.reject(Object.assign(new Error(message), { name })), ROLE);
    const caught = (name: string, message?: string) => failing(name, message)().catch((e: unknown) => e);
    const denied: unknown = await caught('AccessDenied', `User: arn:aws:sts::999999999999:assumed-role/Task/x is not authorized to perform: sts:AssumeRole on resource: ${ROLE}`);
    expect(isRoleRefused(denied)).toBe(true);
    expect(classifyAwsError(denied)).toBe('denied');
    // Our own task credentials failing is never the player's role refusing: it would break every player's link at once.
    for (const name of ['ExpiredToken', 'InvalidClientTokenId', 'RequestExpired']) {
      const err = (await caught(name)) as Error;
      expect(isRoleRefused(err)).toBe(false);
      expect(classifyAwsError(err)).toBe('expired');
    }
    // An AccessDenied that isn't AssumeRole on this player's role, or that our own role's identity policy caused.
    expect(isRoleRefused(await caught('AccessDenied', 'not authorized to perform: sts:AssumeRole on resource: arn:aws:iam::444455556666:role/Other'))).toBe(false);
    expect(isRoleRefused(await caught('AccessDenied', `not authorized to perform: sts:AssumeRole on resource: ${ROLE} because no identity-based policy allows the sts:AssumeRole action`))).toBe(false);
    expect(isRoleRefused(await caught('AccessDenied', 'Access denied'))).toBe(false);
    const other = (await caught('Throttling')) as Error;
    expect(isRoleRefused(other)).toBe(false);
    expect(other.name).toBe('Throttling');
  });

  it('an AccessDenied that names a policy on our own principal (SCP, permissions boundary, session policy) is our side, never the player’s role', async () => {
    const ROLE = 'arn:aws:iam::111122223333:role/AWSCityPlayerRole-us-west-2';
    const caught = (message: string) => refusalsMarked(async () => Promise.reject(Object.assign(new Error(message), { name: 'AccessDenied' })), ROLE)().catch((e: unknown) => e);
    const ours = `User: arn:aws:sts::999999999999:assumed-role/Task/x is not authorized to perform: sts:AssumeRole on resource: ${ROLE}`;
    for (const why of [
      'with an explicit deny in a service control policy',
      'because no service control policy allows the sts:AssumeRole action',
      'with an explicit deny in a permissions boundary',
      'because no permissions boundary allows the sts:AssumeRole action',
      'with an explicit deny in a session policy',
      'because no session policy allows the sts:AssumeRole action',
    ])
      expect(isRoleRefused(await caught(`${ours} ${why}`))).toBe(false);
    // The player's role's own trust policy (resource-based) refusing us is still theirs.
    expect(isRoleRefused(await caught(`${ours} with an explicit deny in a resource-based policy`))).toBe(true);
  });

  it('refusals with feedsBreaker: false (a verify) never count toward the shared breaker, nor clear it', async () => {
    const ROLE = 'arn:aws:iam::111122223333:role/AWSCityPlayerRole-us-west-2';
    const breaker = createRefusalBreaker({ now: () => 0 });
    const refusal = () => Object.assign(new Error(`User: arn:aws:sts::999999999999:assumed-role/Task/x is not authorized to perform: sts:AssumeRole on resource: ${ROLE}`), { name: 'AccessDenied' });
    for (const player of ['v1', 'v2', 'v3']) {
      const err: unknown = await refusalsMarked(async () => Promise.reject(refusal()), ROLE, { player, breaker, feedsBreaker: false })().catch((e: unknown) => e);
      expect(isRoleRefused(err)).toBe(true);
      expect((err as RoleRefusedError).ourSide).toBe(false);
    }
    // Not tripped: two pollers' refusals are still those players' own.
    expect(breaker.ourSide('p1')).toBe(false);
    expect(breaker.ourSide('p2')).toBe(false);
    // A verify that works doesn't clear what the pollers counted either.
    await refusalsMarked(async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), ROLE, { player: 'v4', breaker, feedsBreaker: false })();
    expect(breaker.ourSide('p3')).toBe(true);
  });

  it('a real SDK client hands the refusal on unchanged (it is still RoleRefusedError when send() fails), before any request', async () => {
    const sent: string[] = [];
    const requestHandler = { handle: async () => (sent.push('request'), { response: { statusCode: 200, headers: {}, body: new Uint8Array() } }) };
    const refusing = refusalsMarked(async () => Promise.reject(Object.assign(new Error('not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' })));
    const clients = clientsFor({ region: 'us-west-2', credentials: refusing, accountId: () => '123456789012', requestHandler: requestHandler as never });
    const err = await clients.ec2.send(new DescribeInstancesCommand({})).catch((e: unknown) => e);
    expect(isRoleRefused(err)).toBe(true);
    expect(sent).toEqual([]);
  });

  it('the refusal breaker: the role refusing 3 different players within 5 minutes, with no AssumeRole working between, is our side (logged once)', async () => {
    const ROLE = 'arn:aws:iam::111122223333:role/AWSCityPlayerRole-us-west-2';
    let t = 0;
    const breaker = createRefusalBreaker({ now: () => t });
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const refusal = () => Object.assign(new Error(`User: arn:aws:sts::999999999999:assumed-role/Task/x is not authorized to perform: sts:AssumeRole on resource: ${ROLE}`), { name: 'AccessDenied' });
    const ourSide = async (player: string) => {
      const err: unknown = await refusalsMarked(async () => Promise.reject(refusal()), ROLE, { player, breaker })().catch((e: unknown) => e);
      expect(isRoleRefused(err)).toBe(true);
      return (err as RoleRefusedError).ourSide;
    };
    try {
      expect(await ourSide('p1')).toBe(false);
      expect(await ourSide('p1')).toBe(false); // the same player again (every client of a poll asks) is still one
      expect(await ourSide('p2')).toBe(false);
      expect(await ourSide('p3')).toBe(true);
      expect(await ourSide('p1')).toBe(true);
      expect(error).toHaveBeenCalledTimes(1);
      // An AssumeRole that works (anyone's): STS and our role are fine, so later refusals are the players' own again.
      await refusalsMarked(async () => ({ accessKeyId: 'a', secretAccessKey: 'b' }), ROLE, { player: 'p4', breaker })();
      expect(await ourSide('p1')).toBe(false);
      expect(await ourSide('p2')).toBe(false);
      // Spread over more than the window: still each player's own.
      t += REFUSAL_WINDOW_MS + 1;
      expect(await ourSide('p3')).toBe(false);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('a poll whose refusals the breaker took for our side says so (refusedOurSide), so the tenant does not count it', async () => {
    const clients = fakeClients(() => {
      throw new RoleRefusedError(Object.assign(new Error('not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' }), true);
    });
    const poller = createPoller({ clients, accountId: '123456789012', region: 'us-east-1', intervalMs: 60_000, onSnapshot: () => {} });
    expect(await poller.refresh()).toMatchObject({ roleRefused: true, refusedOurSide: true });
  });

  it("marks the poll roleRefused and keeps what was seen; one service's AccessDenied only locks that service", async () => {
    let mode: 'ok' | 'refused' | 'lambda-denied' = 'ok';
    const clients = fakeClients((cmd) => {
      if (mode === 'refused') throw new RoleRefusedError(Object.assign(new Error('not authorized to perform: sts:AssumeRole'), { name: 'AccessDenied' }));
      if (mode === 'lambda-denied' && cmd === 'ListFunctionsCommand') throw Object.assign(new Error('no'), { name: 'AccessDeniedException' });
      if (cmd === 'ListTablesCommand') return { TableNames: ['city-a'] };
      if (cmd === 'DescribeTableCommand') return { Table: { TableName: 'city-a', TableStatus: 'ACTIVE' } };
      return undefined;
    });
    const poller = createPoller({ clients, accountId: '123456789012', region: 'us-east-1', intervalMs: 60_000, onSnapshot: () => {} });
    const first = await poller.refresh();
    expect(first.roleRefused).toBeUndefined();
    mode = 'refused';
    const second = await poller.refresh();
    expect(second).toMatchObject({ roleRefused: true, credentials: 'ok' });
    expect(second.refusedOurSide).toBeUndefined(); // the player's own refusal counts
    expect(new Set(Object.values(second.services))).toEqual(new Set(['error'])); // not "locked": IAM didn't lock a service
    expect(second.resources.map((r) => r.id)).toEqual(first.resources.map((r) => r.id));
    mode = 'lambda-denied';
    const third = await poller.refresh();
    expect(third.roleRefused).toBeUndefined();
    expect(third.services.lambda).toBe('locked');
  });
});
