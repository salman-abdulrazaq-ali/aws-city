#!/usr/bin/env node
// AWS City one-shot setup: `npm run setup` from the repo root.
//
// Asks only what a person has to decide, checks everything it can against your AWS account, then
// deploys the whole stack (CDK), smoke-tests it and builds the Chrome extension for it. It asks
// before every change to AWS, keeps secrets out of files and logs, and is safe to run again.
//
//   npm run setup                         interactive
//   npm run setup -- --dry-run            ask + check and write aws-city.config.json; changes nothing in AWS
//   npm run setup -- --yes --env staging  non-interactive: reuse aws-city.config.json (CI)
//   npm run setup -- --destroy --env staging
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { CloudFormationClient, DescribeStackEventsCommand, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { FreeTierClient, GetAccountPlanStateCommand } from '@aws-sdk/client-freetier';
import { CognitoIdentityProviderClient, DescribeUserPoolDomainCommand } from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { ListHostedZonesCommand, Route53Client } from '@aws-sdk/client-route-53';
import { CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CreateEmailIdentityCommand, DeleteEmailIdentityCommand, GetAccountCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { explainAwsError, listProfiles, pickProfile, profileRegion } from '../../scripts/launcher/lib.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INFRA = fileURLToPath(new URL('../', import.meta.url));
const CONFIG = `${ROOT}aws-city.config.json`;
// Claude's inference-profile ids follow the Region (us./eu./au./in.): one table for the wizard and the CDK app.
const { CPU_MODEL, FARGATE_ARM_PRICE, NOVA_MODELS, SUPPORTED_REGIONS, cpuAiHourly, geoFor, modelsForChoice, unsupportedRegionMessage } = await import(new URL('../lib/models.ts', import.meta.url));
// The review screen's text (pure, tested in test/review.test.ts).
const { cloudFrontNote, isFreeMail, plannedActions, reviewRows, reviewText } = await import(new URL('../lib/review.ts', import.meta.url));
const { progressLine } = await import(new URL('../lib/deploy-progress.ts', import.meta.url));
const GOOGLE_SECRET = 'aws-city/google-oauth';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const DRY = flag('--dry-run');
/** The step-by-step guide for a new account (root MFA, the Paid plan, an admin user, models, Bedrock's new-account hold). */
const GUIDE = 'https://github.com/salman-abdulrazaq-ali/aws-city/blob/main/docs/self-hosting.md';
const YES = flag('--yes');

const saved = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
const { DEV_EXTENSION_ID, FIREFOX_ADDON_ID } = await import(new URL('../../scripts/extension-id.mjs', import.meta.url));

const bye = (msg = 'Stopped. Nothing else was changed.') => {
  p.cancel(msg);
  process.exit(1);
};
/** Ask, or reuse the saved answer with --yes. */
const ask = async (kind, o, savedValue) => {
  if (YES && savedValue !== undefined) return savedValue;
  if (YES) bye(`--yes needs "${o.message}" in aws-city.config.json`);
  const v = await p[kind](o);
  if (p.isCancel(v)) bye();
  return v;
};
const run = (cmd, argv, cwd = ROOT, env = {}) => {
  const r = spawnSync(cmd, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  if (r.status !== 0) bye(`${cmd} ${argv.join(' ')} failed (exit ${r.status}). Fix the error above and run setup again — it picks up where it left off.`);
};
/** Like `run`, without blocking: the deploy's progress line keeps ticking while cdk works. */
const runAsync = async (cmd, argv, cwd = ROOT, env = {}) => {
  const code = await new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  if (code !== 0) bye(`${cmd} ${argv.join(' ')} failed (exit ${code}). Fix the error above and run setup again — it picks up where it left off.`);
};
const approve = async (what) => {
  if (DRY) {
    p.log.info(`[dry run] would ${what}`);
    return false;
  }
  if (YES) return true;
  return ask('confirm', { message: `OK to ${what}?`, initialValue: true });
};

const { printBanner } = await import(new URL('../../scripts/launcher/banner.mjs', import.meta.url));
printBanner();
p.intro(' AWS City setup ');
p.note(
  [
    'This deploys AWS City into YOUR AWS account:',
    '  CloudFront/ALB → ECS Fargate server → DynamoDB, S3, Amazon Bedrock (Amazon Nova or Claude), Cognito sign-in.',
    'Rough cost while idle: prod ~$60–85/month (2 small Fargate tasks, load balancer, WAF, logs);',
    'staging ~$45–60/month (1 task). Check the AWS Pricing Calculator for your region.',
    'The AI on Bedrock is pay-per-use and capped by a daily quota + a budget kill switch.',
    'The server image is built for you in AWS CodeBuild (a few cents per deploy): no Docker needed.',
    'You can remove everything later with: npm run setup -- --destroy',
  ].join('\n'),
  'What this does',
);

// ── 1. Preflight ─────────────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 24) bye(`Node ${process.versions.node} is too old: install Node 24 or newer (https://nodejs.org).`);
// No Docker needed: the server image is built in AWS CodeBuild during the deploy (infra/lib/service-stack.ts).

// Your sign-in: AWS_PROFILE, else the profile AWS City's own tools use (the launcher's pickProfile: AWS_CITY_PROFILE,
// aws-city from `aws login --profile aws-city`, workshop, default). Exported, so cdk and every child process sign in the
// same way. Keys in the environment (CI) win, and then no profile is picked.
const awsFile = (name) => {
  try {
    return readFileSync(path.join(homedir(), '.aws', name), 'utf8');
  } catch {
    return '';
  }
};
const awsConfigText = awsFile('config');
const profiles = listProfiles(awsFile('credentials'), awsConfigText);
let profile = process.env.AWS_PROFILE ?? (process.env.AWS_ACCESS_KEY_ID ? undefined : pickProfile(profiles));
if (profile) process.env.AWS_PROFILE = profile;

// Staging first (a test copy; docs/self-hosting.md), prod one arrow away.
const envName = opt('--env') ?? (await ask('select', { message: 'Which environment?', options: [{ value: 'staging', label: 'staging', hint: 'a test copy: start here' }, { value: 'prod', label: 'prod', hint: 'the real one players use' }], initialValue: saved.lastEnv ?? 'staging' }, saved.lastEnv));
const prev = saved[envName] ?? {};

// The agents' models (infra/lib/models.ts): Amazon Nova, on demand in the Region and run on Strands Agents' Bedrock model,
// or Claude through a geo inference profile. A saved answer from before this question existed (--yes) keeps Claude.
const modelChoice = await ask(
  'select',
  {
    message: 'Which AI models should the city’s agents run on?',
    options: [
      { value: 'nova', label: 'Amazon Nova (recommended)', hint: 'Amazon’s own models: the lowest cost, billed like any AWS service' },
      { value: 'claude', label: 'Claude', hint: 'Anthropic’s models on Bedrock: needs the one-time use-case form and the Paid plan' },
    ],
    initialValue: prev.modelChoice ?? 'nova',
  },
  prev.modelChoice ?? (YES ? 'claude' : undefined),
);
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;
// Claude needs a Region with a Bedrock geo inference profile; Nova is checked by calling it there (step 2).
const region = await ask(
  'text',
  {
    message: 'AWS Region to deploy in',
    placeholder: 'eu-west-2',
    // A saved answer, then AWS_REGION, then the Region your profile was set up with (aws login asks for it).
    initialValue: prev.region ?? process.env.AWS_REGION ?? profileRegion(awsConfigText, profile ?? 'default') ?? 'us-west-2',
    validate: (v) => (!REGION_RE.test(v ?? '') ? 'an AWS Region, e.g. eu-west-2' : modelChoice === 'nova' || geoFor(v) ? undefined : `Claude needs one of: ${SUPPORTED_REGIONS.join(', ')}`),
  },
  prev.region,
);
if (modelChoice === 'claude' && !geoFor(region)) bye(unsupportedRegionMessage(region)); // a saved --yes answer skips validate
const { main: MAIN_MODEL, light: LIGHT_MODEL } = modelsForChoice(region, modelChoice);
const MODELS = [MAIN_MODEL, LIGHT_MODEL];
let credentials = fromNodeProviderChain({ profile: process.env.AWS_PROFILE });
const aws = (C) => new C({ region, credentials });

// Not signed in, or an `aws login` session that ran out (they expire): sign in from here, in the browser, and carry on
// with the answers already given. The same sign-in the launcher offers (scripts/start.mjs connectAws). CI (--yes), keys
// in the environment and runs without a terminal can't open a browser sign-in, so they stop with the commands instead.
const SIGN_IN_PROFILE = 'aws-city';
const s = p.spinner();
let account;
for (;;) {
  s.start('Checking your AWS sign-in');
  try {
    const id = await aws(STSClient).send(new GetCallerIdentityCommand({}));
    account = id.Account;
    s.stop(`Signed in to AWS account ${account} as ${id.Arn?.split(':').pop()}${profile ? ` (profile ${profile})` : ''}`);
    // Root can do everything and can't be limited: AWS's advice is an admin user with MFA for everyday work.
    if (id.Arn?.endsWith(':root')) {
      p.log.warn(
        `You're signed in as the account's root user. Keep root for billing; deploy as an admin user with MFA instead.\nHow: ${GUIDE}#4-create-an-admin-user-with-mfa, then aws login again as that user.`,
      );
      if (!YES && !DRY && !(await ask('confirm', { message: 'Continue as root anyway?', initialValue: false }))) bye('Sign in as your admin user, then run setup again.');
    }
    break;
  } catch (err) {
    s.stop('Not signed in to AWS', 1);
    p.log.error(explainAwsError(err));
    if (DRY) {
      account = '000000000000';
      p.log.warn('[dry run] continuing without AWS: checks are skipped, nothing is written to AWS.');
      break;
    }
    const manual = `Sign in first, then run setup again:\n  aws login --profile ${SIGN_IN_PROFILE}   (AWS CLI 2.32+; setup finds this profile by itself)\n  or: aws configure sso  /  export AWS_PROFILE=<profile>${profile ? `\n(Tried profile ${profile}.)` : ''}`;
    if (YES || process.env.AWS_ACCESS_KEY_ID || !process.stdin.isTTY) bye(manual);
    const choice = await ask('select', {
      message: 'Sign in to AWS now?',
      options: [
        { value: 'login', label: '🌐 Sign in with your browser (recommended)', hint: 'a browser tab opens; come back here after' },
        ...profiles.filter((x) => x !== profile).map((x) => ({ value: `profile:${x}`, label: `Use the "${x}" profile`, hint: 'already on this computer' })),
        { value: 'stop', label: 'Stop', hint: 'sign in yourself, then run setup again' },
      ],
    });
    if (choice === 'stop') bye(manual);
    if (choice.startsWith('profile:')) profile = choice.slice('profile:'.length);
    else {
      // `aws login` came in AWS CLI 2.32: `aws login help` fails on older versions and when the CLI isn't installed.
      if (spawnSync('aws', ['login', 'help'], { stdio: 'ignore' }).status !== 0) {
        bye('Signing in with your browser needs the AWS CLI 2.32 or newer.\nInstall or update it (macOS: brew install awscli, or brew upgrade awscli if you have it; or https://aws.amazon.com/cli/), then run setup again.');
      }
      profile ??= SIGN_IN_PROFILE;
      p.log.info('A browser tab opens: sign in to AWS, then come back here.');
      spawnSync('aws', ['login', '--profile', profile, '--region', region], { stdio: 'inherit' });
    }
    // cdk and every child process read AWS_PROFILE; a new provider so nothing from the failed check is reused.
    process.env.AWS_PROFILE = profile;
    credentials = fromNodeProviderChain({ profile });
  }
}
const offline = account === '000000000000';

// ── 1b. The account's plan: hosting needs the Paid plan ──────────────────────
// A Free plan account expires once its credits are used up (AWS Free Tier terms), and the city's server would go with
// it. Upgrading keeps the remaining credits. The plan API answers in us-east-1; an unreadable plan isn't a stop.
if (!offline) {
  try {
    const plan = await new FreeTierClient({ region: 'us-east-1', credentials }).send(new GetAccountPlanStateCommand({}));
    if (plan.accountPlanType === 'FREE') {
      p.log.error('This account is on the AWS Free plan.');
      p.note(
        `Hosting needs the Paid plan: AWS closes a Free plan account once its credits run out, and the city's\nserver would close with it. Upgrade as the root user (Billing → Upgrade plan); your remaining credits stay.\nHow: ${GUIDE}#3-upgrade-to-the-paid-plan-as-root`,
        'Upgrade to the Paid plan',
      );
      if (!DRY) bye();
    } else if (plan.accountPlanType) p.log.success(`Account plan: ${plan.accountPlanType === 'PAID' ? 'Paid' : plan.accountPlanType}`);
  } catch (err) {
    p.log.info(`Couldn't read the account's plan (${err.name ?? 'error'}); carrying on.`);
  }
}

if (flag('--destroy')) {
  p.log.warn(`This deletes the ${envName} stacks in ${account} (${region}). The table and buckets are kept (retained) so no player data is lost by accident.`);
  if (!(await approve(`delete the AWSCity-${envName} stacks`))) bye();
  run('npx', ['cdk', 'destroy', '--all', '-c', `env=${envName}`, '--force'], INFRA);
  p.outro('Stacks deleted. Delete the retained table/buckets in the console if you really want them gone.');
  process.exit(0);
}

// ── 2. Bedrock model access ──────────────────────────────────────────────────
s.start(`Checking ${modelChoice === 'nova' ? 'Amazon Nova' : 'Claude'} on Amazon Bedrock`);
const missing = [];
const failures = [];
/** The kill switch at deploy: off only when Bedrock isn't ready and the player chose to deploy anyway. */
let aiEnabled = true;
/** Where the AI runs ('' = this Region) and whether Nova runs on Lite alone: set when Bedrock answers only elsewhere. */
let aiRegion = '';
let novaLiteOnly = false;
/** The AI on AWS without Bedrock: an open model on the city's own Fargate service (EnvConfig.aiCpu), or undefined. */
let aiCpu;
const cpuDay = (cpuAiHourly() * 24).toFixed(2);
/** Ask whether to run the AI on Fargate, and Spot or on-demand. `held`: Bedrock isn't answering (else: as a backup). */
const askAiCpu = async (held) => {
  p.note(
    [
      `${CPU_MODEL.name} (open, Apache-2.0), served on a private Fargate service in your VPC: Graviton, ${CPU_MODEL.cpu / 1024} vCPU, ${CPU_MODEL.memoryMiB / 1024} GB, no GPU.`,
      'Only the city server can reach it; questions never leave your AWS account. The agents keep their tools, approvals and MFA.',
      held ? 'Slower than Bedrock (a CPU, not a GPU). Once Bedrock answers, the city uses Bedrock first and keeps this as a backup.' : 'Bedrock stays first; this answers when Bedrock is busy or held.',
      `Cost while it runs: about $${cpuDay} a day on demand (${FARGATE_ARM_PRICE.region} prices), Spot usually well under half. Switch it off any time: npm run ai -- off.`,
    ].join('\n'),
    'AI on AWS without Bedrock',
  );
  const use = await ask(
    'confirm',
    { message: held ? `Run the city's AI on AWS Fargate (${CPU_MODEL.name}) until Bedrock answers?` : `Bedrock answers. Keep the AI on Fargate as a backup behind it? (about $${cpuDay} a day on demand)`, initialValue: held || Boolean(prev.aiCpu) },
    Boolean(prev.aiCpu),
  );
  if (!use) return undefined;
  const mode = await ask(
    'select',
    {
      message: 'Fargate Spot or on-demand?',
      options: [
        { value: 'spot', label: 'Spot (cheapest)', hint: 'AWS can stop it with 2 minutes’ notice; ECS starts another' },
        { value: 'demand', label: 'On-demand', hint: `steady, for a live demo: about $${cpuDay} a day` },
      ],
      initialValue: prev.aiCpu?.spot === false ? 'demand' : 'spot',
    },
    prev.aiCpu?.spot === false ? 'demand' : 'spot',
  );
  // Held: the server asks only the Fargate model (no Bedrock attempt first, so each answer is one call and one quota
  // count). Re-running setup once Bedrock answers puts Bedrock first again, with this as its backup.
  return { spot: mode === 'spot', ...(held ? { primary: true } : {}) };
};
/** Amazon Nova answers (one token) in this Region? */
const novaAnswers = (r, modelId) =>
  new BedrockRuntimeClient({ region: r, credentials })
    .send(new ConverseCommand({ modelId, messages: [{ role: 'user', content: [{ text: 'hi' }] }], inferenceConfig: { maxTokens: 1 } }))
    .then(() => true, () => false);
/** Regions with Nova on demand to try when this one is held (a new account's hold is Region by Region, model by model). */
const NOVA_ELSEWHERE = ['us-west-2', 'us-east-1', 'eu-central-1'];
for (const modelId of offline ? [] : MODELS) {
  try {
    await aws(BedrockRuntimeClient).send(new ConverseCommand({ modelId, messages: [{ role: 'user', content: [{ text: 'hi' }] }], inferenceConfig: { maxTokens: 1 } }));
  } catch (err) {
    missing.push(`${modelId}: ${err.name}`);
    failures.push(err);
  }
}
if (missing.length) {
  s.stop('Bedrock model access is not ready', 1);
  p.log.error(missing.join('\n'));
  // Two different walls on a new account: Anthropic's one-time use-case form, and a Claude quota of 0 (Service
  // Quotas). Commercial Regions have no Model access page any more: serverless models are enabled on first call. The
  // console's deep links aren't documented, so we point at the guide and name the console steps it gives.
  const verifying = failures.find((e) => /being verified|account.{0,40}verif/i.test(String(e?.message)));
  const quota = failures.some((e) => /Throttl|ServiceQuotaExceeded|too many (tokens|requests)|quota/i.test(`${e?.name} ${e?.message}`));
  const unavailable = failures.find((e) => /not available for this account/i.test(String(e?.message)));
  p.note(
    verifying
      ? explainAwsError(verifying)
      : unavailable
      ? `${explainAwsError(unavailable)}\nHow: ${GUIDE}#3-upgrade-to-the-paid-plan-as-root`
      : modelChoice === 'nova' && !quota
      ? `${explainAwsError(failures[0])}\nAmazon Nova on Bedrock: https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html · ${GUIDE}#7-a-new-accounts-bedrock-hold`
      : quota
      ? `${explainAwsError({ name: 'ServiceQuotaExceededException' })}\nSee your Bedrock quotas (Region ${region}): https://${region}.console.aws.amazon.com/servicequotas/home/services/bedrock/quotas\nAWS Support: https://support.console.aws.amazon.com/support/home#/case/create. Then run setup again.`
      : `In the Amazon Bedrock console (Region ${region}), open the Model catalog, pick an Anthropic Claude model and\nsubmit the one-time use-case form (once per account or organization). How-to:\nhttps://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html\nThe first call also needs aws-marketplace:Subscribe and a valid payment method. Access can take a few minutes; then run setup again.`,
    verifying ? 'Wait for AWS to verify the account' : unavailable ? 'Upgrade to the Paid plan' : quota ? 'Bedrock has no quota yet' : modelChoice === 'nova' ? 'Amazon Nova isn’t answering' : 'Enable Claude on Bedrock',
  );
  // Nova held here? It may answer in another Region (or Lite alone here): offer that before deploying without AI.
  if (modelChoice === 'nova' && quota && !offline) {
    s.start('Looking for a Region where Amazon Nova answers');
    let found;
    for (const r of [region, ...NOVA_ELSEWHERE.filter((x) => x !== region)]) {
      if (!(await novaAnswers(r, NOVA_MODELS.light))) continue;
      found = { region: r, liteOnly: !(await novaAnswers(r, NOVA_MODELS.main)) };
      break;
    }
    s.stop(found ? `Amazon Nova ${found.liteOnly ? 'Lite' : 'Pro and Lite'} answer${found.liteOnly ? 's' : ''} in ${found.region}` : 'No Region answers yet', found ? 0 : 1);
    if (found) {
      const away = found.region !== region;
      p.note(
        [
          `The city's agents can run on Amazon Nova ${found.liteOnly ? 'Lite' : 'Pro and Lite'} in ${found.region} for now.`,
          away ? `Your data, sign-in and server stay in ${region}; only the agents' questions (and the Lookout's screenshots) are processed in ${found.region}.` : '',
          `Run setup again once ${region} answers${found.liteOnly ? ' Nova Pro' : ''} to move it back.`,
        ].filter(Boolean).join('\n'),
        `Bedrock answers ${away ? 'in another Region' : 'with Nova Lite'}`,
      );
      const use = await ask('confirm', { message: `Run the city's AI ${away ? `in ${found.region}` : 'on Nova Lite'} for now?`, initialValue: true }, Boolean(prev.aiRegion || prev.novaLiteOnly));
      if (use) {
        aiRegion = away ? found.region : '';
        novaLiteOnly = found.liteOnly;
      }
    }
  }
  // Bedrock held everywhere: the AI can still run on AWS, an open model on the city's own Fargate service.
  if (!offline && !aiRegion && !novaLiteOnly) aiCpu = await askAiCpu(true);
  // The rest of the city doesn't need the AI: sign-in, progress, linking an account, City care's findings (rules), AWS
  // status. Deploy it now with the kill switch off; re-running setup once Bedrock answers switches the AI on.
  if (!DRY && !aiRegion && !novaLiteOnly && !aiCpu) {
    const withoutAi = !YES && (await ask('confirm', { message: 'Deploy the city now with its AI switched off? (Re-run setup once Bedrock answers to switch it on.)', initialValue: true }));
    if (!withoutAi) bye();
    aiEnabled = false;
    p.log.warn('Deploying with the AI off: agents will say "The city’s AI is resting" until you run setup again.');
  }
} else {
  s.stop(offline ? '[dry run] Bedrock check skipped' : `${MAIN_MODEL} and ${LIGHT_MODEL} are available`);
  // Bedrock answers again: the Fargate AI an earlier run set up can stay as a backup, or go (it costs while it runs).
  if (!offline && prev.aiCpu) aiCpu = await askAiCpu(false);
}

// ── 3–8. The questions. They only read AWS: nothing is written until you confirm the review (step 9). ───────
let zones = [];
try {
  zones = (await aws(Route53Client).send(new ListHostedZonesCommand({}))).HostedZones?.filter((z) => !z.Config?.PrivateZone) ?? [];
} catch {
  /* no Route 53 access: offer CloudFront only */
}
// SES starts in a sandbox: until AWS grants production access, it only sends to addresses verified one by one.
const sesSandbox = offline ? false : await aws(SESv2Client).send(new GetAccountCommand({})).then((r) => !r.ProductionAccessEnabled, () => false);
const googleSecretStored = offline ? false : await aws(SecretsManagerClient).send(new DescribeSecretCommand({ SecretId: GOOGLE_SECRET })).then(() => true, () => false);
const otherEnvSes = Object.entries(saved).filter(([k, v]) => k !== envName && v && typeof v === 'object').map(([, v]) => v.sesFromEmail);

/** One pass through the questions, filled in from `was` (the saved answers, or the last pass's); `kept` holds a secret already typed. */
const askAll = async (was, kept) => {
  const zoneChoice = await ask(
    'select',
    {
      message: 'Web address for the server',
      options: [
        { value: '', label: 'No domain — use CloudFront HTTPS (https://xxxx.cloudfront.net)', hint: 'recommended, nothing to buy' },
        ...zones.map((z) => ({ value: z.Id.replace('/hostedzone/', ''), label: `api.${z.Name.replace(/\.$/, '')}`, hint: 'your Route 53 zone' })),
      ],
      initialValue: was.hostedZoneId ?? '',
    },
    was.hostedZoneId,
  );
  // "No domain" is '', which every zone id ends with: only look a zone up when one was picked.
  const zone = zoneChoice ? zones.find((z) => z.Id.endsWith(zoneChoice)) : undefined;
  const zoneName = zone ? zone.Name.replace(/\.$/, '') : '';
  const domainName = zone ? await ask('text', { message: 'API hostname', initialValue: was.domainName || `api.${zoneName}` }, was.domainName) : '';

  // Sign-in (Cognito). Cognito refuses prefixes containing reserved words such as aws, amazon or cognito.
  const suggested = `cloud-city-${envName === 'prod' ? '' : `${envName}-`}${account.slice(-6)}`;
  let cognitoDomainPrefix;
  for (;;) {
    cognitoDomainPrefix = await ask('text', { message: 'Sign-in page name (Cognito domain prefix)', initialValue: was.cognitoDomainPrefix ?? suggested, validate: (v) => (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v) ? 'lowercase letters, digits and -' : /aws|amazon|cognito/.test(v) ? 'can’t contain aws, amazon or cognito' : undefined) }, was.cognitoDomainPrefix);
    const d = offline ? {} : await aws(CognitoIdentityProviderClient).send(new DescribeUserPoolDomainCommand({ Domain: cognitoDomainPrefix })).catch(() => ({}));
    const owner = d.DomainDescription?.UserPoolId;
    if (!owner || d.DomainDescription?.AWSAccountId === account) break; // free, or already ours (re-run)
    if (YES) bye(`The sign-in name "${cognitoDomainPrefix}" is taken; pick another in aws-city.config.json.`);
    p.log.warn(`"${cognitoDomainPrefix}" is taken by another AWS account. Try another name.`);
  }
  const cognitoHost = `${cognitoDomainPrefix}.auth.${region}.amazoncognito.com`;

  // Google sign-in (optional). The secret is kept in memory; it's stored in Secrets Manager only after the review.
  const useGoogle = await ask('confirm', { message: 'Add "Sign in with Google"? (email + password always works)', initialValue: Boolean(was.googleClientId) }, Boolean(was.googleClientId));
  let googleClientId = '';
  let googleSecret;
  if (useGoogle) {
    p.note(
      [
        '1. https://console.cloud.google.com/apis/credentials → Create credentials → OAuth client ID',
        '   (first time: configure the consent screen: External, app name "AWS City", your email).',
        '2. Application type: Web application. Name: AWS City.',
        `3. Authorised JavaScript origins:  https://${cognitoHost}`,
        `4. Authorised redirect URIs:       https://${cognitoHost}/oauth2/idpresponse`,
        '5. Create → copy the Client ID and Client secret.',
        '6. Google Auth Platform → Audience → Publish app. While it says Testing, only the test users you list',
        '   can sign in with Google (basic sign-in scopes need no Google review).',
      ].join('\n'),
      'Google Cloud Console (2 minutes)',
    );
    googleClientId = await ask('text', { message: 'Google Client ID', initialValue: was.googleClientId, validate: (v) => (/\.apps\.googleusercontent\.com$/.test(v) ? undefined : 'ends with .apps.googleusercontent.com') }, was.googleClientId);
    googleSecret = kept.googleSecret;
    const enter = googleSecret
      ? !YES && !(await ask('confirm', { message: 'Keep the Google client secret you entered?', initialValue: true }))
      : !googleSecretStored || (!YES && (await ask('confirm', { message: 'A Google secret is already stored in Secrets Manager. Replace it?', initialValue: false })));
    if (enter) {
      // Hidden prompt, kept in memory until you confirm. Never written to disk or printed.
      googleSecret = YES ? process.env.GOOGLE_CLIENT_SECRET : await ask('password', { message: 'Google Client secret (hidden)', validate: (v) => (v?.length >= 10 ? undefined : 'paste the client secret') });
      if (!googleSecret) bye('Set GOOGLE_CLIENT_SECRET for --yes runs.');
    }
  }

  // Emails. The AI cut-off works without an alarm email, but in prod nobody would hear about alarms or the cut-off.
  const emailOptional = envName !== 'prod';
  const alarmEmail = await ask('text', { message: 'Email for alarms and budget alerts (you’ll get a confirmation email to click)', initialValue: was.alarmEmail ?? '', validate: (v) => (/^\S+@\S+\.\S+$/.test(v ?? '') || (emailOptional && !v) ? undefined : emailOptional ? 'an email address, or leave empty' : 'prod needs an email for alarms and the budget cut-off') }, was.alarmEmail);
  if (!alarmEmail && !emailOptional) bye('prod needs alarmEmail (alarms and the budget cut-off notify it).');
  if (!alarmEmail) p.log.warn('No alarm email: the AI still switches off at 100% of the budget, but nobody is told. Add one before going live.');
  const monthlyBudgetUsd = Number(await ask('text', { message: 'Monthly AWS budget in USD (AI switches off at 100%)', initialValue: String(was.monthlyBudgetUsd ?? (envName === 'prod' ? 300 : 50)), validate: (v) => (Number(v) > 0 ? undefined : 'a number') }, was.monthlyBudgetUsd));
  // SES starts in a sandbox (only verified recipients), so while it's there the question defaults to No, even when an
  // earlier run said Yes: otherwise players never get their sign-up code. --yes runs keep the saved answer.
  if (sesSandbox)
    p.log.info(
      was.sesFromEmail
        ? `Amazon SES in this account is still in its sandbox: sign-up emails from ${was.sesFromEmail} only reach addresses you verified one by one, so other players can’t sign up. Answer No to use Cognito’s own sender (any address, about 50 a day) until SES has production access.`
        : 'Amazon SES in this account is still in its sandbox: it would only email addresses you verify one by one, so players couldn’t sign up. Skip it for now; request production access in the SES console before using it.',
    );
  const useSes = await ask('confirm', { message: 'Send sign-up emails from your own address with Amazon SES? (otherwise Cognito’s default sender, ~50/day)', initialValue: Boolean(was.sesFromEmail) && !sesSandbox }, Boolean(was.sesFromEmail));
  let sesFromEmail = '';
  if (useSes) {
    sesFromEmail = await ask('text', { message: 'From address (e.g. noreply@yourdomain.com)', initialValue: was.sesFromEmail, validate: (v) => (/^\S+@\S+\.\S+$/.test(v) ? undefined : 'an email address') }, was.sesFromEmail);
    if (isFreeMail(sesFromEmail)) p.log.warn(`${sesFromEmail} is a free email address: mail sent "from" it through SES is often filtered as spoofed. Use an address on a domain you own, or skip SES.`);
  }

  // Chrome extension ids. The local build's id comes from a public key in this repo, so ANY unpacked copy built from it
  // can sign in (only as the person signing in: the server still checks every request). Until there's a store id it's
  // the only way to try the city, so it's the default then; with a store id, prod keeps the previous answer.
  const storeId = await ask('text', { message: 'Chrome Web Store extension id (leave empty until you have one)', initialValue: (was.extensionIds ?? []).find((i) => i !== DEV_EXTENSION_ID) ?? '', validate: (v) => (!v || /^[a-p]{32}$/.test(v) ? undefined : '32 letters a–p') }, (was.extensionIds ?? []).find((i) => i !== DEV_EXTENSION_ID) ?? '');
  const hadDev = (was.extensionIds ?? []).includes(DEV_EXTENSION_ID);
  const allowDev = await ask(
    'confirm',
    {
      message: `Allow the local (unpacked) build to sign in? ${
        envName !== 'prod'
          ? '(handy for testing)'
          : storeId
            ? '(No once your store listing is live: any copy of this repo’s build could sign in)'
            : '(Yes to try it before your Chrome Web Store listing is live. Any copy of this repo’s build could sign in, but only as the person signing in.)'
      }`,
      initialValue: !storeId || (was.extensionIds ? hadDev : envName !== 'prod'),
    },
    was.extensionIds ? hadDev : envName !== 'prod',
  );
  const extensionIds = [...(allowDev ? [DEV_EXTENSION_ID] : []), ...(storeId ? [storeId] : [])];
  if (!extensionIds.length) p.log.warn('No extension can sign in, so you won’t be able to try the city: allow the local build, or publish to the Chrome Web Store and run setup again with its id.');
  // Chrome/Edge are always on; Firefox and Safari players sign in with the same accounts when enabled. One yes/no each:
  // a multiselect needed Space before Enter, and Enter alone quietly chose none.
  p.log.info('Browsers: Chrome and Edge always work. Firefox and Safari are optional (the same accounts sign in there).');
  const firefox = await ask('confirm', { message: `Let players use Firefox too? (add-on id ${FIREFOX_ADDON_ID})`, initialValue: Boolean(was.firefoxAddonId) }, Boolean(was.firefoxAddonId));
  const safariOn = await ask('confirm', { message: 'Let players use Safari too? (on a Mac: npm run safari:xcode builds it; publishing needs an Apple Developer account)', initialValue: Boolean(was.safari) }, Boolean(was.safari));
  const browsers = [...(firefox ? ['firefox'] : []), ...(safariOn ? ['safari'] : [])];

  // GitHub CI/CD (optional).
  let githubRepo = was.githubRepo ?? '';
  const wantCi = await ask('confirm', { message: 'Set up GitHub Actions deploys (OIDC, no stored keys)?', initialValue: Boolean(githubRepo) }, Boolean(githubRepo));
  if (wantCi) {
    githubRepo = await ask('text', { message: 'GitHub repo (owner/name)', initialValue: githubRepo || 'salman-abdulrazaq-ali/aws-city', validate: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v) ? undefined : 'owner/name') }, githubRepo);
    const providers = offline ? [] : await aws(IAMClient).send(new ListOpenIDConnectProvidersCommand({})).then((r) => r.OpenIDConnectProviderList ?? [], () => []);
    // An OIDC provider's ARN is arn:aws:iam::<account>:oidc-provider/<host>: compare the host exactly.
    if (providers.some((x) => x.Arn?.split(':oidc-provider/')[1] === 'token.actions.githubusercontent.com')) {
      p.log.warn('This account already has a GitHub OIDC provider, so the CI stack is skipped (it would clash). Point your existing deploy role at the CDK bootstrap roles instead.');
      githubRepo = '';
    }
  } else githubRepo = '';

  return {
    hostedZoneId: zone ? zoneChoice : '', zoneName, domainName, cognitoDomainPrefix, googleClientId, googleSecret, alarmEmail, monthlyBudgetUsd, sesFromEmail,
    storeId, allowDev, extensionIds, firefoxAddonId: browsers.includes('firefox') ? FIREFOX_ADDON_ID : '', safari: browsers.includes('safari'), githubRepo,
  };
};

// ── 9. Review: every answer and every AWS change on one screen, then Deploy / Change an answer / Cancel ─────────
const cdkReady = async (r) => new CloudFormationClient({ region: r, credentials }).send(new DescribeStacksCommand({ StackName: 'CDKToolkit' })).then(() => true, () => false);
let was = { ...prev, githubRepo: saved.githubRepo ?? '' };
let A;
let sesStatus;
let deleteSes = [];
for (;;) {
  A = await askAll(was, { googleSecret: A?.googleSecret });
  sesStatus = A.sesFromEmail && !offline ? await aws(SESv2Client).send(new GetEmailIdentityCommand({ EmailIdentity: A.sesFromEmail })).then((r) => r.VerifiedForSendingStatus, () => undefined) : undefined;
  // SES addresses an earlier run set up that nothing uses any more (this environment's new answer, or the other one's).
  deleteSes = (prev.sesIdentitiesCreated ?? []).filter((e) => e !== A.sesFromEmail && !otherEnvSes.includes(e));
  const regions = [...new Set([region, ...(A.domainName ? [] : ['us-east-1'])])];
  const bootstrap = offline ? [] : (await Promise.all(regions.map(async (r) => ((await cdkReady(r)) ? undefined : r)))).filter(Boolean);
  const review = { envName, modelChoice, region, aiEnabled, aiRegion, novaLiteOnly, ...A, firefox: Boolean(A.firefoxAddonId), aiCpu: aiCpu && { ...aiCpu, model: CPU_MODEL.name, daily: cpuAiHourly() * 24 } };
  const actions = plannedActions(review, { account, storeGoogleSecret: Boolean(A.googleSecret), verifySes: Boolean(A.sesFromEmail) && sesStatus === undefined, deleteSes, bootstrap });
  if (YES) break;
  p.note(reviewText(reviewRows(review), actions), 'Check your answers');
  if (!A.domainName) p.log.info(cloudFrontNote(region));
  const next = await ask('select', {
    message: DRY ? 'Is this right? (a dry run changes nothing in AWS)' : 'Ready?',
    options: [
      { value: 'go', label: DRY ? 'Looks right' : 'Deploy', hint: DRY ? 'see what it would do' : 'make the changes above' },
      { value: 'change', label: 'Change an answer', hint: 'go through the questions again, your answers filled in' },
      { value: 'cancel', label: 'Cancel', hint: 'nothing has been changed in AWS' },
    ],
    initialValue: 'go',
  });
  if (next === 'cancel') bye('Cancelled. Nothing was changed in AWS.');
  if (next === 'go') break;
  was = { ...A, extensionIds: A.extensionIds };
}
const { hostedZoneId, zoneName, domainName, cognitoDomainPrefix, googleClientId, alarmEmail, monthlyBudgetUsd, sesFromEmail, extensionIds, allowDev, storeId, firefoxAddonId, safari, githubRepo } = A;

// ── 10. Now, and only now, the changes: the Google secret, SES, the saved answers ────────────────────────────
if (A.googleSecret && (await approve(`store the Google client secret in Secrets Manager as "${GOOGLE_SECRET}"`))) {
  const sm = aws(SecretsManagerClient);
  const SecretString = JSON.stringify({ clientSecret: A.googleSecret });
  if (googleSecretStored) await sm.send(new PutSecretValueCommand({ SecretId: GOOGLE_SECRET, SecretString }));
  else await sm.send(new CreateSecretCommand({ Name: GOOGLE_SECRET, SecretString, Description: 'AWS City: Google OAuth client secret for Cognito' }));
  p.log.success('Google secret stored in Secrets Manager.');
}
const sesIdentitiesCreated = [...(prev.sesIdentitiesCreated ?? [])];
if (sesFromEmail) {
  const ses = aws(SESv2Client);
  if (sesStatus === undefined && (await approve(`ask SES to verify ${sesFromEmail} (it sends a verification email)`))) {
    await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: sesFromEmail }));
    sesIdentitiesCreated.push(sesFromEmail);
    p.log.warn(`Click the link in the email SES sent to ${sesFromEmail} before players sign up.${sesSandbox ? ' (SES is in its sandbox: request production access in the SES console.)' : ''}`);
  } else if (sesStatus === false) p.log.warn(`${sesFromEmail} isn't verified yet: click the SES email link.`);
}
for (const e of deleteSes) {
  if (!(await approve(`remove the SES identity ${e} (an earlier run set it up; nothing uses it now)`))) continue;
  await aws(SESv2Client).send(new DeleteEmailIdentityCommand({ EmailIdentity: e })).catch(() => undefined);
  sesIdentitiesCreated.splice(sesIdentitiesCreated.indexOf(e), 1);
}

const envConfig = {
  modelChoice, aiEnabled, aiRegion, novaLiteOnly, ...(aiCpu ? { aiCpu } : {}), region, domainName, hostedZoneId, zoneName, cognitoDomainPrefix, extensionIds, firefoxAddonId, safari, googleClientId, sesFromEmail, alarmEmail,
  monthlyBudgetUsd, dailyModelCalls: prev.dailyModelCalls ?? 100, globalDailyModelCalls: prev.globalDailyModelCalls ?? (envName === 'prod' ? 20000 : 5000),
  minTasks: prev.minTasks ?? (envName === 'prod' ? 2 : 1), maxTasks: prev.maxTasks ?? (envName === 'prod' ? 10 : 3),
  // SES addresses this wizard asked AWS to verify, so a later run can offer to remove one nothing uses.
  ...(sesIdentitiesCreated.length ? { sesIdentitiesCreated } : {}),
};
writeFileSync(CONFIG, `${JSON.stringify({ ...saved, lastEnv: envName, account, githubRepo, [envName]: envConfig }, null, 2)}\n`);
p.log.success('Saved your answers to aws-city.config.json (gitignored; no secrets in it).');

// ── 10. Deploy ───────────────────────────────────────────────────────────────
const cdkEnv = { CDK_DEFAULT_ACCOUNT: account, CDK_DEFAULT_REGION: region, AWS_REGION: region };
if (!existsSync(`${INFRA}node_modules`)) run('npm', ['ci'], INFRA);
// No custom domain → CloudFront, whose WAF lives in us-east-1: that region needs CDK too.
for (const r of offline ? [] : [...new Set([region, ...(domainName ? [] : ['us-east-1'])])]) {
  const cfn = new CloudFormationClient({ region: r, credentials });
  const ready = await cfn.send(new DescribeStacksCommand({ StackName: 'CDKToolkit' })).then(() => true, () => false);
  if (!ready && r === 'us-east-1' && r !== region) p.log.info(cloudFrontNote(region));
  if (!ready && (await approve(`prepare ${account}/${r} for CDK (cdk bootstrap, one time)${r === 'us-east-1' && r !== region ? ': for CloudFront’s firewall' : ''}`))) run('npx', ['cdk', 'bootstrap', `aws://${account}/${r}`], INFRA, cdkEnv);
}
const outputsFile = `${INFRA}outputs.${envName}.json`;
if (await approve(`deploy AWS City (${envName}) — about 15–25 minutes the first time`)) {
  // Interactive runs show IAM/security changes and ask before applying them. Events as plain lines (no redrawn bar), and
  // every minute a line saying what AWS is doing, from the busy stack's events (infra/lib/deploy-progress.ts).
  p.log.info('Deploying. The server takes longest: after a code change AWS CodeBuild builds its image (3–6 minutes), then ECS swaps the servers and watches them for errors. A ⏳ line every minute says what AWS is doing, so you can tell it isn’t stuck.');
  const started = Date.now();
  const watched = [...new Set([region, ...(domainName ? [] : ['us-east-1'])])].map((r) => new CloudFormationClient({ region: r, credentials }));
  const tick = async () => {
    for (const cfn of watched) {
      const stacks = (await cfn.send(new DescribeStacksCommand({})).catch(() => undefined))?.Stacks ?? [];
      const busy = stacks.find((st) => st.StackName?.startsWith(`AWSCity-${envName}-`) && st.StackStatus?.endsWith('_IN_PROGRESS'));
      if (!busy) continue;
      const events = (await cfn.send(new DescribeStackEventsCommand({ StackName: busy.StackName })).catch(() => undefined))?.StackEvents ?? [];
      console.log(progressLine(busy.StackName, busy.StackStatus, events, Date.now() - started));
      return;
    }
  };
  const timer = setInterval(() => void tick(), 60_000);
  try {
    await runAsync('npx', ['cdk', 'deploy', '--all', '-c', `env=${envName}`, '--require-approval', YES ? 'never' : 'broadening', '--progress', 'events', '--outputs-file', outputsFile], INFRA, cdkEnv);
  } finally {
    clearInterval(timer);
  }
  p.log.success(`Deployed in ${Math.max(1, Math.round((Date.now() - started) / 60_000))} min.`);
  run('node', ['scripts/smoke-hosted.mjs', outputsFile, envName]);
}
if (DRY || !existsSync(outputsFile)) {
  p.outro(DRY ? 'Dry run done: aws-city.config.json is ready. Run `npm run setup` to deploy.' : 'Not deployed. Run setup again when you’re ready.');
  process.exit(0);
}

// ── 11. Build the extension for this backend ─────────────────────────────────
const out = JSON.parse(readFileSync(outputsFile, 'utf8'));
const pick = (stack, key) => out[`AWSCity-${envName}-${stack}`]?.[key];
const envFile = [
  'WXT_BACKEND=hosted',
  `WXT_AWS_WS_URL=${pick('Service', 'WsUrl')}`,
  `WXT_AWS_API_URL=${pick('Service', 'ApiUrl')}`,
  `WXT_COGNITO_DOMAIN=${pick('Auth', 'CognitoDomain')}`,
  `WXT_COGNITO_CLIENT_ID=${pick('Auth', 'CognitoClientId')}`,
  ...(safari ? [`WXT_COGNITO_REDIRECT_URL=${pick('Data', 'AuthRelayUrl')}`] : []),
].join('\n');
writeFileSync(`${ROOT}.env.production`, `${envFile}\n`);
if (!existsSync(`${ROOT}node_modules`)) run('npm', ['ci']);
// The store zip first: it builds into .output/chrome-mv3 too, without the manifest key (the store assigns its own id).
// The local build goes last, so the folder you load unpacked keeps the fixed id that Cognito lets sign in.
run('npx', ['wxt', 'zip', '--mode', 'production'], ROOT, { WXT_STORE_BUILD: 'true' });
run('npx', ['wxt', 'build', '--mode', 'production']);
const unpacked = JSON.parse(readFileSync(`${ROOT}.output/chrome-mv3/manifest.json`, 'utf8'));
if (allowDev && !unpacked.key) bye('.output/chrome-mv3 was built without its key, so it would get a random id and couldn’t sign in. Run: npx wxt build --mode production');
if (firefoxAddonId) run('npx', ['wxt', 'zip', '-b', 'firefox', '--mode', 'production']);
if (safari) run('npx', ['wxt', 'build', '-b', 'safari', '--mode', 'production']);

p.note(
  [
    allowDev
      ? [
          'Try it now:  npm run open:hosted  opens it in its own browser window (Chrome for Testing); then ⋯ → Sign in.',
          'Your own Chrome: chrome://extensions → Developer mode → Load unpacked → .output/chrome-mv3 (only you can, once).',
        ].join('\n')
      : storeId
        ? 'Players sign in with the Chrome Web Store build (the local build is not allowed to).'
        : 'No extension can sign in yet: run setup again and allow the local build, or publish (below).',
    '',
    // Neither address is a web page: opened in a browser, the sign-in domain shows "Missing Authentication Token".
    `Server:    ${pick('Service', 'ApiUrl')}  (for the extension; ${pick('Service', 'ApiUrl')}/health shows {"status":"ok"})`,
    `Sign-in:   ${pick('Auth', 'CognitoDomain')}  (the extension's Sign in button opens it)`,
    '',
    'Publish:   upload .output/*-chrome.zip in the Chrome Web Store dashboard (docs/chrome-web-store.md),',
    '           then run setup again with the store id so store users can sign in too.',
    firefoxAddonId ? 'Firefox:   upload .output/*-firefox.zip (+ the -sources.zip) to addons.mozilla.org (docs/firefox-addons.md).' : '',
    safari ? 'Safari:    npm run safari:xcode, then build and submit the app in Xcode (docs/safari.md).' : '',
    alarmEmail ? `Confirm:   click the AWS Notification emails sent to ${alarmEmail}.` : '',
    aiEnabled ? '' : `AI:        off for now. Once Bedrock answers, run npm run setup again (or: aws ssm put-parameter --name /cloud-city/${envName}/ai-enabled --value true --overwrite).`,
    aiCpu ? `AI:        ${CPU_MODEL.name} on your Fargate (${aiCpu.spot ? 'Spot' : 'on-demand'}), private to your VPC${missing.length ? ', until Bedrock answers' : ', behind Bedrock'}. Off: npm run ai -- off · on: npm run ai -- on.` : '',
    aiRegion ? `AI:        runs in ${aiRegion}${novaLiteOnly ? ' on Nova Lite' : ''} until ${region} answers; then run npm run setup again to move it back.` : novaLiteOnly ? 'AI:        runs on Nova Lite until Nova Pro answers here; then run npm run setup again.' : '',
    githubRepo ? `GitHub:    add AWS_DEPLOY_ROLE_ARN (see the AWSCity-CI stack) + AWS_REGION=${region} to the ${envName} environment.` : '',
    'Kill switch / runbook: docs/runbook.md',
  ]
    .filter((l) => l !== undefined)
    .join('\n'),
  'AWS City is live',
);
// The live city in its own browser window, right now. Chrome for Testing, because branded Chrome ignores
// --load-extension: "Load unpacked" there stays the player's one click. Never with --yes (CI) or without a terminal.
if (allowDev && !YES && process.stdin.isTTY) {
  const open = await p.confirm({ message: 'Open AWS City now in its own browser window (Chrome for Testing)?', initialValue: true });
  if (!p.isCancel(open) && open) {
    const { hasChromeForTesting, installChromeForTesting } = await import(new URL('../../scripts/launcher/open-browser.mjs', import.meta.url));
    let ready = await hasChromeForTesting();
    if (!ready) {
      const dl = p.spinner();
      dl.start('Downloading the AWS City browser (Chrome for Testing, one time)…');
      const r = await installChromeForTesting(({ fraction, total }) => dl.message(`Downloading the AWS City browser… ${Math.round(fraction * 100)}% of ${total}`));
      dl.stop(r.ok ? 'Downloaded the AWS City browser.' : 'The download failed: run  npx playwright install chromium  to see why, then  npm run open:hosted');
      ready = r.ok;
    }
    if (ready) {
      // Detached: setup finishes and the window stays open. Built just above, so no second build.
      spawn('node', ['scripts/open.mjs', '--hosted', '--no-build'], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();
      p.log.success('Opened in its own window: ⋯ → Sign in. Open it again any time:  npm run open:hosted');
    }
  }
}
p.outro('Done. Have fun in the city!');
