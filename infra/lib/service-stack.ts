import { fileURLToPath } from 'node:url';
import { Annotations, CfnOutput, type CfnResource, Duration, IgnoreMode, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cfOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import { ContainerImageBuild } from '@cdklabs/deploy-time-build';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { ack, nagAccount } from './nag.js';
import { logWaf, visibility, wafRules } from './waf.js';
import type { Construct } from 'constructs';
import { type EnvConfig, extensionOrigins, playerRolePrefix, taskRoleName } from './config.js';
import { bedrockResources, bedrockWildcards, CPU_MODEL } from './models.js';

export interface ServiceDeps {
  /** CloudFront-scope WAF from EdgeStack (us-east-1), used when there's no custom domain. */
  edgeWebAclArn?: string;
  table: dynamodb.TableV2;
  screenshots: s3.Bucket;
  playerRoleTemplateUrl: string;
  userPool: cognito.UserPool;
  client: cognito.UserPoolClient;
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * The server on ECS Fargate (ARM64) behind an ALB. WebSockets need long-lived connections and the
 * agent loops wait on player approvals, so this is a container service, not Lambda/API Gateway.
 * Per-socket state stays in the task; shared state is in DynamoDB/S3, so no sticky sessions.
 */
export class ServiceStack extends Stack {
  readonly taskRole: iam.Role;
  readonly killSwitch: ssm.StringParameter;

  constructor(scope: Construct, id: string, env: EnvConfig, deps: ServiceDeps, props?: StackProps) {
    super(scope, id, props);

    // Players pick any region for their own account, so tasks need internet egress: public subnets with
    // a public IP (no NAT cost) and a security group that only accepts the load balancer.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      // The default security group allows nothing (nothing uses it; Security Hub EC2.2).
      restrictDefaultSecurityGroup: true,
      // Explicit AZs: no account lookup needed at synth time (CI synthesises without credentials).
      availabilityZones: [`${env.region}a`, `${env.region}b`],
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        // For the internal load balancer behind CloudFront VPC origins (no route to the internet).
        { name: 'alb', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 }, DynamoDB: { service: ec2.GatewayVpcEndpointAwsService.DYNAMODB } },
      flowLogs: {
        rejected: {
          trafficType: ec2.FlowLogTrafficType.REJECT,
          destination: ec2.FlowLogDestination.toCloudWatchLogs(new logs.LogGroup(this, 'FlowLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY })),
        },
      },
    });

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsightsV2: ecs.ContainerInsights.ENABLED });

    this.killSwitch = new ssm.StringParameter(this, 'AiEnabled', {
      // Not "/aws-city/…": SSM reserves parameter names that start with "aws" or "ssm" (any case), and refuses them at
      // deploy ("No access to reserved parameter name"). "cloud-city" is the name the Cognito domain uses for the same reason.
      parameterName: `/cloud-city/${env.name}/ai-enabled`,
      // Off when the account's Bedrock wasn't ready at deploy time (the setup wizard asks); setup turns it on again.
      stringValue: env.aiEnabled === false ? 'false' : 'true',
      description: 'Set to "false" to switch every AI call off within ~30 s (manual kill switch).',
    });

    // Fixed name + retained: every player's AWSCityPlayerRole trusts exactly this role.
    this.taskRole = new iam.Role(this, 'TaskRole', {
      roleName: taskRoleName(env),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: "AWS City server: Bedrock, its own table and bucket, and assuming players' AWSCityPlayerRole.",
    });
    this.taskRole.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const models = [...new Set([env.models.main, env.models.light])];
    // The AI can run in another Region than the stack (EnvConfig.aiRegion): the grant follows it.
    const aiRegion = env.aiRegion || this.region;
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Bedrock',
        // InvokeModel (Claude) and Converse (Amazon Nova) use the same two actions. A geo inference profile (us./eu./au./
        // in., lib/models.ts) routes to its foundation model in that geography's Regions; Nova is on demand, in this one.
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        resources: bedrockResources(aiRegion, this.account, models),
      }),
    );
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'AssumePlayerRoles',
        actions: ['sts:AssumeRole'],
        resources: [`arn:aws:iam::*:role/${playerRolePrefix(env)}-*`],
        // Never a role in our own account, even if someone creates one with that name here.
        conditions: { StringNotEquals: { 'aws:ResourceAccount': this.account } },
      }),
    );
    deps.table.grantReadWriteData(this.taskRole);
    // Presigned POST is signed by this role (PutObject); the Lookout reads the player's own upload (GetObject).
    this.taskRole.addToPolicy(new iam.PolicyStatement({ sid: 'Screenshots', actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'], resources: [deps.screenshots.arnForObjects('screenshots/*')] }));
    // DELETE /me lists the player's folder to remove their screenshots.
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({ sid: 'ListScreenshots', actions: ['s3:ListBucket'], resources: [deps.screenshots.bucketArn], conditions: { StringLike: { 's3:prefix': 'screenshots/*' } } }),
    );
    this.killSwitch.grantRead(this.taskRole);
    this.taskRole.addToPolicy(new iam.PolicyStatement({ sid: 'DeletePlayer', actions: ['cognito-idp:AdminDeleteUser'], resources: [deps.userPool.userPoolArn] }));
    // Step-up check before linking an AWS account: has this player turned MFA on?
    this.taskRole.addToPolicy(new iam.PolicyStatement({ sid: 'CheckPlayerMfa', actions: ['cognito-idp:AdminGetUser'], resources: [deps.userPool.userPoolArn] }));

    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
    const taskDef = new ecs.FargateTaskDefinition(this, 'Task', {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole: this.taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    // Two ways in:
    //  - a custom domain (Route 53 zone given): a public HTTPS load balancer at api.<domain>;
    //  - no domain: CloudFront (free https://xxxx.cloudfront.net, WebSockets supported) in front of an
    //    INTERNAL load balancer through a CloudFront VPC origin, so nothing is exposed to the internet.
    const https = Boolean(env.domainName && env.hostedZoneId && env.zoneName);
    const zone = https ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: env.hostedZoneId, zoneName: env.zoneName }) : undefined;
    const certificate = zone ? new acm.Certificate(this, 'Cert', { domainName: env.domainName, validation: acm.CertificateValidation.fromDns(zone) }) : undefined;
    let internalAlb: elbv2.ApplicationLoadBalancer | undefined;
    let cdn: cloudfront.Distribution | undefined;
    if (!https) {
      internalAlb = new elbv2.ApplicationLoadBalancer(this, 'InternalAlb', { vpc, internetFacing: false, vpcSubnets: { subnetGroupName: 'alb' } });
      // Only CloudFront's origin-facing addresses may reach it (looked up at deploy time; no synth-time lookup).
      const prefixList = new cr.AwsCustomResource(this, 'CloudFrontPrefixList', {
        onUpdate: {
          service: 'EC2',
          action: 'describeManagedPrefixLists',
          parameters: { Filters: [{ Name: 'prefix-list-name', Values: ['com.amazonaws.global.cloudfront.origin-facing'] }] },
          physicalResourceId: cr.PhysicalResourceId.of('cloudfront-origin-facing'),
          outputPaths: ['PrefixLists.0.PrefixListId'],
        },
        policy: cr.AwsCustomResourcePolicy.fromStatements([new iam.PolicyStatement({ actions: ['ec2:DescribeManagedPrefixLists'], resources: ['*'] })]),
        installLatestAwsSdk: false,
      });
      ack(prefixList, [{ id: 'AwsSolutions-IAM5[Resource::*]', reason: 'ec2:DescribeManagedPrefixLists has no resource-level permissions (deploy-time lookup of the CloudFront prefix list).' }]);
      // AwsCustomResource's shared handler Lambda (one per stack, a stack child).
      const crHandler = this.node.tryFindChild(`AWS${cr.AwsCustomResource.PROVIDER_FUNCTION_UUID.replaceAll('-', '')}`);
      if (!crHandler) throw new Error('AwsCustomResource handler not found: update the cdk-nag acknowledgement below');
      ack(crHandler, [{ id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', reason: "The AwsCustomResource handler Lambda's own CloudWatch logging (AWS-managed basic execution role)." }]);
      internalAlb.connections.allowFrom(ec2.Peer.prefixList(prefixList.getResponseField('PrefixLists.0.PrefixListId')), ec2.Port.tcp(80), 'CloudFront VPC origin');
      const cdnLogs = new s3.Bucket(this, 'CdnLogs', {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // CloudFront standard logs need ACLs
        lifecycleRules: [{ expiration: Duration.days(90) }],
        removalPolicy: RemovalPolicy.RETAIN,
      });
      ack(cdnLogs, [{ id: 'AwsSolutions::AwsSolutions-S1', reason: "CloudFront's standard-log bucket: only CloudFront log delivery writes to it, so its own access logs would only record that delivery." }]);
      cdn = new cloudfront.Distribution(this, 'Cdn', {
        comment: `AWS City ${env.name} API`,
        defaultBehavior: {
          origin: cfOrigins.VpcOrigin.withApplicationLoadBalancer(internalAlb, {
            protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
            httpPort: 80,
            readTimeout: Duration.seconds(60),
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          // Forwards Host, Origin, Authorization and the Sec-WebSocket-* headers (the JWT rides in one).
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          // AWS's managed security headers on every response: HSTS, nosniff, frame and referrer rules (no CORS change).
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
        httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        webAclId: deps.edgeWebAclArn,
        enableLogging: true,
        logBucket: cdnLogs,
        logFilePrefix: 'cdn/',
      });
    }
    if (cdn) {
      ack(cdn, [
        { id: 'AwsSolutions::AwsSolutions-CFR1', reason: 'A learning game for everyone: no geo restriction.' },
        { id: 'AwsSolutions::AwsSolutions-CFR4', reason: 'The free *.cloudfront.net domain uses CloudFront’s certificate, where the minimum TLS version cannot be set; use a custom domain for TLS 1.2+.'.replace('’', "'") },
      ]);
    }
    const publicHost = https ? env.domainName : cdn!.distributionDomainName;

    const origins = extensionOrigins(env);
    if (!origins.length) Annotations.of(this).addWarning('No extension can connect yet: set extensionIds (Chrome), firefoxAddonId or safari (npm run setup).');
    // The server image is built in AWS CodeBuild during the deploy (natively on ARM64), so deploying needs no
    // Docker on your machine or in CI. The pushed image lands in a scan-on-push ECR repository.
    const image = new ContainerImageBuild(this, 'ServerImage', {
      directory: REPO_ROOT,
      file: 'server/Dockerfile',
      platform: ecrAssets.Platform.LINUX_ARM64,
      // Only what server/Dockerfile copies (keeps cdk.out, node_modules and secrets out of the upload).
      ignoreMode: IgnoreMode.DOCKER,
      exclude: ['**', '!server/**', 'server/node_modules', 'server/dist', 'server/.data', 'server/test', '!src/backend/contract.ts', '!src/console/risk.ts', '!src/console/types.ts', '!src/world/**', '!shared/**'],
    });
    // Three are enough to roll back to; older ones (e.g. before the distroless base) carry fixed CVEs that nobody runs.
    (image.repository as ecr.Repository).addLifecycleRule({ description: 'Keep the last 3 server images', maxImageCount: 3 });
    // The construct's shared (singleton) CodeBuild project and trigger Lambda: acknowledged on those constructs only.
    for (const helper of this.node.children.filter((c) => /^(ContainerImageBuild|DeployTimeBuildCustomResourceHandler)/.test(c.node.id))) {
      const project = helper.node.tryFindChild('Resource') as CfnResource | undefined;
      const projectId = project?.cfnResourceType === 'AWS::CodeBuild::Project' ? this.getLogicalId(project) : undefined;
      const isTrigger = helper.node.id.startsWith('DeployTimeBuildCustomResourceHandler');
      ack(helper, [
        ...(isTrigger
          ? [{ id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]', reason: "The image-build trigger Lambda's own CloudWatch logging (AWS-managed basic execution role)." }]
          : [{ id: 'AwsSolutions-IAM5[Resource::*]', reason: 'ecr:GetAuthorizationToken (the build logging in to ECR to push the image) has no resource-level permissions.' }]),
        { id: 'AwsSolutions::AwsSolutions-L1', reason: '@cdklabs/deploy-time-build pins its trigger Lambda runtime (nodejs22.x, supported); it only starts the image build.' },
        { id: 'AwsSolutions::AwsSolutions-CB4', reason: 'The build output is a container image pushed to ECR (encrypted at rest); CodeBuild artifacts are not used.' },
        { id: 'AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonElasticContainerRegistryPublicReadOnly]', reason: 'Pulls public base images from ECR Public during the build (read-only).' },
        ...['s3:GetBucket*', 's3:GetObject*', 's3:List*'].map((a) => ({ id: `AwsSolutions-IAM5[Action::${a}]`, reason: 'Reads the uploaded build context from the CDK asset bucket (Asset.grantRead).' })),
        { id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-${nagAccount(this.account)}-${env.region}/*]`, reason: 'The CDK bootstrap asset bucket holding the build context.' },
        ...(projectId
          ? [
              { id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:logs:${env.region}:${nagAccount(this.account)}:log-group:/aws/codebuild/<${projectId}>:*]`, reason: "The build project's own CloudWatch log streams." },
              { id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:codebuild:${env.region}:${nagAccount(this.account)}:report-group/<${projectId}>-*]`, reason: "The build project's own report groups (CodeBuild default policy)." },
            ]
          : []),
      ]);
    }
    const container = taskDef.addContainer('server', {
      image: image.toEcsDockerImageCode(),
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'server' }),
      stopTimeout: Duration.seconds(120), // SIGTERM → drain (http.drain) → SIGKILL
      readonlyRootFilesystem: true,
      // The distroless image's nonroot user (server/Dockerfile), stated here too so ECS never runs it as root (ECS.20).
      user: '65532:65532',
      environment: {
        AWS_CITY_MODE: 'hosted',
        AWS_CITY_REGION: this.region,
        AWS_CITY_BEDROCK_REGION: aiRegion,
        PUBLIC_HOSTS: publicHost,
        PUBLIC_URL: `https://${publicHost}`,
        EXTENSION_ORIGIN: origins.join(',') || 'chrome-extension://not-configured',
        COGNITO_USER_POOL_ID: deps.userPool.userPoolId,
        COGNITO_CLIENT_ID: deps.client.userPoolClientId,
        TABLE_NAME: deps.table.tableName,
        SCREENSHOT_BUCKET: deps.screenshots.bucketName,
        PLAYER_ROLE_TEMPLATE_URL: deps.playerRoleTemplateUrl,
        SELF_ACCOUNT_ID: this.account,
        TASK_ROLE_NAME: taskRoleName(env),
        PLAYER_ROLE_PREFIX: playerRolePrefix(env),
        KILL_SWITCH_PARAM: this.killSwitch.parameterName,
        DAILY_MODEL_CALLS: String(env.dailyModelCalls),
        GLOBAL_DAILY_MODEL_CALLS: String(env.globalDailyModelCalls),
        AWS_CITY_MODEL: env.models.main,
        AWS_CITY_LIGHT_MODEL: env.models.light,
        AWS_CITY_FALLBACK_MODEL: env.models.light,
        ...(env.jev?.model ? { AWS_CITY_JEV_MODEL: env.jev.model } : {}),
      },
      // The one secret: Jev's API key, only when configured (ECS reads it at task start through the execution role).
      ...(env.jev
        ? { secrets: { TYPESAFE_API_KEY: ecs.Secret.fromSecretsManager(secretsmanager.Secret.fromSecretNameV2(this, 'JevKey', env.jev.secretName), 'apiKey') } }
        : {}),
    });
    container.addPortMappings({ containerPort: 8787 });


    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Service', {
      cluster,
      taskDefinition: taskDef,
      desiredCount: env.minTasks,
      assignPublicIp: true,
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      ...(internalAlb ? { loadBalancer: internalAlb, publicLoadBalancer: false, openListener: false } : { publicLoadBalancer: true }),
      ...(zone && certificate
        ? { domainName: env.domainName, domainZone: zone, certificate, protocol: elbv2.ApplicationProtocol.HTTPS, redirectHTTP: true, sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS }
        : {}),
      idleTimeout: Duration.seconds(300), // above the server's 25 s WebSocket pings
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: Duration.seconds(30),
    });
    service.targetGroup.configureHealthCheck({ path: '/health', healthyHttpCodes: '200', interval: Duration.seconds(15), healthyThresholdCount: 2 });
    service.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '110');
    service.loadBalancer.setAttribute('routing.http.drop_invalid_header_fields.enabled', 'true');

    // ── The city's AI on AWS without Bedrock (EnvConfig.aiCpu) ───────────────────────────────────────────────────────
    // An open model served by Ollama on its own private Fargate service (Graviton, CPU): reachable only from the server's
    // security group, by a private DNS name, never through the load balancer. The server's Strands ModelRouter tries
    // Bedrock first and this model next (Claude, whose routes don't all run on Strands, uses it alone).
    if (env.aiCpu) {
      const namespace = `awscity-${env.name}.internal`;
      cluster.addDefaultCloudMapNamespace({ name: namespace, type: servicediscovery.NamespaceType.DNS_PRIVATE, vpc, useForServiceConnect: false });
      cluster.enableFargateCapacityProviders();
      const aiImage = new ContainerImageBuild(this, 'AiImage', {
        directory: fileURLToPath(new URL('../ai-image', import.meta.url)),
        platform: ecrAssets.Platform.LINUX_ARM64,
      });
      (aiImage.repository as ecr.Repository).addLifecycleRule({ description: 'Keep the last 3 AI images (about 4 GB each)', maxImageCount: 3 });
      const aiLogs = new logs.LogGroup(this, 'AiLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY });
      // No task role: the model server calls no AWS API (the execution role only pulls the image and writes logs).
      const aiTask = new ecs.FargateTaskDefinition(this, 'AiTask', {
        cpu: CPU_MODEL.cpu,
        memoryLimitMiB: CPU_MODEL.memoryMiB,
        // Room for the unpacked image (Ollama + the 2.5 GB model); Fargate's default is 20 GiB.
        ephemeralStorageGiB: 30,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      });
      // Locked down: not root, a read-only root filesystem (only /tmp writable), every Linux capability dropped. Ollama's
      // pull/create/delete endpoints then can't change the model even if something inside the VPC reached them.
      aiTask.addVolume({ name: 'tmp' });
      const aiLinux = new ecs.LinuxParameters(this, 'AiLinux', { initProcessEnabled: true });
      aiLinux.dropCapabilities(ecs.Capability.ALL);
      const aiContainer = aiTask.addContainer('ai', {
        image: aiImage.toEcsDockerImageCode(),
        logging: ecs.LogDrivers.awsLogs({ logGroup: aiLogs, streamPrefix: 'ai' }),
        portMappings: [{ containerPort: 11434 }],
        user: '65534:65534',
        readonlyRootFilesystem: true,
        linuxParameters: aiLinux,
        healthCheck: { command: ['CMD', '/bin/ollama', 'list'], interval: Duration.seconds(30), timeout: Duration.seconds(10), retries: 3, startPeriod: Duration.seconds(60) },
      });
      aiContainer.addMountPoints({ containerPath: '/tmp', sourceVolume: 'tmp', readOnly: false });
      // Its own group: in, only the city server on 11434 (below); out, only HTTPS, which pulling its image from ECR (and
      // S3 for the layers) and writing logs need. The model server itself calls nobody (OLLAMA_NO_CLOUD, Dockerfile), and
      // DNS to the VPC resolver isn't filtered by security groups.
      const aiSg = new ec2.SecurityGroup(this, 'AiSecurityGroup', { vpc, description: 'AWS City AI model server', allowAllOutbound: false });
      aiSg.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS only: ECR image pull and CloudWatch Logs');
      const ai = new ecs.FargateService(this, 'AiService', {
        cluster,
        taskDefinition: aiTask,
        securityGroups: [aiSg],
        // No desiredCount: CloudFormation starts it at 1 and later deploys leave the count alone, so `npm run ai -- off`
        // (desired count 0, no deploy) sticks until `npm run ai -- on`.
        capacityProviderStrategies: [{ capacityProvider: env.aiCpu.spot ? 'FARGATE_SPOT' : 'FARGATE', weight: 1 }],
        // A public address only to pull its image (this VPC has no NAT); its security group lets only the server in.
        assignPublicIp: true,
        vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
        cloudMapOptions: { name: 'ai', dnsRecordType: servicediscovery.DnsRecordType.A, dnsTtl: Duration.seconds(10) },
        circuitBreaker: { rollback: true },
        minHealthyPercent: 100,
        maxHealthyPercent: 200,
      });
      ai.connections.allowFrom(service.service, ec2.Port.tcp(11434), 'The city server asks the AI');
      const claude = /(^|\.)anthropic\./.test(env.models.main);
      // server/src/config.ts: a hosted server may reach a model of its own only at a name in this private namespace.
      container.addEnvironment('AWS_CITY_PRIVATE_DOMAIN', namespace);
      container.addEnvironment('AWS_CITY_LOCAL_URL', `http://ai.${namespace}:11434/v1`);
      container.addEnvironment('AWS_CITY_LOCAL_MODEL', CPU_MODEL.id);
      // Bedrock held (setup's `primary`) or Claude: this model alone. Otherwise behind Nova, as Strands ModelRouter's backup.
      // (Behind a held Bedrock every answer cost two calls: the failed Bedrock try, then this, each counted on the quota.)
      if (claude || env.aiCpu.primary) container.addEnvironment('AWS_CITY_MODEL_PROVIDER', 'local');
      else container.addEnvironment('AWS_CITY_LOCAL_FALLBACK', 'true');
      ack(aiTask, [{ id: 'AwsSolutions-IAM5[Resource::*]', reason: 'ecr:GetAuthorizationToken (pulling the AI image) does not support resource-level permissions.' }]);
      new CfnOutput(this, 'AiCluster', { value: cluster.clusterName, description: 'npm run ai -- on|off|status' });
      new CfnOutput(this, 'AiServiceName', { value: ai.serviceName, description: 'npm run ai -- on|off|status' });
    }
    const albLogs = new s3.Bucket(this, 'AlbLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED, // ALB log delivery requires SSE-S3
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(90) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    service.loadBalancer.logAccessLogs(albLogs, 'alb');
    ack(albLogs, [{ id: 'AwsSolutions::AwsSolutions-S1', reason: "The load balancer's access-log bucket: only ELB log delivery writes to it, so its own access logs would only record that delivery." }]);
    // Internal load balancer (no domain): only CloudFront's prefix list may connect, so EC23 doesn't apply there.
    if (https) ack(service.loadBalancer, [{ id: 'AwsSolutions::AwsSolutions-EC23', reason: 'The public load balancer for api.<domain> accepts 80/443 from the internet by design (80 only redirects to HTTPS); WAF with a per-IP limit sits in front.' }]);

    const scaling = service.service.autoScaleTaskCount({ minCapacity: env.minTasks, maxCapacity: env.maxTasks });
    scaling.scaleOnCpuUtilization('Cpu', { targetUtilizationPercent: 60 });
    scaling.scaleOnMemoryUtilization('Memory', { targetUtilizationPercent: 70 });

    // WAF sees the HTTP requests and WebSocket upgrades; frame-level limits live in the app. A public load
    // balancer gets its own WAF with a per-IP limit. Behind CloudFront the edge WAF (EdgeStack) already
    // filters every request, and the internal load balancer only accepts CloudFront, so a second WAF
    // here would only add cost.
    if (https) {
      const waf = new wafv2.CfnWebACL(this, 'Waf', {
        scope: 'REGIONAL',
        defaultAction: { allow: {} },
        visibilityConfig: visibility(`aws-city-${env.name}`),
        rules: wafRules({ ratePerIp: true }),
      });
      new wafv2.CfnWebACLAssociation(this, 'WafAlb', { resourceArn: service.loadBalancer.loadBalancerArn, webAclArn: waf.attrArn });
      logWaf(this, waf, `aws-city-${env.name}`);
    }

    // ── Alarms ──
    const topic = new sns.Topic(this, 'Alarms', { enforceSSL: true });
    if (env.alarmEmail) topic.addSubscription(new subs.EmailSubscription(env.alarmEmail));
    const alarm = (name: string, metric: cloudwatch.IMetric, threshold: number, periods = 3, alarmName?: string) => {
      const a = new cloudwatch.Alarm(this, name, { alarmName, metric, threshold, evaluationPeriods: periods, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING });
      a.addAlarmAction(new cwActions.SnsAction(topic));
      return a;
    };
    // A fixed name: the service lists this alarm for deploy rollback, and a generated name would make the service
    // depend on an alarm that depends on the service's own load balancer (a deploy-time cycle; the ECS module warns).
    const deploy5xxName = `aws-city-${env.name}-http5xx`;
    // One-minute periods: ECS works out how long to keep watching a finished deploy from this alarm's settings ("based on
    // the alarm configuration", ECS deployment alarms docs), and 3 × 5 minutes held every deploy open ~16 minutes after
    // the new servers were already live. 3 × 1 minute at 5 errors a minute is the same rate as 20 in 5 minutes.
    alarm('Http5xx', service.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(1) }), 5, 3, deploy5xxName);
    alarm('Unhealthy', service.targetGroup.metrics.unhealthyHostCount({ period: Duration.minutes(1) }), 1, 5);
    const app = (name: string) => new cloudwatch.Metric({ namespace: 'AWSCity', metricName: name, statistic: 'Sum', period: Duration.minutes(5) });
    alarm('QuotaRejections', app('QuotaRejected'), 200);
    alarm('GlobalCap', app('GlobalQuotaRejected'), 1, 1);
    alarm('ModelCallSpike', app('ModelCalls'), env.globalDailyModelCalls / 24, 2);
    // Bedrock said "slow down" (429) even after the SDK's retries: players are seeing "the AI is busy".
    alarm('ModelThrottled', app('ModelThrottled'), 10, 2);
    // Every failure the server logs is a JSON line with level "error" (server/src/log.ts; publicError adds the `ref`
    // players quote), WebSocket failures included, which the load balancer's 5xx count never sees.
    const loggedErrors = logGroup
      .addMetricFilter('ErrorLines', { filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'error'), metricNamespace: 'AWSCity', metricName: 'LoggedErrors', metricValue: '1' })
      .metric({ statistic: 'Sum', period: Duration.minutes(5) });
    alarm('LoggedErrors', loggedErrors, 20, 3);
    // A promise nobody handled (server/src/main.ts logs it and keeps serving): always a bug.
    alarm('UnhandledRejections', app('UnhandledRejections'), 1, 1);
    // Several players' roles refused at once (server/src/aws.ts createRefusalBreaker): most likely our task role, not theirs.
    alarm('RoleRefusalBreaker', app('RoleRefusalBreaker'), 1, 1);
    alarm('TableThrottled', deps.table.metricThrottledRequestsForOperations({
        // The operations the server uses (server/src/store/dynamo.ts); an alarm takes at most 10 metrics.
        operations: [dynamodb.Operation.GET_ITEM, dynamodb.Operation.PUT_ITEM, dynamodb.Operation.UPDATE_ITEM, dynamodb.Operation.DELETE_ITEM, dynamodb.Operation.QUERY, dynamodb.Operation.BATCH_WRITE_ITEM],
        period: Duration.minutes(5),
      }), 10, 2);
    // Fewer tasks than the minimum for 10 minutes: capacity or a crash loop (Container Insights).
    new cloudwatch.Metric({
      namespace: 'ECS/ContainerInsights',
      metricName: 'RunningTaskCount',
      dimensionsMap: { ClusterName: cluster.clusterName, ServiceName: service.service.serviceName },
      statistic: 'Minimum',
      period: Duration.minutes(5),
    })
      .createAlarm(this, 'TasksBelowMinimum', { threshold: env.minTasks, comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD, evaluationPeriods: 2, treatMissingData: cloudwatch.TreatMissingData.BREACHING })
      .addAlarmAction(new cwActions.SnsAction(topic));
    // A deploy that makes the 5xx alarm fire is rolled back automatically (on top of the circuit breaker).
    service.service.enableDeploymentAlarms([deploy5xxName], { behavior: ecs.AlarmBehavior.ROLLBACK_ON_ALARM });

    new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `aws-city-${env.name}`,
      widgets: [
        [
          new cloudwatch.GraphWidget({ title: 'Model calls / quota', left: [app('ModelCalls'), app('QuotaRejected'), app('GlobalQuotaRejected')] }),
          new cloudwatch.GraphWidget({ title: 'ALB', left: [service.loadBalancer.metrics.activeConnectionCount(), service.loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT)] }),
          new cloudwatch.GraphWidget({ title: 'Service', left: [service.service.metricCpuUtilization(), service.service.metricMemoryUtilization()] }),
        ],
        [
          new cloudwatch.GraphWidget({ title: 'Errors', left: [loggedErrors, app('UnhandledRejections')] }),
          new cloudwatch.GraphWidget({ title: 'Model throttles / refusals', left: [app('ModelThrottled'), app('Refusals')] }),
          new cloudwatch.GraphWidget({ title: 'Tokens', left: [app('InputTokens'), app('OutputTokens'), app('CacheReadTokens')] }),
        ],
      ],
    });

    const apiUrl = `https://${publicHost}`;
    new CfnOutput(this, 'ApiUrl', { value: apiUrl });
    new CfnOutput(this, 'WsUrl', { value: apiUrl.replace(/^http/, 'ws') + '/ws' });
    new CfnOutput(this, 'KillSwitchParam', { value: this.killSwitch.parameterName });

    const IAM5 = 'AwsSolutions-IAM5';
    ack(this.taskRole, [
      { id: `${IAM5}[Resource::arn:aws:iam::*:role/${playerRolePrefix(env)}-*]`, reason: "Player roles live in every player's own account; our own account is excluded by an aws:ResourceAccount condition." },
      ...bedrockWildcards(models).map((arn) => ({ id: `${IAM5}[Resource::${arn}]`, reason: "The geo inference profile routes to this model in several of its geography's Regions." })),
      { id: `${IAM5}[Resource::AWSCity-${env.name}-Data:ExportsOutputFnGetAttScreenshotsA7A7D8A0Arn0675524A/screenshots/*]`, reason: 'Objects under the screenshots/ prefix only (one folder per player).' },
      // TableV2.grantReadWriteData on a customer-managed key: the wildcards are action families, on that one key.
      { id: `${IAM5}[Action::kms:ReEncrypt*]`, reason: 'Table data-key operations on the single table key (CDK grantReadWriteData).' },
      { id: `${IAM5}[Action::kms:GenerateDataKey*]`, reason: 'Table data-key operations on the single table key (CDK grantReadWriteData).' },
    ]);
    ack(taskDef, [
      { id: `${IAM5}[Resource::*]`, reason: 'ecr:GetAuthorizationToken does not support resource-level permissions.' },
      { id: 'AwsSolutions::AwsSolutions-ECS2', reason: 'Only non-secret configuration is passed as environment variables; the one optional secret (the Jev API key) comes from Secrets Manager through `secrets`.' },
    ]);
    ack(this, [
      { id: 'Construct-Annotations::@aws-cdk/core:crossStackReferencesDefaultStrong', reason: 'Strong cross-stack references are intended (Data/Auth outlive Service).' },
    ]);
  }
}
