import { readFileSync } from 'node:fs';
import { App, Validations } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { AuthStack } from '../lib/auth-stack.js';
import { BudgetStack } from '../lib/budget-stack.js';
import { type EnvConfig, firefoxRedirectUrl, loadEnv, taskRoleName } from '../lib/config.js';
import { DataStack, PLAYER_ROLE_KEY, playerRoleTemplateVersion } from '../lib/data-stack.js';
import { EdgeStack } from '../lib/edge-stack.js';
import { bedrockWildcards, CPU_MODEL, cpuAiHourly, foundationModel, geoFor, isProfileId, modelsFor, modelsForChoice, NOVA_MODELS } from '../lib/models.js';
import { ServiceStack } from '../lib/service-stack.js';

const env: EnvConfig = {
  name: 'staging', region: 'us-west-2', domainName: 'api.example.com', hostedZoneId: 'Z1', zoneName: 'example.com',
  cognitoDomainPrefix: 'cloud-city-test', extensionIds: ['abcdefghijklmnopabcdefghijklmnop'], googleClientId: 'g.apps.googleusercontent.com',
  sesFromEmail: '', alarmEmail: 'ops@example.com', monthlyBudgetUsd: 50, dailyModelCalls: 100, globalDailyModelCalls: 5000,
  minTasks: 2, maxTasks: 4, models: { main: 'us.anthropic.claude-opus-5-5', light: 'us.anthropic.claude-sonnet-5-5' },
};

const build = (over: Partial<EnvConfig> = {}) => {
  const app = new App();
  const env2 = { ...env, ...over };
  const where = { env: { account: '111122223333', region: env2.region } };
  const data = new DataStack(app, 'D', env2, where);
  const auth = new AuthStack(app, 'A', env2, { ...where, authRelayUrl: data.authRelayUrl });
  const svc = new ServiceStack(app, 'S', env2, { table: data.table, screenshots: data.screenshots, playerRoleTemplateUrl: data.playerRoleTemplateUrl, userPool: auth.userPool, client: auth.client }, where);
  const budget = new BudgetStack(app, 'B', env2, where);
  return { data: Template.fromStack(data), auth: Template.fromStack(auth), svc: Template.fromStack(svc), budget: Template.fromStack(budget) };
};

describe('infrastructure guarantees', () => {
  const t = build();

  it('task role: fixed name, may only assume player roles outside our own account', () => {
    t.svc.hasResourceProperties('AWS::IAM::Role', { RoleName: taskRoleName(env) });
    t.svc.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'AssumePlayerRoles', Action: 'sts:AssumeRole', Resource: 'arn:aws:iam::*:role/AWSCityPlayerRole-staging-*', Condition: { StringNotEquals: { 'aws:ResourceAccount': '111122223333' } } }),
        ]),
      },
    });
    // No broad grants to the task role.
    const json = JSON.stringify(t.svc.findResources('AWS::IAM::Policy'));
    expect(json).not.toMatch(/"Action":"\*"/);
    expect(json).not.toContain('iam:PassRole');
  });

  it('HTTPS load balancer with WAF, access logs and a long idle timeout for WebSockets', () => {
    t.svc.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Protocol: 'HTTPS', Port: 443 });
    t.svc.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    t.svc.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'idle_timeout.timeout_seconds', Value: '300' }, { Key: 'access_logs.s3.enabled', Value: 'true' }]),
    });
    t.svc.hasResourceProperties('AWS::ECS::TaskDefinition', { RuntimePlatform: { CpuArchitecture: 'ARM64' } });
  });

  it('table has point-in-time recovery, TTL and deletion protection; screenshots expire after a day', () => {
    t.data.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      Replicas: Match.arrayWith([Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }, DeletionProtectionEnabled: true })]),
    });
    t.data.hasResourceProperties('AWS::S3::Bucket', { LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 1 })]) } });
  });

  it('prod blocks risky sign-ins (Plus plan, threat protection enforced); staging stays on Essentials', () => {
    const prod = Template.fromStack(new AuthStack(new App(), 'P', { ...env, name: 'prod' }, { env: { account: '111122223333', region: 'us-west-2' } }));
    prod.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTier: 'PLUS', UserPoolAddOns: { AdvancedSecurityMode: 'ENFORCED', AdvancedSecurityAdditionalFlows: { CustomAuthMode: 'ENFORCED' } } });
    prod.hasResourceProperties('AWS::Cognito::UserPoolRiskConfigurationAttachment', {
      AccountTakeoverRiskConfiguration: { Actions: Match.objectLike({ HighAction: { EventAction: 'BLOCK', Notify: false } }) },
    });
    t.auth.hasResourceProperties('AWS::Cognito::UserPool', { UserPoolTier: 'ESSENTIALS' });
    t.auth.resourceCountIs('AWS::Cognito::UserPoolRiskConfigurationAttachment', 0);
  });

  it('the server can check a player has MFA before they link an AWS account', () => {
    t.svc.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Sid: 'CheckPlayerMfa', Action: 'cognito-idp:AdminGetUser' })]) },
    });
    t.auth.hasResourceProperties('AWS::Cognito::UserPoolClient', { AllowedOAuthScopes: Match.arrayWith(['aws.cognito.signin.user.admin']) });
  });

  it('sign-out can revoke refresh tokens, and a new email takes effect only once it is verified', () => {
    t.auth.hasResourceProperties('AWS::Cognito::UserPoolClient', { EnableTokenRevocation: true });
    t.auth.hasResourceProperties('AWS::Cognito::UserPool', { UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] } });
  });

  it('the player table uses our rotated KMS key, and the task role can use it', () => {
    t.data.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    t.data.hasResourceProperties('AWS::DynamoDB::GlobalTable', { SSESpecification: Match.objectLike({ SSEEnabled: true, SSEType: 'KMS' }) });
    t.svc.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: Match.arrayWith(['kms:Decrypt']) })]) },
    });
  });

  it('WAF logs go to aws-waf-logs-* with tokens redacted; no second WAF behind CloudFront', () => {
    t.svc.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
      RedactedFields: [{ SingleHeader: { Name: 'authorization' } }, { SingleHeader: { Name: 'sec-websocket-protocol' } }],
    });
    t.svc.hasResourceProperties('AWS::Logs::LogGroup', { LogGroupName: 'aws-waf-logs-aws-city-staging' });
    const cf = build({ domainName: '', hostedZoneId: '', zoneName: '' });
    cf.svc.resourceCountIs('AWS::WAFv2::WebACL', 0);
  });

  it('the table has daily AWS Backup snapshots on top of PITR, kept 35 days (privacy policy)', () => {
    t.data.resourceCountIs('AWS::Backup::BackupPlan', 1);
    t.data.hasResourceProperties('AWS::Backup::BackupPlan', {
      BackupPlan: Match.objectLike({ BackupPlanRule: [Match.objectLike({ Lifecycle: { DeleteAfterDays: 35 } })] }),
    });
    t.data.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: [Match.objectLike({ PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } })],
    });
    t.data.hasResourceProperties('AWS::Backup::BackupSelection', { BackupSelection: Match.objectLike({ Resources: Match.anyValue() }) });
  });

  it('alarms cover throttling, missing tasks, logged errors and unhandled rejections, and a bad deploy rolls back on the 5xx alarm', () => {
    for (const metric of ['ModelThrottled', 'RunningTaskCount', 'LoggedErrors', 'UnhandledRejections', 'RoleRefusalBreaker']) t.svc.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: metric });
    // server/src/log.ts writes {"level":"error",…} lines; the filter turns them into AWSCity/LoggedErrors.
    t.svc.hasResourceProperties('AWS::Logs::MetricFilter', {
      FilterPattern: '{ $.level = "error" }',
      MetricTransformations: [Match.objectLike({ MetricNamespace: 'AWSCity', MetricName: 'LoggedErrors', MetricValue: '1' })],
    });
    t.svc.hasResourceProperties('AWS::ECS::Service', { DeploymentConfiguration: Match.objectLike({ Alarms: Match.objectLike({ Enable: true, Rollback: true }) }) });
    // One-minute periods: ECS watches a finished deploy for as long as this alarm's settings say (3 × 5 min kept every
    // deploy open ~16 minutes after the new servers were live). 5 a minute is the old 20 in 5 minutes.
    t.svc.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmName: Match.stringLikeRegexp('^aws-city-.+-http5xx$'), MetricName: 'HTTPCode_Target_5XX_Count', Period: 60, EvaluationPeriods: 3, Threshold: 5 });
  });

  it('Firefox and Safari: their sign-in callbacks, server origins and screenshot CORS are added only when enabled', () => {
    const both = build({ firefoxAddonId: 'aws-city@aws-city.dev', safari: true });
    both.auth.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      CallbackURLs: Match.arrayWith(['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/', firefoxRedirectUrl('aws-city@aws-city.dev')]),
    });
    // The Safari relay page (a cross-stack reference to the templates bucket) is a callback too.
    expect(JSON.stringify(both.auth.findResources('AWS::Cognito::UserPoolClient'))).toContain('auth/callback.html');
    both.data.hasResourceProperties('AWS::S3::Bucket', {
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'moz-extension://*', 'safari-web-extension://*'] })] },
    });
    expect(JSON.stringify(both.svc.findResources('AWS::ECS::TaskDefinition'))).toContain('chrome-extension://abcdefghijklmnopabcdefghijklmnop,moz-extension://*,safari-web-extension://*');
    // Chrome only (the default): no wildcard origins anywhere.
    expect(JSON.stringify(t.svc.findResources('AWS::ECS::TaskDefinition'))).not.toContain('moz-extension');
    expect(JSON.stringify(t.auth.findResources('AWS::Cognito::UserPoolClient'))).not.toContain('allizom');
  });

  it('the Firefox redirect rule matches the extension build (scripts/extension-id.mjs)', async () => {
    const script = await import('../../scripts/extension-id.mjs');
    expect(firefoxRedirectUrl(script.FIREFOX_ADDON_ID)).toBe(script.firefoxRedirectUrl());
    // sha1('aws-city@aws-city.dev') — the value Firefox's identity.getRedirectURL() returns for this id.
    expect(firefoxRedirectUrl('aws-city@aws-city.dev')).toMatch(/^https:\/\/[0-9a-f]{40}\.extensions\.allizom\.org\/$/);
  });

  it('the server image is built in AWS during the deploy: no Docker needed on the machine running cdk', () => {
    t.svc.resourceCountIs('Custom::CDKContainerImageBuild', 1);
    t.svc.hasResourceProperties('AWS::CodeBuild::Project', { Environment: Match.objectLike({ Image: Match.stringLikeRegexp('aarch64') }) });
    t.svc.hasResourceProperties('AWS::ECR::Repository', { ImageScanningConfiguration: { ScanOnPush: true }, LifecyclePolicy: Match.anyValue() });
    // Only the last 3 server images are kept (enough to roll back): older ones carry fixed CVEs that nobody runs.
    expect(JSON.stringify(t.svc.findResources('AWS::ECR::Repository'))).toContain('Keep the last 3 server images');
  });

  it('extension client is a public PKCE client with chromiumapp.org callbacks', () => {
    t.auth.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      CallbackURLs: ['https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/'],
      SupportedIdentityProviders: Match.arrayWith(['COGNITO', 'Google']),
    });
  });

  it('budget action cuts off Bedrock automatically at 100%', () => {
    t.budget.hasResourceProperties('AWS::Budgets::BudgetsAction', { ActionType: 'APPLY_IAM_POLICY', ApprovalModel: 'AUTOMATIC', ActionThreshold: { Type: 'PERCENTAGE', Value: 100 } });
    t.budget.hasResourceProperties('AWS::Budgets::Budget', {
      NotificationsWithSubscribers: Match.arrayWith([Match.objectLike({ Notification: Match.objectLike({ NotificationType: 'FORECASTED' }) })]),
    });
  });

  it("each budget counts its environment's tagged resources and untagged spend (Claude on Bedrock), not the other environment's", () => {
    t.budget.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({
        FilterExpression: {
          Or: [
            { And: [{ Tags: { Key: 'app', Values: ['aws-city'], MatchOptions: ['EQUALS'] } }, { Tags: { Key: 'env', Values: [env.name], MatchOptions: ['EQUALS'] } }] },
            { Tags: { Key: 'app', MatchOptions: ['ABSENT'] } },
          ],
        },
      }),
    });
  });

  it('budget cut-off exists even when no alarm e-mail is set', () => {
    const budget = Template.fromStack(new BudgetStack(new App(), 'NoEmail', { ...env, alarmEmail: '' }, { env: { account: '111122223333', region: 'us-west-2' } }));
    budget.resourceCountIs('AWS::Budgets::BudgetsAction', 1);
    budget.resourceCountIs('AWS::SNS::Subscription', 0);
  });
});

describe('no custom domain: CloudFront in front of a private load balancer', () => {
  const t = build({ domainName: '', hostedZoneId: '', zoneName: '' });

  it('Security Hub basics: the server runs as its nonroot user, the VPC default security group allows nothing', () => {
    const server = Object.values(t.svc.findResources('AWS::ECS::TaskDefinition')).find((d) => JSON.stringify(d).includes('"Name":"server"')) as { Properties: { ContainerDefinitions: Record<string, unknown>[] } };
    expect(server.Properties.ContainerDefinitions[0]).toMatchObject({ User: '65532:65532', ReadonlyRootFilesystem: true });
    // restrictDefaultSecurityGroup: CDK's custom resource strips the default group's rules.
    expect(JSON.stringify(t.svc.findResources('Custom::VpcRestrictDefaultSG'))).toContain('DefaultSecurityGroupId');
  });

  it('CloudFront (HTTPS only, no caching) reaches an internal ALB through a VPC origin', () => {
    t.svc.resourceCountIs('AWS::CloudFront::VpcOrigin', 1);
    t.svc.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: 'https-only', AllowedMethods: Match.arrayWith(['POST', 'DELETE']) }) }),
    });
    // AWS's managed SecurityHeadersPolicy (HSTS, nosniff, X-Frame-Options, Referrer-Policy) on every response.
    t.svc.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ DefaultCacheBehavior: Match.objectLike({ ResponseHeadersPolicyId: '67f7725c-6f97-4210-82d7-5512b31e9d03' }) }),
    });
    t.svc.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    // Nothing is open to the internet inbound: only CloudFront's origin-facing prefix list reaches the ALB.
    const inbound = JSON.stringify([
      ...Object.values(t.svc.findResources('AWS::EC2::SecurityGroup')).map((r) => r.Properties?.SecurityGroupIngress ?? []),
      ...Object.values(t.svc.findResources('AWS::EC2::SecurityGroupIngress')),
    ]);
    expect(inbound).not.toContain('0.0.0.0/0');
    t.svc.hasResourceProperties('AWS::EC2::SecurityGroupIngress', { SourcePrefixListId: Match.anyValue(), FromPort: 80, ToPort: 80 });
  });

  it('the server accepts exactly the CloudFront host; per-IP limits run at the edge, never on X-Forwarded-For', () => {
    const task = JSON.stringify(t.svc.findResources('AWS::ECS::TaskDefinition'));
    expect(task).toMatch(/"Name":"PUBLIC_HOSTS","Value":\{"Fn::GetAtt":\["Cdn[0-9A-F]+","DomainName"\]\}/);
    const regional = JSON.stringify(t.svc.findResources('AWS::WAFv2::WebACL'));
    expect(regional).not.toContain('FORWARDED_IP'); // a client could spoof it
    expect(regional).not.toContain('RatePerIp'); // behind CloudFront every source is a CloudFront address
    const app = new App();
    const edge = Template.fromStack(new EdgeStack(app, 'E', env, { env: { account: '111122223333', region: 'us-east-1' } }));
    edge.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'CLOUDFRONT',
      // 2000 per 5 minutes: a classroom behind one NAT address must fit (infra/lib/waf.ts).
      Rules: Match.arrayWith([Match.objectLike({ Name: 'RatePerIp', Statement: { RateBasedStatement: Match.objectLike({ AggregateKeyType: 'IP', Limit: 2000, EvaluationWindowSec: 300 }) } })]),
    });
  });

  it('staging and prod use different role names (one account can host both)', () => {
    t.svc.hasResourceProperties('AWS::IAM::Role', { RoleName: 'AWSCityTaskRole-staging' });
  });
});

describe('Claude inference profiles follow the deploy Region', () => {
  it('maps each geography to its profile prefix and refuses Regions without one (Bedrock model cards, Opus 5 / Sonnet 5)', () => {
    expect(modelsFor('us-west-2')).toEqual({ main: 'us.anthropic.claude-opus-5-5', light: 'us.anthropic.claude-sonnet-5-5' });
    expect(geoFor('ca-central-1')).toBe('us'); // Canada is a source Region of the US profile
    expect(modelsFor('eu-west-2').main).toBe('eu.anthropic.claude-opus-5-5');
    expect(modelsFor('ap-southeast-2').light).toBe('au.anthropic.claude-sonnet-5-5');
    // India has no 5.5 geo profile (Bedrock model cards, 2026-10-12): it keeps Opus 5 / Sonnet 5.
    expect(modelsFor('ap-south-1')).toEqual({ main: 'in.anthropic.claude-opus-5', light: 'in.anthropic.claude-sonnet-5' });
    for (const r of ['ap-northeast-1', 'ap-southeast-1', 'sa-east-1', 'us-gov-west-1', 'eu-west-9']) expect(() => modelsFor(r)).toThrow(/no Bedrock geo inference profile/);
    expect(foundationModel('au.anthropic.claude-opus-5-5')).toBe('anthropic.claude-opus-5-5');
  });

  it('loadEnv derives the models from the Region, and synth fails in a Region without a profile', () => {
    const cfg = { region: 'eu-central-1', cognitoDomainPrefix: 'cloud-city-x', extensionIds: [] };
    expect(loadEnv(new App({ context: { env: 'staging', staging: cfg } })).models.main).toBe('eu.anthropic.claude-opus-5-5');
    expect(() => loadEnv(new App({ context: { env: 'staging', staging: { ...cfg, region: 'ap-northeast-1' } } }))).toThrow(/ap-northeast-1/);
  });

  it("the task role may invoke exactly that geography's profiles and the models behind them", () => {
    const eu = build({ region: 'eu-west-1', models: modelsFor('eu-west-1') });
    eu.svc.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'Bedrock',
            Resource: [
              'arn:aws:bedrock:eu-west-1:111122223333:inference-profile/eu.anthropic.claude-opus-5-5',
              'arn:aws:bedrock:eu-west-1:111122223333:inference-profile/eu.anthropic.claude-sonnet-5-5',
              'arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-5-5*',
              'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-5-5*',
            ],
          }),
        ]),
      },
    });
    const task = JSON.stringify(eu.svc.findResources('AWS::ECS::TaskDefinition'));
    expect(task).toContain('"Name":"AWS_CITY_MODEL","Value":"eu.anthropic.claude-opus-5-5"');
    expect(task).not.toContain('us.anthropic');
  });
});

describe('Amazon Nova: on demand in the deploy Region (Converse, Strands Agents)', () => {
  it('the setup wizard\'s modelChoice picks Nova, in any Region; Claude stays the default', () => {
    const cfg = { region: 'eu-west-2', cognitoDomainPrefix: 'cloud-city-x', extensionIds: [] };
    expect(loadEnv(new App({ context: { env: 'staging', staging: { ...cfg, modelChoice: 'nova' } } })).models).toEqual(NOVA_MODELS);
    expect(loadEnv(new App({ context: { env: 'staging', staging: cfg } })).models.main).toBe('eu.anthropic.claude-opus-5-5');
    // Nova has no geo profile, so a Region Claude can't use doesn't fail synth (the wizard checks Nova answers there).
    expect(loadEnv(new App({ context: { env: 'staging', staging: { ...cfg, region: 'ap-northeast-1', modelChoice: 'nova' } } })).models).toEqual(NOVA_MODELS);
  });

  it('the task role may invoke exactly those two Nova models in its own Region: no wildcard, no profile', () => {
    expect(isProfileId('eu.anthropic.claude-opus-5-5')).toBe(true);
    expect(isProfileId('amazon.nova-pro-v1:0')).toBe(false);
    expect(bedrockWildcards([NOVA_MODELS.main, NOVA_MODELS.light])).toEqual([]);
    const nova = build({ region: 'eu-west-2', modelChoice: 'nova', models: modelsForChoice('eu-west-2', 'nova') });
    nova.svc.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'Bedrock',
            Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            Resource: ['arn:aws:bedrock:eu-west-2::foundation-model/amazon.nova-pro-v1:0', 'arn:aws:bedrock:eu-west-2::foundation-model/amazon.nova-lite-v1:0'],
          }),
        ]),
      },
    });
    const task = JSON.stringify(nova.svc.findResources('AWS::ECS::TaskDefinition'));
    expect(task).toContain('"Name":"AWS_CITY_MODEL","Value":"amazon.nova-pro-v1:0"');
    expect(task).toContain('"Name":"AWS_CITY_LIGHT_MODEL","Value":"amazon.nova-lite-v1:0"');
    expect(task).not.toContain('anthropic');
  });
});

describe('the AI in another Region (a new account whose Bedrock answers elsewhere)', () => {
  const cfg = { region: 'eu-west-2', cognitoDomainPrefix: 'cloud-city-x', extensionIds: [], modelChoice: 'nova' as const };
  it('aiRegion defaults to the deploy Region; novaLiteOnly puts Lite in every slot', () => {
    expect(loadEnv(new App({ context: { env: 'staging', staging: cfg } })).aiRegion).toBe('eu-west-2');
    const away = loadEnv(new App({ context: { env: 'staging', staging: { ...cfg, aiRegion: 'us-west-2', novaLiteOnly: true } } }));
    expect(away).toMatchObject({ region: 'eu-west-2', aiRegion: 'us-west-2', models: { main: NOVA_MODELS.light, light: NOVA_MODELS.light } });
    expect(modelsForChoice('eu-west-2', 'nova', { liteOnly: true })).toEqual({ main: 'amazon.nova-lite-v1:0', light: 'amazon.nova-lite-v1:0' });
    // Claude in another Region takes that Region's geo profile.
    expect(loadEnv(new App({ context: { env: 'staging', staging: { ...cfg, modelChoice: 'claude', aiRegion: 'us-west-2' } } })).models.main).toBe('us.anthropic.claude-opus-5-5');
  });

  it('the task role may invoke exactly Nova Lite in the AI Region (once), and the server is told where to call it', () => {
    const away = build({ region: 'eu-west-2', aiRegion: 'us-west-2', modelChoice: 'nova', novaLiteOnly: true, models: modelsForChoice('us-west-2', 'nova', { liteOnly: true }) });
    away.svc.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'Bedrock', Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'], Resource: 'arn:aws:bedrock:us-west-2::foundation-model/amazon.nova-lite-v1:0' }),
        ]),
      },
    });
    const task = JSON.stringify(away.svc.findResources('AWS::ECS::TaskDefinition'));
    expect(task).toContain('"Name":"AWS_CITY_REGION","Value":"eu-west-2"');
    expect(task).toContain('"Name":"AWS_CITY_BEDROCK_REGION","Value":"us-west-2"');
    expect(task).toContain('"Name":"AWS_CITY_MODEL","Value":"amazon.nova-lite-v1:0"');
    expect(task).not.toContain('nova-pro');
    // Without aiRegion the server calls Bedrock where it runs.
    expect(JSON.stringify(build().svc.findResources('AWS::ECS::TaskDefinition'))).toContain(`"Name":"AWS_CITY_BEDROCK_REGION","Value":"${env.region}"`);
  });
});

describe('the AI on AWS without Bedrock: an open model on a private Fargate service', () => {
  it('runs only when asked: Graviton, 8 vCPU / 16 GB, Spot or on-demand, a private DNS name, no desired count', () => {
    expect(build().svc.findResources('AWS::ServiceDiscovery::PrivateDnsNamespace')).toEqual({});
    const spot = build({ aiCpu: { spot: true }, modelChoice: 'nova', models: modelsForChoice(env.region, 'nova') });
    spot.svc.hasResourceProperties('AWS::ECS::TaskDefinition', { Cpu: String(CPU_MODEL.cpu), Memory: String(CPU_MODEL.memoryMiB), RuntimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' } });
    spot.svc.hasResourceProperties('AWS::ServiceDiscovery::PrivateDnsNamespace', { Name: `awscity-${env.name}.internal` });
    spot.svc.hasResourceProperties('AWS::ServiceDiscovery::Service', { Name: 'ai' });
    const services = Object.values(spot.svc.findResources('AWS::ECS::Service')) as { Properties: Record<string, unknown> }[];
    const ai = services.find((s) => s.Properties.CapacityProviderStrategy);
    expect(ai?.Properties.CapacityProviderStrategy).toEqual([{ CapacityProvider: 'FARGATE_SPOT', Weight: 1 }]);
    // No desired count: `npm run ai -- off` sticks across deploys.
    expect(ai?.Properties.DesiredCount).toBeUndefined();
    const onDemand = build({ aiCpu: { spot: false }, modelChoice: 'nova', models: modelsForChoice(env.region, 'nova') });
    expect(JSON.stringify(onDemand.svc.findResources('AWS::ECS::Service'))).toContain('"CapacityProvider":"FARGATE","Weight":1');
  });

  it('only the city server may reach it, on its one port; the model server has no AWS permissions', () => {
    const t = build({ aiCpu: { spot: true }, modelChoice: 'nova', models: modelsForChoice(env.region, 'nova') });
    const ingress = Object.values(t.svc.findResources('AWS::EC2::SecurityGroupIngress')) as { Properties: Record<string, unknown> }[];
    const toAi = ingress.filter((r) => r.Properties.FromPort === 11434);
    expect(toAi).toHaveLength(1);
    expect(toAi[0].Properties).toMatchObject({ IpProtocol: 'tcp', ToPort: 11434, SourceSecurityGroupId: { 'Fn::GetAtt': [expect.stringMatching(/^ServiceSecurityGroup/), 'GroupId'] } });
    expect(JSON.stringify(toAi)).not.toContain('0.0.0.0/0');
    // Out: HTTPS only (its image from ECR, its logs); never every port.
    const groups = t.svc.findResources('AWS::EC2::SecurityGroup');
    const aiGroup = Object.entries(groups).find(([id]) => id.startsWith('AiSecurityGroup'))?.[1] as { Properties: { SecurityGroupEgress: Record<string, unknown>[] } };
    expect(aiGroup.Properties.SecurityGroupEgress).toEqual([expect.objectContaining({ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' })]);
    // Locked down: not root, read-only root filesystem (only /tmp writable), every capability dropped.
    const aiDef = Object.values(t.svc.findResources('AWS::ECS::TaskDefinition')).find((d) => JSON.stringify(d).includes('"Name":"ai"')) as { Properties: { ContainerDefinitions: Record<string, unknown>[]; Volumes: unknown[] } };
    expect(aiDef.Properties.ContainerDefinitions[0]).toMatchObject({
      User: '65534:65534',
      ReadonlyRootFilesystem: true,
      LinuxParameters: { Capabilities: { Drop: ['ALL'] }, InitProcessEnabled: true },
      MountPoints: [{ ContainerPath: '/tmp', SourceVolume: 'tmp', ReadOnly: false }],
    });
    expect(aiDef.Properties.Volumes).toEqual([{ Name: 'tmp' }]);
    // Its task role carries no policy at all.
    const policies = JSON.stringify(t.svc.findResources('AWS::IAM::Policy'));
    expect(policies).not.toMatch(/AiTaskTaskRole/);
  });

  it('the server is told the private name and the model: Bedrock first behind Nova, the model alone behind Claude', () => {
    const nova = JSON.stringify(build({ aiCpu: { spot: true }, modelChoice: 'nova', models: modelsForChoice(env.region, 'nova') }).svc.findResources('AWS::ECS::TaskDefinition'));
    expect(nova).toContain(`"Name":"AWS_CITY_PRIVATE_DOMAIN","Value":"awscity-${env.name}.internal"`);
    expect(nova).toContain(`"Name":"AWS_CITY_LOCAL_URL","Value":"http://ai.awscity-${env.name}.internal:11434/v1"`);
    expect(nova).toContain(`"Name":"AWS_CITY_LOCAL_MODEL","Value":"${CPU_MODEL.id}"`);
    expect(nova).toContain('"Name":"AWS_CITY_LOCAL_FALLBACK","Value":"true"');
    const claude = JSON.stringify(build({ aiCpu: { spot: true } }).svc.findResources('AWS::ECS::TaskDefinition'));
    expect(claude).toContain('"Name":"AWS_CITY_MODEL_PROVIDER","Value":"local"');
    expect(claude).not.toContain('AWS_CITY_LOCAL_FALLBACK');
    // Bedrock held (setup's `primary`): the model alone, even behind Nova, so each answer is one call and one quota count.
    const held = JSON.stringify(build({ aiCpu: { spot: true, primary: true }, modelChoice: 'nova', models: modelsForChoice(env.region, 'nova') }).svc.findResources('AWS::ECS::TaskDefinition'));
    expect(held).toContain('"Name":"AWS_CITY_MODEL_PROVIDER","Value":"local"');
    expect(held).not.toContain('AWS_CITY_LOCAL_FALLBACK');
    // Without aiCpu, none of it.
    expect(JSON.stringify(build().svc.findResources('AWS::ECS::TaskDefinition'))).not.toContain('AWS_CITY_LOCAL');
  });

  it('the image pins the Ollama release and the exact model weights', () => {
    const dockerfile = readFileSync(new URL('../ai-image/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^FROM ollama\/ollama:[\d.]+@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toContain(`ARG MODEL=${CPU_MODEL.id}`);
    // The whole model is pinned: the registry manifest's own digest and the five files it lists, checked by
    // verify-model.sh on Ollama's content-addressed blobs (infra/test/ai-image.test.ts tests the script).
    expect(dockerfile).toContain(`ARG MODEL_MANIFEST=${CPU_MODEL.manifest}`);
    expect(dockerfile).toContain(`ARG MODEL_DIGESTS="${CPU_MODEL.digests.join(' ')}"`);
    expect(CPU_MODEL.digests).toHaveLength(5);
    expect(dockerfile).toContain('COPY --chmod=0755 verify-model.sh /usr/local/bin/verify-model');
    expect(dockerfile).toContain('verify-model /root/.ollama/models "$MODEL_MANIFEST" $MODEL_DIGESTS &&');
    // It calls nobody: no Ollama cloud, no model-recommendations fetch.
    expect(dockerfile).toContain('OLLAMA_NO_CLOUD=1');
    // The base image's Ubuntu packages are patched at build time, before anything else runs.
    expect(dockerfile.indexOf('apt-get -y upgrade')).toBeGreaterThan(dockerfile.indexOf('FROM ollama/'));
    expect(dockerfile.indexOf('apt-get -y upgrade')).toBeLessThan(dockerfile.indexOf('ollama pull'));
    expect(dockerfile).toMatch(/^USER 65534:65534$/m);
    expect(dockerfile).toContain('OLLAMA_NOPRUNE=1');
    // About $8.72 a day on demand in eu-west-2 (8 vCPU + 16 GB of Graviton Fargate).
    expect(cpuAiHourly() * 24).toBeCloseTo(8.72, 1);
  });
});

describe('SSM parameter names AWS accepts', () => {
  it('no parameter starts with a reserved prefix ("aws" or "ssm", any case), in either environment or model family', () => {
    for (const over of [{}, { name: 'prod' as const }, { region: 'eu-west-2', modelChoice: 'nova' as const, models: modelsForChoice('eu-west-2', 'nova') }]) {
      const t = build(over);
      const names = [t.data, t.auth, t.svc, t.budget].flatMap((x) => Object.values(x.findResources('AWS::SSM::Parameter')).map((r) => String((r as { Properties: { Name?: unknown } }).Properties.Name)));
      expect(names.length).toBeGreaterThan(0);
      for (const n of names) expect(n.replace(/^\//, ''), n).not.toMatch(/^(aws|ssm)/i);
    }
  });
});

describe('deploying before the account\'s Bedrock is ready', () => {
  it('starts the kill switch off when the wizard deploys without AI, and on otherwise', () => {
    build().svc.hasResourceProperties('AWS::SSM::Parameter', { Name: '/cloud-city/staging/ai-enabled', Value: 'true' });
    build({ aiEnabled: false }).svc.hasResourceProperties('AWS::SSM::Parameter', { Name: '/cloud-city/staging/ai-enabled', Value: 'false' });
  });
});

describe('player role template versions', () => {
  it("is published under the template's own version, and old versions are never pruned", () => {
    const yaml = readFileSync(new URL('../player-role/player-role.yaml', import.meta.url), 'utf8');
    const version = Number(/^Description:.*\bv(\d+)\s*$/m.exec(yaml)?.[1]);
    expect(version).toBeGreaterThan(0);
    expect(playerRoleTemplateVersion()).toBe(version);
    expect(PLAYER_ROLE_KEY).toBe(`player-role/v${version}.yaml`);
    expect(() => playerRoleTemplateVersion('Description: no version here')).toThrow(/template version/);
    const t = build();
    t.data.hasResourceProperties('Custom::CDKBucketDeployment', { DestinationBucketKeyPrefix: Match.absent(), Prune: false, RetainOnDelete: Match.absent() });
    t.data.hasOutput('PlayerRoleTemplateUrl', { Value: Match.objectLike({ 'Fn::Join': ['', Match.arrayWith([`/${PLAYER_ROLE_KEY}`])] }) });
    // The server hands players a setup link to that same key.
    expect(JSON.stringify(t.svc.findResources('AWS::ECS::TaskDefinition'))).toContain(`/${PLAYER_ROLE_KEY}`);
  });
});

describe('cdk-nag AwsSolutions (acknowledgements sit on the constructs they are about)', () => {
  const nagSynth = (over: Partial<EnvConfig>, stray = false) => {
    const app = new App();
    const e = { ...env, ...over, models: modelsFor(over.region ?? env.region) };
    // bin/app.ts's stack names, with a concrete account (as when `npm run setup` synthesises with credentials).
    const where = { account: '111122223333', region: e.region };
    const id = (s: string) => `AWSCity-${e.name}-${s}`;
    const data = new DataStack(app, id('Data'), e, { env: where });
    const auth = new AuthStack(app, id('Auth'), e, { env: where, authRelayUrl: data.authRelayUrl });
    const noDomain = !(e.domainName && e.hostedZoneId && e.zoneName);
    const edge = noDomain ? new EdgeStack(app, id('Edge'), e, { env: { account: where.account, region: 'us-east-1' }, crossRegionReferences: true }) : undefined;
    const svc = new ServiceStack(app, id('Service'), e, { ...data, playerRoleTemplateUrl: data.playerRoleTemplateUrl, userPool: auth.userPool, client: auth.client, edgeWebAclArn: edge?.webAclArn }, { env: where, crossRegionReferences: Boolean(edge) });
    new BudgetStack(app, id('Budget'), e, { env: where }).node.addDependency(svc);
    // An unrelated bucket without access logs must still be flagged: no stack-wide S1 acknowledgement.
    if (stray) new s3.Bucket(svc, 'Stray', { enforceSSL: true });
    Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: false }));
    return () => app.synth();
  };

  it.each([
    ['staging, CloudFront + internal ALB', { domainName: '', hostedZoneId: '', zoneName: '' }],
    ['prod, CloudFront + internal ALB', { name: 'prod' as const, domainName: '', hostedZoneId: '', zoneName: '' }],
    ['staging, custom domain + public ALB (eu-west-1)', { region: 'eu-west-1' }],
    ['prod, custom domain + public ALB', { name: 'prod' as const }],
    ['prod with Jev on', { name: 'prod' as const, jev: { secretName: 'aws-city/jev' } }],
    ['staging on Amazon Nova, CloudFront (eu-west-2)', { region: 'eu-west-2', domainName: '', hostedZoneId: '', zoneName: '', modelChoice: 'nova' as const, models: modelsForChoice('eu-west-2', 'nova') }],
    ['prod with the AI on Fargate (Spot), CloudFront (eu-west-2)', { name: 'prod' as const, region: 'eu-west-2', domainName: '', hostedZoneId: '', zoneName: '', aiCpu: { spot: true } }],
  ])('%s synthesises clean', (_name, over) => {
    expect(nagSynth(over)).not.toThrow();
  });

  it('Jev: off by default; when configured, its key reaches the task only as a Secrets Manager secret', () => {
    const off = JSON.stringify(build().svc.findResources('AWS::ECS::TaskDefinition'));
    expect(off).not.toContain('TYPESAFE_API_KEY');
    const on = build({ jev: { secretName: 'aws-city/jev', model: 'jev-1.13.0' } }).svc;
    on.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Secrets: [Match.objectLike({ Name: 'TYPESAFE_API_KEY', ValueFrom: Match.anyValue() })],
          Environment: Match.arrayWith([{ Name: 'AWS_CITY_JEV_MODEL', Value: 'jev-1.13.0' }]),
        }),
      ]),
    });
    // Never as a plain environment variable.
    const env = JSON.stringify(on.findResources('AWS::ECS::TaskDefinition')).match(/"Environment":\[[^\]]*\]/g)?.join('') ?? '';
    expect(env).not.toContain('TYPESAFE_API_KEY');
  });

  it('a new bucket without access logs is still flagged', () => {
    expect(nagSynth({ domainName: '', hostedZoneId: '', zoneName: '' }, true)).toThrow(/Service\/Stray\/Resource[\s\S]*AwsSolutions-S1|AwsSolutions-S1[\s\S]*Service\/Stray/);
  });
});
