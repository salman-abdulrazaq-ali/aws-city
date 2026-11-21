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
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as p from '@clack/prompts';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient, DescribeUserPoolDomainCommand } from '@aws-sdk/client-cognito-identity-provider';
import { IAMClient, ListOpenIDConnectProvidersCommand } from '@aws-sdk/client-iam';
import { ListHostedZonesCommand, Route53Client } from '@aws-sdk/client-route-53';
import { CreateSecretCommand, DescribeSecretCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { CreateEmailIdentityCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INFRA = fileURLToPath(new URL('../', import.meta.url));
const CONFIG = `${ROOT}aws-city.config.json`;
// Claude's inference-profile ids follow the Region (us./eu./au./in.): one table for the wizard and the CDK app.
const { SUPPORTED_REGIONS, geoFor, modelsFor, unsupportedRegionMessage } = await import(new URL('../lib/models.ts', import.meta.url));
const GOOGLE_SECRET = 'aws-city/google-oauth';

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const DRY = flag('--dry-run');
const YES = flag('--yes');

const saved = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, 'utf8')) : {};
const { DEV_EXTENSION_ID, FIREFOX_ADDON_ID } = await import(new URL('../../scripts/extension-id.mjs', import.meta.url));
const { isHttpsUrl } = await import(new URL('../../scripts/release-check.mjs', import.meta.url));

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
// npm and npx are .cmd scripts on Windows, which spawn can only start through a shell (as the launcher does: WIN_SHELL
// in scripts/launcher/open-browser.mjs). A shell joins the words as they are, so a word with a space (the repo's path
// may have one) is quoted; one command string, not an argument list, also avoids Node's DEP0190 warning.
const WIN_SHELL = process.platform === 'win32';
const run = (cmd, argv, cwd = ROOT, env = {}) => {
  const opts = { cwd, stdio: 'inherit', env: { ...process.env, ...env } };
  const r = WIN_SHELL ? spawnSync([cmd, ...argv].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), { ...opts, shell: true }) : spawnSync(cmd, argv, opts);
  if (r.error) bye(`Couldn't start ${cmd}: ${r.error.message}`);
  if (r.status !== 0) bye(`${cmd} ${argv.join(' ')} failed (exit ${r.status ?? r.signal}). Fix the error above and run setup again — it picks up where it left off.`);
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
    '  CloudFront/ALB → ECS Fargate server → DynamoDB, S3, Amazon Bedrock (Claude), Cognito sign-in.',
    'Rough cost while idle: prod ~$60–85/month (2 small Fargate tasks, load balancer, WAF, logs);',
    'staging ~$45–60/month (1 task). Check the AWS Pricing Calculator for your region.',
    'Claude on Bedrock is pay-per-use and capped by a daily quota + a budget kill switch.',
    'The server image is built for you in AWS CodeBuild (a few cents per deploy): no Docker needed.',
    'You can remove everything later with: npm run setup -- --destroy',
  ].join('\n'),
  'What this does',
);

// ── 1. Preflight ─────────────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 24) bye(`Node ${process.versions.node} is too old: install Node 24 or newer (https://nodejs.org).`);
// No Docker needed: the server image is built in AWS CodeBuild during the deploy (infra/lib/service-stack.ts).

const envName = opt('--env') ?? (await ask('select', { message: 'Which environment?', options: [{ value: 'prod', label: 'prod', hint: 'the real one players use' }, { value: 'staging', label: 'staging', hint: 'a test copy' }], initialValue: saved.lastEnv ?? 'prod' }, saved.lastEnv));
const prev = saved[envName] ?? {};

// Only Regions where the server's Claude models have a Bedrock geo inference profile (infra/lib/models.ts).
const region = await ask('text', { message: 'AWS Region to deploy in', placeholder: 'us-west-2', initialValue: prev.region ?? process.env.AWS_REGION ?? 'us-west-2', validate: (v) => (geoFor(v) ? undefined : `Claude needs one of: ${SUPPORTED_REGIONS.join(', ')}`) }, prev.region);
if (!geoFor(region)) bye(unsupportedRegionMessage(region)); // a saved --yes answer skips validate
const { main: MAIN_MODEL, light: LIGHT_MODEL } = modelsFor(region);
const MODELS = [MAIN_MODEL, LIGHT_MODEL];
const credentials = fromNodeProviderChain({ profile: process.env.AWS_PROFILE });
const aws = (C) => new C({ region, credentials });

const s = p.spinner();
s.start('Checking your AWS sign-in');
let account;
try {
  const id = await aws(STSClient).send(new GetCallerIdentityCommand({}));
  account = id.Account;
  s.stop(`Signed in to AWS account ${account} as ${id.Arn?.split(':').pop()}`);
} catch (err) {
  s.stop('Not signed in to AWS', 1);
  p.log.error(err.message ?? String(err));
  if (!DRY) bye('Sign in first, then run setup again:\n  aws login            (AWS CLI 2.32+)\n  or: aws configure sso  /  export AWS_PROFILE=<profile>');
  account = '000000000000';
  p.log.warn('[dry run] continuing without AWS: checks are skipped, nothing is written to AWS.');
}
const offline = account === '000000000000';

if (flag('--destroy')) {
  p.log.warn(`This deletes the ${envName} stacks in ${account} (${region}). The table and buckets are kept (retained) so no player data is lost by accident.`);
  if (!(await approve(`delete the AWSCity-${envName} stacks`))) bye();
  run('npx', ['cdk', 'destroy', '--all', '-c', `env=${envName}`, '--force'], INFRA);
  p.outro('Stacks deleted. Delete the retained table/buckets in the console if you really want them gone.');
  process.exit(0);
}

// ── 2. Bedrock model access ──────────────────────────────────────────────────
s.start('Checking Claude on Amazon Bedrock');
const missing = [];
for (const modelId of offline ? [] : MODELS) {
  try {
    await aws(BedrockRuntimeClient).send(new ConverseCommand({ modelId, messages: [{ role: 'user', content: [{ text: 'hi' }] }], inferenceConfig: { maxTokens: 1 } }));
  } catch (err) {
    missing.push(`${modelId}: ${err.name}`);
  }
}
if (missing.length) {
  s.stop('Bedrock model access is not ready', 1);
  p.log.error(missing.join('\n'));
  // Commercial Regions have no Model access page any more: serverless models are enabled on first call, and
  // Anthropic needs a one-time use-case form. The console's deep links aren't documented, so we point at the guide
  // (https://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html) and name the console steps it gives.
  p.note(
    `In the Amazon Bedrock console (Region ${region}), open the Model catalog, pick an Anthropic Claude model and\nsubmit the one-time use-case form (once per account or organization). How-to:\nhttps://docs.aws.amazon.com/bedrock/latest/userguide/model-access.html\nThe first call also needs aws-marketplace:Subscribe and a valid payment method. Access can take a few minutes; then run setup again.`,
    'Enable Claude on Bedrock',
  );
  if (!DRY) bye();
} else s.stop(offline ? '[dry run] Bedrock check skipped' : `${MAIN_MODEL} and ${LIGHT_MODEL} are available`);

// ── 3. Domain: yours, or free HTTPS from CloudFront ──────────────────────────
let zones = [];
try {
  zones = (await aws(Route53Client).send(new ListHostedZonesCommand({}))).HostedZones?.filter((z) => !z.Config?.PrivateZone) ?? [];
} catch {
  /* no Route 53 access: offer CloudFront only */
}
const zoneChoice = await ask(
  'select',
  {
    message: 'Web address for the server',
    options: [
      { value: '', label: 'No domain — use CloudFront HTTPS (https://xxxx.cloudfront.net)', hint: 'recommended, nothing to buy' },
      ...zones.map((z) => ({ value: z.Id.replace('/hostedzone/', ''), label: `api.${z.Name.replace(/\.$/, '')}`, hint: 'your Route 53 zone' })),
    ],
    initialValue: prev.hostedZoneId ?? '',
  },
  prev.hostedZoneId,
);
const zone = zones.find((z) => z.Id.endsWith(zoneChoice));
const zoneName = zone ? zone.Name.replace(/\.$/, '') : '';
const domainName = zone ? await ask('text', { message: 'API hostname', initialValue: prev.domainName || `api.${zoneName}` }, prev.domainName) : '';

// ── 4. Sign-in (Cognito) ─────────────────────────────────────────────────────
// Cognito refuses prefixes containing reserved words such as aws, amazon or cognito.
const suggested = `cloud-city-${envName === 'prod' ? '' : `${envName}-`}${account.slice(-6)}`;
let cognitoDomainPrefix;
for (;;) {
  cognitoDomainPrefix = await ask('text', { message: 'Sign-in page name (Cognito domain prefix)', initialValue: prev.cognitoDomainPrefix ?? suggested, validate: (v) => (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(v) ? 'lowercase letters, digits and -' : /aws|amazon|cognito/.test(v) ? 'can’t contain aws, amazon or cognito' : undefined) }, prev.cognitoDomainPrefix);
  const d = offline ? {} : await aws(CognitoIdentityProviderClient).send(new DescribeUserPoolDomainCommand({ Domain: cognitoDomainPrefix })).catch(() => ({}));
  const owner = d.DomainDescription?.UserPoolId;
  if (!owner || d.DomainDescription?.AWSAccountId === account) break; // free, or already ours (re-run)
  if (YES) bye(`The sign-in name "${cognitoDomainPrefix}" is taken; pick another in aws-city.config.json.`);
  p.log.warn(`"${cognitoDomainPrefix}" is taken by another AWS account. Try another name.`);
}
const cognitoHost = `${cognitoDomainPrefix}.auth.${region}.amazoncognito.com`;

// ── 5. Google sign-in (optional) ─────────────────────────────────────────────
const useGoogle = await ask('confirm', { message: 'Add "Sign in with Google"? (email + password always works)', initialValue: Boolean(prev.googleClientId) }, Boolean(prev.googleClientId));
let googleClientId = '';
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
  googleClientId = await ask('text', { message: 'Google Client ID', initialValue: prev.googleClientId, validate: (v) => (/\.apps\.googleusercontent\.com$/.test(v) ? undefined : 'ends with .apps.googleusercontent.com') }, prev.googleClientId);
  const sm = aws(SecretsManagerClient);
  const exists = offline ? false : await sm.send(new DescribeSecretCommand({ SecretId: GOOGLE_SECRET })).then(() => true, () => false);
  const update = !exists || (!YES && (await ask('confirm', { message: 'A Google secret is already stored in Secrets Manager. Replace it?', initialValue: false })));
  if (update) {
    // Hidden prompt → straight to Secrets Manager. Never written to disk or printed.
    const secret = YES ? process.env.GOOGLE_CLIENT_SECRET : await ask('password', { message: 'Google Client secret (hidden)', validate: (v) => (v?.length >= 10 ? undefined : 'paste the client secret') });
    if (!secret) bye('Set GOOGLE_CLIENT_SECRET for --yes runs.');
    if (await approve(`store the Google client secret in Secrets Manager as "${GOOGLE_SECRET}"`)) {
      const SecretString = JSON.stringify({ clientSecret: secret });
      if (exists) await sm.send(new PutSecretValueCommand({ SecretId: GOOGLE_SECRET, SecretString }));
      else await sm.send(new CreateSecretCommand({ Name: GOOGLE_SECRET, SecretString, Description: 'AWS City: Google OAuth client secret for Cognito' }));
      p.log.success('Google secret stored in Secrets Manager.');
    }
  }
}

// ── 6. Emails ────────────────────────────────────────────────────────────────
// The AI cut-off works without an email, but in prod nobody would hear about alarms or the cut-off.
const emailOptional = envName !== 'prod';
const alarmEmail = await ask('text', { message: 'Email for alarms and budget alerts (you’ll get a confirmation email to click)', initialValue: prev.alarmEmail ?? '', validate: (v) => (/^\S+@\S+\.\S+$/.test(v ?? '') || (emailOptional && !v) ? undefined : emailOptional ? 'an email address, or leave empty' : 'prod needs an email for alarms and the budget cut-off') }, prev.alarmEmail);
if (!alarmEmail && !emailOptional) bye('prod needs alarmEmail (alarms and the budget cut-off notify it).');
if (!alarmEmail) p.log.warn('No alarm email: the AI still switches off at 100% of the budget, but nobody is told. Add one before going live.');
// Optional: who the privacy policy names as the operator (docs/privacy-policy.md is a template). Remembered like the rest.
const operatorName = (await ask('text', { message: 'Your name or organisation, for the privacy policy (optional; you run this service)', initialValue: prev.operatorName ?? '' }, prev.operatorName ?? '')).trim();
const contactEmail = (await ask('text', { message: 'Contact email for privacy questions (optional)', initialValue: prev.contactEmail ?? alarmEmail ?? '', validate: (v) => (!v || /^\S+@\S+\.\S+$/.test(v) ? undefined : 'an email address, or leave empty') }, prev.contactEmail ?? '')).trim();
// The extension links it (⋯ → Account, the sign-in card) and a store build stops without it (scripts/release-check.mjs).
const privacyUrl = (await ask('text', { message: 'Where your privacy policy is published, https (optional now; store builds need it: this run writes the policy for you to host)', initialValue: prev.privacyUrl ?? '', validate: (v) => (!v || isHttpsUrl(v) ? undefined : 'an https address, or leave empty') }, prev.privacyUrl ?? '')).trim();
const monthlyBudgetUsd = Number(await ask('text', { message: 'Monthly AWS budget in USD (AI switches off at 100%)', initialValue: String(prev.monthlyBudgetUsd ?? (envName === 'prod' ? 300 : 50)), validate: (v) => (Number(v) > 0 ? undefined : 'a number') }, prev.monthlyBudgetUsd));
const useSes = await ask('confirm', { message: 'Send sign-up emails from your own address with Amazon SES? (otherwise Cognito’s default sender, ~50/day)', initialValue: Boolean(prev.sesFromEmail) }, Boolean(prev.sesFromEmail));
let sesFromEmail = '';
if (useSes) {
  sesFromEmail = await ask('text', { message: 'From address (e.g. noreply@yourdomain.com)', initialValue: prev.sesFromEmail, validate: (v) => (/^\S+@\S+\.\S+$/.test(v) ? undefined : 'an email address') }, prev.sesFromEmail);
  const ses = aws(SESv2Client);
  const status = offline ? undefined : await ses.send(new GetEmailIdentityCommand({ EmailIdentity: sesFromEmail })).then((r) => r.VerifiedForSendingStatus, () => undefined);
  if (status === undefined && (await approve(`ask SES to verify ${sesFromEmail} (it sends a verification email)`))) {
    await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: sesFromEmail }));
    p.log.warn(`Click the link in the email SES sent to ${sesFromEmail} before players sign up. (New SES accounts are in the sandbox: request production access in the SES console.)`);
  } else if (status === false) p.log.warn(`${sesFromEmail} isn't verified yet: click the SES email link.`);
}

// ── 7. Chrome and Edge extension ids ─────────────────────────────────────────
// Each store assigns its own id: the Chrome Web Store one, and Edge Add-ons another for the same zip. Both sign in
// through https://<id>.chromiumapp.org/ like the local build, so each goes into extensionIds (Cognito callbacks,
// the server's allowed origins, the screenshot bucket's CORS).
const storeIdCheck = (v) => (!v || /^[a-p]{32}$/.test(v) ? undefined : '32 letters a–p');
const prevChromeId = prev.chromeStoreId ?? (prev.extensionIds ?? []).find((i) => i !== DEV_EXTENSION_ID && i !== prev.edgeStoreId) ?? '';
const storeId = await ask('text', { message: 'Chrome Web Store extension id (leave empty until you have one)', initialValue: prevChromeId, validate: storeIdCheck }, prevChromeId);
const edgeStoreId = await ask('text', { message: 'Microsoft Edge Add-ons extension id (optional: Edge gives the same zip its own id)', initialValue: prev.edgeStoreId ?? '', validate: storeIdCheck }, prev.edgeStoreId ?? '');
// The local build's id comes from a public key in this repo, so ANY unpacked extension could claim it.
// Fine for staging; for prod it's opt-in (it lets that id sign in and talk to your server).
const hadDev = (prev.extensionIds ?? []).includes(DEV_EXTENSION_ID);
const allowDev = await ask(
  'confirm',
  {
    message: `Allow the local (unpacked) build to sign in? ${envName === 'prod' ? '(not recommended for prod: anyone can build an extension with this id)' : '(handy for testing)'}`,
    initialValue: prev.extensionIds ? hadDev : envName !== 'prod',
  },
  prev.extensionIds ? hadDev : envName !== 'prod',
);
const extensionIds = [...new Set([...(allowDev ? [DEV_EXTENSION_ID] : []), ...(storeId ? [storeId] : []), ...(edgeStoreId ? [edgeStoreId] : [])])];
if (!extensionIds.length) p.log.warn('No extension can sign in yet: publish to the Chrome Web Store (or Edge Add-ons) and re-run setup with its id (or allow the local build).');
// Chrome/Edge are always on; Firefox and Safari players sign in with the same accounts when enabled.
const browsers = await ask(
  'multiselect',
  {
    message: 'Which other browsers should players be able to use? (Chrome and Edge always work)',
    options: [
      { value: 'firefox', label: 'Firefox', hint: `add-on id ${FIREFOX_ADDON_ID}` },
      { value: 'safari', label: 'Safari', hint: 'needs Xcode + an Apple Developer account to publish' },
    ],
    initialValues: [...(prev.firefoxAddonId ? ['firefox'] : []), ...(prev.safari ? ['safari'] : [])],
    required: false,
  },
  [...(prev.firefoxAddonId ? ['firefox'] : []), ...(prev.safari ? ['safari'] : [])],
);
const firefoxAddonId = browsers.includes('firefox') ? FIREFOX_ADDON_ID : '';
const safari = browsers.includes('safari');

// ── 8. GitHub CI/CD (optional) ───────────────────────────────────────────────
// The repo named here gets a role that deploys into this account (infra/lib/ci-stack.ts: its `staging` and `prod`
// GitHub environments), so there is no default: it's pre-filled from this clone's origin, and you confirm it.
/** owner/name of a GitHub remote: https://github.com/o/r(.git), git@github.com:o/r.git or ssh://git@github.com/o/r.git. */
const githubRepoOf = (url) => /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url ?? '')?.slice(1).join('/');
let githubRepo = saved.githubRepo ?? '';
const wantCi = await ask('confirm', { message: 'Set up GitHub Actions deploys (OIDC, no stored keys)?', initialValue: Boolean(githubRepo) }, Boolean(githubRepo));
if (!wantCi) githubRepo = '';
else {
  const originRepo = githubRepoOf(spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim());
  githubRepo = await ask('text', { message: 'GitHub repo allowed to deploy into this account (owner/name)', placeholder: 'owner/name', initialValue: githubRepo || originRepo || '', validate: (v) => (/^[\w.-]+\/[\w.-]+$/.test(v ?? '') ? undefined : 'owner/name') }, githubRepo);
  if (githubRepo.toLowerCase() !== originRepo?.toLowerCase())
    p.log.warn(
      [
        `${githubRepo} is NOT this clone's origin (${originRepo ?? 'no GitHub origin found'}).`,
        `Anyone who can run a workflow in ${githubRepo}'s staging or prod environment could deploy into AWS account ${account}.`,
        'Only go on if you control that repo.',
      ].join('\n'),
    );
  // A saved answer (--yes) was confirmed when it was saved.
  const trusted = await ask('confirm', { message: `Let GitHub Actions in ${githubRepo} (environments staging and prod) deploy into AWS account ${account}?`, initialValue: false }, true);
  if (!trusted) {
    githubRepo = '';
    p.log.info('GitHub deploys skipped: no CI stack.');
  }
}
if (githubRepo) {
  const providers = offline ? [] : await aws(IAMClient).send(new ListOpenIDConnectProvidersCommand({})).then((r) => r.OpenIDConnectProviderList ?? [], () => []);
  if (providers.some((x) => x.Arn?.endsWith('token.actions.githubusercontent.com'))) {
    p.log.warn('This account already has a GitHub OIDC provider, so the CI stack is skipped (it would clash). Point your existing deploy role at the CDK bootstrap roles instead.');
    githubRepo = '';
  }
}

// ── 9. Save the answers (no secrets) ─────────────────────────────────────────
const envConfig = {
  region, domainName, hostedZoneId: zone ? zoneChoice : '', zoneName, cognitoDomainPrefix, extensionIds, chromeStoreId: storeId, edgeStoreId, firefoxAddonId, safari, googleClientId, sesFromEmail, alarmEmail, operatorName, contactEmail, privacyUrl,
  monthlyBudgetUsd, dailyModelCalls: prev.dailyModelCalls ?? 100, globalDailyModelCalls: prev.globalDailyModelCalls ?? (envName === 'prod' ? 20000 : 5000),
  minTasks: prev.minTasks ?? (envName === 'prod' ? 2 : 1), maxTasks: prev.maxTasks ?? (envName === 'prod' ? 10 : 3),
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
  if (!ready && (await approve(`prepare ${account}/${r} for CDK (cdk bootstrap, one time)`))) run('npx', ['cdk', 'bootstrap', `aws://${account}/${r}`], INFRA, cdkEnv);
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
const buildVars = {
  WXT_BACKEND: 'hosted',
  WXT_AWS_WS_URL: pick('Service', 'WsUrl'),
  WXT_AWS_API_URL: pick('Service', 'ApiUrl'),
  WXT_COGNITO_DOMAIN: pick('Auth', 'CognitoDomain'),
  WXT_COGNITO_CLIENT_ID: pick('Auth', 'CognitoClientId'),
  ...(safari ? { WXT_COGNITO_REDIRECT_URL: pick('Data', 'AuthRelayUrl') } : {}),
};
const unset = Object.keys(buildVars).filter((k) => !buildVars[k]);
if (unset.length) bye(`${outputsFile} has no value for ${unset.join(', ')}: run setup again to finish the deploy.`);
// Every plain build (npm run build, zip, zip:firefox, safari:xcode) now builds for this deployment; the demo
// (npm start), npm run smoke and smoke:copilot set WXT_BACKEND=mock, which beats .env files.
const envVars = privacyUrl ? { ...buildVars, WXT_PRIVACY_URL: privacyUrl } : buildVars;
writeFileSync(`${ROOT}.env.production`, `${Object.entries(envVars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
if (!existsSync(`${ROOT}node_modules`)) run('npm', ['ci']);
// Store builds (WXT_STORE_BUILD=true: no manifest key, so each store assigns its id; no window.awsCity debug handles;
// the brand off) each rebuild .output/<browser>-mv3, so the keyed copy for trying it here is built last. They need the
// privacy policy's address (wxt.config.ts stops without it), so without one they wait for the next run.
const store = { WXT_STORE_BUILD: 'true' };
if (privacyUrl) {
  run('npx', ['wxt', 'zip', '--mode', 'production'], ROOT, store);
  if (firefoxAddonId) run('npx', ['wxt', 'zip', '-b', 'firefox', '--mode', 'production'], ROOT, store);
  if (safari) run('npx', ['wxt', 'build', '-b', 'safari', '--mode', 'production'], ROOT, store);
}
// The copy to try keeps the repo's key (id DEV_EXTENSION_ID, the one Cognito knows), in a folder of its own: the demo
// (npm start) builds into .output/chrome-mv3 and would replace it there.
const tryCopy = `.output/chrome-mv3-${envName}`;
if (allowDev) {
  run('npx', ['wxt', 'build', '--mode', 'production'], ROOT, { WXT_STORE_BUILD: 'false' });
  rmSync(`${ROOT}${tryCopy}`, { recursive: true, force: true });
  cpSync(`${ROOT}.output/chrome-mv3`, `${ROOT}${tryCopy}`, { recursive: true });
}

// The privacy policy, filled in for this deployment (the store listings need it at a public URL).
const policyFile = `.output/privacy-policy-${envName}.md`;
mkdirSync(`${ROOT}.output`, { recursive: true });
writeFileSync(
  `${ROOT}${policyFile}`,
  readFileSync(`${ROOT}docs/privacy-policy.md`, 'utf8')
    .replaceAll('{{OPERATOR_NAME}}', operatorName || '{{OPERATOR_NAME}}')
    .replaceAll('{{CONTACT_EMAIL}}', contactEmail || '{{CONTACT_EMAIL}}')
    .replaceAll('{{REGION}}', region),
);
if (!operatorName || !contactEmail) p.log.warn(`The privacy policy still has {{OPERATOR_NAME}} / {{CONTACT_EMAIL}} blanks: fill them in (${policyFile}) or run setup again.`);

p.note(
  [
    `Server:   ${pick('Service', 'ApiUrl')}`,
    `Sign-in:  ${pick('Auth', 'CognitoDomain')}`,
    '',
    allowDev ? `Try it now: chrome://extensions → Developer mode → Load unpacked → ${tryCopy} (id ${DEV_EXTENSION_ID}).` : 'The local build is not allowed to sign in (prod); use the store build.',
    privacyUrl
      ? 'Publish:   upload .output/*-chrome.zip to the Chrome Web Store (docs/chrome-web-store.md) and, if you like, Edge Add-ons,'
      : 'Publish:   no store zips yet: they need your privacy policy’s https address. Host the policy below, then run setup again with it.',
    privacyUrl ? '           then run setup again with their ids so store players can sign in too.' : '',
    privacyUrl && firefoxAddonId ? 'Firefox:   upload .output/*-firefox.zip (+ the -sources.zip) to addons.mozilla.org (docs/firefox-addons.md).' : '',
    safari ? 'Safari:    WXT_STORE_BUILD=true npm run safari:xcode, then build and submit the app in Xcode (docs/safari.md).' : '',
    'Builds:    npm run build / zip now build for this server (.env.production); npm start’s demo and npm run smoke stay the demo.',
    alarmEmail ? `Confirm:   click the AWS Notification emails sent to ${alarmEmail}.` : '',
    githubRepo ? `GitHub:    add AWS_DEPLOY_ROLE_ARN (see the AWSCity-CI stack) + AWS_REGION=${region} to the ${envName} environment.` : '',
    privacyUrl
      ? `Privacy:   ${policyFile}: publish it at ${privacyUrl} (the extension links it; the store listings ask for it too).`
      : `Privacy:   ${policyFile}: host it at a public https URL; the Chrome, Edge, Firefox and Apple listings all ask for one.`,
    'Kill switch / runbook: docs/runbook.md',
  ]
    .filter((l) => l !== undefined)
    .join('\n'),
  'AWS City is live',
);
p.outro('Done. Have fun in the city!');
