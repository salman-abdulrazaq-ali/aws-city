import { whoOf } from '../src/social.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { AddressInfo } from 'node:net';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { connectsPlayerLabel, createAccountLinker, playerRoleName, templateVersion } from '../src/accounts/link.js';
import { APIConnectionError, APIConnectionTimeoutError, APIUserAbortError, BadRequestError, InternalServerError, PermissionDeniedError, RateLimitError } from '@anthropic-ai/sdk';
import { createMfaCheck, memoryMfa, SIGN_IN_AGAIN_MESSAGE, type StepUp } from '../src/accounts/mfa.js';
import { metered, ModelLimitError, NEW_PLAYERS_KEY, PAUSED_MESSAGE, QUOTA_MESSAGE, withErrorCodes } from '../src/agents/metered.js';
import { cognitoAuth, type JwtVerifier, type Principal } from '../src/auth.js';
import { publicError, setPublicErrors } from '../src/log.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createUploadStore } from '../src/contract/uploads.js';
import { createHttpServer } from '../src/http.js';
import { dynamoStores } from '../src/store/dynamo.js';
import { localStores, memoryQuota } from '../src/store/local.js';
import { LockLostError, today } from '../src/store/types.js';
import { executeAction } from '../src/agents/executor.js';
import { type AwsClients, createRefusalBreaker, refusalsMarked } from '../src/aws.js';
import type { Approvals } from '../src/contract/approvals.js';
import { createTenants, type Tenant, UNLINKED_REASON } from '../src/tenants.js';
import type { ServerEvent } from '../src/world.js';
import { bearerSubprotocols, CLOSE_CODES, CONTRACT_HEADER, CONTRACT_VERSION } from '../../src/backend/contract.js';
import { fakeLlm, message, text } from './fakes.js';

const EXT = 'chrome-extension://storeid';
const SELF = '999999999999';

describe('config refuses unsafe setups', () => {
  it('token mode is loopback-only; hosted needs its settings', () => {
    expect(() => loadConfig({ HOST: '0.0.0.0' })).toThrow(ConfigError);
    expect(() => loadConfig({ AWS_CITY_MODE: 'hosted' })).toThrow(/COGNITO/);
    expect(loadConfig({}).authMode).toBe('token');
    const hosted = loadConfig({
      AWS_CITY_MODE: 'hosted', HOST: '0.0.0.0', PUBLIC_HOSTS: 'api.example.com', COGNITO_USER_POOL_ID: 'p', COGNITO_CLIENT_ID: 'c',
      EXTENSION_ORIGIN: EXT, TABLE_NAME: 't', SCREENSHOT_BUCKET: 'b', SELF_ACCOUNT_ID: SELF, PLAYER_ROLE_TEMPLATE_URL: 'https://x/t.yaml',
    });
    expect(hosted).toMatchObject({ authMode: 'cognito', awsMode: 'assume-role', store: 'dynamodb', uploads: 's3' });
  });

  it('signed-in players never share the operator’s profile account (cognito needs assume-role)', () => {
    const signedIn = { AUTH_MODE: 'cognito', COGNITO_USER_POOL_ID: 'p', COGNITO_CLIENT_ID: 'c', EXTENSION_ORIGIN: EXT };
    expect(() => loadConfig(signedIn)).toThrow(/AWS_MODE=assume-role/);
    expect(() => loadConfig({ ...signedIn, AWS_MODE: 'profile' })).toThrow(/AWS_MODE=assume-role/);
  });

  it('rejects typos and nonsense values instead of falling back to a looser mode', () => {
    expect(() => loadConfig({ AUTH_MODE: 'Cognito' })).toThrow(/AUTH_MODE=Cognito/);
    expect(() => loadConfig({ AWS_MODE: 'assume_role' })).toThrow(ConfigError);
    expect(() => loadConfig({ STORE: 'dynamo' })).toThrow(ConfigError);
    expect(() => loadConfig({ POLL_INTERVAL_MS: '0' })).toThrow(/POLL_INTERVAL_MS/);
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => loadConfig({ AWS_CITY_TOKEN: 'short' })).toThrow(/AWS_CITY_TOKEN/);
    expect(loadConfig({ AWS_CITY_TOKEN: 'x'.repeat(32) }).token).toHaveLength(32);
  });
});

describe('metered model calls', () => {
  it('stops at the daily quota with a friendly, coded error', async () => {
    const { llm } = fakeLlm([message([text('a')], 'end_turn'), message([text('b')], 'end_turn')]);
    const m = metered(llm, { sub: 'u1', quota: memoryQuota(), daily: 1, globalDaily: 10, enabled: async () => true });
    await m.create({ max_tokens: 10, messages: [] });
    await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toThrow(ModelLimitError);
    const seen: ServerEvent[] = [];
    withErrorCodes<ServerEvent>((e) => seen.push(e))({ type: 'error', message: `Chat failed: ${QUOTA_MESSAGE}` });
    expect(seen[0]).toMatchObject({ code: 'quota' });
  });

  it('a refusal is retried once on the fallback model, and the retry counts against the quota', async () => {
    const refused = { ...message([text('no')], 'end_turn'), stop_reason: 'refusal' } as Anthropic.Message;
    const { llm, calls } = fakeLlm([refused, message([text('ok')], 'end_turn')]);
    const quota = memoryQuota();
    const m = metered(llm, { sub: 'u1', quota, daily: 1, globalDaily: 10, enabled: async () => true });
    // Daily quota of 1: the fallback is a second call, so it's refused rather than run for free.
    await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toThrow(QUOTA_MESSAGE);
    expect(calls).toHaveLength(1);
    await quota.firstSeen('u2', '2026-01-01'); // an established player: their full daily quota
    const roomy = metered(fakeLlm([refused, message([text('ok')], 'end_turn')]).llm, { sub: 'u2', quota, daily: 5, globalDaily: 10, enabled: async () => true });
    expect((await roomy.create({ max_tokens: 10, messages: [] })).stop_reason).toBe('end_turn');
  });

  it('a player first seen today gets a fifth of the daily calls; a returning player all of them', async () => {
    const replies = () => Array.from({ length: 30 }, () => message([text('a')], 'end_turn'));
    const quota = memoryQuota();
    const fresh = metered(fakeLlm(replies()).llm, { sub: 'new', quota, daily: 10, globalDaily: 1000, enabled: async () => true });
    for (let i = 0; i < 2; i++) await fresh.create({ max_tokens: 10, messages: [] });
    await expect(fresh.create({ max_tokens: 10, messages: [] })).rejects.toMatchObject({ code: 'quota' });
    await quota.firstSeen('old', '2026-01-01');
    const old = metered(fakeLlm(replies()).llm, { sub: 'old', quota, daily: 10, globalDaily: 1000, enabled: async () => true });
    for (let i = 0; i < 10; i++) await old.create({ max_tokens: 10, messages: [] });
    await expect(old.create({ max_tokens: 10, messages: [] })).rejects.toMatchObject({ code: 'quota' });
    // The local server's one player is never "new".
    const local = metered(fakeLlm(replies()).llm, { sub: 'local', quota, daily: 10, globalDaily: 1000, enabled: async () => true });
    for (let i = 0; i < 10; i++) await local.create({ max_tokens: 10, messages: [] });
  });

  it('players first seen today share at most a quarter of the city’s cap, so throwaway sign-ups can’t use up its day', async () => {
    const quota = memoryQuota();
    const signUp = (sub: string) => metered(fakeLlm(Array.from({ length: 5 }, () => message([text('a')], 'end_turn'))).llm, { sub, quota, daily: 100, globalDaily: 100, enabled: async () => true });
    // 200 throwaway accounts, 20 calls each at most: the new players' share (25 of 100) runs out, the rest stays.
    let served = 0;
    for (let i = 0; i < 200; i++) {
      const m = signUp(`bot-${i}`);
      for (let c = 0; c < 2; c++) served += await m.create({ max_tokens: 10, messages: [] }).then(() => 1, () => 0);
    }
    expect(served).toBe(25);
    expect(await quota.used(NEW_PLAYERS_KEY, today())).toBe(25);
    expect(await quota.used('GLOBAL', today())).toBe(25);
    await quota.firstSeen('regular', '2026-01-01');
    const regular = metered(fakeLlm([message([text('a')], 'end_turn')]).llm, { sub: 'regular', quota, daily: 100, globalDaily: 100, enabled: async () => true });
    expect((await regular.create({ max_tokens: 10, messages: [] })).stop_reason).toBe('end_turn');
  });

  it('a call Bedrock refused (throttled, denied) is given back; an aborted one is not', async () => {
    const quota = memoryQuota();
    await quota.firstSeen('u1', '2026-01-01');
    const { llm } = fakeLlm([]);
    const m = metered(llm, { sub: 'u1', quota, daily: 5, globalDaily: 10, enabled: async () => true });
    const create = llm.create as unknown as ReturnType<typeof vi.fn>;
    create.mockRejectedValueOnce(new RateLimitError(429, { message: 'slow down' }, 'slow down', new Headers()));
    await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toBeInstanceOf(RateLimitError);
    expect(await quota.used('u1', today())).toBe(0);
    expect(await quota.used('GLOBAL', today())).toBe(0);
    create.mockRejectedValueOnce(new APIUserAbortError());
    await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toBeInstanceOf(APIUserAbortError);
    expect(await quota.used('u1', today())).toBe(1);
    // A stream that failed before its first word gives the call back too.
    (llm.stream as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new RateLimitError(429, undefined, 'busy', new Headers()));
    await expect(m.stream({ max_tokens: 10, messages: [] }, () => undefined)).rejects.toBeInstanceOf(RateLimitError);
    expect(await quota.used('u1', today())).toBe(1);
    // The citizens' model: gate takes a call, refund gives it back when its failure proves the model never ran.
    await m.gate();
    expect(await quota.used('u1', today())).toBe(2);
    await m.refund(new RateLimitError(429, undefined, 'busy', new Headers()));
    expect(await quota.used('u1', today())).toBe(1);
    await m.gate();
    await m.refund(new APIConnectionTimeoutError());
    expect(await quota.used('u1', today())).toBe(2);
  });

  it('only a failure that proves the model never ran is given back: throttled, denied, a bad request, no connection', async () => {
    const quota = memoryQuota();
    await quota.firstSeen('u1', '2026-01-01');
    const { llm } = fakeLlm([]);
    const m = metered(llm, { sub: 'u1', quota, daily: 50, globalDaily: 100, enabled: async () => true });
    const create = llm.create as unknown as ReturnType<typeof vi.fn>;
    const used = () => quota.used('u1', today());
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const given = [
      new RateLimitError(429, undefined, 'slow down', new Headers()),
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 429 } }),
      new PermissionDeniedError(403, undefined, 'denied', new Headers()),
      new BadRequestError(400, undefined, 'messages: field required', new Headers()),
      Object.assign(new Error('Strands'), { name: 'ModelThrottledError', cause: new RateLimitError(429, undefined, 'x', new Headers()) }),
      new APIConnectionError({ cause: Object.assign(new TypeError('fetch failed'), { cause: refused }) }),
    ];
    for (const err of given) {
      create.mockRejectedValueOnce(err);
      await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toBeDefined();
      expect(await used()).toBe(0);
    }
    // A timeout, a 5xx after Bedrock accepted the call, or a connection that dropped mid-answer may have cost something.
    const kept = [
      new APIConnectionTimeoutError(),
      new InternalServerError(500, undefined, 'oops', new Headers()),
      new InternalServerError(503, undefined, 'unavailable', new Headers()),
      new APIConnectionError({ cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }),
    ];
    for (const [i, err] of kept.entries()) {
      create.mockRejectedValueOnce(err);
      await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toBeDefined();
      expect(await used()).toBe(i + 1);
    }
    // A stream that produced any event (a thinking block, before any text) ran the model, whatever failed after.
    (llm.stream as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async (_p: unknown, _onText: unknown, onEvent?: () => void) => {
      onEvent?.();
      throw new RateLimitError(429, undefined, 'busy', new Headers());
    });
    await expect(m.stream({ max_tokens: 10, messages: [] }, () => undefined)).rejects.toBeInstanceOf(RateLimitError);
    expect(await used()).toBe(kept.length + 1);
  });

  it('a player stays "new" (a fifth of the calls) for 3 days from their first call, then gets all of them', async () => {
    const replies = () => Array.from({ length: 20 }, () => message([text('a')], 'end_turn'));
    const quota = memoryQuota();
    const at = (day: string) => Date.parse(`${day}T12:00:00Z`);
    await quota.firstSeen('p2', '2026-11-19'); // two days ago: still new
    const twoDays = metered(fakeLlm(replies()).llm, { sub: 'p2', quota, daily: 10, globalDaily: 1000, enabled: async () => true, now: () => at('2026-11-21') });
    for (let i = 0; i < 2; i++) await twoDays.create({ max_tokens: 10, messages: [] });
    await expect(twoDays.create({ max_tokens: 10, messages: [] })).rejects.toMatchObject({ code: 'quota' });
    expect(await quota.used(NEW_PLAYERS_KEY, '2026-11-21')).toBe(2);
    await quota.firstSeen('p3', '2026-11-18'); // three days ago: a regular
    const threeDays = metered(fakeLlm(replies()).llm, { sub: 'p3', quota, daily: 10, globalDaily: 1000, enabled: async () => true, now: () => at('2026-11-21') });
    for (let i = 0; i < 10; i++) await threeDays.create({ max_tokens: 10, messages: [] });
    expect(await quota.used(NEW_PLAYERS_KEY, '2026-11-21')).toBe(2);
  });

  it('Bedrock AccessDenied (the budget’s deny policy) reads as the city’s AI resting, code paused, for hosted players', async () => {
    const denied = () => new PermissionDeniedError(403, { message: 'not authorized to perform bedrock:InvokeModel' }, 'denied', new Headers());
    const quota = memoryQuota();
    const { llm } = fakeLlm([]);
    const create = llm.create as unknown as ReturnType<typeof vi.fn>;
    const m = metered(llm, { sub: 'u1', quota, daily: 5, globalDaily: 10, enabled: async () => true });
    setPublicErrors(true);
    try {
      create.mockRejectedValueOnce(denied());
      const err = await m.create({ max_tokens: 10, messages: [] }).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: 'paused', message: PAUSED_MESSAGE });
      expect(await quota.used('u1', today())).toBe(0); // and the call is given back
      // A denial that reaches publicError some other way (the Strands citizens) says the same.
      expect(publicError('task failed', denied())).toBe(PAUSED_MESSAGE);
      expect(publicError('task failed', Object.assign(new Error('wrapped'), { cause: denied() }))).toBe(PAUSED_MESSAGE);
      // An AWS AccessDenied from the player's account is not the city's AI.
      expect(publicError('task failed', Object.assign(new Error('no'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } }))).toMatch(/Something went wrong/);
    } finally {
      setPublicErrors(false);
    }
    // The local server shows its developer the real error (a missing model grant).
    create.mockRejectedValueOnce(denied());
    await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it('a global refusal doesn’t burn the player’s quota, and a player at their quota doesn’t burn the global one', async () => {
    const { llm } = fakeLlm([message([text('a')], 'end_turn'), message([text('b')], 'end_turn')]);
    const quota = memoryQuota();
    const full = metered(llm, { sub: 'u1', quota, daily: 1, globalDaily: 0, enabled: async () => true });
    await expect(full.create({ max_tokens: 10, messages: [] })).rejects.toMatchObject({ code: 'paused' });
    expect(await quota.used('u1', today())).toBe(0);
    const m = metered(llm, { sub: 'u1', quota, daily: 1, globalDaily: 10, enabled: async () => true });
    await m.create({ max_tokens: 10, messages: [] });
    await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toMatchObject({ code: 'quota' });
    expect(await quota.used('GLOBAL', today())).toBe(1);
  });

  it('the kill switch blocks every call', async () => {
    const { llm } = fakeLlm([message([text('a')], 'end_turn')]);
    const m = metered(llm, { sub: 'u1', quota: memoryQuota(), daily: 100, globalDaily: 100, enabled: async () => false });
    await expect(m.create({ max_tokens: 10, messages: [] })).rejects.toMatchObject({ code: 'paused' });
    expect(llm.create).not.toHaveBeenCalled();
  });
});

describe('account linking', () => {
  const setup = (
    whoAmI: (roleArn: string) => { Account?: string; Arn?: string },
    opts: { canFix?: () => Promise<boolean | undefined>; now?: () => number; deleted?: (sub: string) => Promise<boolean> } = {},
  ) => {
    const stores = localStores('/tmp/aws-city-link-test.json');
    let lastArn = '';
    const canFix = vi.fn(opts.canFix ?? (async () => undefined));
    const linker = createAccountLinker({
      accounts: stores.accounts,
      templateUrl: 'https://templates.example/player-role/v5.yaml',
      selfAccountId: SELF,
      credentialsFor: (o) => {
        lastArn = o.roleArn;
        return async () => ({ accessKeyId: 'x', secretAccessKey: 'y' });
      },
      whoAmI: async () => whoAmI(lastArn),
      // Never the network: the DryRun probe is stubbed (fixesAllowed has its own test in fixes.test.ts).
      canFix,
      now: opts.now,
      deleted: opts.deleted,
    });
    const link = (sub: string, region: string, extra: { allowFixes?: boolean; label?: string } = {}) => linker.link(sub, region, { label: `Player ${sub}`, ...extra });
    return { linker, stores, link, canFix };
  };
  const ok = (arn: string) => ({ Account: '111122223333', Arn: `arn:aws:sts::111122223333:assumed-role/${arn.split('/')[1]}/aws-city-x` });

  it('quick-create link carries a per-player ExternalId that survives re-linking', async () => {
    const { link } = setup(() => ({}));
    const a = await link('u1', 'eu-west-1');
    expect(a.url).toContain('https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/quickcreate?');
    expect(a.url).toContain(`param_ExternalId=${a.externalId}`);
    expect(a.url).not.toContain('param_Trusted'); // trust is fixed in the published template
    expect((await link('u1', 'eu-west-1')).externalId).toBe(a.externalId);
    expect((await link('u2', 'eu-west-1')).externalId).not.toBe(a.externalId);
    await expect(link('u1', 'not a region')).rejects.toThrow(/region/);
  });

  it('v2.17: the link names who it connects (ConnectsPlayer) and asks for AllowFixes only when the player did', async () => {
    const { link } = setup(() => ({}));
    const plain = await link('u1', 'us-west-2', { label: 'Mayor Kind Otter' });
    expect(plain.url).toContain('param_ConnectsPlayer=Mayor%20Kind%20Otter'); // %20, not +: the console shows it as written
    expect(plain.url).toContain(`templateURL=${encodeURIComponent('https://templates.example/player-role/v5.yaml')}`);
    expect(plain.url).not.toContain('AllowFixes');
    expect((await link('u1', 'us-west-2', { allowFixes: true })).url).toContain('param_AllowFixes=true');
    expect(templateVersion('https://bucket.s3.us-west-2.amazonaws.com/player-role/v5.yaml')).toBe(5);
    expect(templateVersion('https://templates.example/player-role/latest.yaml')).toBeUndefined();
  });

  it("v2.17: ConnectsPlayer is the public Mayor name, else a masked email, else a short id: never the raw email, always the template's pattern", () => {
    expect(connectsPlayerLabel({ sub: 'abc' }, { public: true, name: 'Kind Otter' })).toBe('Mayor Kind Otter');
    const masked = connectsPlayerLabel({ sub: 'abc', email: 'ahmed.k@example.co.uk' }, { public: false, name: 'Kind Otter' });
    expect(masked).toBe('a***@e***.uk');
    expect(masked).not.toContain('ahmed');
    expect(connectsPlayerLabel({ sub: '1a2b3c4d-5e6f-7a8b-9c0d-ef0123456789' })).toBe('Player 1a2b3c4d');
    // Junk in a profile or an email never reaches the link (letters, digits, spaces and . _ @ * - only).
    for (const label of [connectsPlayerLabel({ sub: 'x', email: '<b>@"evil"' }), connectsPlayerLabel({ sub: '!!!' }), connectsPlayerLabel({ sub: 's' }, { public: true, name: '<script>' })])
      expect(label).toMatch(/^[A-Za-z0-9 ._@*-]{1,64}$/);
  });

  it('verify accepts an account id, checks who we really are, and refuses our own account', async () => {
    const { linker, stores, link } = setup(() => ({ Account: '111122223333', Arn: `arn:aws:sts::111122223333:assumed-role/${playerRoleName('us-west-2')}/aws-city-x` }));
    await link('u1', 'us-west-2');
    const rec = await linker.verify('u1', '111122223333');
    expect(rec).toMatchObject({ status: 'linked', accountId: '111122223333', roleArn: `arn:aws:iam::111122223333:role/AWSCityPlayerRole-us-west-2` });
    expect((await stores.accounts.get('u1'))?.status).toBe('linked');
    await expect(linker.verify('u1', SELF)).rejects.toThrow(/own account/);
    await expect(linker.verify('u1', 'arn:aws:iam::111122223333:role/Admin')).rejects.toThrow(/account id/);
  });

  it('v2.17: verify records the template version the link pointed at and whether fixes are allowed (a DryRun), never guessing', async () => {
    let answer: boolean | undefined = true;
    const { linker, stores, link, canFix } = setup(ok, { canFix: async () => answer });
    await link('u1', 'us-west-2');
    expect(await stores.accounts.get('u1')).toMatchObject({ status: 'pending', linkRoleVersion: 5, linkIssuedAt: expect.any(String) });
    expect(await linker.verify('u1', '111122223333')).toMatchObject({ roleVersion: 5, fixes: true });
    expect(canFix).toHaveBeenCalledWith('us-west-2', expect.any(Function), '111122223333');
    answer = false;
    expect(await linker.verify('u1', '111122223333')).toMatchObject({ fixes: false });
    // Can't tell this time: unknown, not the last answer (the stack may have changed since).
    answer = undefined;
    expect(await linker.verify('u1', '111122223333')).not.toHaveProperty('fixes');
    expect(linker).toMatchObject({ latestRoleVersion: 5, templateUrl: 'https://templates.example/player-role/v5.yaml' });
  });

  it('v2.17: verify is refused a day after the link was made; a new link (same ExternalId) works again', async () => {
    let t = Date.parse('2026-11-21T10:00:00Z');
    const { linker, link, stores } = setup(ok, { now: () => t });
    const first = await link('u1', 'us-west-2');
    t += 24 * 60 * 60_000 + 1;
    await expect(linker.verify('u1', '111122223333')).rejects.toThrow(/more than a day old/);
    expect((await stores.accounts.get('u1'))?.status).toBe('pending');
    expect((await link('u1', 'us-west-2')).externalId).toBe(first.externalId);
    expect(await linker.verify('u1', '111122223333')).toMatchObject({ status: 'linked' });
    // A record from before v2.17 (no issue time) needs a new link too.
    await stores.accounts.put('u2', { status: 'pending', externalId: 'e'.repeat(32), region: 'us-west-2' });
    await expect(linker.verify('u2', '111122223333')).rejects.toThrow(/more than a day old/);
  });

  it('v2.17: a broken link goes back to pending on a new link, and a verify clears it', async () => {
    const { linker, link, stores } = setup(ok);
    await link('u1', 'us-west-2');
    const linked = await linker.verify('u1', '111122223333');
    await stores.accounts.put('u1', { ...linked, brokenAt: '2026-11-21T10:00:00.000Z' });
    await link('u1', 'us-west-2');
    const pending = await stores.accounts.get('u1');
    expect(pending).toMatchObject({ status: 'pending', externalId: linked.externalId });
    expect(pending).not.toHaveProperty('brokenAt');
    expect(pending).not.toHaveProperty('roleArn');
    await stores.accounts.put('u1', { ...linked, brokenAt: '2026-11-21T10:00:00.000Z', linkIssuedAt: new Date().toISOString() });
    expect(await linker.verify('u1', '111122223333')).not.toHaveProperty('brokenAt');
  });

  it('asking for a link in another Region keeps the linked account usable until verify succeeds', async () => {
    const { linker, stores, link } = setup(ok);
    await link('u1', 'us-west-2');
    await linker.verify('u1', '111122223333');
    const before = await stores.accounts.get('u1');
    const again = await link('u1', 'eu-west-1');
    expect(again.externalId).toBe(before!.externalId);
    // Still linked to us-west-2 (the role ARN and account id survive), with the new Region pending.
    expect(await stores.accounts.get('u1')).toEqual({ ...before, pendingRegion: 'eu-west-1', linkIssuedAt: expect.any(String) });
    const rec = await linker.verify('u1', '111122223333');
    expect(rec).toMatchObject({ status: 'linked', region: 'eu-west-1', roleArn: `arn:aws:iam::111122223333:role/${playerRoleName('eu-west-1')}` });
    expect(await stores.accounts.get('u1')).not.toHaveProperty('pendingRegion');
    // Asking for the linked Region again drops a pending one.
    await link('u1', 'us-east-1');
    await link('u1', 'eu-west-1');
    expect(await stores.accounts.get('u1')).not.toHaveProperty('pendingRegion');
  });

  it('a failed verify for the new Region leaves the old link in place', async () => {
    let fail = false;
    const { linker, stores, link } = setup((arn) => {
      if (fail) throw new Error('AccessDenied');
      return ok(arn);
    });
    await link('u1', 'us-west-2');
    await linker.verify('u1', '111122223333');
    await link('u1', 'eu-west-1');
    fail = true;
    await expect(linker.verify('u1', '111122223333')).rejects.toThrow(/eu-west-1/);
    expect(await stores.accounts.get('u1')).toMatchObject({ status: 'linked', region: 'us-west-2', accountId: '111122223333', roleArn: expect.stringContaining('us-west-2') });
  });

  it('v2.17: the role version is the link’s only when the player installed or updated from it; another verify keeps it', async () => {
    const { linker, stores, link } = setup(ok);
    await link('u1', 'us-west-2');
    expect(await linker.verify('u1', '111122223333')).toMatchObject({ roleVersion: 5 }); // a first verify: installed from the link
    // The city publishes v6. A new link names it, but the stack in the account is still v5 until the player updates it.
    const v6 = createAccountLinker({
      accounts: stores.accounts,
      templateUrl: 'https://templates.example/player-role/v6.yaml',
      selfAccountId: SELF,
      credentialsFor: () => async () => ({ accessKeyId: 'x', secretAccessKey: 'y' }),
      whoAmI: async () => ok(`arn:aws:iam::111122223333:role/${playerRoleName('us-west-2')}`),
      canFix: async () => undefined,
    });
    await v6.link('u1', 'us-west-2', { label: 'Player u1' });
    expect(await stores.accounts.get('u1')).toMatchObject({ linkRoleVersion: 6, roleVersion: 5 });
    expect(await v6.verify('u1', '111122223333')).toMatchObject({ roleVersion: 5 });
    // "I've updated the stack": the player says the stack now runs the link's template.
    expect(await v6.verify('u1', '111122223333', { updated: true })).toMatchObject({ roleVersion: 6 });
    // A stack made in another Region from the link is installed from it too.
    const fresh = setup(ok);
    await fresh.link('u2', 'us-west-2');
    await fresh.linker.verify('u2', '111122223333');
    await fresh.stores.accounts.put('u2', { ...(await fresh.stores.accounts.get('u2'))!, roleVersion: 3 });
    await fresh.link('u2', 'eu-west-1');
    expect(await fresh.linker.verify('u2', '111122223333')).toMatchObject({ region: 'eu-west-1', roleVersion: 5 });
  });

  it('v2.17 Check again (recheck): asks the linked role about fixes again, read-only: no new link window, the role version stays', async () => {
    let answer: boolean | undefined = false;
    const { linker, stores, link, canFix } = setup(ok, { canFix: async () => answer });
    await expect(linker.recheck('u1')).rejects.toThrow(/Connect your AWS account first/);
    await link('u1', 'us-west-2');
    await expect(linker.recheck('u1')).rejects.toThrow(/Connect your AWS account first/); // pending: nothing linked yet
    const linked = await linker.verify('u1', '111122223333');
    expect(linked).toMatchObject({ fixes: false, roleVersion: 5 });
    answer = true; // the player set AllowFixes=true in CloudFormation
    const rechecked = await linker.recheck('u1');
    expect(rechecked).toEqual({ ...linked, fixes: true });
    expect(await stores.accounts.get('u1')).toEqual({ ...linked, fixes: true });
    expect(canFix).toHaveBeenLastCalledWith('us-west-2', expect.any(Function), '111122223333');
    // Can't tell (the DryRun's answer was unclear): the known answer stands.
    answer = undefined;
    expect(await linker.recheck('u1')).toEqual({ ...linked, fixes: true });
    expect(await stores.accounts.get('u1')).toEqual({ ...linked, fixes: true });
    await stores.accounts.put('u1', { ...linked, brokenAt: '2026-11-21T10:00:00.000Z' });
    await expect(linker.recheck('u1')).rejects.toThrow(/stopped working/);
  });

  it('v2.17 Check again racing a Disconnect or DELETE /me on another task writes nothing back (the ExternalId and role ARN stay gone)', async () => {
    let held: Promise<boolean | undefined> | undefined;
    let probe!: (allowed: boolean | undefined) => void;
    const { linker, stores, link, canFix } = setup(ok, { canFix: async () => held ?? false });
    await link('u1', 'us-west-2');
    await linker.verify('u1', '111122223333');
    held = new Promise((r) => (probe = r));
    const checking = linker.recheck('u1');
    await vi.waitFor(() => expect(canFix).toHaveBeenCalledTimes(2)); // the DryRun is in flight
    await stores.accounts.delete('u1'); // another task: Disconnect (DELETE /me deletes the same record)
    probe(true);
    await expect(checking).rejects.toThrow('Your AWS account link changed meanwhile. Try again.');
    expect(await stores.accounts.get('u1')).toBeUndefined();
  });

  it('v2.17 Check again racing a disconnect and a new link of the same account and Region leaves the new link as it is', async () => {
    let held: Promise<boolean | undefined> | undefined;
    let probe!: (allowed: boolean | undefined) => void;
    const { linker, stores, link, canFix } = setup(ok, { canFix: async () => held ?? false });
    await link('u1', 'us-west-2');
    await linker.verify('u1', '111122223333');
    held = new Promise((r) => (probe = r));
    const checking = linker.recheck('u1');
    await vi.waitFor(() => expect(canFix).toHaveBeenCalledTimes(2));
    // Another task: Disconnect, then a new link (a new ExternalId) to the same account and Region, verified.
    await stores.accounts.delete('u1');
    held = undefined;
    await link('u1', 'us-west-2');
    const relinked = await linker.verify('u1', '111122223333');
    probe(true);
    await expect(checking).rejects.toThrow(/changed meanwhile/);
    expect(await stores.accounts.get('u1')).toEqual(relinked);
  });

  it('v2.17 Check again writes only onto the link it read: a delete landing between its re-read and its write wins', async () => {
    const stores = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-recheck-${Date.now()}/progress.json`);
    let deleteAfterNextRead = false;
    const accounts = {
      ...stores.accounts,
      async get(sub: string) {
        const r = await stores.accounts.get(sub);
        if (deleteAfterNextRead) {
          deleteAfterNextRead = false;
          await stores.accounts.delete(sub); // another task's Disconnect, right after this read
        }
        return r;
      },
    };
    let calls = 0;
    const linker = createAccountLinker({
      accounts,
      templateUrl: 'https://templates.example/player-role/v5.yaml',
      selfAccountId: SELF,
      credentialsFor: () => async () => ({ accessKeyId: 'x', secretAccessKey: 'y' }),
      whoAmI: async () => ok('arn:aws:iam::111122223333:role/AWSCityPlayerRole-us-west-2'),
      // The DryRun of Check again (the second call) is followed by the re-read: that read is the one a delete races.
      canFix: async () => (++calls === 2 && (deleteAfterNextRead = true), true),
    });
    await linker.link('u1', 'us-west-2', { label: 'Player u1' });
    await linker.verify('u1', '111122223333');
    await expect(linker.recheck('u1')).rejects.toThrow(/changed meanwhile/);
    expect(await stores.accounts.get('u1')).toBeUndefined();
  });

  it('v2.17 Check again with a role that no longer works is a plain refusal, and nothing is written', async () => {
    let fail = false;
    const { linker, stores, link } = setup((arn) => {
      if (fail) throw new Error('AccessDenied');
      return ok(arn);
    });
    await link('u1', 'us-west-2');
    const linked = await linker.verify('u1', '111122223333');
    fail = true;
    await expect(linker.recheck('u1')).rejects.toThrow(/couldn’t use the AWSCity role in 111122223333 \(us-west-2\) just now/);
    expect(await stores.accounts.get('u1')).toEqual(linked);
  });

  /** Two server tasks' linkers on one store; `accounts` is what the first one reads and writes through (a test can wrap it). */
  const twoTasks = (accounts: ReturnType<typeof localStores>['accounts'], raw: ReturnType<typeof localStores>['accounts'], canFix: () => Promise<boolean | undefined> = async () => undefined) => {
    const make = (a: typeof accounts) =>
      createAccountLinker({
        accounts: a,
        templateUrl: 'https://templates.example/player-role/v5.yaml',
        selfAccountId: SELF,
        credentialsFor: () => async () => ({ accessKeyId: 'x', secretAccessKey: 'y' }),
        whoAmI: async () => ok(`arn:aws:iam::111122223333:role/${playerRoleName('us-west-2')}`),
        canFix,
      });
    return { here: make(accounts), there: make(raw) };
  };

  it('v2.17 verify’s refusals never feed the shared refusal breaker (three players pressing Verify too early); Check again’s do', async () => {
    const breaker = createRefusalBreaker();
    let refuse = false;
    const stores = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-breaker-${Date.now()}/progress.json`);
    const role = `arn:aws:iam::111122223333:role/${playerRoleName('us-west-2')}`;
    const refusal = () => Object.assign(new Error(`User: arn:aws:sts::${SELF}:assumed-role/Task/x is not authorized to perform: sts:AssumeRole on resource: ${role}`), { name: 'AccessDenied' });
    const linker = createAccountLinker({
      accounts: stores.accounts,
      templateUrl: 'https://templates.example/player-role/v5.yaml',
      selfAccountId: SELF,
      // As assumedRole wraps STS (aws.ts), with the test's own breaker and a provider that never reaches AWS.
      credentialsFor: (o) =>
        refusalsMarked(async () => (refuse ? Promise.reject(refusal()) : { accessKeyId: 'x', secretAccessKey: 'y' }), o.roleArn, { player: o.sub, breaker, feedsBreaker: o.feedsBreaker }),
      whoAmI: async (_region, credentials) => (await credentials(), ok(role)),
      canFix: async () => undefined,
    });
    refuse = true;
    for (const sub of ['v1', 'v2', 'v3']) {
      await linker.link(sub, 'us-west-2', { label: `Player ${sub}` });
      await expect(linker.verify(sub, '111122223333')).rejects.toThrow(/couldn’t use the AWSCity role/);
    }
    // Not tripped: a poller's refusal for another player is still that player's own.
    expect(breaker.ourSide('poller-1')).toBe(false);
    breaker.succeeded();
    // Check again asks for a link already verified: its refusals count like a poller's.
    refuse = false;
    for (const sub of ['r1', 'r2', 'r3']) {
      await linker.link(sub, 'us-west-2', { label: `Player ${sub}` });
      await linker.verify(sub, '111122223333');
    }
    refuse = true;
    for (const sub of ['r1', 'r2', 'r3']) await expect(linker.recheck(sub)).rejects.toThrow(/just now/);
    expect(breaker.ourSide('poller-2')).toBe(true);
  });

  it('v2.17 Check again sets only fixes: a new setup link made on another task meanwhile (another Region, a new link window) is kept', async () => {
    const stores = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-recheck-link-${Date.now()}/progress.json`);
    let linkAfterNextRead = false;
    let calls = 0;
    const accounts = {
      ...stores.accounts,
      async get(sub: string) {
        const r = await stores.accounts.get(sub);
        if (linkAfterNextRead) {
          linkAfterNextRead = false;
          await tasks.there.link(sub, 'eu-west-1', { label: 'Player u1' }); // another task, right after this read
        }
        return r;
      },
    };
    // verify's DryRun says no; Check again's (the second) says yes, and the re-read after it is the one a link races.
    const tasks = twoTasks(accounts, stores.accounts, async () => (++calls === 2 ? ((linkAfterNextRead = true), true) : false));
    await tasks.here.link('u1', 'us-west-2', { label: 'Player u1' });
    expect(await tasks.here.verify('u1', '111122223333')).toMatchObject({ fixes: false });
    const rechecked = await tasks.here.recheck('u1');
    const stored = await stores.accounts.get('u1');
    expect(stored).toMatchObject({ status: 'linked', region: 'us-west-2', fixes: true, pendingRegion: 'eu-west-1' });
    expect(rechecked).toEqual(stored);
  });

  it('v2.17 a verify in flight while DELETE /me lands on another task writes nothing back (no ExternalId or role ARN after deletion)', async () => {
    let held: Promise<boolean | undefined> | undefined;
    let probe!: (allowed: boolean | undefined) => void;
    const { linker, stores, link, canFix } = setup(ok, { canFix: async () => held ?? false });
    await link('u1', 'us-west-2');
    held = new Promise((r) => (probe = r));
    const verifying = linker.verify('u1', '111122223333');
    await vi.waitFor(() => expect(canFix).toHaveBeenCalledTimes(1)); // past AssumeRole, its DryRun in flight
    await stores.accounts.delete('u1'); // another task: DELETE /me deletes the ACCOUNT row
    probe(true);
    await expect(verifying).rejects.toThrow('Your AWS account link changed meanwhile. Try again.');
    expect(await stores.accounts.get('u1')).toBeUndefined();
  });

  it('v2.17 two first setup links at once (two tasks) never overwrite each other’s ExternalId', async () => {
    const stores = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-first-link-${Date.now()}/progress.json`);
    let theirs: string | undefined;
    const accounts = {
      ...stores.accounts,
      async get(sub: string) {
        const r = await stores.accounts.get(sub);
        // Another task's first link lands right after this one found nothing.
        if (!theirs) theirs = (await tasks.there.link(sub, 'us-west-2', { label: 'Player u1' })).externalId;
        return r;
      },
    };
    const tasks = twoTasks(accounts, stores.accounts);
    await expect(tasks.here.link('u1', 'us-west-2', { label: 'Player u1' })).rejects.toThrow(/changed meanwhile/);
    expect((await stores.accounts.get('u1'))?.externalId).toBe(theirs);
    // Asked again, it finds theirs and keeps its ExternalId (a stack made from either link works).
    expect((await tasks.here.link('u1', 'us-west-2', { label: 'Player u1' })).externalId).toBe(theirs);
  });

  it('v2.17 a player deleted a moment ago (a socket on another task) can neither link nor verify', async () => {
    const gone = new Set<string>();
    const { linker, stores, link } = setup(ok, { deleted: async (sub) => gone.has(sub) });
    await link('u1', 'us-west-2');
    gone.add('u1');
    await expect(linker.verify('u1', '111122223333')).rejects.toThrow(/was just deleted/);
    await expect(link('u1', 'us-west-2')).rejects.toThrow(/was just deleted/);
    expect(await stores.accounts.get('u1')).toMatchObject({ status: 'pending' });
  });

  it('verify refuses a role that turns out to be something else', async () => {
    const { linker, link } = setup(() => ({ Account: '444455556666', Arn: 'arn:aws:sts::444455556666:assumed-role/Other/x' }));
    await link('u1', 'us-west-2');
    await expect(linker.verify('u1', '111122223333')).rejects.toThrow(/isn’t the AWSCity/);
  });
});

describe('account store: unlink forgets the link (v2.17)', () => {
  it('local: delete removes the record, and deleting nothing is fine', async () => {
    const s = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-unlink-${Date.now()}/progress.json`);
    await s.accounts.put('u1', { status: 'linked', externalId: 'e'.repeat(32), region: 'us-west-2', accountId: '111122223333' });
    await s.accounts.delete('u1');
    expect(await s.accounts.get('u1')).toBeUndefined();
    await s.accounts.delete('nobody');
  });

  it('local: a put with ifLink writes only onto that same link (same ExternalId and linkedAt)', async () => {
    const s = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-iflink-${Date.now()}/progress.json`);
    const rec = { status: 'linked' as const, externalId: 'e'.repeat(32), region: 'us-west-2', accountId: '111122223333', linkedAt: '2026-11-21T10:00:00.000Z' };
    expect(await s.accounts.put('u1', rec, rec)).toBe(false); // nothing stored yet
    expect(await s.accounts.get('u1')).toBeUndefined();
    expect(await s.accounts.put('u1', rec)).toBe(true);
    expect(await s.accounts.put('u1', { ...rec, fixes: true }, rec)).toBe(true);
    expect(await s.accounts.put('u1', { ...rec, fixes: false }, { ...rec, linkedAt: '2026-11-21T11:00:00.000Z' })).toBe(false);
    expect(await s.accounts.put('u1', { ...rec, fixes: false }, { ...rec, externalId: 'f'.repeat(32) })).toBe(false);
    expect(await s.accounts.get('u1')).toEqual({ ...rec, fixes: true });
  });

  it('local: a put with "new" only creates; update sets one field on the same link and keeps the rest', async () => {
    const s = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-update-${Date.now()}/progress.json`);
    const rec = { status: 'linked' as const, externalId: 'e'.repeat(32), region: 'us-west-2', accountId: '111122223333', linkedAt: '2026-11-21T10:00:00.000Z' };
    expect(await s.accounts.update('u1', { fixes: true }, rec)).toBeUndefined(); // nothing stored yet
    expect(await s.accounts.put('u1', rec, 'new')).toBe(true);
    expect(await s.accounts.put('u1', { ...rec, region: 'eu-west-1' }, 'new')).toBe(false);
    // Another task's new setup link (pendingRegion, a new window) since this one read the record: kept.
    await s.accounts.put('u1', { ...rec, pendingRegion: 'eu-west-1', linkIssuedAt: '2026-11-21T11:00:00.000Z' }, rec);
    expect(await s.accounts.update('u1', { fixes: true }, rec)).toEqual({ ...rec, pendingRegion: 'eu-west-1', linkIssuedAt: '2026-11-21T11:00:00.000Z', fixes: true });
    expect(await s.accounts.update('u1', { brokenAt: '2026-11-21T12:00:00.000Z' }, { ...rec, linkedAt: undefined })).toBeUndefined(); // another link
    expect(await s.accounts.get('u1')).toEqual({ ...rec, pendingRegion: 'eu-west-1', linkIssuedAt: '2026-11-21T11:00:00.000Z', fixes: true });
  });
});

describe('local store: step-up MFA times', () => {
  it('the first sight of an authenticator is kept on disk, forgotten when it goes off, and deleted with the player', async () => {
    const file = `${process.env.TEMP ?? '/tmp'}/aws-city-mfa-${Date.now()}/progress.json`;
    const a = localStores(file);
    expect(await a.mfa.since('u1', 1000)).toBe(1000);
    expect(await a.mfa.since('u1', 5000)).toBe(1000);
    // Another process (a restart) reads the same time.
    expect(await localStores(file).mfa.since('u1', 9000)).toBe(1000);
    await a.mfa.forget('u1');
    expect(await a.mfa.since('u1', 7000)).toBe(7000);
    await a.deleteUser('u1');
    expect(await localStores(file).mfa.since('u1', 8000)).toBe(8000);
  });
});

describe('DynamoDB store', () => {
  // Cast: aws-sdk-client-mock's types pin a slightly different @smithy version than lib-dynamodb.
  type Loose = {
    reset(): void;
    on(cmd: unknown): { resolves(v: unknown): Loose['on'] extends never ? never : ReturnType<Loose['on']>; rejects(e: unknown): ReturnType<Loose['on']>; resolvesOnce(v: unknown): ReturnType<Loose['on']>; rejectsOnce(e: unknown): ReturnType<Loose['on']> };
    commandCalls(cmd: unknown): { args: [{ input: Record<string, unknown> }] }[];
  };
  const ddb = mockClient(DynamoDBDocumentClient as never) as unknown as Loose;
  beforeEach(() => ddb.reset());
  const stores = () => dynamoStores({ client: new DynamoDBClient({ region: 'us-west-2' }), table: 'aws-city-test' });
  const conditional = () => new ConditionalCheckFailedException({ message: 'no', $metadata: {} });

  it('DELETE /me removes every page of items and retries throttled deletes', async () => {
    const item = (sk: string) => ({ pk: 'USER#u1', sk });
    // The first query finds the player's live-city and leaderboard rows (none here); then every page of their items.
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [item('A'), item('B')], LastEvaluatedKey: { pk: 'USER#u1', sk: 'B' } })
      .resolvesOnce({ Items: [item('C')] });
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { 'aws-city-test': [{ DeleteRequest: { Key: item('B') } }] } })
      .resolves({});
    await stores().deleteUser('u1');
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(3);
    const deleted = ddb.commandCalls(BatchWriteCommand).flatMap((c) => (c.args[0].input.RequestItems as Record<string, { DeleteRequest: { Key: { sk: string } } }[]>)['aws-city-test']!.map((r) => r.DeleteRequest.Key.sk));
    expect(deleted).toEqual(['A', 'B', 'B', 'C']);
  });

  it('DELETE /me also removes the player\'s presence and leaderboard rows (v2.11)', async () => {
    const who = whoOf('u1');
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ pk: 'USER#u1', sk: 'SOCIAL#LB#shield#2026-W42', target: 'LB#shield#2026-W42' }, { pk: 'USER#u1', sk: 'SOCIAL#PRESENCE#us-west-2', target: 'PRESENCE#us-west-2' }] })
      .resolves({ Items: [] });
    ddb.on(BatchWriteCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    await stores().deleteUser('u1');
    const keys = ddb.commandCalls(BatchWriteCommand).flatMap((c) => (c.args[0].input.RequestItems as Record<string, { DeleteRequest: { Key: { pk: string; sk: string } } }[]>)['aws-city-test']!.map((r) => r.DeleteRequest.Key));
    expect(keys).toEqual(expect.arrayContaining([{ pk: 'LB#shield#2026-W42', sk: who }, { pk: 'PRESENCE#us-west-2', sk: who }, { pk: 'USER#u1', sk: 'SOCIAL#LB#shield#2026-W42' }]));
    expect(JSON.stringify(keys)).not.toContain('"sk":"u1"');
  });

  it('v2.17 account.unlink: the ACCOUNT item is deleted under the player key', async () => {
    ddb.on(DeleteCommand).resolves({});
    await stores().accounts.delete('u1');
    expect(ddb.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({ TableName: 'aws-city-test', Key: { pk: 'USER#u1', sk: 'ACCOUNT' } });
  });

  it('v2.17 a put with ifLink is conditional on the same link; a failed condition (deleted or relinked) is false, not an error', async () => {
    const rec = { status: 'linked' as const, externalId: 'e'.repeat(32), region: 'us-west-2', accountId: '111122223333', linkedAt: '2026-11-21T10:00:00.000Z' };
    ddb.on(PutCommand).resolvesOnce({}).rejectsOnce(conditional()).rejectsOnce(conditional());
    expect(await stores().accounts.put('u1', { ...rec, fixes: true }, rec)).toBe(true);
    expect(await stores().accounts.put('u1', { ...rec, fixes: true }, rec)).toBe(false);
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({
      Item: { pk: 'USER#u1', sk: 'ACCOUNT', record: { ...rec, fixes: true } },
      ConditionExpression: 'attribute_exists(pk) AND #r.#e = :e AND #r.#l = :l',
      ExpressionAttributeNames: { '#r': 'record', '#e': 'externalId', '#l': 'linkedAt' },
      ExpressionAttributeValues: { ':e': rec.externalId, ':l': rec.linkedAt },
    });
    // A plain put has no condition, and a failure there is still an error.
    await expect(stores().accounts.put('u1', rec)).rejects.toThrow();
    expect(ddb.commandCalls(PutCommand).at(-1)!.args[0].input).not.toHaveProperty('ConditionExpression');
  });

  it('v2.17 a put with ifLink for a link not verified yet (no linkedAt) needs linkedAt still absent; "new" needs no record at all', async () => {
    const pending = { status: 'pending' as const, externalId: 'e'.repeat(32), region: 'us-west-2' };
    ddb.on(PutCommand).resolvesOnce({}).rejectsOnce(conditional());
    expect(await stores().accounts.put('u1', { ...pending, accountId: '111122223333' }, pending)).toBe(true);
    const ifPending = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(ifPending).toMatchObject({
      ConditionExpression: 'attribute_exists(pk) AND #r.#e = :e AND attribute_not_exists(#r.#l)',
      ExpressionAttributeNames: { '#r': 'record', '#e': 'externalId', '#l': 'linkedAt' },
      ExpressionAttributeValues: { ':e': pending.externalId },
    });
    expect(ifPending.ExpressionAttributeValues).not.toHaveProperty(':l'); // DynamoDB refuses an unused value
    expect(await stores().accounts.put('u1', pending, 'new')).toBe(false);
    const create = ddb.commandCalls(PutCommand)[1]!.args[0].input;
    expect(create).toMatchObject({ Item: { pk: 'USER#u1', sk: 'ACCOUNT', record: pending }, ConditionExpression: 'attribute_not_exists(pk)' });
    expect(create).not.toHaveProperty('ExpressionAttributeNames');
    expect(create).not.toHaveProperty('ExpressionAttributeValues');
  });

  it('v2.17 accounts.update sets only the named field in place, on the same link (another task’s new setup link meanwhile is kept)', async () => {
    const rec = { status: 'linked' as const, externalId: 'e'.repeat(32), region: 'us-west-2', accountId: '111122223333', linkedAt: '2026-11-21T10:00:00.000Z' };
    const after = { ...rec, pendingRegion: 'eu-west-1', fixes: true };
    ddb.on(UpdateCommand).resolvesOnce({ Attributes: { pk: 'USER#u1', sk: 'ACCOUNT', record: after } }).rejectsOnce(conditional()).rejectsOnce(new Error('throttled'));
    expect(await stores().accounts.update('u1', { fixes: true }, rec)).toEqual(after);
    expect(await stores().accounts.update('u1', { brokenAt: '2026-11-21T12:00:00.000Z' }, { externalId: rec.externalId })).toBeUndefined();
    await expect(stores().accounts.update('u1', { fixes: false }, rec)).rejects.toThrow('throttled'); // only a failed condition is "not that link"
    const [fixes, broken] = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(fixes).toMatchObject({
      Key: { pk: 'USER#u1', sk: 'ACCOUNT' },
      UpdateExpression: 'SET #r.#f0 = :v0',
      ConditionExpression: 'attribute_exists(pk) AND #r.#e = :e AND #r.#l = :l',
      ExpressionAttributeNames: { '#r': 'record', '#e': 'externalId', '#l': 'linkedAt', '#f0': 'fixes' },
      ExpressionAttributeValues: { ':e': rec.externalId, ':l': rec.linkedAt, ':v0': true },
      ReturnValues: 'ALL_NEW',
    });
    expect(broken).toMatchObject({
      ConditionExpression: 'attribute_exists(pk) AND #r.#e = :e AND attribute_not_exists(#r.#l)',
      ExpressionAttributeNames: { '#f0': 'brokenAt' },
      ExpressionAttributeValues: { ':v0': '2026-11-21T12:00:00.000Z' },
    });
    expect(broken!.ExpressionAttributeValues).not.toHaveProperty(':l');
  });

  it('v2.17 accounts.get reads strongly consistent (live() and the once-a-minute re-read must see another task’s Disconnect)', async () => {
    const rec = { status: 'linked' as const, externalId: 'e'.repeat(32), region: 'us-west-2' };
    ddb.on(GetCommand).resolves({ Item: { pk: 'USER#u1', sk: 'ACCOUNT', record: rec } });
    expect(await stores().accounts.get('u1')).toEqual(rec);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({ TableName: 'aws-city-test', Key: { pk: 'USER#u1', sk: 'ACCOUNT' }, ConsistentRead: true });
  });

  it("v2.17 GET /me/export: the social rows are the player's own refs, each read by its key (the salted hash)", async () => {
    const who = whoOf('u1');
    const until = Date.now() + 60_000;
    ddb.on(QueryCommand).resolves({ Items: [{ pk: 'USER#u1', sk: 'SOCIAL#LB#shield#2026-W47', target: 'LB#shield#2026-W47' }, { pk: 'USER#u1', sk: 'SOCIAL#PRESENCE#us-west-2', target: 'PRESENCE#us-west-2' }] });
    ddb
      .on(GetCommand)
      .resolvesOnce({ Item: { pk: 'LB#shield#2026-W47', sk: who, name: 'Kind Otter', score: 120 } })
      .resolvesOnce({ Item: { pk: 'PRESENCE#us-west-2', sk: who, until, name: 'Kind Otter', rank: 'Town' } });
    expect(await stores().social.mine('u1')).toEqual([
      { kind: 'leaderboard', board: 'shield', week: '2026-W47', name: 'Kind Otter', score: 120 },
      { kind: 'presence', region: 'us-west-2', until: new Date(until).toISOString(), name: 'Kind Otter', rank: 'Town' },
    ]);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input).toMatchObject({ ExpressionAttributeValues: { ':pk': 'USER#u1', ':p': 'SOCIAL#' } });
    expect(ddb.commandCalls(GetCommand).map((c) => c.args[0].input.Key)).toEqual([
      { pk: 'LB#shield#2026-W47', sk: who },
      { pk: 'PRESENCE#us-west-2', sk: who },
    ]);
  });

  it('progress: newest wins atomically, an older copy is accepted but not written', async () => {
    ddb.on(PutCommand).rejects(conditional());
    const out = await stores().progress.put('u1', { version: 1, landmarks: {}, updatedAt: '2026-01-01T00:00:00.000Z' });
    expect(out).toEqual({ ok: true });
    const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put).toMatchObject({ Item: { pk: 'USER#u1', sk: 'PROGRESS' }, ConditionExpression: expect.stringContaining('updatedAt <= :u') });
    expect((await stores().progress.put('u1', { version: 1, landmarks: {}, updatedAt: 'nope' })).ok).toBe(false);
  });

  it('quota: a conditional ADD, false when the limit is reached', async () => {
    ddb.on(UpdateCommand).resolvesOnce({}).rejectsOnce(conditional());
    const s = stores();
    expect(await s.quota.consume('u1', '2026-09-25', 100)).toBe(true);
    expect(await s.quota.consume('u1', '2026-09-25', 100)).toBe(false);
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({ Key: { pk: 'USER#u1', sk: 'QUOTA#2026-09-25' }, ExpressionAttributeValues: { ':limit': 100 } });
  });

  it('quota: a refund is a conditional ADD of -1; the new players’ counter is the city’s; the first day is kept', async () => {
    ddb.on(UpdateCommand).resolvesOnce({}).rejectsOnce(conditional()).resolvesOnce({}).resolves({ Attributes: { firstDay: '2026-09-01' } });
    const s = stores();
    await s.quota.refund('u1', '2026-09-25');
    await s.quota.refund('u1', '2026-09-25'); // already at zero: nothing to give back, no error
    await s.quota.consume(NEW_PLAYERS_KEY, '2026-09-25', 50);
    expect(await s.quota.firstSeen('u1', '2026-09-25')).toBe('2026-09-01');
    const calls = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(calls[0]).toMatchObject({ Key: { pk: 'USER#u1', sk: 'QUOTA#2026-09-25' }, UpdateExpression: 'ADD calls :minus', ConditionExpression: 'calls > :zero', ExpressionAttributeValues: { ':minus': -1 } });
    expect(calls[2]).toMatchObject({ Key: { pk: 'QUOTA#GLOBAL#NEW', sk: '2026-09-25' } });
    expect(calls[3]).toMatchObject({ Key: { pk: 'USER#u1', sk: 'SEEN' }, UpdateExpression: 'SET firstDay = if_not_exists(firstDay, :d)', ReturnValues: 'ALL_NEW' });
  });

  it('mfa: the first sight is kept atomically under the player’s key, and forgetting deletes it', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { since: 1234 } });
    ddb.on(DeleteCommand).resolves({});
    const s = stores();
    expect(await s.mfa.since('u1', 9999)).toBe(1234);
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      Key: { pk: 'USER#u1', sk: 'MFA' }, UpdateExpression: 'SET since = if_not_exists(since, :t)', ExpressionAttributeValues: { ':t': 9999 }, ReturnValues: 'ALL_NEW',
    });
    await s.mfa.forget('u1');
    expect(ddb.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({ Key: { pk: 'USER#u1', sk: 'MFA' } });
  });

  it('v2.17 GET /me/export reads the first AI day and the MFA time with GetItem only (an export never saves a row)', async () => {
    ddb.on(GetCommand).resolvesOnce({ Item: { firstDay: '2026-11-19' } }).resolvesOnce({ Item: { since: 1234 } }).resolvesOnce({});
    const s = stores();
    expect(await s.quota.firstDay('u1')).toBe('2026-11-19');
    expect(await s.mfa.get('u1')).toBe(1234);
    expect(await s.quota.firstDay('u2')).toBeUndefined();
    expect(ddb.commandCalls(GetCommand).map((c) => c.args[0].input.Key)).toEqual([
      { pk: 'USER#u1', sk: 'SEEN' },
      { pk: 'USER#u1', sk: 'MFA' },
      { pk: 'USER#u2', sk: 'SEEN' },
    ]);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('account lock: a lease per AWS account, released by its owner', async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});
    ddb.on(GetCommand).resolves({});
    const result = await stores().locks.withLock('111122223333', async () => 'done');
    expect(result).toBe('done');
    const lock = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(lock).toMatchObject({ Item: { pk: 'AWSACCT#111122223333', sk: 'LOCK' }, ConditionExpression: 'attribute_not_exists(pk) OR expiresAt < :now' });
    expect(ddb.commandCalls(DeleteCommand)[0]!.args[0].input).toMatchObject({ Key: { pk: 'AWSACCT#111122223333', sk: 'LOCK' }, ConditionExpression: '#o = :o' });
  });

  it('account lock: the lease is renewed by its owner while held, and no longer once released', async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const s = dynamoStores({ client: new DynamoDBClient({ region: 'us-west-2' }), table: 'aws-city-test', renewMs: 20 });
    // Longer than a lease would last unrenewed at this pace (a fix waiting for the player's approval).
    await s.locks.withLock('111122223333', () => new Promise((r) => setTimeout(r, 110)));
    const owner = (ddb.commandCalls(PutCommand)[0]!.args[0].input.Item as { owner: string }).owner;
    const renewals = ddb.commandCalls(UpdateCommand);
    expect(renewals.length).toBeGreaterThanOrEqual(2);
    expect(renewals[0]!.args[0].input).toMatchObject({ Key: { pk: 'AWSACCT#111122223333', sk: 'LOCK' }, ConditionExpression: '#o = :o', ExpressionAttributeValues: { ':o': owner } });
    await new Promise((r) => setTimeout(r, 80));
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(renewals.length);
  });

  it('account lock: a lease taken by another task aborts, so the holder stops before its next AWS write', async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});
    ddb.on(UpdateCommand).rejects(conditional()); // someone else owns the lock now
    const s = dynamoStores({ client: new DynamoDBClient({ region: 'us-west-2' }), table: 'aws-city-test', renewMs: 20 });
    const seen = await s.locks.withLock('111122223333', async (lease) => {
      expect(lease.aborted).toBe(false);
      await new Promise((r) => setTimeout(r, 80));
      return lease;
    });
    expect(seen.aborted).toBe(true);
    expect(() => seen.throwIfAborted()).toThrow(LockLostError);

    // executeAction checks the lease before writing: no RunInstances/StopInstances call goes out.
    const sent: string[] = [];
    const ec2 = { send: async (c: { constructor: { name: string } }) => (sent.push(c.constructor.name), { Images: [{ ImageId: 'ami-1', CreationDate: '2026' }] }), config: { region: async () => 'us-west-2' } };
    const clients = { ec2 } as unknown as AwsClients;
    const out = await executeAction({ type: 'stop_instance', instanceId: 'i-1' }, clients, { accountId: SELF, region: 'us-west-2', takenAt: '', resources: [] } as never, 'us-west-2', seen);
    expect(out).toEqual({ ok: false, message: expect.stringContaining('stopped before changing anything else') });
    await executeAction({ type: 'launch_instance', instanceType: 't4g.nano', name: 'web' }, clients, { accountId: SELF, resources: [] } as never, 'us-west-2', seen);
    expect(sent).toEqual(['DescribeImagesCommand']); // the AMI lookup is a read; the launch never went out
  });

  it('account lock: a lease that stops renewing aborts before it can expire', async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(DeleteCommand).resolves({});
    ddb.on(UpdateCommand).rejects(new Error('network'));
    let t = 0;
    const s = dynamoStores({ client: new DynamoDBClient({ region: 'us-west-2' }), table: 'aws-city-test', renewMs: 10, now: () => t });
    const seen = await s.locks.withLock('111122223333', async (lease) => {
      t = 15_000;
      await new Promise((r) => setTimeout(r, 40));
      expect(lease.aborted).toBe(false); // renewals failing, but the lease is still good for a while
      t = 30_000;
      await new Promise((r) => setTimeout(r, 40));
      return lease;
    });
    expect(seen.aborted).toBe(true);
  });

  it('DELETE /me: the tombstone is written before anything is deleted, and expires', async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(QueryCommand).resolves({ Items: [] });
    let t = 1_000;
    const s = dynamoStores({ client: new DynamoDBClient({ region: 'us-west-2' }), table: 'aws-city-test', now: () => t });
    await s.deleteUser('u1');
    const tomb = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(tomb).toMatchObject({ Item: { pk: 'DELETED#u1', sk: 'TOMBSTONE', until: 1_000 + 2 * 60 * 60_000 } });
    ddb.on(GetCommand).resolves({ Item: tomb.Item });
    expect(await s.deletedRecently('u1')).toBe(true);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input).toMatchObject({ Key: { pk: 'DELETED#u1', sk: 'TOMBSTONE' }, ConsistentRead: true });
    t += 2 * 60 * 60_000 + 1; // TTL deletes lazily: `until` decides
    expect(await s.deletedRecently('u1')).toBe(false);
  });

  it('bill: the switch is set in place (the cached read is never rewritten), creating the record the first time', async () => {
    ddb.on(UpdateCommand).rejectsOnce(conditional()).resolves({});
    ddb.on(PutCommand).resolves({});
    const s = stores();
    await s.bills.setOn('u1', true);
    const update = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(update).toMatchObject({ Key: { pk: 'USER#u1', sk: 'BILL' }, UpdateExpression: 'SET #r.#on = :on', ConditionExpression: 'attribute_exists(#r)', ExpressionAttributeValues: { ':on': true } });
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input).toMatchObject({ Item: { pk: 'USER#u1', sk: 'BILL', record: { on: true } }, ConditionExpression: 'attribute_not_exists(pk)' });
    await s.bills.setOn('u1', false);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(1); // exists now: an update only
  });

  it('bill: a read is saved only while the bill is on, and never writes `on`', async () => {
    ddb.on(UpdateCommand).resolvesOnce({}).rejectsOnce(conditional());
    const s = stores();
    const read = { bill: { type: 'city.bill' as const, unavailable: 'x', takenAt: '' }, fetchedAt: 1, retryMs: 2, accountId: undefined };
    expect(await s.bills.saveRead('u1', read)).toBe(true);
    expect(await s.bills.saveRead('u1', read)).toBe(false);
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Key: { pk: 'USER#u1', sk: 'BILL' }, ConditionExpression: '#r.#on = :on', ExpressionAttributeValues: { ':on': true } });
    expect(String(input.UpdateExpression)).not.toContain('#on');
    expect(Object.values(input.ExpressionAttributeNames as Record<string, string>)).not.toContain('accountId'); // undefined fields are left alone
  });
});

describe('screenshots are scoped to their owner', () => {
  it("one player can't read another's upload", async () => {
    const store = createUploadStore('http://127.0.0.1:1');
    const { screenshotKey, uploadUrl } = await store.create('image/jpeg', 'alice');
    const sig = new URL(uploadUrl).searchParams.get('sig')!;
    expect(store.accept(screenshotKey, sig, Buffer.from('img'))).toBe(true);
    expect(await store.get(screenshotKey, 'alice')).toBeDefined();
    expect(await store.get(screenshotKey, 'bob')).toBeUndefined();
  });
});

// ── End to end: signed-in players over the socket, each in their own city ──
describe('hosted server: Cognito players and tenants', () => {
  let port: number;
  let close: () => void;
  let mfaReady: ReturnType<typeof vi.fn<(p: Principal) => Promise<StepUp>>>;
  const verifier: JwtVerifier = {
    async verify(token) {
      if (token === 'jwt-alice') return { sub: 'alice' };
      if (token === 'jwt-bob') return { sub: 'bob' };
      if (token === 'jwt-carol') return { sub: 'carol' };
      if (token === 'jwt-frank') return { sub: 'frank' };
      // The socket-cap tests count one player's tabs: each has its own player, so a tab an earlier test closed
      // (the server frees its slot a moment later) can't take a slot.
      if (token === 'jwt-erin') return { sub: 'erin' };
      if (token === 'jwt-gus') return { sub: 'gus' };
      // POST /me/mfa's per-player limit: only its own test calls it as this player.
      if (token === 'jwt-hana') return { sub: 'hana' };
      // …and its 409/503 test: one fresh player per case, so no burst is shared with another test.
      if (token.startsWith('jwt-mfa-')) return { sub: token.slice('jwt-'.length) };
      // A token that expires the moment the socket opens.
      if (token === 'jwt-dave') return { sub: 'dave', exp: Math.floor(Date.now() / 1000) };
      throw new Error('bad');
    },
  };

  beforeAll(async () => {
    const base = loadConfig({});
    const config = { ...base, authMode: 'cognito' as const, extensionOrigins: [EXT], port: 0 };
    // Its own directory each run: progress files sit beside it, and one run's players must not meet the next run's.
    const stores = localStores(`${process.env.TEMP ?? '/tmp'}/aws-city-hosted-${Date.now()}/progress.json`);
    const { llm } = fakeLlm([]);
    const uploads = createUploadStore('http://127.0.0.1:1');
    const tenants = createTenants({ config, stores, uploads, llm, enabled: async () => true, awsFor: () => undefined, walkMs: 0 });
    // carol hasn't turned MFA on yet.
    mfaReady = vi.fn(async (p: Principal): Promise<StepUp> => (p.sub === 'carol' ? 'enrol' : 'ok'));
    const deleted = (sub: string) => stores.deletedRecently(sub);
    const probe = createHttpServer({ config, tenants, authenticate: cognitoAuth(config, verifier), uploads, mfaReady, deleted });
    await new Promise<void>((r) => probe.server.listen(0, '127.0.0.1', r));
    port = (probe.server.address() as AddressInfo).port;
    probe.server.close();
    const { server } = createHttpServer({ config: { ...config, port }, tenants, authenticate: cognitoAuth(config, verifier), uploads, mfaReady, deleted });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    close = () => server.close();
  });
  afterAll(() => close());

  const open = (jwt?: string, query = '') =>
    new Promise<{ ws?: WebSocket; status?: number; events: ServerEvent[] }>((resolve) => {
      const events: ServerEvent[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`, jwt ? bearerSubprotocols(jwt) : [], { origin: EXT });
      ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
      ws.on('open', async () => {
        for (const end = Date.now() + 3000; events.length === 0 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
        resolve({ ws, events });
      });
      ws.on('unexpected-response', (_q, res) => resolve({ status: res.statusCode, events }));
    });

  it('needs a valid Cognito token in the subprotocol, never in the URL', async () => {
    expect((await open()).status).toBe(401);
    expect((await open('forged')).status).toBe(401);
    expect((await open(undefined, '?token=jwt-alice')).status).toBe(401);
    const { ws, events } = await open('jwt-alice');
    expect(ws!.protocol).toBe('base64UrlBearerAuthorization');
    expect(events[0]).toMatchObject({ type: 'account.status', linked: false });
    ws!.close();
  });

  it('per-player socket cap holds even when tabs connect at the same instant', async () => {
    const all = await Promise.all(Array.from({ length: 8 }, () => open('jwt-erin')));
    const opened = all.filter((r) => r.ws);
    expect(opened.length).toBe(4);
    expect(all.filter((r) => r.status === 429).length).toBe(4);
    for (const r of opened) r.ws!.close();
    await new Promise((r) => setTimeout(r, 100));
    // Slots are given back on close.
    const again = await open('jwt-erin');
    expect(again.ws).toBeDefined();
    again.ws!.close();
  });

  it('clients that drop mid-handshake give their slot back', async () => {
    const { connect } = await import('node:net');
    const b64 = Buffer.from('jwt-gus').toString('base64url');
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((resolve) => {
        const s = connect(port, '127.0.0.1', () => {
          s.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${EXT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Protocol: base64UrlBearerAuthorization.${b64}, base64UrlBearerAuthorization\r\n\r\n`);
          s.resetAndDestroy(); // gone before the server finishes the upgrade
          resolve();
        });
      });
    }
    await new Promise((r) => setTimeout(r, 200));
    const tabs = await Promise.all(Array.from({ length: 4 }, () => open('jwt-gus')));
    expect(tabs.every((t) => t.ws)).toBe(true);
    for (const t of tabs) t.ws!.close();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('REST progress is per player', async () => {
    const put = (jwt: string, xp: number) =>
      fetch(`http://127.0.0.1:${port}/progress`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', origin: EXT },
        body: JSON.stringify({ version: 1, landmarks: { s3: { discovered: true, xp } }, updatedAt: new Date().toISOString() }),
      });
    expect((await put('jwt-alice', 42)).status).toBe(204);
    const get = (jwt: string) => fetch(`http://127.0.0.1:${port}/progress`, { headers: { authorization: `Bearer ${jwt}`, origin: EXT } });
    expect(((await (await get('jwt-alice')).json()) as { landmarks: { s3: { xp: number } } }).landmarks.s3.xp).toBe(42);
    expect((await get('jwt-bob')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/me`, { method: 'DELETE', headers: { authorization: 'Bearer jwt-alice', origin: EXT } })).status).toBe(204);
    // Deleted: the still-valid token can neither read nor recreate the progress.
    expect((await get('jwt-alice')).status).toBe(410);
    expect((await put('jwt-alice', 7)).status).toBe(410);
    expect((await get('jwt-bob')).status).toBe(404);
  });

  it('v2.17 GET /me/export: the player\'s own data as a download; another player\'s never; a deleted player 410', async () => {
    const auth = (jwt: string) => ({ authorization: `Bearer ${jwt}`, origin: EXT });
    const put = await fetch(`http://127.0.0.1:${port}/progress`, {
      method: 'PUT',
      headers: { ...auth('jwt-bob'), 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, landmarks: { s3: { discovered: true, xp: 31 } }, updatedAt: new Date().toISOString() }),
    });
    expect(put.status).toBe(204);
    const bob = await fetch(`http://127.0.0.1:${port}/me/export`, { headers: auth('jwt-bob') });
    expect(bob.status).toBe(200);
    expect(bob.headers.get('content-disposition')).toMatch(/^attachment; filename="aws-city-my-data\.json"$/);
    expect(bob.headers.get('cache-control')).toBe('no-store');
    const data = (await bob.json()) as { contract: string; progress: { landmarks: { s3: { xp: number } } }; social: unknown[]; account?: unknown };
    expect(data).toMatchObject({ contract: CONTRACT_VERSION, progress: { landmarks: { s3: { xp: 31 } } }, social: [] });
    expect(data).not.toHaveProperty('account');
    // Another player's export has none of it.
    const carol = (await (await fetch(`http://127.0.0.1:${port}/me/export`, { headers: auth('jwt-carol') })).json()) as { progress: unknown };
    expect(carol.progress).toBeNull();
    expect((await fetch(`http://127.0.0.1:${port}/me/export`, { headers: { origin: EXT } })).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${port}/me/export`, { headers: auth('jwt-alice') })).status).toBe(410); // deleted above
    // Once a minute per player: a download reads every row the player has.
    const again = await fetch(`http://127.0.0.1:${port}/me/export`, { headers: auth('jwt-bob') });
    expect(again.status).toBe(429);
    expect(await again.json()).toEqual({ error: 'You downloaded your data a moment ago. Try again in a minute.' });
  });

  it('v2.17 version handshake: a newer extension is refused (409, naming the server’s version) on the upgrade and on progress', async () => {
    const [major, minor] = CONTRACT_VERSION.split('.').map(Number);
    const newer = `${major}.${minor! + 1}`;
    expect((await open('jwt-bob', `?contract=${newer}`)).status).toBe(409);
    const same = await open('jwt-bob', `?contract=${CONTRACT_VERSION}`);
    expect(same.ws!.protocol).toBe('base64UrlBearerAuthorization');
    same.ws!.close();
    const progress = (contract: string, method = 'GET') =>
      fetch(`http://127.0.0.1:${port}/progress?contract=${contract}`, {
        method,
        headers: { authorization: 'Bearer jwt-bob', 'content-type': 'application/json', origin: EXT },
        ...(method === 'PUT' ? { body: JSON.stringify({ version: 1, landmarks: {}, updatedAt: new Date().toISOString() }) } : {}),
      });
    for (const method of ['GET', 'PUT']) {
      const refused = await progress(newer, method);
      expect(refused.status).toBe(409);
      expect(refused.headers.get(CONTRACT_HEADER)).toBe(CONTRACT_VERSION);
      expect(refused.headers.get('access-control-expose-headers')).toBe(CONTRACT_HEADER);
    }
    expect((await progress(CONTRACT_VERSION)).status).toBe(200);
    // Taking data out (and deleting it) never waits for a version (a player who hasn't downloaded this minute).
    expect((await fetch(`http://127.0.0.1:${port}/me/export?contract=${newer}`, { headers: { authorization: 'Bearer jwt-gus', origin: EXT } })).status).toBe(200);
  });

  it('an unlinked player can learn but agents refuse to build', async () => {
    expect(UNLINKED_REASON).toMatch(/Connect your AWS account/);
    const { ws, events } = await open('jwt-bob');
    ws!.send(JSON.stringify({ action: 'account.link', requestId: 'r1', region: 'us-west-2' }));
    for (const end = Date.now() + 3000; !events.some((e) => 'requestId' in e && e.requestId === 'r1') && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    // No linker configured in this test → the server just reports the (unlinked) status.
    expect(events).toContainEqual(expect.objectContaining({ type: 'account.status', requestId: 'r1', linked: false }));
    ws!.close();
  });

  it('a socket does not outlive its token: it closes for re-auth once idle', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, bearerSubprotocols('jwt-dave'), { origin: EXT });
    const code = await new Promise<number>((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4401);
  });

  it('deleting the account closes that player’s open sockets for good: no reconnect, no data recreated', async () => {
    const { ws } = await open('jwt-frank');
    const closed = new Promise<number>((r) => ws!.on('close', (c) => r(c)));
    expect((await fetch(`http://127.0.0.1:${port}/me`, { method: 'DELETE', headers: { authorization: 'Bearer jwt-frank', origin: EXT } })).status).toBe(204);
    expect(await closed).toBe(CLOSE_CODES.deleted); // terminal: the client signs out instead of reconnecting
    // A client that reconnects anyway with its still-valid token is refused at the handshake.
    expect((await open('jwt-frank')).status).toBe(410);
    const put = await fetch(`http://127.0.0.1:${port}/progress`, {
      method: 'PUT',
      headers: { authorization: 'Bearer jwt-frank', 'content-type': 'application/json', origin: EXT },
      body: JSON.stringify({ version: 1, landmarks: {}, updatedAt: new Date().toISOString() }),
    });
    expect(put.status).toBe(410);
  });

  it('POST /me/mfa looks at once (the extension calls it right after turning an authenticator on)', async () => {
    mfaReady.mockClear();
    const post = (jwt: string) => fetch(`http://127.0.0.1:${port}/me/mfa`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, origin: EXT } });
    const res = await post('jwt-bob');
    expect(res.status).toBe(204);
    expect(mfaReady).toHaveBeenCalledWith(expect.objectContaining({ sub: 'bob' }));
    expect((await fetch(`http://127.0.0.1:${port}/me/mfa`, { method: 'POST', headers: { origin: EXT } })).status).toBe(401);
  });

  it('POST /me/mfa answers 204 only once the first sight is recorded; what any player can cause is a 409, never a 5xx (the extension tries again)', async () => {
    const post = (jwt: string) => fetch(`http://127.0.0.1:${port}/me/mfa`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, origin: EXT } });
    // 'enrol': AdminGetUser doesn't list SOFTWARE_TOKEN_MFA yet. Sign-up is open, so a script can send this all day: a
    // 5xx would feed the Http5xx alarm that pages and rolls a deploy back.
    const enrol = await post('jwt-carol');
    expect(enrol.status).toBe(409);
    expect(await enrol.json()).toEqual({ error: expect.stringMatching(/authenticator/) });
    // Cognito or DynamoDB (the MFA store) throttling the look, or a player who's gone: not the server's fault either.
    const refusals: [string, object][] = [
      ['TooManyRequestsException', {}],
      ['ThrottlingException', {}],
      ['UserNotFoundException', {}],
      ['ProvisionedThroughputExceededException', {}],
      ['RequestLimitExceeded', {}],
      ['SomeThrottle', { $retryable: { throttling: true } }], // the SDK's own flag, whatever the name
      ['SomeLimit', { $metadata: { httpStatusCode: 429 } }],
    ];
    for (const [name, extra] of refusals) {
      mfaReady.mockRejectedValueOnce(Object.assign(new Error('refused'), { name }, extra));
      expect((await post(`jwt-mfa-${name}`)).status, name).toBe(409);
    }
    // A failure that's ours (our task role refused, a bug) is still a 5xx.
    mfaReady.mockRejectedValueOnce(Object.assign(new Error('AdminGetUser failed'), { name: 'AccessDeniedException' }));
    const failed = await post('jwt-mfa-ours');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: expect.stringMatching(/authenticator/) });
    mfaReady.mockResolvedValueOnce('reauth'); // recorded; this session just predates it
    expect((await post('jwt-mfa-ours')).status).toBe(204);
  });

  it('POST /me/mfa is limited per player: the extension’s three tries go through, then 429 with a plain message and no Cognito call', async () => {
    const post = (jwt: string) => fetch(`http://127.0.0.1:${port}/me/mfa`, { method: 'POST', headers: { authorization: `Bearer ${jwt}`, origin: EXT } });
    mfaReady.mockClear();
    for (let i = 0; i < 3; i++) expect((await post('jwt-hana')).status, `try ${i + 1}`).toBe(204);
    const limited = await post('jwt-hana');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'You asked a moment ago. Try again in a few seconds.' });
    expect(mfaReady).toHaveBeenCalledTimes(3);
    // Another player isn't held back.
    expect((await post('jwt-gus')).status).toBe(204);
  });

  it('linking an AWS account needs MFA first', async () => {
    const { ws, events } = await open('jwt-carol');
    ws!.send(JSON.stringify({ action: 'account.link', requestId: 'm1', region: 'us-west-2' }));
    for (const end = Date.now() + 3000; !events.some((e) => 'requestId' in e && e.requestId === 'm1') && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', requestId: 'm1', code: 'mfa_required' }));
    // Spamming account commands is refused before any AWS call.
    ws!.send(JSON.stringify({ action: 'account.link', requestId: 'm2', region: 'us-west-2' }));
    for (const end = Date.now() + 3000; !events.some((e) => 'requestId' in e && e.requestId === 'm2') && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    expect(events).toContainEqual(expect.objectContaining({ type: 'error', requestId: 'm2', message: expect.stringMatching(/few seconds/) }));
    ws!.close();
  });
});

describe('MFA step-up check', () => {
  const cognito = (user: { UserStatus?: string; UserMFASettingList?: string[] }) => {
    const send = vi.fn(async (_cmd: unknown) => user);
    return { send } as unknown as { send: typeof send };
  };
  const totp = { UserStatus: 'CONFIRMED', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] };

  it('needs TOTP for email players, trusts Google for federated ones, and asks Cognito by username', async () => {
    const none = cognito({ UserStatus: 'CONFIRMED', UserMFASettingList: [] });
    expect(await createMfaCheck({ cognito: none as never, userPoolId: 'p' })({ sub: 's1', authTime: Date.now() })).toBe('enrol');
    const on = cognito(totp);
    let t = 10_000;
    const check = createMfaCheck({ cognito: on as never, userPoolId: 'p', now: () => t });
    expect(await check({ sub: 's1', authTime: 5_000 })).toBe('reauth'); // signed in at 5 s, before TOTP was first seen (10 s)
    t = 30_000;
    expect(await check({ sub: 's1', authTime: 20_000 })).toBe('ok');
    expect(on.send).toHaveBeenCalledTimes(1); // a yes is cached
    const google = cognito({ UserStatus: 'EXTERNAL_PROVIDER' });
    expect(await createMfaCheck({ cognito: google as never, userPoolId: 'p' })({ sub: 's2', username: 'google_123' })).toBe('ok');
    expect((google.send.mock.calls[0]![0] as { input: { Username: string } }).input.Username).toBe('google_123');
  });

  it('a session that signed in before the authenticator was first seen must sign in again; one after passes', async () => {
    let t = 1_000_000;
    const since = memoryMfa();
    const check = createMfaCheck({ cognito: cognito(totp) as never, userPoolId: 'p', since, now: () => t });
    // An attacker signed in with only the password at 900 s; the player turned TOTP on and the server saw it at 1000 s.
    expect(await check({ sub: 's1', authTime: 900_000 })).toBe('reauth');
    expect(await check({ sub: 's1' })).toBe('reauth'); // no auth_time: never assumed fresh
    // The player signs in again (with their code) at 1000.4 s: auth_time has whole seconds, so it reads 1000 s.
    t = 1_001_000;
    expect(await check({ sub: 's1', authTime: 1_000_000 })).toBe('ok');
    expect(await since.since('s1', 0)).toBe(1_000_000);
    expect(SIGN_IN_AGAIN_MESSAGE).toMatch(/sign in again/);
  });

  it('a first sight with nothing recorded (POST /me/mfa never landed) is dated now, never from Cognito’s last change to the user', async () => {
    const since = memoryMfa();
    // Whether turning TOTP on moves UserLastModifiedDate is unconfirmed: dating the first sight from it (8 s) could let a
    // session from before the authenticator (a stolen password, signed in at 9 s) pass. The server first looks at 10 s.
    const user = { ...totp, UserLastModifiedDate: new Date(8_000) };
    const check = createMfaCheck({ cognito: cognito(user as never) as never, userPoolId: 'p', since, now: () => 10_000 });
    expect(await check({ sub: 's1', authTime: 9_000 })).toBe('reauth');
    expect(await since.since('s1', 0)).toBe(10_000);
    // The player signs in once more (the extension says they may have to): that one passes.
    expect(await check({ sub: 's1', authTime: 10_000 })).toBe('ok');
    // A recorded first sight (POST /me/mfa landed before every session ended) always wins.
    const recorded = memoryMfa();
    await recorded.since('s3', 8_000);
    expect(await createMfaCheck({ cognito: cognito(user as never) as never, userPoolId: 'p', since: recorded, now: () => 10_000 })({ sub: 's3', authTime: 9_000 })).toBe('ok');
  });

  it('the first sight is kept in the store, so another task (or a restart) agrees', async () => {
    const since = memoryMfa();
    const at = (t: number) => createMfaCheck({ cognito: cognito(totp) as never, userPoolId: 'p', since, now: () => t });
    expect(await at(5_000)({ sub: 's1', authTime: 6_000 })).toBe('ok');
    // Another task sees it later: the stored first sight still decides.
    expect(await at(50_000)({ sub: 's1', authTime: 6_000 })).toBe('ok');
    expect(await at(50_000)({ sub: 's1', authTime: 4_000 })).toBe('reauth');
  });

  it('seeing TOTP off forgets the first sight, so turning it on again starts over', async () => {
    let t = 1_000;
    const user = { ...totp };
    const since = memoryMfa();
    const check = createMfaCheck({ cognito: cognito(user) as never, userPoolId: 'p', since, now: () => t });
    expect(await check({ sub: 's1', authTime: 2_000 })).toBe('ok');
    t = 100_000; // past the cache
    user.UserMFASettingList = [];
    expect(await check({ sub: 's1', authTime: 2_000 })).toBe('enrol');
    // Someone signs in with the password while it's off (50 s), then TOTP goes back on (seen at 200 s).
    t = 200_000;
    user.UserMFASettingList = ['SOFTWARE_TOKEN_MFA'];
    expect(await check({ sub: 's1', authTime: 50_000 })).toBe('reauth');
  });

  it('a cached yes expires, so turning MFA off is noticed', async () => {
    let t = 0;
    const user = { ...totp };
    const c = cognito(user);
    const check = createMfaCheck({ cognito: c as never, userPoolId: 'p', cacheMs: 1000, now: () => t });
    expect(await check({ sub: 's1', authTime: 0 })).toBe('ok');
    user.UserMFASettingList = [];
    t = 999;
    expect(await check({ sub: 's1', authTime: 0 })).toBe('ok');
    t = 61_000;
    expect(await check({ sub: 's1', authTime: 0 })).toBe('enrol');
    expect(c.send).toHaveBeenCalledTimes(2);
  });

  it('by default a yes is trusted for 60 s at most', async () => {
    let t = 0;
    const user = { ...totp };
    const c = cognito(user);
    const check = createMfaCheck({ cognito: c as never, userPoolId: 'p', now: () => t });
    expect(await check({ sub: 's1', authTime: 0 })).toBe('ok');
    user.UserMFASettingList = [];
    t = 59_999;
    expect(await check({ sub: 's1', authTime: 0 })).toBe('ok'); // still cached
    t = 60_000;
    expect(await check({ sub: 's1', authTime: 0 })).toBe('enrol'); // MFA turned off: writes stop within a minute
    expect(c.send).toHaveBeenCalledTimes(2);
  });
});

// Every AWS write is approved through deploy.approve (task writes) or started by finding.fix: both need MFA on.
describe('MFA step-up for writes', () => {
  it('v2.17: account.unlink needs no MFA; resource.remove starts only with it (and is validated strictly); allowFixes reaches the link', async () => {
    let mfa: StepUp = 'enrol';
    const unlink = vi.fn(async (requestId: string, emit: (e: ServerEvent) => void) => emit({ type: 'account.status', requestId, linked: false }));
    const remove = vi.fn(async (cmd: { requestId: string }, emit: (e: ServerEvent) => void, _approvals: Approvals) => emit({ type: 'error', requestId: cmd.requestId, message: 'removed' }));
    const link = vi.fn(async (requestId: string, _region: string, emit: (e: ServerEvent) => void) => emit({ type: 'account.linkUrl', requestId, url: 'u', externalId: 'e' }));
    const tenant = { sub: 'erin', region: 'us-west-2', unlink, remove, link, createCopilot: () => undefined, welcome: async () => [], subscribe: () => () => undefined, emitter: (emit: unknown) => emit } as unknown as Tenant;
    const tenants = { acquire: async () => tenant, data: () => tenant, release: () => undefined, closeAll: () => undefined };
    const base = { ...loadConfig({}), authMode: 'cognito' as const, extensionOrigins: [EXT] };
    const deps = { tenants, authenticate: async () => ({ sub: 'erin' }), mfaReady: async () => mfa };
    const probe = createHttpServer({ config: { ...base, port: 0 }, ...deps });
    await new Promise<void>((r) => probe.server.listen(0, '127.0.0.1', r));
    const port = (probe.server.address() as AddressInfo).port;
    probe.server.close();
    const { server } = createHttpServer({ config: { ...base, port }, ...deps });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    const events: ServerEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, bearerSubprotocols('x'), { origin: EXT });
    ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on('open', r));
    const until = async (ok: () => boolean) => {
      for (const end = Date.now() + 3000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    };
    const reply = (id: string) => events.find((e) => 'requestId' in e && e.requestId === id);
    try {
      ws.send(JSON.stringify({ action: 'account.unlink', requestId: 'u1' }));
      await until(() => !!reply('u1'));
      expect(unlink).toHaveBeenCalledWith('u1', expect.any(Function));
      expect(reply('u1')).toMatchObject({ type: 'account.status', linked: false });

      ws.send(JSON.stringify({ action: 'resource.remove', requestId: 'm1', kind: 'table', id: 'city-quest' }));
      await until(() => !!reply('m1'));
      expect(reply('m1')).toMatchObject({ type: 'error', code: 'mfa_required' });
      expect(remove).not.toHaveBeenCalled();
      mfa = 'ok';
      ws.send(JSON.stringify({ action: 'resource.remove', requestId: 'm2', kind: 'table', id: 'city-quest' }));
      await until(() => !!reply('m2'));
      expect(remove).toHaveBeenCalledWith({ requestId: 'm2', kind: 'table', id: 'city-quest' }, expect.any(Function), expect.anything());

      // Strict: an unknown kind or field, or an id with a slash, never reaches the tenant.
      for (const bad of [
        { action: 'resource.remove', requestId: 'b1', kind: 'function', id: 'f' },
        { action: 'resource.remove', requestId: 'b2', kind: 'table', id: 'city-x', region: 'eu-west-1' },
        { action: 'resource.remove', requestId: 'b3', kind: 'bucket', id: '../x/y' },
        { action: 'account.unlink', requestId: 'b4', force: true },
      ])
        ws.send(JSON.stringify(bad));
      await until(() => events.filter((e) => e.type === 'error' && /Bad command/.test(e.message)).length >= 4);
      expect(events.filter((e) => e.type === 'error' && /Bad command/.test(e.message))).toHaveLength(4);
      expect(remove).toHaveBeenCalledTimes(1);

      // The cooldown spans every account command on a socket (each rebuilds the city): this one just unlinked.
      ws.send(JSON.stringify({ action: 'account.link', requestId: 'l0', region: 'us-west-2' }));
      await until(() => !!reply('l0'));
      expect(reply('l0')).toMatchObject({ type: 'error', message: expect.stringMatching(/few seconds/) });
      // Another tab: allowFixes reaches the link.
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws`, bearerSubprotocols('x'), { origin: EXT });
      ws2.on('message', (raw) => events.push(JSON.parse(raw.toString())));
      await new Promise((r) => ws2.on('open', r));
      ws2.send(JSON.stringify({ action: 'account.link', requestId: 'l1', region: 'us-west-2', allowFixes: true }));
      await until(() => !!reply('l1'));
      expect(link).toHaveBeenCalledWith('l1', 'us-west-2', expect.any(Function), true);
      ws2.close();
    } finally {
      ws.close();
      server.close();
    }
  });

  /** A hosted server around one stub tenant (the socket's own rules under test), and a socket to it. */
  const stubServer = async (tenant: Tenant, mfaReady: () => Promise<StepUp>) => {
    const tenants = { acquire: async () => tenant, data: () => tenant, release: () => undefined, closeAll: () => undefined };
    const base = { ...loadConfig({}), authMode: 'cognito' as const, extensionOrigins: [EXT] };
    const deps = { tenants, authenticate: async () => ({ sub: 'erin' }), mfaReady };
    const probe = createHttpServer({ config: { ...base, port: 0 }, ...deps });
    await new Promise<void>((r) => probe.server.listen(0, '127.0.0.1', r));
    const port = (probe.server.address() as AddressInfo).port;
    probe.server.close();
    const { server } = createHttpServer({ config: { ...base, port }, ...deps });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    const events: ServerEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, bearerSubprotocols('x'), { origin: EXT });
    ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on('open', r));
    const until = async (ok: () => boolean) => {
      for (const end = Date.now() + 3000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    };
    const reply = (id: string) => events.find((e) => 'requestId' in e && e.requestId === id);
    const send = (cmd: object) => ws.send(JSON.stringify(cmd));
    return { events, until, reply, send, close: () => (ws.close(), server.close()) };
  };

  it('v2.17: a verify right after this socket’s own link passes the cooldown (once); Check again needs no MFA but waits its turn', async () => {
    let mfa: StepUp = 'ok';
    const link = vi.fn(async (requestId: string, _region: string, emit: (e: ServerEvent) => void) => emit({ type: 'account.linkUrl', requestId, url: 'u', externalId: 'e' }));
    const verify = vi.fn(async (requestId: string, _arn: string, emit: (e: ServerEvent) => void) => emit({ type: 'account.status', requestId, linked: true }));
    const recheck = vi.fn(async (requestId: string, emit: (e: ServerEvent) => void) => emit({ type: 'account.status', requestId, linked: true, fixes: true }));
    const tenant = { sub: 'erin', region: 'us-west-2', link, verify, recheck, createCopilot: () => undefined, welcome: async () => [], subscribe: () => () => undefined, emitter: (emit: unknown) => emit } as unknown as Tenant;
    const t = await stubServer(tenant, async () => mfa);
    try {
      // "I've updated the stack": a link, then a verify as soon as it's in (well inside the 5 s cooldown).
      t.send({ action: 'account.link', requestId: 'l1', region: 'us-west-2' });
      await t.until(() => !!t.reply('l1'));
      t.send({ action: 'account.verify', requestId: 'v1', roleArn: '111122223333', updated: true });
      await t.until(() => !!t.reply('v1'));
      expect(t.reply('v1')).toMatchObject({ type: 'account.status', linked: true });
      expect(verify).toHaveBeenCalledWith('v1', '111122223333', expect.any(Function), true);
      // Once per link: another verify straight away is spam again, and so is Check again.
      t.send({ action: 'account.verify', requestId: 'v2', roleArn: '111122223333' });
      t.send({ action: 'account.recheck', requestId: 'c0' });
      await t.until(() => !!t.reply('v2') && !!t.reply('c0'));
      expect(t.reply('v2')).toMatchObject({ type: 'error', message: expect.stringMatching(/few seconds/) });
      expect(t.reply('c0')).toMatchObject({ type: 'error', message: expect.stringMatching(/few seconds/) });
      expect(verify).toHaveBeenCalledTimes(1);
      expect(recheck).not.toHaveBeenCalled();
    } finally {
      t.close();
    }
    // A fresh socket: Check again changes nothing, so it needs no authenticator; it's strict about its fields.
    mfa = 'enrol';
    const u = await stubServer(tenant, async () => mfa);
    try {
      u.send({ action: 'account.recheck', requestId: 'c1' });
      await u.until(() => !!u.reply('c1'));
      expect(u.reply('c1')).toMatchObject({ type: 'account.status', requestId: 'c1', fixes: true });
      expect(recheck).toHaveBeenCalledWith('c1', expect.any(Function));
      u.send({ action: 'account.recheck', requestId: 'c2', roleArn: 'x' });
      await u.until(() => u.events.some((e) => e.type === 'error' && /Bad command/.test(e.message)));
      expect(recheck).toHaveBeenCalledTimes(1);
    } finally {
      u.close();
    }
  });

  it('v2.17: a removal waiting for its approval counts with the tasks, never with the request slots chats need', async () => {
    const asks: string[] = [];
    const remove = vi.fn(async (cmd: { requestId: string }, emit: (e: ServerEvent) => void, approvals: Approvals) => {
      await approvals.request(cmd.requestId, { action: { type: 'delete_table', name: 'city-quest' } as never, summary: 'Delete table', destructive: true }, emit, cmd.requestId);
    });
    const tenant = {
      sub: 'erin',
      region: 'us-west-2',
      remove,
      // Each question takes a request slot and holds it (an answer still being written).
      orchestrator: () => ({ ask: (cmd: { requestId: string }) => (asks.push(cmd.requestId), new Promise(() => undefined)) }),
      createCopilot: () => undefined,
      welcome: async () => [],
      subscribe: () => () => undefined,
      emitter: (emit: unknown) => emit,
    } as unknown as Tenant;
    const t = await stubServer(tenant, async () => 'ok');
    try {
      t.send({ action: 'resource.remove', requestId: 'rm1', kind: 'table', id: 'city-quest' });
      await t.until(() => t.events.some((e) => e.type === 'deploy.preview'));
      for (const id of ['q1', 'q2', 'q3']) t.send({ action: 'chat.ask', requestId: id, districtId: 'storage', question: 'What is S3?', context: {} });
      await t.until(() => asks.length === 3);
      expect(asks).toEqual(['q1', 'q2', 'q3']);
      expect(t.events.some((e) => e.type === 'error')).toBe(false);
      // Two changes may wait at once; a third is refused plainly.
      t.send({ action: 'resource.remove', requestId: 'rm2', kind: 'table', id: 'city-quest' });
      t.send({ action: 'resource.remove', requestId: 'rm3', kind: 'table', id: 'city-quest' });
      await t.until(() => !!t.reply('rm3') && t.events.filter((e) => e.type === 'deploy.preview').length === 2);
      expect(t.events.find((e) => e.type === 'error')).toMatchObject({ requestId: 'rm3', message: expect.stringMatching(/already waiting/) });
    } finally {
      t.close();
    }
  });

  it('deploy.approve and finding.fix are refused while MFA is off; the preview waits until it is on', async () => {
    let mfa: StepUp = 'enrol';
    const fix = vi.fn(async (requestId: string, _f: string, emit: (e: ServerEvent) => void) => emit({ type: 'error', requestId, message: 'fixed' }));
    const tenant = {
      sub: 'erin',
      region: 'us-west-2',
      orchestrator: () => ({
        submitTask: async (cmd: { taskId: string }, emit: (e: ServerEvent) => void, approvals: Approvals) => {
          const ok = await approvals.request(cmd.taskId, { action: { type: 'create_table', name: 'city-x' } as never, summary: 'Create table', destructive: false }, emit);
          emit({ type: 'task.done', taskId: cmd.taskId, ok, result: '', xp: [] });
        },
      }),
      care: () => ({ fix, explain: async () => undefined, undo: () => undefined }),
      createCopilot: () => undefined,
      welcome: async () => [],
      subscribe: () => () => undefined,
      emitter: (emit: unknown) => emit,
    } as unknown as Tenant;
    const tenants = { acquire: async () => tenant, data: () => tenant, release: () => undefined, closeAll: () => undefined };
    const base = { ...loadConfig({}), authMode: 'cognito' as const, extensionOrigins: [EXT] };
    const deps = { tenants, authenticate: async () => ({ sub: 'erin' }), mfaReady: async () => mfa };
    const probe = createHttpServer({ config: { ...base, port: 0 }, ...deps });
    await new Promise<void>((r) => probe.server.listen(0, '127.0.0.1', r));
    const port = (probe.server.address() as AddressInfo).port;
    probe.server.close();
    const { server } = createHttpServer({ config: { ...base, port }, ...deps });
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    const events: ServerEvent[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, bearerSubprotocols('x'), { origin: EXT });
    ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await new Promise((r) => ws.on('open', r));
    const until = async (ok: () => boolean) => {
      for (const end = Date.now() + 3000; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
    };
    try {
      ws.send(JSON.stringify({ action: 'task.submit', taskId: 't1', prompt: 'make a table', context: {} }));
      await until(() => events.some((e) => e.type === 'deploy.preview'));
      const { deployId } = events.find((e) => e.type === 'deploy.preview') as { deployId: string };
      ws.send(JSON.stringify({ action: 'deploy.approve', deployId }));
      ws.send(JSON.stringify({ action: 'finding.fix', requestId: 'f1', findingId: 'x' }));
      await until(() => events.filter((e) => e.type === 'error').length >= 2);
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', code: 'mfa_required' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'error', requestId: 'f1', code: 'mfa_required' }));
      expect(fix).not.toHaveBeenCalled();
      expect(events.some((e) => e.type === 'task.done' || e.type === 'deploy.status')).toBe(false);

      // TOTP is on, but this session signed in before it: sign in again (code auth), nothing runs.
      mfa = 'reauth';
      events.length = 0;
      ws.send(JSON.stringify({ action: 'deploy.approve', deployId }));
      ws.send(JSON.stringify({ action: 'finding.fix', requestId: 'f3', findingId: 'x' }));
      await until(() => events.filter((e) => e.type === 'error').length >= 2);
      expect(events).toContainEqual({ type: 'error', code: 'auth', message: SIGN_IN_AGAIN_MESSAGE });
      expect(events).toContainEqual({ type: 'error', requestId: 'f3', code: 'auth', message: SIGN_IN_AGAIN_MESSAGE });
      expect(fix).not.toHaveBeenCalled();

      mfa = 'ok';
      ws.send(JSON.stringify({ action: 'deploy.approve', deployId }));
      ws.send(JSON.stringify({ action: 'finding.fix', requestId: 'f2', findingId: 'x' }));
      await until(() => events.some((e) => e.type === 'task.done') && fix.mock.calls.length > 0);
      expect(events).toContainEqual(expect.objectContaining({ type: 'deploy.status', deployId, status: 'creating' }));
      expect(events).toContainEqual(expect.objectContaining({ type: 'task.done', taskId: 't1', ok: true }));
      expect(fix).toHaveBeenCalledWith('f2', 'x', expect.any(Function), expect.anything());
    } finally {
      ws.close();
      server.close();
    }
  });
});
