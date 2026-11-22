// npm run ai -- on|off|status [--env prod|staging]
// Switches the city's AI on Fargate (EnvConfig.aiCpu: an open model on a private Fargate service) on or off without a
// deploy: it sets the AI service's desired count to 1 or 0. CloudFormation doesn't manage that count
// (infra/lib/service-stack.ts), so a later deploy leaves the switch where you put it. Uses the AWS CLI and your sign-in.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listProfiles, pickProfile } from './launcher/lib.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('--') && !['prod', 'staging'].includes(a)) ?? 'status';
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};
if (!['on', 'off', 'status'].includes(command)) fail('Use: npm run ai -- on | off | status   (add --env staging for staging)');

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
const saved = readJson(path.join(ROOT, 'aws-city.config.json'));
const envIndex = args.indexOf('--env');
const envName = envIndex >= 0 ? args[envIndex + 1] : (saved.lastEnv ?? 'prod');
const region = saved[envName]?.region;
const stack = readJson(path.join(ROOT, 'infra', `outputs.${envName}.json`))[`AWSCity-${envName}-Service`] ?? {};
if (!region || !stack.AiCluster || !stack.AiServiceName)
  fail(`No AI on Fargate in ${envName} yet: run npm run setup and answer Yes to "Run the city's AI on AWS Fargate".`);

const awsFile = (name) => {
  try {
    return readFileSync(path.join(homedir(), '.aws', name), 'utf8');
  } catch {
    return '';
  }
};
// The same sign-in as setup: AWS_PROFILE, else the profile AWS City's tools use; keys in the environment win.
const profile = process.env.AWS_PROFILE ?? (process.env.AWS_ACCESS_KEY_ID ? undefined : pickProfile(listProfiles(awsFile('credentials'), awsFile('config'))));
const aws = (...argv) => {
  const r = spawnSync('aws', [...argv, '--region', region, '--output', 'json', ...(profile ? ['--profile', profile] : [])], { encoding: 'utf8' });
  if (r.error) fail('This needs the AWS CLI (https://aws.amazon.com/cli/).');
  if (r.status !== 0) fail(`${(r.stderr || r.stdout).trim().split('\n').pop()}\nSigned out? Run: aws login${profile ? ` --profile ${profile}` : ''}`);
  return JSON.parse(r.stdout || '{}');
};
const where = ['--cluster', stack.AiCluster];

if (command === 'on' || command === 'off') {
  aws('ecs', 'update-service', ...where, '--service', stack.AiServiceName, '--desired-count', command === 'on' ? '1' : '0');
  console.log(
    command === 'on'
      ? '✓ Switching the AI on. Fargate starts it in about 2–4 minutes (it pulls a 4 GB image); the agents answer once it runs.\n  Check: npm run ai -- status'
      : '✓ Switching the AI off: it stops within a minute and costs nothing while off. The rest of the city keeps working.\n  Back on: npm run ai -- on',
  );
} else {
  const svc = aws('ecs', 'describe-services', ...where, '--services', stack.AiServiceName).services?.[0];
  if (!svc) fail('The AI service is missing: run npm run setup again.');
  const mode = svc.capacityProviderStrategy?.[0]?.capacityProvider === 'FARGATE_SPOT' ? 'Spot' : 'on-demand';
  const state = svc.desiredCount === 0 ? 'off' : svc.runningCount >= svc.desiredCount ? 'on: running' : 'on: starting';
  console.log(`AI on Fargate (${envName}, ${mode}): ${state} · running ${svc.runningCount}, starting ${svc.pendingCount}, wanted ${svc.desiredCount}`);
}
