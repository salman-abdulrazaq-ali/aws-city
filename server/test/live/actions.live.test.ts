/**
 * Every agent write, for real, against a test AWS account: the same ActionService, policy and executor the city uses,
 * auto-approved, each checked in AWS afterwards. Skipped unless AWS_CITY_LIVE_ROLE_ARN is set, so CI never runs it.
 *
 *   AWS_PROFILE=aws-city AWS_CITY_LIVE_ROLE_ARN=arn:aws:iam::<test account>:role/<role> \
 *     npx vitest run test/live/actions.live.test.ts --silent=false
 *
 * --silent=false prints the step table and the audit lines (this setup hides a passing test's console output).
 * Optional: AWS_CITY_LIVE_REGION (default us-west-2), AWS_CITY_LIVE_EXTERNAL_ID (for a role that needs one).
 * Cost: one t4g.nano for about 3 minutes, an empty bucket and an empty on-demand table (well under $0.01).
 * Everything it makes is named "livetest" and is removed at the end, even when a step fails.
 */
import { randomBytes } from 'node:crypto';
import { DeleteTableCommand, DescribeTableCommand, ListTablesCommand, waitUntilTableExists, waitUntilTableNotExists } from '@aws-sdk/client-dynamodb';
import { DescribeInstancesCommand, TerminateInstancesCommand, waitUntilInstanceRunning, waitUntilInstanceStopped, waitUntilInstanceTerminated } from '@aws-sdk/client-ec2';
import { DeleteBucketCommand, GetBucketTaggingCommand, HeadBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3';
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuditEntry, createActionService, NEEDS_APPROVAL_REASON, type SubmitOutcome } from '../../src/agents/service.js';
import { clientsFor } from '../../src/aws.js';
import { bucketPrefix, GAME_TAG } from '../../src/state/model.js';
import { createPoller } from '../../src/state/poller.js';

const ROLE = process.env.AWS_CITY_LIVE_ROLE_ARN;
const REGION = process.env.AWS_CITY_LIVE_REGION ?? 'us-west-2';
const ACCOUNT = ROLE?.split(':')[4] ?? '';
const RUN = randomBytes(3).toString('hex');
const WAIT = { maxWaitTime: 300, minDelay: 5, maxDelay: 15 };

/** One row per step: what was asked, what the city answered, what AWS shows. Printed at the end. */
const rows: { step: string; outcome: string; aws: string }[] = [];

describe.skipIf(!ROLE)(`every agent write, for real (${ACCOUNT} · ${REGION})`, { timeout: 600_000 }, () => {
  const credentials = fromTemporaryCredentials({
    masterCredentials: fromNodeProviderChain(),
    clientConfig: { region: REGION },
    params: { RoleArn: ROLE!, RoleSessionName: `aws-city-livetest-${RUN}`, DurationSeconds: 3600, ...(process.env.AWS_CITY_LIVE_EXTERNAL_ID ? { ExternalId: process.env.AWS_CITY_LIVE_EXTERNAL_ID } : {}) },
  });
  const clients = clientsFor({ region: REGION, credentials });
  const poller = createPoller({ clients, accountId: ACCOUNT, region: REGION, intervalMs: 3_600_000, onSnapshot: () => undefined });
  const audit: AuditEntry[] = [];
  const service = createActionService({ clients, poller, region: REGION, audit: (e) => audit.push(e) });
  const approve = async () => true;
  const submit = async (step: string, name: string, input: Record<string, unknown>, opts: { approve?: typeof approve } = { approve }) => {
    await poller.refresh(); // policy reads the account as it is now (a just-made resource, its new state)
    const outcome = await service.submit(name, input, opts);
    return { outcome, row: (aws: string) => rows.push({ step, outcome: said(outcome), aws }) };
  };
  const said = (o: SubmitOutcome) => (o.status === 'done' || o.status === 'failed' ? `${o.status}: ${o.result.message}` : o.status === 'denied' ? `denied: ${o.reason}` : `invalid: ${o.error}`);

  const bucket = `livetest-${RUN}`;
  const bucketName = bucketPrefix(ACCOUNT) + bucket;
  const table = `city-livetest-${RUN}`;
  const server = `livetest-${RUN}`;
  let instanceId = '';

  beforeAll(async () => {
    await poller.refresh();
  });

  afterAll(async () => {
    // Anything named livetest, from this run or an earlier one that stopped half-way.
    const leftovers: string[] = [];
    const { Buckets = [] } = await clients.s3.send(new ListBucketsCommand({ Prefix: `${bucketPrefix(ACCOUNT)}livetest-` })).catch(() => ({ Buckets: [] }));
    for (const b of Buckets) await clients.s3.send(new DeleteBucketCommand({ Bucket: b.Name })).then(() => leftovers.push(`bucket ${b.Name}`), () => undefined);
    const { TableNames = [] } = await clients.dynamodb.send(new ListTablesCommand({ ExclusiveStartTableName: 'city-livetest-', Limit: 100 })).catch(() => ({ TableNames: [] }));
    for (const t of TableNames.filter((n) => n.startsWith('city-livetest-'))) {
      await clients.dynamodb.send(new DeleteTableCommand({ TableName: t })).then(() => leftovers.push(`table ${t}`), () => undefined);
    }
    const { Reservations = [] } = await clients.ec2
      .send(new DescribeInstancesCommand({ Filters: [{ Name: 'tag:Name', Values: ['livetest-*'] }, { Name: 'instance-state-name', Values: ['pending', 'running', 'stopping', 'stopped'] }] }))
      .catch(() => ({ Reservations: [] }));
    const ids = Reservations.flatMap((r) => r.Instances ?? []).flatMap((i) => (i.InstanceId ? [i.InstanceId] : []));
    if (ids.length) await clients.ec2.send(new TerminateInstancesCommand({ InstanceIds: ids })).then(() => leftovers.push(...ids.map((id) => `instance ${id}`)), () => undefined);
    console.table(rows);
    console.log(leftovers.length ? `Cleaned up: ${leftovers.join(', ')}` : 'Nothing left over.');
    console.log('Audit lines:', JSON.stringify(audit));
  });

  it('refuses, with no AWS write: not the city’s, invalid input, a larger instance, no Approve button', async () => {
    const notOurs = await submit('delete a bucket the city didn’t build', 'delete_bucket', { name: `${bucketPrefix(ACCOUNT)}not-ours-${RUN}` });
    expect(notOurs.outcome.status).toBe('denied');
    notOurs.row('no call made');
    const notOursServer = await submit('stop a server the city didn’t build', 'stop_instance', { instanceId: 'i-0000000000000dead' });
    expect(notOursServer.outcome.status).toBe('denied');
    notOursServer.row('no call made');
    const big = await submit('launch an m5.large', 'launch_instance', { name: server, instanceType: 'm5.large' });
    expect(big.outcome.status).toBe('invalid');
    big.row('no call made');
    const badName = await submit('a bucket name that is too short', 'create_bucket', { suffix: 'ab' });
    expect(badName.outcome.status).toBe('invalid');
    badName.row('no call made');
    const noButton = await submit('create a table with no Approve button', 'create_table', { name: table }, {});
    expect(noButton.outcome).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    noButton.row('no call made');
  });

  it('a bucket: create (tagged as the city’s), then delete', async () => {
    const made = await submit('create_bucket', 'create_bucket', { suffix: bucket });
    expect(made.outcome.status).toBe('done');
    await clients.s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    const { TagSet = [] } = await clients.s3.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
    expect(TagSet).toContainEqual({ Key: GAME_TAG.key, Value: GAME_TAG.value });
    made.row(`HeadBucket ${bucketName}: exists, tagged ${GAME_TAG.key}=${GAME_TAG.value}`);

    const gone = await submit('delete_bucket', 'delete_bucket', { name: bucketName });
    expect(gone.outcome.status).toBe('done');
    await expect(clients.s3.send(new HeadBucketCommand({ Bucket: bucketName }))).rejects.toThrow();
    gone.row(`HeadBucket ${bucketName}: not found`);
  });

  it('a table: create, ACTIVE, then delete', async () => {
    const made = await submit('create_table', 'create_table', { name: table });
    expect(made.outcome.status).toBe('done');
    await waitUntilTableExists({ client: clients.dynamodb, ...WAIT }, { TableName: table });
    const { Table } = await clients.dynamodb.send(new DescribeTableCommand({ TableName: table }));
    expect(Table?.TableStatus).toBe('ACTIVE');
    made.row(`DescribeTable ${table}: ${Table?.TableStatus}, ${Table?.BillingModeSummary?.BillingMode ?? 'PAY_PER_REQUEST'}`);

    const gone = await submit('delete_table', 'delete_table', { name: table });
    expect(gone.outcome.status).toBe('done');
    await waitUntilTableNotExists({ client: clients.dynamodb, ...WAIT }, { TableName: table });
    gone.row(`DescribeTable ${table}: not found`);
  });

  it('a t4g.nano: launch, stop, start, terminate', async () => {
    const made = await submit('launch_instance', 'launch_instance', { name: server, instanceType: 't4g.nano' });
    expect(made.outcome.status, JSON.stringify(made.outcome)).toBe('done');
    instanceId = made.outcome.status === 'done' ? (made.outcome.result.resourceId ?? '') : '';
    await waitUntilInstanceRunning({ client: clients.ec2, ...WAIT }, { InstanceIds: [instanceId] });
    made.row(`DescribeInstances ${instanceId}: running`);

    const stopped = await submit('stop_instance', 'stop_instance', { instanceId });
    expect(stopped.outcome.status).toBe('done');
    await waitUntilInstanceStopped({ client: clients.ec2, ...WAIT }, { InstanceIds: [instanceId] });
    stopped.row(`DescribeInstances ${instanceId}: stopped`);

    const started = await submit('start_instance', 'start_instance', { instanceId });
    expect(started.outcome.status).toBe('done');
    await waitUntilInstanceRunning({ client: clients.ec2, ...WAIT }, { InstanceIds: [instanceId] });
    started.row(`DescribeInstances ${instanceId}: running`);

    const gone = await submit('terminate_instance', 'terminate_instance', { instanceId });
    expect(gone.outcome.status).toBe('done');
    await waitUntilInstanceTerminated({ client: clients.ec2, ...WAIT }, { InstanceIds: [instanceId] });
    gone.row(`DescribeInstances ${instanceId}: terminated`);
  });

  it('wrote one audit line per write asked for', () => {
    expect(audit.map((e) => e.outcome)).not.toContain(undefined);
    expect(audit.filter((e) => e.outcome === 'done').map((e) => e.action)).toEqual(
      expect.arrayContaining(['create_bucket', 'delete_bucket', 'create_table', 'delete_table', 'launch_instance', 'stop_instance', 'start_instance', 'terminate_instance']),
    );
  });
});
