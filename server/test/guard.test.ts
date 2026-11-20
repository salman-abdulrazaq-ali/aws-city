import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { CostExplorerClient, GetCostAndUsageCommand } from '@aws-sdk/client-cost-explorer';
import { CreateTableCommand, UpdateContinuousBackupsCommand } from '@aws-sdk/client-dynamodb';
import {
  AuthorizeSecurityGroupIngressCommand,
  DescribeAvailabilityZonesCommand,
  DescribeInstancesCommand,
  DescribeRegionsCommand,
  DisableEbsEncryptionByDefaultCommand,
  EC2Client,
  EnableEbsEncryptionByDefaultCommand,
  ModifyInstanceMetadataOptionsCommand,
  RevokeSecurityGroupIngressCommand,
  RunInstancesCommand,
  type RunInstancesCommandInput,
  StopInstancesCommand,
  TerminateInstancesCommand,
} from '@aws-sdk/client-ec2';
import { CreateBucketCommand, ListBucketsCommand, PutBucketTaggingCommand, PutPublicAccessBlockCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_SCHEMAS } from '../src/agents/actions.js';
import { FIXES } from '../src/agents/fixes.js';
import { createActionService, NEEDS_APPROVAL_REASON, REJECTED_REASON } from '../src/agents/service.js';
import { classifyAwsError, clientsFor, COST_EXPLORER_REGION } from '../src/aws.js';
import { type Grant, guard, GuardDeniedError, mintGrant, withGrant } from '../src/guard/gate.js';
import { actionGrant } from '../src/guard/grants.js';
import { INSTANCE_TYPES, launchTarget, RULES } from '../src/guard/rules.js';
import { log } from '../src/log.js';
import type { Poller } from '../src/state/poller.js';
import type { WorldSnapshot } from '../src/state/model.js';
import type { CityFinding } from '../src/world.js';
import { ACCOUNT, instance, snapshot } from './fixtures.js';

const HOME = 'us-west-2';
const I_ABC = 'i-0abc0000000000001';
const I_DEF = 'i-0def0000000000002';
const SG = 'sg-0123456789abcdef0';
const SGR_SSH = 'sgr-0000000000000000a';
const SGR_RDP = 'sgr-0000000000000000b';
const BUCKET = `aws-city-${ACCOUNT}-photos`;
const credentials = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-secret' });

interface Sent {
  op: string;
  host: string;
  body: string;
}

const EC2_XMLNS = 'http://ec2.amazonaws.com/doc/2016-11-15/';
/** Canned bodies for the reads the fixes and the launch make first; every other reply is an empty 200. */
const REPLIES: Record<string, string> = {
  DescribeImages: `<DescribeImagesResponse xmlns="${EC2_XMLNS}"><imagesSet><item><imageId>ami-0123456789abcdef0</imageId><creationDate>2026-10-01T00:00:00.000Z</creationDate></item></imagesSet></DescribeImagesResponse>`,
  DescribeSecurityGroupRules: `<DescribeSecurityGroupRulesResponse xmlns="${EC2_XMLNS}"><securityGroupRuleSet>${[
    [SGR_SSH, 22],
    [SGR_RDP, 3389],
  ]
    .map(([id, port]) => `<item><securityGroupRuleId>${id}</securityGroupRuleId><groupId>${SG}</groupId><isEgress>false</isEgress><ipProtocol>tcp</ipProtocol><fromPort>${port}</fromPort><toPort>${port}</toPort><cidrIpv4>0.0.0.0/0</cidrIpv4></item>`)
    .join('')}</securityGroupRuleSet></DescribeSecurityGroupRulesResponse>`,
};

/** The operation a signed request is for: query (EC2, STS), JSON target (DynamoDB, CE), RPCv2 path (CloudWatch) or S3 REST. */
const opOf = (r: { method: string; hostname: string; path: string; query?: Record<string, unknown>; headers: Record<string, string>; body?: unknown }, body: string) =>
  /(?:^|&)Action=(\w+)/.exec(body)?.[1] ??
  r.headers['x-amz-target']?.split('.')[1] ??
  /\/operation\/(\w+)/.exec(r.path)?.[1] ??
  `${r.method} ${r.hostname.split('.')[0]}${r.path}${Object.keys(r.query ?? {}).length ? `?${Object.keys(r.query ?? {}).join('&')}` : ''}`;

/** A stub HTTP handler: records every request that reaches it (signed, so past the gate) and never touches the network. */
const recorder = () => {
  const sent: Sent[] = [];
  const requestHandler = {
    async handle(r: { method: string; hostname: string; path: string; query?: Record<string, unknown>; headers: Record<string, string>; body?: unknown }) {
      const body = typeof r.body === 'string' ? r.body : r.body instanceof Uint8Array ? Buffer.from(r.body.buffer, r.body.byteOffset, r.body.byteLength).toString('latin1') : '';
      const op = opOf(r, body);
      sent.push({ op, host: r.hostname, body });
      return { response: { statusCode: 200, headers: {}, body: new TextEncoder().encode(REPLIES[op] ?? '') } };
    },
  };
  return { sent, requestHandler };
};

/** The real clientsFor, with the stub handler (null: the account isn't known yet). */
const recording = (accountId: string | null = ACCOUNT) => {
  const { sent, requestHandler } = recorder();
  const clients = clientsFor({ region: HOME, credentials, accountId: () => accountId ?? undefined, requestHandler: requestHandler as never });
  return { sent, clients };
};

/** Awaits a send that the gate must refuse; returns the error. */
const refused = async (p: Promise<unknown>): Promise<GuardDeniedError> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, 'the gate should have refused this').toBeInstanceOf(GuardDeniedError);
  return err as GuardDeniedError;
};

const granted = <T>(grant: Grant | undefined, fn: () => Promise<T>) => withGrant(grant!, fn);
const launchInput = (over: Partial<RunInstancesCommandInput> = {}): RunInstancesCommandInput => ({
  ImageId: 'ami-0123456789abcdef0',
  InstanceType: 't4g.micro',
  MinCount: 1,
  MaxCount: 1,
  MetadataOptions: { HttpTokens: 'required' },
  BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { Encrypted: true } }],
  CreditSpecification: { CpuCredits: 'standard' },
  TagSpecifications: [
    { ResourceType: 'instance', Tags: [{ Key: 'Name', Value: 'web' }, { Key: 'managed-by', Value: 'aws-city' }] },
    { ResourceType: 'volume', Tags: [{ Key: 'Name', Value: 'web' }, { Key: 'managed-by', Value: 'aws-city' }] },
  ],
  ...over,
});
const finding = (id: string, fixId: string) => ({ id: 'f-1', resource: { id, name: id, gameOwned: true }, fix: { fixId } }) as unknown as CityFinding;
const pollerFor = (s: WorldSnapshot) => ({ current: () => s, refresh: async () => s, start() {}, stop() {} }) as Poller;

afterEach(() => vi.restoreAllMocks());

describe('the gate between the server and AWS', () => {
  it('sits on every client clientsFor makes, the lazily made ones too', () => {
    const { clients } = recording();
    const all = [...Object.values(clients).filter((c): c is EC2Client => typeof c === 'object' && 'middlewareStack' in c), clients.ec2For('eu-west-1'), clients.costExplorer(), clients.cloudwatch()];
    expect(all.length).toBeGreaterThanOrEqual(14);
    for (const c of all) expect(c.middlewareStack.identify(), c.constructor.name).toContain('awsCityGate - initialize');
    // The credentials aren't handed out, so nothing builds an ungated client from AwsClients.
    expect(Object.keys(clients)).not.toContain('credentials');
  });

  it('refuses a command it does not list, even inside a grant, before anything is sent', async () => {
    const { clients, sent } = recording();
    const grant = actionGrant({ type: 'terminate_instance', instanceId: I_ABC }, ACCOUNT);
    await granted(grant, async () => {
      const err = await refused(clients.ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: SG, CidrIp: '0.0.0.0/0', IpProtocol: 'tcp', FromPort: 22, ToPort: 22 })));
      expect(err.name).toBe('AwsCityGuardDenied');
      expect(err.message).toBe('the city never sends AuthorizeSecurityGroupIngress to AWS.');
      expect(err.publicMessage).toBe("The city's safety gate stopped this: the city never sends AuthorizeSecurityGroupIngress to AWS.");
      expect(classifyAwsError(err)).toBe('denied');
      await refused(clients.sts.send(new AssumeRoleCommand({ RoleArn: `arn:aws:iam::${ACCOUNT}:role/Admin`, RoleSessionName: 'x' })));
      await refused(clients.ec2.send(new DisableEbsEncryptionByDefaultCommand({})));
    });
    // A client the table doesn't know at all.
    await refused(guard(new SSMClient({ region: HOME, credentials, requestHandler: recorder().requestHandler as never }), { home: HOME }).send(new GetParameterCommand({ Name: 'x' })));
    expect(sent).toEqual([]);
  });

  it('refuses every write without a grant', async () => {
    const { clients, sent } = recording();
    const err = await refused(clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [I_ABC] })));
    expect(err.message).toContain('need your approval');
    await refused(clients.dynamodb.send(new CreateTableCommand({ TableName: 'city-quest', AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }], BillingMode: 'PAY_PER_REQUEST', Tags: [{ Key: 'managed-by', Value: 'aws-city' }] })));
    await refused(clients.s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: HOME } })));
    expect(sent).toEqual([]);
  });

  it('a grant allows exactly its commands and targets, once each', async () => {
    const { clients, sent } = recording();
    await granted(actionGrant({ type: 'terminate_instance', instanceId: I_ABC }, ACCOUNT), async () => {
      expect((await refused(clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [I_DEF] })))).message).toBe("that isn't the change you approved.");
      await refused(clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [I_ABC, I_DEF] })));
      await refused(clients.ec2.send(new StopInstancesCommand({ InstanceIds: [I_ABC] })));
      await clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [I_ABC] }));
      expect((await refused(clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [I_ABC] })))).message).toBe('that approved change has already been sent.');
    });
    expect(sent.map((s) => s.op)).toEqual(['TerminateInstances']);
    expect(sent[0]!.body).toContain(`InstanceId.1=${I_ABC}`);
    // Outside the grant, the same request is a write without approval again.
    await refused(clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: [I_ABC] })));

    // create_bucket: that one bucket's CreateBucket and PutBucketTagging, nothing else.
    await granted(actionGrant({ type: 'create_bucket', suffix: 'photos' }, ACCOUNT), async () => {
      await refused(clients.s3.send(new CreateBucketCommand({ Bucket: `aws-city-${ACCOUNT}-other`, CreateBucketConfiguration: { LocationConstraint: HOME } })));
      await clients.s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: HOME } }));
      await clients.s3.send(new PutBucketTaggingCommand({ Bucket: BUCKET, Tagging: { TagSet: [{ Key: 'managed-by', Value: 'aws-city' }] } }));
    });
    expect(sent.map((s) => s.op)).toEqual(['TerminateInstances', 'PUT aws-city-123456789012-photos/', 'PUT aws-city-123456789012-photos/?tagging']);
  });

  it("RunInstances keeps the role's shape even with a grant", async () => {
    const { clients, sent } = recording();
    const launch = (input: RunInstancesCommandInput) =>
      granted(mintGrant('test', [{ client: 'EC2Client', command: 'RunInstancesCommand', target: launchTarget(String(input.InstanceType), 'web') }]), () => clients.ec2.send(new RunInstancesCommand(input)));
    await launch(launchInput());
    expect(sent.map((s) => s.op)).toEqual(['RunInstances']);
    const unsafe: Partial<RunInstancesCommandInput>[] = [
      { InstanceType: 't3.large' },
      { MetadataOptions: undefined },
      { MetadataOptions: { HttpTokens: 'optional' } },
      { MetadataOptions: { HttpTokens: 'required', HttpEndpoint: 'enabled', HttpPutResponseHopLimit: 5 } },
      { BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: { Encrypted: false } }] },
      { BlockDeviceMappings: [{ DeviceName: '/dev/xvda', Ebs: {} }] },
      { BlockDeviceMappings: [] },
      { IamInstanceProfile: { Name: 'Admin' } },
      { UserData: Buffer.from('#!/bin/sh\ncurl evil').toString('base64') },
      { MinCount: 1, MaxCount: 2 },
      { CreditSpecification: { CpuCredits: 'unlimited' } },
      { TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: 'web' }] }] },
      { KeyName: 'my-key' },
    ];
    for (const over of unsafe) {
      const err = await refused(launch(launchInput(over)));
      expect(err.message, JSON.stringify(over)).toContain('a new house must be one t4g.nano or t4g.micro');
    }
    expect(sent.map((s) => s.op)).toEqual(['RunInstances']);
    // The gate's instance types are the agents' (and the role's: player-role.test.ts).
    expect(ACTION_SCHEMAS.launch_instance.shape.instanceType.unwrap().options).toEqual([...INSTANCE_TYPES]);
  });

  it('tables and buckets keep their names, tags, billing and Region even with a grant', async () => {
    const { clients, sent } = recording();
    const table = { TableName: 'city-quest', AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' as const }], KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' as const }], BillingMode: 'PAY_PER_REQUEST' as const, Tags: [{ Key: 'managed-by', Value: 'aws-city' }] };
    const create = (input: typeof table & Record<string, unknown>) =>
      granted(mintGrant('test', [{ client: 'DynamoDBClient', command: 'CreateTableCommand', target: input.TableName }]), () => clients.dynamodb.send(new CreateTableCommand(input)));
    await refused(create({ ...table, BillingMode: 'PROVISIONED' as never, ProvisionedThroughput: { ReadCapacityUnits: 1000, WriteCapacityUnits: 1000 } }));
    await refused(create({ ...table, TableName: 'prod-orders' }));
    await refused(create({ ...table, Tags: [] }));
    await refused(create({ ...table, ResourcePolicy: '{"Statement":[{"Effect":"Allow","Principal":"*"}]}' }));
    await create(table);
    expect(sent.map((s) => s.op)).toEqual(['CreateTable']);

    const bucket = (name: string, config?: { LocationConstraint: string }) =>
      granted(mintGrant('test', [{ client: 'S3Client', command: 'CreateBucketCommand', target: name }]), () =>
        clients.s3.send(new CreateBucketCommand({ Bucket: name, ...(config ? { CreateBucketConfiguration: config as never } : {}) })),
      );
    await refused(bucket('aws-city-999999999999-photos', { LocationConstraint: HOME })); // another account's prefix
    await refused(bucket(BUCKET, { LocationConstraint: 'eu-west-1' })); // a bucket in another Region
    await refused(bucket(BUCKET)); // no LocationConstraint outside us-east-1 would put it in us-east-1
    await refused(granted(mintGrant('test', [{ client: 'S3Client', command: 'CreateBucketCommand', target: BUCKET }]), () => clients.s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: HOME }, ACL: 'public-read' }))));
    // Before the account is known, no bucket is the city's.
    const early = recording(null);
    await refused(granted(actionGrant({ type: 'create_bucket', suffix: 'photos' }, ACCOUNT), () => early.clients.s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: HOME } }))));
    expect(early.sent).toEqual([]);
    expect(sent.map((s) => s.op)).toEqual(['CreateTable']);

    // Home us-east-1: a bucket there carries no LocationConstraint (S3 rejects one), and naming any Region is refused.
    const east = recorder();
    const s3East = clientsFor({ region: 'us-east-1', credentials, accountId: () => ACCOUNT, requestHandler: east.requestHandler as never }).s3;
    const eastGrant = () => mintGrant('test', [{ client: 'S3Client', command: 'CreateBucketCommand', target: BUCKET }]);
    await refused(granted(eastGrant(), () => s3East.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: 'us-east-2' } }))));
    await granted(eastGrant(), () => s3East.send(new CreateBucketCommand({ Bucket: BUCKET })));
    expect(east.sent.map((s) => s.op)).toEqual(['PUT aws-city-123456789012-photos/']);
  });

  it('fixes can only tighten, and only what was approved', async () => {
    const { clients, sent } = recording();
    const fixGrant = (entry: Parameters<typeof mintGrant>[1][number]) => mintGrant('fix:test', [entry]);
    const bpa = (on: boolean[], owner = ACCOUNT) =>
      granted(fixGrant({ client: 'S3Client', command: 'PutPublicAccessBlockCommand', target: BUCKET }), () =>
        clients.s3.send(
          new PutPublicAccessBlockCommand({
            Bucket: BUCKET,
            ExpectedBucketOwner: owner,
            PublicAccessBlockConfiguration: { BlockPublicAcls: on[0], IgnorePublicAcls: on[1], BlockPublicPolicy: on[2], RestrictPublicBuckets: on[3] },
          }),
        ),
      );
    expect((await refused(bpa([true, true, false, true]))).message).toContain('can only turn all four settings on');
    await refused(bpa([true, true, true, true], '999999999999'));
    await bpa([true, true, true, true]);

    const imds = (input: Record<string, unknown>) =>
      granted(fixGrant({ client: 'EC2Client', command: 'ModifyInstanceMetadataOptionsCommand', target: I_ABC }), () => clients.ec2.send(new ModifyInstanceMetadataOptionsCommand({ InstanceId: I_ABC, ...input })));
    await refused(imds({ HttpTokens: 'optional' }));
    await refused(imds({ HttpTokens: 'required', HttpEndpoint: 'enabled' }));
    await refused(imds({ HttpEndpoint: 'disabled' }));
    await imds({ HttpTokens: 'required' });

    const pitr = (on: boolean) =>
      granted(fixGrant({ client: 'DynamoDBClient', command: 'UpdateContinuousBackupsCommand', target: 'city-quest' }), () =>
        clients.dynamodb.send(new UpdateContinuousBackupsCommand({ TableName: 'city-quest', PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: on } })),
      );
    await refused(pitr(false));
    await pitr(true);

    // EBS encryption by default: on, in the Region the finding named.
    await refused(granted(fixGrant({ client: 'EC2Client', command: 'EnableEbsEncryptionByDefaultCommand', target: 'ebs-default:eu-west-1' }), () => clients.ec2.send(new EnableEbsEncryptionByDefaultCommand({}))));
    await granted(fixGrant({ client: 'EC2Client', command: 'EnableEbsEncryptionByDefaultCommand', target: `ebs-default:${HOME}` }), () => clients.ec2.send(new EnableEbsEncryptionByDefaultCommand({})));

    // Security groups: only remove, and only the rule ids approved.
    const sgGrant = () => fixGrant({ client: 'EC2Client', command: 'RevokeSecurityGroupIngressCommand', target: SG, ids: [SGR_SSH] });
    await refused(granted(sgGrant(), () => clients.ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: SG, SecurityGroupRuleIds: [SGR_SSH, SGR_RDP] }))));
    await refused(granted(sgGrant(), () => clients.ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: SG, IpPermissions: [{ IpProtocol: '-1' }] }))));
    await refused(granted(sgGrant(), () => clients.ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: SG, CidrIp: '0.0.0.0/0', IpProtocol: '-1' }))));
    await refused(granted(sgGrant(), () => clients.ec2.send(new DisableEbsEncryptionByDefaultCommand({}))));
    await granted(sgGrant(), () => clients.ec2.send(new RevokeSecurityGroupIngressCommand({ GroupId: SG, SecurityGroupRuleIds: [SGR_SSH] })));
    expect(sent.map((s) => s.op)).toEqual(['PUT aws-city-123456789012-photos/?publicAccessBlock', 'ModifyInstanceMetadataOptions', 'UpdateContinuousBackups', 'EnableEbsEncryptionByDefault', 'RevokeSecurityGroupIngress']);
  });

  it("the real fixes pass the gate with their own grants; the same call outside one doesn't", async () => {
    const { clients, sent } = recording();
    await FIXES.ec2_require_imdsv2!.apply(clients, finding(I_ABC, 'ec2_require_imdsv2'), { accountId: ACCOUNT });
    await FIXES.ebs_default_encryption!.apply(clients, finding(`ebs-default:${HOME}`, 'ebs_default_encryption'), { accountId: ACCOUNT });
    await FIXES.s3_block_public_access!.apply(clients, finding(BUCKET, 's3_block_public_access'), { accountId: ACCOUNT });
    await FIXES.dynamodb_enable_pitr!.apply(clients, finding('city-quest', 'dynamodb_enable_pitr'), { accountId: ACCOUNT });
    // The group has SSH and RDP open to the world; the player approved only the SSH rule.
    await FIXES.sg_revoke_world_admin!.apply(clients, finding(SG, 'sg_revoke_world_admin'), { accountId: ACCOUNT }, [SGR_SSH]);
    expect(sent.map((s) => s.op)).toEqual([
      'ModifyInstanceMetadataOptions',
      'EnableEbsEncryptionByDefault',
      'PUT aws-city-123456789012-photos/?publicAccessBlock',
      'UpdateContinuousBackups',
      'DescribeSecurityGroupRules',
      'RevokeSecurityGroupIngress',
    ]);
    expect(sent.at(-1)!.body).toContain(`SecurityGroupRuleId.1=${SGR_SSH}`);
    expect(sent.at(-1)!.body).not.toContain(SGR_RDP);
    await refused(clients.ec2.send(new ModifyInstanceMetadataOptionsCommand({ InstanceId: I_ABC, HttpTokens: 'required' })));
    expect(sent).toHaveLength(6);
  });

  it('reads stay in the home Region, except AZ and Region lists (any Region) and Cost Explorer (us-east-1)', async () => {
    const { clients, sent } = recording();
    await clients.ec2.send(new DescribeInstancesCommand({}));
    await clients.s3.send(new ListBucketsCommand({}));
    const away = clients.ec2For('eu-west-1');
    expect((await refused(away.send(new DescribeInstancesCommand({})))).message).toBe('the city sends DescribeInstances only to your home Region (us-west-2).');
    await away.send(new DescribeAvailabilityZonesCommand({}));
    await away.send(new DescribeRegionsCommand({}));
    await clients.costExplorer().send(new GetCostAndUsageCommand({ TimePeriod: { Start: '2026-11-01', End: '2026-11-20' }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'] }));
    await clients.cloudwatch().send(new GetMetricDataCommand({ StartTime: new Date(0), EndTime: new Date(300_000), MetricDataQueries: [] }));
    expect(sent.map((s) => [s.op, s.host])).toEqual([
      ['DescribeInstances', `ec2.${HOME}.amazonaws.com`],
      ['GET s3/?x-id', `s3.${HOME}.amazonaws.com`],
      ['DescribeAvailabilityZones', 'ec2.eu-west-1.amazonaws.com'],
      ['DescribeRegions', 'ec2.eu-west-1.amazonaws.com'],
      ['GetCostAndUsage', `ce.${COST_EXPLORER_REGION}.amazonaws.com`],
      ['GetMetricData', `monitoring.${HOME}.amazonaws.com`],
    ]);

    // The same clients, made in the wrong Region, get nothing through.
    const { requestHandler, sent: elsewhere } = recorder();
    const gate = { home: HOME, accountId: () => ACCOUNT };
    const base = { credentials, requestHandler: requestHandler as never };
    await refused(guard(new CostExplorerClient({ ...base, region: HOME }), gate).send(new GetCostAndUsageCommand({ TimePeriod: { Start: '2026-11-01', End: '2026-11-20' }, Granularity: 'MONTHLY', Metrics: ['UnblendedCost'] })));
    await refused(guard(new CloudWatchClient({ ...base, region: 'eu-west-1' }), gate).send(new GetMetricDataCommand({ StartTime: new Date(0), EndTime: new Date(300_000), MetricDataQueries: [] })));
    await refused(guard(new S3Client({ ...base, region: 'eu-west-1' }), gate).send(new ListBucketsCommand({})));
    // A write in another Region is refused even with its grant.
    await refused(granted(actionGrant({ type: 'terminate_instance', instanceId: I_ABC }, ACCOUNT), () => guard(new EC2Client({ ...base, region: 'eu-west-1' }), gate).send(new TerminateInstancesCommand({ InstanceIds: [I_ABC] }))));
    expect(elsewhere).toEqual([]);
  });

  it('through ActionService: approve sends the write; reject or no approval channel sends nothing', async () => {
    const { clients, sent } = recording();
    const service = createActionService({ clients, poller: pollerFor(snapshot([instance(I_ABC, 'running')])), region: HOME });
    expect(await service.submit('terminate_instance', { instanceId: I_ABC })).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    expect(await service.submit('terminate_instance', { instanceId: I_ABC }, { approve: async () => false })).toEqual({ status: 'denied', reason: REJECTED_REASON });
    expect(sent).toEqual([]);
    expect(await service.submit('terminate_instance', { instanceId: I_ABC }, { approve: async () => true })).toMatchObject({ status: 'done' });
    expect(sent.map((s) => s.op)).toEqual(['TerminateInstances']);
    expect(sent[0]!.body).toContain(`InstanceId.1=${I_ABC}`);

    // A launch: the AMI lookup (a read) and the one approved RunInstances.
    expect(await service.submit('launch_instance', { name: 'web', instanceType: 't4g.nano' }, { approve: async () => true })).toMatchObject({ status: 'done' });
    // A bucket: its CreateBucket and PutBucketTagging.
    expect(await service.submit('create_bucket', { suffix: 'photos' }, { approve: async () => true })).toMatchObject({ status: 'done' });
    expect(sent.map((s) => s.op)).toEqual(['TerminateInstances', 'DescribeImages', 'RunInstances', 'PUT aws-city-123456789012-photos/', 'PUT aws-city-123456789012-photos/?tagging']);
    expect(sent[2]!.body).toContain('InstanceType=t4g.nano');
  });

  it("a snapshot naming another account can't steer a write: the player reads the gate's reason", async () => {
    const { clients, sent } = recording();
    const service = createActionService({ clients, poller: pollerFor(snapshot([], { accountId: '999999999999' })), region: HOME });
    const out = await service.submit('create_bucket', { suffix: 'photos' }, { approve: async () => true });
    expect(out).toEqual({ status: 'failed', result: { ok: false, message: "The city's safety gate stopped this: a new warehouse must be named aws-city-<your account>-… and stay in this Region." } });
    expect(sent).toEqual([]);
  });

  it('logs every write decision and every refused read, with no account ids', async () => {
    const info = vi.spyOn(log, 'info');
    const warn = vi.spyOn(log, 'warn');
    const { clients } = recording();
    await clients.ec2.send(new DescribeInstancesCommand({}));
    expect(info).not.toHaveBeenCalled(); // an allowed read isn't logged
    const grant = actionGrant({ type: 'create_bucket', suffix: 'photos' }, ACCOUNT)!;
    await withGrant(grant, () => clients.s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: HOME } })));
    await refused(clients.s3.send(new CreateBucketCommand({ Bucket: BUCKET, CreateBucketConfiguration: { LocationConstraint: HOME } })));
    await refused(clients.ec2For('eu-west-1').send(new DescribeInstancesCommand({})));
    await refused(clients.ec2.send(new RunInstancesCommand(launchInput({ InstanceType: 't3.large' }))));
    expect(info.mock.calls).toEqual([['aws gate', expect.objectContaining({ decision: 'allow', client: 'S3Client', command: 'CreateBucketCommand', kind: 'write', grant: grant.id, reason: 'create_bucket' })]]);
    expect(warn.mock.calls.map(([, f]) => f)).toEqual([
      expect.objectContaining({ decision: 'refuse', command: 'CreateBucketCommand', kind: 'write', grant: 'none', reason: expect.stringContaining('approval') }),
      expect.objectContaining({ decision: 'refuse', command: 'DescribeInstancesCommand', kind: 'read', reason: expect.stringContaining('home Region') }),
      expect.objectContaining({ decision: 'refuse', command: 'RunInstancesCommand', kind: 'write', detail: 'InstanceType:invalid_value' }),
    ]);
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toMatch(/\d{12}/);
    expect(logged).not.toContain('arn:');
  });

  it('every write and fix in the table binds a target, and reads bind none', () => {
    for (const [client, commands] of Object.entries(RULES)) {
      for (const [command, rule] of Object.entries(commands)) {
        if (rule.kind === 'read') expect('wire' in rule, `${client}.${command}`).toBe(false);
        else expect(typeof rule.target, `${client}.${command}`).toBe('function');
      }
    }
  });
});
