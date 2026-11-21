import { ApiGatewayV2Client } from '@aws-sdk/client-apigatewayv2';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ResourceExplorer2Client } from '@aws-sdk/client-resource-explorer-2';
import { ResourceGroupsTaggingAPIClient } from '@aws-sdk/client-resource-groups-tagging-api';
import { S3ControlClient } from '@aws-sdk/client-s3-control';
import { EC2Client, type EC2ClientConfig } from '@aws-sdk/client-ec2';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { RDSClient } from '@aws-sdk/client-rds';
import { S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromIni, fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { createHash } from 'node:crypto';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { Config } from './config.js';
import { GUARD_DENIED, guard, type GateContext } from './guard/gate.js';
import { log, who } from './log.js';

/**
 * Re-reads the profile from ~/.aws/credentials every minute, so refreshed workshop keys
 * are picked up without restarting the server. (Static session keys carry no expiry, so
 * the SDK would otherwise cache the first ones forever.)
 */
export const refreshingProfile = (profile: string): AwsCredentialIdentityProvider => async () => {
  const creds = await fromIni({ profile, ignoreCache: true })();
  return { ...creds, expiration: new Date(Date.now() + 60_000) };
};

/**
 * STS refused the player role itself (AssumeRole on that role said AccessDenied), not one call made with it: the AWSCity
 * stack was deleted or its trust changed. It keeps the cause's name, so classifyAwsError reads it as before ('denied');
 * the poller tells it apart from one service's AccessDenied by its class.
 */
export class RoleRefusedError extends Error {
  /** The refusal breaker took it for our side (the role refusing many players at once), so it never breaks a link. */
  readonly ourSide: boolean;
  constructor(cause: unknown, ourSide = false) {
    super((cause as Error)?.message ?? 'AssumeRole refused', { cause });
    this.name = (cause as Error)?.name ?? 'AccessDenied';
    this.ourSide = ourSide;
  }
}
export const isRoleRefused = (err: unknown): err is RoleRefusedError => err instanceof RoleRefusedError;

/**
 * A player's own account (hosted mode): short-lived credentials for AWSCityPlayerRole, assumed from our
 * task role with the player's ExternalId. The SDK caches them and refreshes before they expire. STS refusing this role
 * comes out as RoleRefusedError; anything else (our own task credentials failing, throttling, the network) as it was.
 * `feedsBreaker: false` (verify): its refusals and successes stay out of the shared refusal breaker (refusalsMarked).
 */
export const assumedRole = (opts: { roleArn: string; externalId: string; sub: string; region: string; feedsBreaker?: boolean }): AwsCredentialIdentityProvider => {
  const provider = fromTemporaryCredentials({
    masterCredentials: fromNodeProviderChain(),
    clientConfig: { ...SDK_DEFAULTS, region: opts.region },
    params: {
      RoleArn: opts.roleArn,
      ExternalId: opts.externalId,
      RoleSessionName: `aws-city-${createHash('sha256').update(opts.sub).digest('hex').slice(0, 16)}`,
      DurationSeconds: 3600,
    },
  });
  return refusalsMarked(provider, opts.roleArn, { player: who(opts.sub), ...(opts.feedsBreaker === false ? { feedsBreaker: false } : {}) });
};

/**
 * The policies IAM evaluates on the caller of AssumeRole, i.e. our own task role: an AccessDenied naming one ("no
 * identity-based policy allows", "explicit deny in a service control policy", a permissions boundary or a session policy)
 * is our side. The player's side names their role's trust policy (resource-based) or nothing at all (no such role).
 */
const OUR_POLICY = /identity-based policy|service control policy|permissions boundary|session policy/i;

/**
 * Whether a failed AssumeRole is the player's role refusing us: AccessDenied for sts:AssumeRole on that role (`roleArn`,
 * when known). Never our own task credentials failing (ExpiredToken, InvalidClientTokenId: 'expired', or a policy on our
 * role not allowing the call: OUR_POLICY): those would mark every player's link broken at once.
 */
const isPlayerRoleRefusal = (err: unknown, roleArn?: string): boolean => {
  const e = err as { name?: string; message?: string } | undefined;
  const message = e?.message ?? '';
  return e?.name === 'AccessDenied' && message.includes('sts:AssumeRole') && (!roleArn || message.includes(roleArn)) && !OUR_POLICY.test(message);
};

/** The refusal breaker: this many different players refused within REFUSAL_WINDOW_MS, with no AssumeRole working between. */
export const REFUSAL_PLAYERS = 3;
export const REFUSAL_WINDOW_MS = 5 * 60_000;

/**
 * isPlayerRoleRefusal leans on STS's wording ("identity-based policy" marks our own role's refusal). If that wording
 * changes, or our task role breaks some other way, every player's role would look deleted at once. So, per server
 * process: the role refusing REFUSAL_PLAYERS different players within REFUSAL_WINDOW_MS, with no AssumeRole succeeding in
 * between, is taken for our side: those refusals don't count toward breaking anyone's link (tenants.ts BROKEN_AFTER), and
 * it's logged as an error once (until an AssumeRole works again, or a whole window passes with no refusal). A task
 * serving fewer players than that can't tell, and counts refusals as before.
 */
export const createRefusalBreaker = (opts: { players?: number; windowMs?: number; now?: () => number } = {}) => {
  const players = opts.players ?? REFUSAL_PLAYERS;
  const windowMs = opts.windowMs ?? REFUSAL_WINDOW_MS;
  const now = opts.now ?? Date.now;
  /** Player (who(sub)) → when the role last refused them, since the last AssumeRole that worked. */
  const refused = new Map<string, number>();
  let logged = false;
  return {
    /** An AssumeRole worked: STS and our side are fine, so the refusals since were the players' own. */
    succeeded() {
      refused.clear();
      logged = false;
    },
    /** A player's role refused: true when it looks like our side (it mustn't count against that player). */
    ourSide(player: string): boolean {
      const t = now();
      for (const [k, at] of refused) if (t - at > windowMs) refused.delete(k);
      if (refused.size === 0) logged = false;
      refused.set(player, t);
      if (refused.size < players) return false;
      if (!logged) {
        logged = true;
        log.error('player role refused for several players at once: taken for our side, no link is marked broken', { players: refused.size, windowMs });
        // One line wouldn't trip LoggedErrors (20 per 5 min); this metric has its own alarm (infra service-stack).
        log.metric('RoleRefusalBreaker', 1);
      }
      return true;
    },
  };
};
export type RefusalBreaker = ReturnType<typeof createRefusalBreaker>;
/** The process's breaker (every player's assumedRole shares it). */
const roleRefusals = createRefusalBreaker();

/**
 * Wraps a credential provider so the player role refusing it comes out as RoleRefusedError (assumedRole's; a test seam
 * too), marked `ourSide` when the breaker says so. `player`: who it's for (who(sub)), as the breaker counts players.
 * `feedsBreaker: false`: neither counted nor clearing (verify: pressed before CREATE_COMPLETE, or with a stack from an older
 * link, it's refused the same way, so a few players, or one with a few sign-ups, would trip the breaker and page us,
 * and while it's tripped real deleted stacks wouldn't count). Only links already verified feed it: pollers and recheck.
 */
export const refusalsMarked =
  (provider: AwsCredentialIdentityProvider, roleArn?: string, opts: { player?: string; breaker?: RefusalBreaker; feedsBreaker?: boolean } = {}): AwsCredentialIdentityProvider =>
  async (...args) => {
    const breaker = opts.breaker ?? roleRefusals;
    const feeds = opts.feedsBreaker !== false;
    let credentials: Awaited<ReturnType<AwsCredentialIdentityProvider>>;
    try {
      credentials = await provider(...args);
    } catch (err) {
      if (!isPlayerRoleRefusal(err, roleArn)) throw err;
      throw new RoleRefusedError(err, feeds && breaker.ourSide(opts.player ?? roleArn ?? 'unknown'));
    }
    if (feeds) breaker.succeeded();
    return credentials;
  };

/** Credentials for our own infrastructure (Bedrock, the table, the bucket): the profile locally, the task role hosted. */
export const serviceCredentials = (config: Config): AwsCredentialIdentityProvider =>
  config.awsMode === 'profile' ? refreshingProfile(config.awsProfile) : fromNodeProviderChain();

/**
 * Every AWS SDK client gets bounded timeouts: the SDK's Node handler has none by default, and one hung
 * call would freeze a player's poller (it coalesces with the call in flight) or hold their write lock.
 * requestTimeout only warns unless throwOnRequestTimeout is set (@smithy/node-http-handler).
 */
export const SDK_DEFAULTS = {
  maxAttempts: 3,
  retryMode: 'adaptive',
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 10_000, throwOnRequestTimeout: true },
} as const;

/** The workshop profile (local mode, one player); `accountId` is the account it acts in, once the server has asked STS. */
export const createAwsClients = (config: Config, accountId?: () => string | undefined) =>
  clientsFor({ region: config.region, credentials: refreshingProfile(config.awsProfile), accountId, player: 'local' });

/** Cost Explorer has one endpoint, in us-east-1, whatever the account's home Region. */
export const COST_EXPLORER_REGION = 'us-east-1';

/**
 * The player's AWS clients. Every one, the lazily made ones included, goes through the gate (server/src/guard): a
 * command it doesn't list, another Region or a write without its grant is refused before the request is signed.
 * The gate catches mistakes in the server's own code paths; it isn't a sandbox. Each client's `config.credentials`
 * still holds the player's credentials, and code in this process could build an ungated client or presign with them:
 * test/guard.test.ts fails if any file outside aws.ts and guard/ touches credentials, middleware stacks or signers
 * (a short allowlist, each with its reason). The player role and IAM are the outer wall.
 */
export const clientsFor = (opts: {
  region: string;
  credentials: AwsCredentialIdentityProvider;
  /** The account the credentials act in, once known (bucket names, fixes and grants are checked against it). */
  accountId?: () => string | undefined;
  /** Who they act for, as `who(sub)` (log.ts), for the gate's audit lines. */
  player?: string;
  /** Test seam: where requests go (a stub that records them, never the network). */
  requestHandler?: EC2ClientConfig['requestHandler'];
}) => {
  const { accountId, player, ...sdk } = opts;
  const base = { ...SDK_DEFAULTS, ...sdk };
  const gate: GateContext = { home: opts.region, accountId, player };
  const ec2 = guard(new EC2Client(base), gate);
  /** Read-only EC2 clients for other Regions (their AZ maps), same credentials, made on first use. */
  const ec2ByRegion = new Map<string, EC2Client>([[opts.region, ec2]]);
  let ce: CostExplorerClient | undefined;
  let cw: CloudWatchClient | undefined;
  return {
    ec2,
    ec2For(region: string): EC2Client {
      let c = ec2ByRegion.get(region);
      if (!c) ec2ByRegion.set(region, (c = guard(new EC2Client({ ...base, region }), gate)));
      return c;
    },
    /** Cost Explorer (the bill, only while the player has it on): $0.01 per request. */
    costExplorer(): CostExplorerClient {
      return (ce ??= guard(new CostExplorerClient({ ...base, region: COST_EXPLORER_REGION }), gate));
    },
    /** CloudWatch in the home Region (live traffic, only while the player has it on): GetMetricData only. */
    cloudwatch(): CloudWatchClient {
      return (cw ??= guard(new CloudWatchClient(base), gate));
    },
    dynamodb: guard(new DynamoDBClient(base), gate),
    s3: guard(new S3Client(base), gate),
    lambda: guard(new LambdaClient(base), gate),
    rds: guard(new RDSClient(base), gate),
    apigw: guard(new ApiGatewayV2Client(base), gate),
    sts: guard(new STSClient(base), gate),
    // Read-only, for the city's mirror of the account and its Well-Architected checks.
    s3control: guard(new S3ControlClient(base), gate),
    cloudtrail: guard(new CloudTrailClient(base), gate),
    explorer: guard(new ResourceExplorer2Client(base), gate),
    tagging: guard(new ResourceGroupsTaggingAPIClient(base), gate),
  };
};

export type AwsClients = ReturnType<typeof createAwsClients>;

export const getAccountId = async (clients: AwsClients): Promise<string> => {
  const id = await clients.sts.send(new GetCallerIdentityCommand({}));
  if (!id.Account) throw new Error('STS returned no account id');
  return id.Account;
};

/** IAM's refusals, and the city's own gate's (server/src/guard). */
const DENIED = new Set(['AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'AuthorizationError', GUARD_DENIED]);
const EXPIRED = new Set(['ExpiredToken', 'ExpiredTokenException', 'InvalidClientTokenId', 'UnrecognizedClientException', 'RequestExpired']);

export type AwsErrorKind = 'denied' | 'expired' | 'other';

export const classifyAwsError = (err: unknown): AwsErrorKind => {
  const name = (err as { name?: string })?.name ?? '';
  if (DENIED.has(name)) return 'denied';
  if (EXPIRED.has(name)) return 'expired';
  return 'other';
};
