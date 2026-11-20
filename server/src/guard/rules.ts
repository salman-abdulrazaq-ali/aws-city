import { z } from 'zod';
import { bucketPrefix, GAME_TAG, TABLE_PREFIX } from '../state/model.js';

/**
 * Every request the server may send with a player's credentials, keyed by client and command exactly as the SDK names
 * them in the handler context (`clientName`, `commandName`: @smithy/core's makeBuilder). Anything not listed here is
 * refused by the gate (gate.ts). Our own infrastructure's clients (Bedrock, our table and bucket, SSM, Cognito) don't use
 * a player's role and aren't gated.
 *
 * read: runs without a grant, in the home Region (unless `region` says otherwise).
 * write / fix: needs a grant naming the command and its exact target, and the request must have the exact shape the
 * server sends (`wire`, strict: an unknown field is refused), grant or not. They mirror executor.ts and fixes.ts, and
 * the player role's conditions (infra/player-role/player-role.yaml).
 */
export type Kind = 'read' | 'write' | 'fix';

/** What a write or fix is checked against: the client's Region and the account the credentials act in. */
export interface WireContext {
  region: string;
  /** Undefined until known: bucket writes and fixes that name the owner are refused until then. */
  accountId?: string;
}

/** `region` for the few account-wide reads that may go to any Region. */
export const ANY_REGION = 'any';

interface RuleBase {
  /** IAM actions the call needs in the player role (none for GetCallerIdentity, which needs no permission). */
  iam: readonly string[];
  /** Where it may go: the home Region (default), ANY_REGION, or one fixed Region. */
  region?: string;
}
export interface ReadRule extends RuleBase {
  kind: 'read';
}
/** A request's input; `wire` has checked its shape before `target` and `ids` read it. */
type Wire = Record<string, any>;
export interface ChangeRule extends RuleBase {
  kind: 'write' | 'fix';
  /** The exact request the server sends; anything else is refused, even with a grant. */
  wire: (ctx: WireContext) => z.ZodType;
  /** Shown to the player when the request isn't that shape (plain words, no ids). */
  refusal: string;
  /** The one thing it touches, which the grant must name exactly. */
  target: (input: Wire, ctx: WireContext) => string | undefined;
  /** Rule ids it removes, each of which the grant must name. */
  ids?: (input: Wire) => readonly string[];
}
export type CommandRule = ReadRule | ChangeRule;

const read = (iam: string | null, region?: string): ReadRule => ({ kind: 'read', iam: iam ? [iam] : [], ...(region ? { region } : {}) });
const write = (rule: Omit<ChangeRule, 'kind'>): ChangeRule & { kind: 'write' } => ({ kind: 'write', ...rule });
const fix = (rule: Omit<ChangeRule, 'kind'>): ChangeRule & { kind: 'fix' } => ({ kind: 'fix', ...rule });

/** The only instance types the role lets the city launch ('ec2:InstanceType' in player-role.yaml). */
export const INSTANCE_TYPES = ['t4g.nano', 't4g.micro'] as const;
/** Cost Explorer's one endpoint (COST_EXPLORER_REGION in aws.ts). */
const COST_EXPLORER = 'us-east-1';

/** What a launch grant names: the instance type and the Name tag the player approved. */
export const launchTarget = (instanceType: string, name: string) => `${instanceType} ${name}`;

const instanceId = z.string().regex(/^i-[0-9a-f]{8,17}$/);
const tag = z.object({ Key: z.string(), Value: z.string() }).strict();
const gameTags = z.array(tag).refine((tags) => tags.some((t) => t.Key === GAME_TAG.key && t.Value === GAME_TAG.value), 'missing the city tag');
const oneInstance = z.object({ InstanceIds: z.tuple([instanceId]) }).strict();
/** A bucket of this account's: aws-city-<account>-… (none until the account is known). */
const gameBucket = (ctx: WireContext) => (ctx.accountId ? z.string().startsWith(bucketPrefix(ctx.accountId)) : z.never());

const RUN_INSTANCES = z
  .object({
    ImageId: z.string().regex(/^ami-[0-9a-f]{8,17}$/),
    InstanceType: z.enum(INSTANCE_TYPES),
    MinCount: z.literal(1),
    MaxCount: z.literal(1),
    MetadataOptions: z.object({ HttpTokens: z.literal('required') }).strict(),
    BlockDeviceMappings: z
      .array(z.object({ DeviceName: z.string(), Ebs: z.object({ Encrypted: z.literal(true) }).strict() }).strict())
      .min(1),
    CreditSpecification: z.object({ CpuCredits: z.literal('standard') }).strict().optional(),
    TagSpecifications: z
      .array(z.object({ ResourceType: z.enum(['instance', 'volume']), Tags: gameTags }).strict())
      .refine((specs) => specs.some((s) => s.ResourceType === 'instance'), 'no instance tags'),
  })
  .strict();

const CREATE_TABLE = z
  .object({
    TableName: z.string().startsWith(TABLE_PREFIX),
    AttributeDefinitions: z.array(z.object({ AttributeName: z.string(), AttributeType: z.enum(['S', 'N', 'B']) }).strict()).min(1),
    KeySchema: z.array(z.object({ AttributeName: z.string(), KeyType: z.enum(['HASH', 'RANGE']) }).strict()).min(1).max(2),
    BillingMode: z.literal('PAY_PER_REQUEST'),
    Tags: gameTags,
  })
  .strict();

const nameTag = (input: Wire): string | undefined =>
  (input.TagSpecifications as { ResourceType: string; Tags: { Key: string; Value: string }[] }[])
    .find((s) => s.ResourceType === 'instance')
    ?.Tags.find((t) => t.Key === 'Name')?.Value;

export const RULES = {
  EC2Client: {
    DescribeInstancesCommand: read('ec2:DescribeInstances'),
    DescribeSecurityGroupsCommand: read('ec2:DescribeSecurityGroups'),
    DescribeSecurityGroupRulesCommand: read('ec2:DescribeSecurityGroupRules'),
    DescribeVolumesCommand: read('ec2:DescribeVolumes'),
    DescribeImagesCommand: read('ec2:DescribeImages'),
    GetEbsEncryptionByDefaultCommand: read('ec2:GetEbsEncryptionByDefault'),
    // The account's AZ map in every Region it uses (ec2For) and which Regions are on: account-wide metadata.
    DescribeAvailabilityZonesCommand: read('ec2:DescribeAvailabilityZones', ANY_REGION),
    DescribeRegionsCommand: read('ec2:DescribeRegions', ANY_REGION),
    RunInstancesCommand: write({
      // Tags on launch need ec2:CreateTags (the role allows it only with ec2:CreateAction RunInstances).
      iam: ['ec2:RunInstances', 'ec2:CreateTags'],
      wire: () => RUN_INSTANCES,
      refusal: "a new house must be one t4g.nano or t4g.micro with IMDSv2 required, an encrypted disk and the city's tag, and nothing else.",
      target: (i) => {
        const name = nameTag(i);
        return name === undefined ? undefined : launchTarget(i.InstanceType, name);
      },
    }),
    StopInstancesCommand: write({ iam: ['ec2:StopInstances'], wire: () => oneInstance, refusal: 'houses are changed one at a time, by their own id.', target: (i) => i.InstanceIds[0] }),
    StartInstancesCommand: write({ iam: ['ec2:StartInstances'], wire: () => oneInstance, refusal: 'houses are changed one at a time, by their own id.', target: (i) => i.InstanceIds[0] }),
    TerminateInstancesCommand: write({ iam: ['ec2:TerminateInstances'], wire: () => oneInstance, refusal: 'houses are changed one at a time, by their own id.', target: (i) => i.InstanceIds[0] }),
    RevokeSecurityGroupIngressCommand: fix({
      iam: ['ec2:RevokeSecurityGroupIngress'],
      wire: () => z.object({ GroupId: z.string().regex(/^sg-[0-9a-f]+$/), SecurityGroupRuleIds: z.array(z.string().regex(/^sgr-[0-9a-f]+$/)).min(1) }).strict(),
      refusal: 'a security group fix can only remove the rules you approved, by their ids.',
      target: (i) => i.GroupId,
      ids: (i) => i.SecurityGroupRuleIds,
    }),
    ModifyInstanceMetadataOptionsCommand: fix({
      iam: ['ec2:ModifyInstanceMetadataOptions'],
      wire: () => z.object({ InstanceId: instanceId, HttpTokens: z.literal('required') }).strict(),
      refusal: 'an IMDS fix can only require IMDSv2, and change nothing else.',
      target: (i) => i.InstanceId,
    }),
    EnableEbsEncryptionByDefaultCommand: fix({
      iam: ['ec2:EnableEbsEncryptionByDefault'],
      wire: () => z.object({}).strict(),
      refusal: 'the EBS fix only turns encryption by default on.',
      // The finding's resource id for this Region's setting (agents/findings.ts).
      target: (_i, ctx) => `ebs-default:${ctx.region}`,
    }),
  },
  DynamoDBClient: {
    ListTablesCommand: read('dynamodb:ListTables'),
    DescribeTableCommand: read('dynamodb:DescribeTable'),
    ListTagsOfResourceCommand: read('dynamodb:ListTagsOfResource'),
    DescribeContinuousBackupsCommand: read('dynamodb:DescribeContinuousBackups'),
    CreateTableCommand: write({
      // Tags on create need dynamodb:TagResource.
      iam: ['dynamodb:CreateTable', 'dynamodb:TagResource'],
      wire: () => CREATE_TABLE,
      refusal: `a new library must be an on-demand table named ${TABLE_PREFIX}… with the city's tag, and nothing else.`,
      target: (i) => i.TableName,
    }),
    DeleteTableCommand: write({
      iam: ['dynamodb:DeleteTable'],
      wire: () => z.object({ TableName: z.string().startsWith(TABLE_PREFIX) }).strict(),
      refusal: `the city only deletes its own ${TABLE_PREFIX}… tables.`,
      target: (i) => i.TableName,
    }),
    UpdateContinuousBackupsCommand: fix({
      iam: ['dynamodb:UpdateContinuousBackups'],
      wire: () => z.object({ TableName: z.string().min(1), PointInTimeRecoverySpecification: z.object({ PointInTimeRecoveryEnabled: z.literal(true) }).strict() }).strict(),
      refusal: 'a backup fix can only turn point-in-time recovery on.',
      target: (i) => i.TableName,
    }),
  },
  S3Client: {
    ListBucketsCommand: read('s3:ListAllMyBuckets'),
    GetPublicAccessBlockCommand: read('s3:GetBucketPublicAccessBlock'),
    CreateBucketCommand: write({
      iam: ['s3:CreateBucket'],
      wire: (ctx) =>
        z
          .object({
            Bucket: gameBucket(ctx),
            // us-east-1 takes no LocationConstraint; every other Region names itself, so the bucket stays in the home Region.
            CreateBucketConfiguration: ctx.region === 'us-east-1' ? z.never().optional() : z.object({ LocationConstraint: z.literal(ctx.region) }).strict(),
          })
          .strict(),
      refusal: 'a new warehouse must be named aws-city-<your account>-… and stay in this Region.',
      target: (i) => i.Bucket,
    }),
    PutBucketTaggingCommand: write({
      iam: ['s3:PutBucketTagging'],
      wire: (ctx) => z.object({ Bucket: gameBucket(ctx), Tagging: z.object({ TagSet: gameTags }).strict() }).strict(),
      refusal: "only the city's own warehouses are tagged, and they keep the city's tag.",
      target: (i) => i.Bucket,
    }),
    DeleteBucketCommand: write({
      iam: ['s3:DeleteBucket'],
      wire: (ctx) => z.object({ Bucket: gameBucket(ctx) }).strict(),
      refusal: 'the city only deletes its own aws-city-… warehouses.',
      target: (i) => i.Bucket,
    }),
    PutPublicAccessBlockCommand: fix({
      iam: ['s3:PutBucketPublicAccessBlock'],
      wire: (ctx) =>
        z
          .object({
            Bucket: z.string().min(1),
            ExpectedBucketOwner: ctx.accountId ? z.literal(ctx.accountId) : z.never(),
            PublicAccessBlockConfiguration: z
              .object({ BlockPublicAcls: z.literal(true), IgnorePublicAcls: z.literal(true), BlockPublicPolicy: z.literal(true), RestrictPublicBuckets: z.literal(true) })
              .strict(),
          })
          .strict(),
      refusal: 'a Block Public Access fix can only turn all four settings on, for a bucket in your own account.',
      target: (i) => i.Bucket,
    }),
  },
  S3ControlClient: {
    GetPublicAccessBlockCommand: read('s3:GetAccountPublicAccessBlock'),
  },
  LambdaClient: {
    ListFunctionsCommand: read('lambda:ListFunctions'),
  },
  RDSClient: {
    DescribeDBInstancesCommand: read('rds:DescribeDBInstances'),
  },
  ApiGatewayV2Client: {
    GetApisCommand: read('apigateway:GET'),
  },
  STSClient: {
    // Who am I (the account id, and account linking's check). It needs no IAM permission.
    GetCallerIdentityCommand: read(null),
  },
  CloudTrailClient: {
    DescribeTrailsCommand: read('cloudtrail:DescribeTrails'),
    GetTrailStatusCommand: read('cloudtrail:GetTrailStatus'),
    ListEventDataStoresCommand: read('cloudtrail:ListEventDataStores'),
  },
  ResourceExplorer2Client: {
    ListIndexesCommand: read('resource-explorer-2:ListIndexes'),
    SearchCommand: read('resource-explorer-2:Search'),
  },
  ResourceGroupsTaggingAPIClient: {
    GetResourcesCommand: read('tag:GetResources'),
  },
  CostExplorerClient: {
    GetCostAndUsageCommand: read('ce:GetCostAndUsage', COST_EXPLORER),
  },
  CloudWatchClient: {
    GetMetricDataCommand: read('cloudwatch:GetMetricData'),
  },
} satisfies Record<string, Record<string, CommandRule>>;

type Rules = typeof RULES;
export type ClientName = keyof Rules;
/** The writes and fixes of one client: the only commands a grant can name. */
export type ChangeCommand<C extends ClientName> = { [K in keyof Rules[C]]: Rules[C][K] extends { kind: 'write' | 'fix' } ? K : never }[keyof Rules[C]] & string;

/** The rule for a request, or undefined (refused). Own keys only: no prototype names. */
export const ruleFor = (client: string, command: string): CommandRule | undefined => {
  const table = RULES as Record<string, Record<string, CommandRule>>;
  const commands = Object.hasOwn(table, client) ? table[client] : undefined;
  return commands && Object.hasOwn(commands, command) ? commands[command] : undefined;
};
