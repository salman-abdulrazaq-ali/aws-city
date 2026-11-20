/**
 * The setup wizard's review screen (infra/setup/setup.mjs): every answer on one screen, and the changes it will make in
 * AWS, before anything is written. Pure and plain erasable TypeScript, no imports: the wizard imports this file directly
 * (Node 24 strips the types), and test/review.test.ts covers it.
 */

export interface ReviewAnswers {
  envName: 'staging' | 'prod';
  modelChoice: 'nova' | 'claude';
  region: string;
  /** Empty: no custom domain (CloudFront, whose firewall is in us-east-1). */
  domainName: string;
  cognitoDomainPrefix: string;
  googleClientId: string;
  alarmEmail: string;
  monthlyBudgetUsd: number;
  sesFromEmail: string;
  storeId: string;
  allowDev: boolean;
  firefox: boolean;
  safari: boolean;
  githubRepo: string;
  /** False: deploy with the kill switch off (Bedrock wasn't ready). */
  aiEnabled: boolean;
}

/** Big free email providers. Their addresses make a poor SES "from" address: mail sent as them is often filtered. */
export const FREE_MAIL_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
] as const;

export const isFreeMail = (email: string) => (FREE_MAIL_DOMAINS as readonly string[]).includes(email.trim().toLowerCase().split('@')[1] ?? '');

/** Why CloudFront needs us-east-1 (AWS WAF developer guide: a CloudFront web ACL is created in US East (N. Virginia)). */
export const cloudFrontNote = (region: string) =>
  `CloudFront is global, and AWS requires its firewall (AWS WAF) in us-east-1 (N. Virginia). Only that firewall lives there; your server, data and sign-in stay in ${region}.`;

/** The answers, as label/value rows. */
export const reviewRows = (a: ReviewAnswers): [string, string][] => [
  ['Environment', a.envName === 'staging' ? 'staging (a test copy)' : 'prod (the one players use)'],
  ['AI models', a.modelChoice === 'nova' ? 'Amazon Nova' : 'Claude'],
  ['AI at first', a.aiEnabled ? 'on' : 'off until Bedrock answers (run setup again to switch it on)'],
  ['Region', a.domainName ? a.region : `${a.region} (CloudFront's firewall: us-east-1)`],
  ['Web address', a.domainName || 'CloudFront HTTPS (https://xxxx.cloudfront.net)'],
  ['Sign-in page', `${a.cognitoDomainPrefix}.auth.${a.region}.amazoncognito.com`],
  ['Google sign-in', a.googleClientId ? `yes (${a.googleClientId.slice(0, 12)}…)` : 'no (email + password)'],
  ['Alarm email', a.alarmEmail || 'none'],
  ['Monthly budget', `$${a.monthlyBudgetUsd} (the AI switches off at 100%)`],
  ['Sign-up emails from', a.sesFromEmail ? `${a.sesFromEmail} (Amazon SES)` : 'Cognito’s default sender (~50 a day)'],
  ['Chrome Web Store id', a.storeId || 'none yet'],
  ['Local build signs in', a.allowDev ? 'yes' : 'no'],
  ['Other browsers', [a.firefox && 'Firefox', a.safari && 'Safari'].filter(Boolean).join(', ') || 'none'],
  ['GitHub deploys', a.githubRepo || 'no'],
];

/** What confirming will do in AWS, in order. */
export const plannedActions = (
  a: ReviewAnswers,
  ctx: { account: string; storeGoogleSecret: boolean; verifySes: boolean; deleteSes: readonly string[]; bootstrap: readonly string[] },
): string[] => [
  ...(ctx.storeGoogleSecret ? ['Store the Google client secret in Secrets Manager ("aws-city/google-oauth")'] : []),
  ...(ctx.verifySes ? [`Ask Amazon SES to verify ${a.sesFromEmail} (it sends a verification email)`] : []),
  ...ctx.deleteSes.map((e) => `Remove the SES identity ${e} (set up by an earlier run, no longer used)`),
  ...ctx.bootstrap.map((r) => `Prepare ${ctx.account}/${r} for CDK (one time)${r === 'us-east-1' && r !== a.region ? ': for CloudFront’s firewall' : ''}`),
  `Deploy AWS City (${a.envName}) in ${a.region}: about 15–25 minutes the first time`,
];

/** The review box's text: answers, then the AWS changes. */
export const reviewText = (rows: readonly [string, string][], actions: readonly string[]) => {
  const width = Math.max(...rows.map(([k]) => k.length));
  return [...rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`), '', 'In AWS, confirming will:', ...actions.map((x, i) => `  ${i + 1}. ${x}`)].join('\n');
};
