#!/usr/bin/env node
/**
 * Read-only proof of what the installed AWSCityPlayerRole can and can't do, by asking IAM's policy simulator
 * (iam:SimulatePrincipalPolicy). Nothing in the account changes. Organization SCPs are part of the answer.
 *
 *   cd infra && AWS_PROFILE=aws-city node scripts/check-player-role.mjs \
 *     --account 047463438585 --region us-west-2 [--assume arn:aws:iam::047463438585:role/OrganizationAccountAccessRole] [--cleanup]
 *
 * --cleanup: the stack has AllowCleanup=true ("Let the city change things you made", role v6): servers and empty buckets
 * the player made are then allowed too (only this account's, in this Region); everything else stays as without it.
 * --assume: a role in that account allowed to call iam:SimulatePrincipalPolicy (default: the caller's own credentials).
 * Exit code 1 when any line doesn't match what the city relies on.
 */
import { IAMClient, SimulatePrincipalPolicyCommand } from '@aws-sdk/client-iam';
import { fromNodeProviderChain, fromTemporaryCredentials } from '@aws-sdk/credential-providers';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { account: { type: 'string' }, region: { type: 'string', default: 'us-west-2' }, assume: { type: 'string' }, cleanup: { type: 'boolean', default: false } } });
const cleanup = values.cleanup;
const account = values.account;
const region = values.region;
if (!account || !/^\d{12}$/.test(account)) {
  console.error('Usage: node scripts/check-player-role.mjs --account <12 digits> [--region us-west-2] [--assume <role arn>]');
  process.exit(2);
}
const credentials = values.assume
  ? fromTemporaryCredentials({ masterCredentials: fromNodeProviderChain(), params: { RoleArn: values.assume, RoleSessionName: 'aws-city-role-check' } })
  : fromNodeProviderChain();
const iam = new IAMClient({ region: 'us-east-1', credentials });
const role = `arn:aws:iam::${account}:role/AWSCityPlayerRole-${region}`;

const s = (key, value) => ({ ContextKeyName: key, ContextKeyValues: [value], ContextKeyType: 'string' });
const inRegion = (r = region) => s('aws:RequestedRegion', r);
const tagged = s('aws:ResourceTag/managed-by', 'aws-city');
const tagging = s('aws:RequestTag/managed-by', 'aws-city');
const instance = (r = region) => `arn:aws:ec2:${r}:${account}:instance/i-0123456789abcdef0`;
const table = (name) => `arn:aws:dynamodb:${region}:${account}:table/${name}`;
const bucket = (name) => `arn:aws:s3:::${name}`;
const city = `aws-city-${account}-livetest`;
const owned = (a = account) => s('aws:ResourceAccount', a);
/** Allowed only when the stack has AllowCleanup=true. */
const ifCleanup = cleanup ? 'allowed' : 'denied';

/** [what the city relies on, action, resource, context, expected] */
const CASES = [
  ['create a city bucket', 's3:CreateBucket', bucket(city), [inRegion()], 'allowed'],
  ['delete a city bucket', 's3:DeleteBucket', bucket(city), [inRegion()], 'allowed'],
  ['create a city-* table, tagged', 'dynamodb:CreateTable', table('city-livetest'), [inRegion(), tagging], 'allowed'],
  ['delete a city-* table the city tagged', 'dynamodb:DeleteTable', table('city-livetest'), [inRegion(), tagged], 'allowed'],
  ['launch a tagged t4g.nano, IMDSv2', 'ec2:RunInstances', instance(), [inRegion(), s('ec2:InstanceType', 't4g.nano'), s('ec2:MetadataHttpTokens', 'required'), tagging], 'allowed'],
  ['stop a server the city tagged', 'ec2:StopInstances', instance(), [inRegion(), tagged], 'allowed'],
  ['start a server the city tagged', 'ec2:StartInstances', instance(), [inRegion(), tagged], 'allowed'],
  ['terminate a server the city tagged', 'ec2:TerminateInstances', instance(), [inRegion(), tagged], 'allowed'],
  ['create a bucket with any other name', 's3:CreateBucket', bucket('company-backups'), [inRegion()], 'denied'],
  ['delete another account’s city bucket', 's3:DeleteBucket', bucket('aws-city-111122223333-x'), [inRegion(), owned('111122223333')], 'denied'],
  ['create a city bucket in another Region', 's3:CreateBucket', bucket(city), [inRegion('eu-west-1')], 'denied'],
  ['read objects in a city bucket', 's3:GetObject', `${bucket(city)}/photo.jpg`, [inRegion()], 'denied'],
  ['make a city bucket public (bucket policy)', 's3:PutBucketPolicy', bucket(city), [inRegion()], 'denied'],
  ['delete a table without the city- prefix', 'dynamodb:DeleteTable', table('orders'), [inRegion(), tagged], 'denied'],
  ['delete a city-* table the city didn’t tag', 'dynamodb:DeleteTable', table('city-orders'), [inRegion(), s('aws:ResourceTag/managed-by', 'someone-else')], 'denied'],
  ['read items in a city table', 'dynamodb:Scan', table('city-livetest'), [inRegion()], 'denied'],
  ['launch an m5.large', 'ec2:RunInstances', instance(), [inRegion(), s('ec2:InstanceType', 'm5.large'), s('ec2:MetadataHttpTokens', 'required'), tagging], 'denied'],
  ['launch without the city tag', 'ec2:RunInstances', instance(), [inRegion(), s('ec2:InstanceType', 't4g.nano'), s('ec2:MetadataHttpTokens', 'required')], 'denied'],
  ['launch with IMDSv1', 'ec2:RunInstances', instance(), [inRegion(), s('ec2:InstanceType', 't4g.nano'), s('ec2:MetadataHttpTokens', 'optional'), tagging], 'denied'],
  ['launch in another Region', 'ec2:RunInstances', instance('eu-west-1'), [inRegion('eu-west-1'), s('ec2:InstanceType', 't4g.nano'), s('ec2:MetadataHttpTokens', 'required'), tagging], 'denied'],
  ['terminate a server the city didn’t tag (allowed only with AllowCleanup)', 'ec2:TerminateInstances', instance(), [inRegion()], ifCleanup],
  ['stop a server the city didn’t tag (allowed only with AllowCleanup)', 'ec2:StopInstances', instance(), [inRegion()], ifCleanup],
  ['delete a bucket you made (allowed only with AllowCleanup)', 's3:DeleteBucket', bucket('test-demo-livetest'), [inRegion(), owned()], ifCleanup],
  ['delete a bucket you made, in another Region', 's3:DeleteBucket', bucket('test-demo-livetest'), [inRegion('eu-west-1'), owned()], 'denied'],
  ['delete another account’s bucket', 's3:DeleteBucket', bucket('company-backups'), [inRegion(), owned('111122223333')], 'denied'],
  ['terminate a server in another Region', 'ec2:TerminateInstances', instance('eu-west-1'), [inRegion('eu-west-1')], 'denied'],
  ['create an IAM user', 'iam:CreateUser', `arn:aws:iam::${account}:user/x`, [], 'denied'],
  ['attach a policy to a role', 'iam:AttachRolePolicy', `arn:aws:iam::${account}:role/x`, [], 'denied'],
  ['pass a role to a service', 'iam:PassRole', `arn:aws:iam::${account}:role/x`, [], 'denied'],
  ['assume another role', 'sts:AssumeRole', `arn:aws:iam::${account}:role/x`, [], 'denied'],
  ['read a secret', 'secretsmanager:GetSecretValue', `arn:aws:secretsmanager:${region}:${account}:secret:x`, [inRegion()], 'denied'],
  ['decrypt with KMS', 'kms:Decrypt', `arn:aws:kms:${region}:${account}:key/x`, [inRegion()], 'denied'],
  ['create a Lambda function', 'lambda:CreateFunction', `arn:aws:lambda:${region}:${account}:function:x`, [inRegion()], 'denied'],
];

const rows = [];
let failures = 0;
for (const [what, action, resource, context, expected] of CASES) {
  const { EvaluationResults = [] } = await iam.send(
    new SimulatePrincipalPolicyCommand({ PolicySourceArn: role, ActionNames: [action], ResourceArns: [resource], ContextEntries: context }),
  );
  const decision = EvaluationResults[0]?.EvalDecision ?? 'none';
  const actual = decision === 'allowed' ? 'allowed' : 'denied';
  const ok = actual === expected;
  if (!ok) failures++;
  rows.push({ ok: ok ? 'PASS' : 'FAIL', what, action, expected, aws: decision });
}
console.log(`AWS's policy simulator on ${role}:`);
console.table(rows);
console.log(failures ? `${failures} line(s) don't match.` : `All ${rows.length} lines match: the role does what the city needs and nothing more of these.`);
process.exit(failures ? 1 : 0);
