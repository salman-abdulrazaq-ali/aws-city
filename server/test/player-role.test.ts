import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { FIXES } from '../src/agents/fixes.js';
import { RULES } from '../src/guard/rules.js';

/**
 * The player role (infra/player-role/player-role.yaml) must allow every AWS call the server makes for a
 * player, and nothing broad. Adding an SDK command without its IAM action fails here, not in production.
 * The template is parsed (YAML, CloudFormation's short tags as plain values), so a comment never counts as a grant.
 */
const template = readFileSync(new URL('../../infra/player-role/player-role.yaml', import.meta.url), 'utf8');
const source = ['../src/state/poller.ts', '../src/state/inventory.ts', '../src/state/bill.ts', '../src/state/flow.ts', '../src/agents/executor.ts', '../src/agents/fixes.ts'].map((f) => readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
/** Every SDK command the server's player-facing code constructs. */
const used = [...new Set([...source.matchAll(/new ([A-Z][A-Za-z0-9]+Command)\(/g)].map((m) => m[1]!))];

/** CloudFormation's short-form intrinsics (!Sub, !Ref, !If…), read as the plain scalar, list or map they hold. */
const INTRINSICS = ['Ref', 'Sub', 'GetAtt', 'If', 'Equals', 'Not', 'And', 'Or', 'Condition', 'Join', 'Select', 'Split', 'FindInMap', 'ImportValue', 'Base64', 'Cidr', 'GetAZs'];
const customTags = INTRINSICS.flatMap((name) => [
  { tag: `!${name}`, resolve: (value: string) => value },
  { tag: `!${name}`, collection: 'seq' as const, resolve: <T>(node: T) => node },
  { tag: `!${name}`, collection: 'map' as const, resolve: <T>(node: T) => node },
]);

interface Statement {
  Sid?: string;
  Effect?: string;
  Action?: string | string[];
  NotAction?: unknown;
  Condition?: Record<string, Record<string, unknown>>;
}
interface Policy {
  PolicyName: string;
  PolicyDocument: { Statement: Statement[] };
}
/** The one statement granting `action` in `policy` (undefined if none or several). */
const statementFor = (policy: Statement[], action: string) => {
  const hits = policy.filter((s) => [s.Action ?? []].flat().includes(action));
  return hits.length === 1 ? hits[0] : undefined;
};

/** What the template grants, read from its parsed policies: each policy's statements and IAM actions. */
const parseRole = (text: string) => {
  const doc = parseDocument(text, { customTags, uniqueKeys: true });
  const problems = [...doc.errors, ...doc.warnings].map((e) => `yaml: ${e.message.split('\n')[0]}`);
  const t = (doc.toJS() ?? {}) as { Resources?: Record<string, { Type?: string; Properties?: Record<string, unknown> }> };
  const role = t.Resources?.PlayerRole?.Properties ?? {};
  const statements: Record<string, Statement[]> = {};
  const conditions: Record<string, unknown> = {};
  for (const item of (role.Policies ?? []) as (Policy | [string, Policy, unknown])[]) {
    // An optional policy is `!If [Condition, policy, !Ref AWS::NoValue]`.
    const [condition, policy, otherwise] = Array.isArray(item) ? item : [undefined, item, 'AWS::NoValue'];
    if (otherwise !== 'AWS::NoValue') problems.push(`${policy.PolicyName}: its !If must otherwise be AWS::NoValue`);
    if (statements[policy.PolicyName]) problems.push(`${policy.PolicyName}: defined twice`);
    statements[policy.PolicyName] = policy.PolicyDocument.Statement;
    conditions[policy.PolicyName] = condition;
  }
  const actionsOf = (name: string) => [...new Set((statements[name] ?? []).flatMap((s) => [s.Action ?? []].flat()))].sort();
  return { t, role, problems, statements, conditions, actionsOf };
};

/** The gate's IAM actions of one kind (server/src/guard/rules.ts). */
const gateIam = (kind: 'read' | 'write' | 'fix') =>
  [...new Set(Object.values(RULES).flatMap((commands) => Object.values(commands).flatMap((rule) => (rule.kind === kind ? [...rule.iam] : []))))].sort();
/** Which gate kind each of the role's policies must match exactly. */
const POLICIES = { 'aws-city-read': 'read', 'aws-city-build': 'write', 'aws-city-fix': 'fix' } as const;

/**
 * Everything wrong with a template, as the role's own words: empty means it grants exactly the gate's read, write and
 * fix actions, each in its own policy, fixes only behind AllowFixes, and nothing else anywhere.
 */
const roleProblems = (text: string): string[] => {
  const { t, role, problems, statements, conditions, actionsOf } = parseRole(text);
  if (Object.keys(t.Resources ?? {}).join() !== 'PlayerRole') problems.push(`resources: ${Object.keys(t.Resources ?? {}).join(', ')} (only PlayerRole)`);
  for (const key of ['ManagedPolicyArns', 'PermissionsBoundary']) if (key in role) problems.push(`PlayerRole has ${key}`);
  if (Object.keys(statements).sort().join() !== Object.keys(POLICIES).sort().join()) problems.push(`policies: ${Object.keys(statements).join(', ')}`);
  for (const [name, kind] of Object.entries(POLICIES)) {
    const got = actionsOf(name);
    const want = gateIam(kind);
    if (got.join() !== want.join()) problems.push(`${name} grants [${got.join(', ')}], the gate's ${kind} actions are [${want.join(', ')}]`);
    if (conditions[name] !== (kind === 'fix' ? 'FixesOn' : undefined)) problems.push(`${name}: condition ${String(conditions[name])}`);
  }
  // No wildcard action and no NotAction anywhere in the template (any resource, any policy, the trust policy too).
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, `${path}[${i}]`));
    else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'NotAction') problems.push(`${path}.NotAction`);
        if (key === 'Action') for (const a of [value].flat()) if (typeof a !== 'string' || a.includes('*')) problems.push(`${path}.Action: ${String(a)}`);
        walk(value, `${path}.${key}`);
      }
    }
  };
  walk(t, 'template');
  return problems;
};

const role = parseRole(template);
/** Every IAM action the role grants anywhere, by policy. */
const granted = Object.keys(POLICIES).flatMap((name) => role.actionsOf(name));
const fixStatements = role.statements['aws-city-fix'] ?? [];

const IAM_FOR: Record<string, string> = {
  DescribeInstancesCommand: 'ec2:DescribeInstances',
  DescribeSecurityGroupsCommand: 'ec2:DescribeSecurityGroups',
  DescribeImagesCommand: 'ec2:DescribeImages',
  RunInstancesCommand: 'ec2:RunInstances',
  StopInstancesCommand: 'ec2:StopInstances',
  StartInstancesCommand: 'ec2:StartInstances',
  TerminateInstancesCommand: 'ec2:TerminateInstances',
  ListTablesCommand: 'dynamodb:ListTables',
  DescribeTableCommand: 'dynamodb:DescribeTable',
  ListTagsOfResourceCommand: 'dynamodb:ListTagsOfResource',
  CreateTableCommand: 'dynamodb:CreateTable',
  DeleteTableCommand: 'dynamodb:DeleteTable',
  ListBucketsCommand: 's3:ListAllMyBuckets',
  CreateBucketCommand: 's3:CreateBucket',
  PutBucketTaggingCommand: 's3:PutBucketTagging',
  DeleteBucketCommand: 's3:DeleteBucket',
  ListFunctionsCommand: 'lambda:ListFunctions',
  DescribeDBInstancesCommand: 'rds:DescribeDBInstances',
  GetApisCommand: 'apigateway:GET',
  // the city's mirror and its Well-Architected checks (read-only)
  DescribeContinuousBackupsCommand: 'dynamodb:DescribeContinuousBackups',
  GetEbsEncryptionByDefaultCommand: 'ec2:GetEbsEncryptionByDefault',
  DescribeSecurityGroupRulesCommand: 'ec2:DescribeSecurityGroupRules',
  DescribeVolumesCommand: 'ec2:DescribeVolumes',
  GetPublicAccessBlockCommand: 's3:GetBucketPublicAccessBlock',
  GetAccountPublicAccessBlockCommand: 's3:GetAccountPublicAccessBlock',
  DescribeTrailsCommand: 'cloudtrail:DescribeTrails',
  GetTrailStatusCommand: 'cloudtrail:GetTrailStatus',
  ListEventDataStoresCommand: 'cloudtrail:ListEventDataStores',
  ListIndexesCommand: 'resource-explorer-2:ListIndexes',
  SearchCommand: 'resource-explorer-2:Search',
  GetResourcesCommand: 'tag:GetResources',
  // v2.5: the real AZ map and Region opt-ins, and the opt-in bill (read-only)
  DescribeAvailabilityZonesCommand: 'ec2:DescribeAvailabilityZones',
  DescribeRegionsCommand: 'ec2:DescribeRegions',
  GetCostAndUsageCommand: 'ce:GetCostAndUsage',
  GetMetricDataCommand: 'cloudwatch:GetMetricData',
  // the citizens' fixes (aws-city-fix, AllowFixes=true only)
  PutPublicAccessBlockCommand: 's3:PutBucketPublicAccessBlock',
  RevokeSecurityGroupIngressCommand: 'ec2:RevokeSecurityGroupIngress',
  ModifyInstanceMetadataOptionsCommand: 'ec2:ModifyInstanceMetadataOptions',
  EnableEbsEncryptionByDefaultCommand: 'ec2:EnableEbsEncryptionByDefault',
  UpdateContinuousBackupsCommand: 'dynamodb:UpdateContinuousBackups',
};

describe('player role template', () => {
  it('parses cleanly, every short tag read as a plain value', () => {
    expect(role.problems).toEqual([]);
    expect(Object.keys(role.statements)).toEqual(['aws-city-read', 'aws-city-build', 'aws-city-fix']);
  });

  it('allows every AWS call the server makes for a player', () => {
    expect(used.length).toBeGreaterThan(10);
    for (const cmd of used) {
      const action = IAM_FOR[cmd];
      expect(action, `${cmd} has no IAM mapping — add it here and to player-role.yaml`).toBeDefined();
      expect(granted, `${action} missing from player-role.yaml's policies`).toContain(action!);
    }
  });

  it('grants nothing broad: no wildcards actions, no IAM, no role passing', () => {
    expect(template).not.toMatch(/Action:\s*['"]?\*/);
    expect(template).not.toMatch(/Action:.*\b\w+:\*/);
    expect(template).not.toMatch(/\biam:[A-Za-z*]/); // no IAM actions (ARNs contain iam::)
    expect(template).not.toMatch(/PassRole/);
    // Trust needs both our role and the player's ExternalId.
    expect(template).toContain("'sts:ExternalId': !Ref ExternalId");
    expect(template).toContain("'aws:PrincipalArn': 'arn:aws:iam::__AWS_CITY_ACCOUNT_ID__:role/__AWS_CITY_TASK_ROLE__'");
    // The trusted account can't be a parameter: a crafted setup link could otherwise trust anyone.
    expect(template).not.toMatch(/Trusted\w*:\s*\n\s*Type:/);
    expect(template).not.toMatch(/\$\{Trusted/);
    // Tiny instances with IMDSv2 only.
    expect(template).toMatch(/'ec2:InstanceType': \[t4g.nano, t4g.micro\]/);
    expect(template).toContain("'ec2:MetadataHttpTokens': required");
    // Encrypted volumes only, and the server asks for one (a launch would otherwise be denied).
    expect(template).toContain("'ec2:Encrypted': 'true'");
    expect(source).toMatch(/Ebs: \{ Encrypted: true \}/);
  });

  it('fixes are opt-in, match fixes.ts exactly, and can only tighten things', () => {
    expect(template).toMatch(/AllowFixes:\s*\n\s*Type: String\s*\n\s*Default: 'false'/);
    expect(template).toContain("FixesOn: !Equals [!Ref AllowFixes, 'true']");
    expect(role.conditions['aws-city-fix']).toBe('FixesOn');
    for (const def of Object.values(FIXES)) {
      expect(role.actionsOf('aws-city-fix'), `${def.iamAction} belongs in aws-city-fix`).toContain(def.iamAction);
      // ...and only there: no fix action is granted unconditionally.
      expect([...role.actionsOf('aws-city-read'), ...role.actionsOf('aws-city-build')], `${def.iamAction} outside aws-city-fix`).not.toContain(def.iamAction);
    }
    // IMDS changes are held to HttpTokens=required by IAM itself.
    expect(statementFor(fixStatements, 'ec2:ModifyInstanceMetadataOptions')?.Condition?.StringEquals?.['ec2:Attribute/HttpTokens']).toBe('required');
    // Nothing that could undo a fix by loosening a setting, anywhere in the role.
    for (const loosen of ['AuthorizeSecurityGroupIngress', 'DisableEbsEncryptionByDefault', 'DeleteBucketPublicAccessBlock', 'DeletePublicAccessBlock']) expect(template).not.toContain(loosen);
  });

  it('CloudWatch: GetMetricData only, in its own Region, and only the fixed queries flow.ts sends', async () => {
    const cw = template.match(/cloudwatch:[A-Za-z*]+/g) ?? [];
    expect([...new Set(cw)]).toEqual(['cloudwatch:GetMetricData']);
    expect(template).toMatch(/Sid: LiveTraffic[\s\S]*?Action: cloudwatch:GetMetricData[\s\S]*?'aws:RequestedRegion': !Ref 'AWS::Region'/);
    const { FLOW_QUERIES } = await import('../src/state/flow.js');
    for (const q of FLOW_QUERIES) expect(q.expression, q.id).toMatch(/^SELECT SUM\(/);
  });

  it("grants exactly the gate's command table (server/src/guard/rules.ts), policy by policy, and no wildcard anywhere", () => {
    expect(roleProblems(template)).toEqual([]);
    // Every guarded command names its IAM actions (GetCallerIdentity needs none).
    for (const [client, commands] of Object.entries(RULES)) {
      for (const [command, rule] of Object.entries(commands)) if (command !== 'GetCallerIdentityCommand') expect(rule.iam.length, `${client}.${command} names no IAM action`).toBeGreaterThan(0);
    }
    expect(Object.values(FIXES).map((d) => d.iamAction).sort()).toEqual(gateIam('fix'));
    // Every command the server sends is in the table, under the IAM action IAM_FOR names, and the table holds nothing IAM_FOR doesn't.
    const rules = Object.entries(RULES).flatMap(([client, commands]) => Object.entries(commands).map(([command, rule]) => ({ name: `${client}.${command}`, command, iam: [...rule.iam] })));
    const ALIASES: Record<string, string> = { GetAccountPublicAccessBlockCommand: 'GetPublicAccessBlockCommand' };
    for (const cmd of used) {
      const hits = rules.filter((r) => r.command === (ALIASES[cmd] ?? cmd) && r.iam.includes(IAM_FOR[cmd]!));
      expect(hits, `${cmd} isn't in the gate's table (server/src/guard/rules.ts)`).toHaveLength(1);
    }
    for (const r of rules) if (r.iam.length) expect(Object.values(IAM_FOR), `${r.name} isn't in IAM_FOR`).toContain(r.iam[0]);
  });

  it("the check isn't fooled: comments, quotes, wildcards, NotAction, a write in the read policy or an extra policy all fail it", () => {
    const stmt = (lines: string) => `              - Sid: X\n                Effect: Allow\n${lines}                Resource: '*'\n`;
    const before = (anchor: string, insert: string) => {
      expect(template, anchor).toContain(anchor);
      return template.replace(anchor, insert + anchor);
    };
    const GAME_BUCKETS = '              - Sid: GameBuckets';
    const mutations: Record<string, string> = {
      'single wildcard': before(GAME_BUCKETS, stmt('                Action: ec2:*\n')),
      'list wildcard': before(GAME_BUCKETS, stmt('                Action:\n                  - iam:*\n')),
      'quoted action': before(GAME_BUCKETS, stmt("                Action: 'iam:PassRole'\n")),
      'quoted list item': before(GAME_BUCKETS, stmt('                Action:\n                  - "s3:PutBucketPolicy"\n')),
      NotAction: before(GAME_BUCKETS, stmt('                NotAction: s3:GetObject\n')),
      'flow-list wildcard': before(GAME_BUCKETS, stmt('                Action: [ec2:*]\n')),
      'a write in the read policy': template.replace('                  - tag:GetResources\n', '                  - tag:GetResources\n                  - ec2:AuthorizeSecurityGroupIngress\n'),
      // An action that's only in a comment is no grant: dropping the real line must fail.
      'ce:GetCostAndUsage only in a comment': template.replace('                Action: ce:GetCostAndUsage\n', '                Action: cloudwatch:GetMetricData\n'),
      'a fix granted unconditionally': before(GAME_BUCKETS, stmt('                Action: ec2:EnableEbsEncryptionByDefault\n')),
      'a managed policy': template.replace('      MaxSessionDuration: 3600\n', '      MaxSessionDuration: 3600\n      ManagedPolicyArns: [arn:aws:iam::aws:policy/ReadOnlyAccess]\n'),
      'another resource': template.replace('\nOutputs:', "\n  Extra:\n    Type: AWS::IAM::Policy\n    Properties: { PolicyName: x, Roles: [!Ref PlayerRole], PolicyDocument: { Statement: [{ Effect: Allow, Action: 's3:GetObject', Resource: '*' }] } }\n\nOutputs:"),
      'an unknown tag': template.replace("FixesOn: !Equals [!Ref AllowFixes, 'true']", "FixesOn: !Bogus [!Ref AllowFixes, 'true']"),
    };
    for (const [name, text] of Object.entries(mutations)) {
      expect(text, `${name}: the mutation didn't apply`).not.toBe(template);
      expect(roleProblems(text), name).not.toEqual([]);
    }
  });

  it('role name matches what account linking expects', async () => {
    const { playerRoleName } = await import('../src/accounts/link.js');
    expect(template).toContain('RoleName: !Sub __AWS_CITY_PLAYER_ROLE__-${AWS::Region}');
    expect(role.role.RoleName).toBe('__AWS_CITY_PLAYER_ROLE__-${AWS::Region}');
    expect(playerRoleName('eu-west-1')).toBe('AWSCityPlayerRole-eu-west-1');
    expect(playerRoleName('eu-west-1', 'AWSCityPlayerRole-staging')).toBe('AWSCityPlayerRole-staging-eu-west-1');
  });
});
