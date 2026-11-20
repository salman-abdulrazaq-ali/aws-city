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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
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
const { SUPPORTED_REGIONS, geoFor, modelsForChoice, unsupportedRegionMessage } = await import(new URL('../lib/models.ts', import.meta.url));
// The review screen's text (pure, tested in test/review.test.ts).
const { cloudFrontNote, isFreeMail, plannedActions, reviewRows, reviewText } = await import(new URL('../lib/review.ts', import.meta.url));
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
const profile = process.env.AWS_PROFILE ?? (process.env.AWS_ACCESS_KEY_ID ? undefined : pickProfile(listProfiles(awsFile('credentials'), awsConfigText)));
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
const credentials = fromNodeProviderChain({ profile: process.env.AWS_PROFILE });
const aws = (C) => new C({ region, credentials });

const s = p.spinner();
s.start('Checking your AWS sign-in');
let account;
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
} catch (err) {
  s.stop('Not signed in to AWS', 1);
  p.log.error(err.message ?? String(err));
  if (!DRY) bye(`Sign in first, then run setup again:\n  aws login --profile aws-city   (AWS CLI 2.32+; setup finds this profile by itself)\n  or: aws configure sso  /  export AWS_PROFILE=<profile>${profile ? `\n(Tried profile ${profile}.)` : ''}`);
  account = '000000000000';
  p.log.warn('[dry run] continuing without AWS: checks are skipped, nothing is written to AWS.');
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
  // The rest of the city doesn't need the AI: sign-in, progress, linking an account, City care's findings (rules), AWS
  // status. Deploy it now with the kill switch off; re-running setup once Bedrock answers switches the AI on.
  if (!DRY) {
    const withoutAi = !YES && (await ask('confirm', { message: 'Deploy the city now with its AI switched off? (Re-run setup once Bedrock answers to switch it on.)', initialValue: true }));
    if (!withoutAi) bye();
    aiEnabled = false;
    p.log.warn('Deploying with the AI off: agents will say "The city’s AI is resting" until you run setup again.');
  }
} else s.stop(offline ? '[dry run] Bedrock check skipped' : `${MAIN_MODEL} and ${LIGHT_MODEL} are available`);

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
  if (sesSandbox && !was.sesFromEmail)
    p.log.info('Amazon SES in this account is still in its sandbox: it would only email addresses you verify one by one, so players couldn’t sign up. Skip it for now; request production access in the SES console before using it.');
  const useSes = await ask('confirm', { message: 'Send sign-up emails from your own address with Amazon SES? (otherwise Cognito’s default sender, ~50/day)', initialValue: Boolean(was.sesFromEmail) }, Boolean(was.sesFromEmail));
  let sesFromEmail = '';
  if (useSes) {
    sesFromEmail = await ask('text', { message: 'From address (e.g. noreply@yourdomain.com)', initialValue: was.sesFromEmail, validate: (v) => (/^\S+@\S+\.\S+$/.test(v) ? undefined : 'an email address') }, was.sesFromEmail);
    if (isFreeMail(sesFromEmail)) p.log.warn(`${sesFromEmail} is a free email address: mail sent "from" it through SES is often filtered as spoofed. Use an address on a domain you own, or skip SES.`);
  }

  // Chrome extension ids. The local build's id comes from a public key in this repo, so ANY unpacked extension could
  // claim it: fine for staging; for prod it's opt-in (it lets that id sign in and talk to your server).
  const storeId = await ask('text', { message: 'Chrome Web Store extension id (leave empty until you have one)', initialValue: (was.extensionIds ?? []).find((i) => i !== DEV_EXTENSION_ID) ?? '', validate: (v) => (!v || /^[a-p]{32}$/.test(v) ? undefined : '32 letters a–p') }, (was.extensionIds ?? []).find((i) => i !== DEV_EXTENSION_ID) ?? '');
  const hadDev = (was.extensionIds ?? []).includes(DEV_EXTENSION_ID);
  const allowDev = await ask(
    'confirm',
    {
      message: `Allow the local (unpacked) build to sign in? ${envName === 'prod' ? '(not recommended for prod: anyone can build an extension with this id)' : '(handy for testing)'}`,
      initialValue: was.extensionIds ? hadDev : envName !== 'prod',
    },
    was.extensionIds ? hadDev : envName !== 'prod',
  );
  const extensionIds = [...(allowDev ? [DEV_EXTENSION_ID] : []), ...(storeId ? [storeId] : [])];
  if (!extensionIds.length) p.log.warn('No extension can sign in yet: publish to the Chrome Web Store and re-run setup with its id (or allow the local build).');
  // Chrome/Edge are always on; Firefox and Safari players sign in with the same accounts when enabled.
  const browsers = await ask(
    'multiselect',
    {
      message: 'Which other browsers should players be able to use? (Chrome and Edge always work)',
      options: [
        { value: 'firefox', label: 'Firefox', hint: `add-on id ${FIREFOX_ADDON_ID}` },
        { value: 'safari', label: 'Safari', hint: 'needs Xcode + an Apple Developer account to publish' },
      ],
      initialValues: [...(was.firefoxAddonId ? ['firefox'] : []), ...(was.safari ? ['safari'] : [])],
      required: false,
    },
    [...(was.firefoxAddonId ? ['firefox'] : []), ...(was.safari ? ['safari'] : [])],
  );

  // GitHub CI/CD (optional).
  let githubRepo = was.githubRepo ?? '';
  const wantCi = await ask('confirm', { message: 'Set up GitHub Actions deploys (OIDC, no stored keys)?', initialValue: Boolean(githubRepo) }, Boolean(githubRepo));
  if (wantCi) {
    githubRepo = await ask('text', { message: 'GitHub repo (owner/name)', initialValue: githubRepo || 'salman-abdulrazaq-ali/aws-city', validate: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v) ? undefined : 'owner/name') }, githubRepo);
    const providers = offline ? [] : await aws(IAMClient).send(new ListOpenIDConnectProvidersCommand({})).then((r) => r.OpenIDConnectProviderList ?? [], () => []);
    if (providers.some((x) => x.Arn?.endsWith('token.actions.githubusercontent.com'))) {
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
  const review = { envName, modelChoice, region, aiEnabled, ...A, firefox: Boolean(A.firefoxAddonId) };
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
const { hostedZoneId, zoneName, domainName, cognitoDomainPrefix, googleClientId, alarmEmail, monthlyBudgetUsd, sesFromEmail, extensionIds, allowDev, firefoxAddonId, safari, githubRepo } = A;

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
  modelChoice, aiEnabled, region, domainName, hostedZoneId, zoneName, cognitoDomainPrefix, extensionIds, firefoxAddonId, safari, googleClientId, sesFromEmail, alarmEmail,
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
  // Interactive runs show IAM/security changes and ask before applying them.
  run('npx', ['cdk', 'deploy', '--all', '-c', `env=${envName}`, '--require-approval', YES ? 'never' : 'broadening', '--outputs-file', outputsFile], INFRA, cdkEnv);
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
run('npx', ['wxt', 'build', '--mode', 'production']);
run('npx', ['wxt', 'zip', '--mode', 'production'], ROOT, { WXT_STORE_BUILD: 'true' });
if (firefoxAddonId) run('npx', ['wxt', 'zip', '-b', 'firefox', '--mode', 'production']);
if (safari) run('npx', ['wxt', 'build', '-b', 'safari', '--mode', 'production']);

p.note(
  [
    `Server:   ${pick('Service', 'ApiUrl')}`,
    `Sign-in:  ${pick('Auth', 'CognitoDomain')}`,
    '',
    allowDev ? `Try it now: chrome://extensions → Developer mode → Load unpacked → .output/chrome-mv3 (id ${DEV_EXTENSION_ID}).` : 'The local build is not allowed to sign in (prod); use the store build.',
    'Publish:   upload .output/*-chrome.zip in the Chrome Web Store dashboard (docs/chrome-web-store.md),',
    '           then run setup again with the store id so store users can sign in too.',
    firefoxAddonId ? 'Firefox:   upload .output/*-firefox.zip (+ the -sources.zip) to addons.mozilla.org (docs/firefox-addons.md).' : '',
    safari ? 'Safari:    npm run safari:xcode, then build and submit the app in Xcode (docs/safari.md).' : '',
    alarmEmail ? `Confirm:   click the AWS Notification emails sent to ${alarmEmail}.` : '',
    aiEnabled ? '' : `AI:        off for now. Once Bedrock answers, run npm run setup again (or: aws ssm put-parameter --name /cloud-city/${envName}/ai-enabled --value true --overwrite).`,
    githubRepo ? `GitHub:    add AWS_DEPLOY_ROLE_ARN (see the AWSCity-CI stack) + AWS_REGION=${region} to the ${envName} environment.` : '',
    'Kill switch / runbook: docs/runbook.md',
  ]
    .filter((l) => l !== undefined)
    .join('\n'),
  'AWS City is live',
);
p.outro('Done. Have fun in the city!');
