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
 * STS refused the player role itself (AssumeRole said no), not one call made with it: the AWSCity stack was deleted, its
 * trust changed, or the credentials asking for it are no good. It keeps the cause's name, so classifyAwsError reads it
 * as before ('denied' or 'expired'); the poller tells it apart from one service's AccessDenied by its class.
 */
export class RoleRefusedError extends Error {
  constructor(cause: unknown) {
    super((cause as Error)?.message ?? 'AssumeRole refused', { cause });
    this.name = (cause as Error)?.name ?? 'AccessDenied';
  }
}
export const isRoleRefused = (err: unknown): err is RoleRefusedError => err instanceof RoleRefusedError;

/**
 * A player's own account (hosted mode): short-lived credentials for AWSCityPlayerRole, assumed from our
 * task role with the player's ExternalId. The SDK caches them and refreshes before they expire. A refusal
 * ('denied' or 'expired') comes out as RoleRefusedError; anything else (throttling, the network) as it was.
 */
export const assumedRole = (opts: { roleArn: string; externalId: string; sub: string; region: string }): AwsCredentialIdentityProvider => {
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
  return refusalsMarked(provider);
};

/** Wraps a credential provider so STS's refusals of it come out as RoleRefusedError (assumedRole's; a test seam too). */
export const refusalsMarked =
  (provider: AwsCredentialIdentityProvider): AwsCredentialIdentityProvider =>
  async (...args) => {
    try {
      return await provider(...args);
    } catch (err) {
      throw classifyAwsError(err) === 'other' ? err : new RoleRefusedError(err);
    }
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
