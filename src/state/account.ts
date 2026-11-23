// A real AWS account as the player sees it (contract v2.19). Pure: no store, no I/O, so the Deploy tab, the To-do list,
// ⋯ → Account and City care agree. Which Regions a link can use, whether a link is under way (the Deploy tab stays in
// sight), the To-do row that offers one, the role update and "turn fixes on" steps, and the city's own builds that
// "Take it down" can remove (resource.remove).

import type { ConnectionStatus } from '@/backend/AgentBackend';
import type { InventoryItem, ResourceRemove } from '@/backend/contract';
import { isPracticeDeploy } from '@/backend/ServerBackend';
import { FACTS, regionInfo } from '@/world/regions';

/** The account fields these rules read (the store's AccountState has them all). */
export interface AccountLike {
  linked: boolean;
  region?: string;
  linkUrl?: string;
  mfaRequired?: boolean;
  /** v2.19: the link is kept but its role can't be used any more (the server stopped reading the account). */
  broken?: boolean;
  roleVersion?: number;
  latestRoleVersion?: number;
  templateUrl?: string;
  /** The Region the player asked a setup link for last (this session). */
  linkRegion?: string;
}

export interface LinkRegion {
  code: string;
  name: string;
  /** An opt-in Region: the account must have it turned on first. */
  optIn: boolean;
}

/** "0474-6343-8585": an account id as the console shows it. */
export const accountLabel = (id: string) => id.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3');

/** The role an AWS Organization makes in each member account, which "Switch role" asks for unless the player changed it. */
export const DEFAULT_CONSOLE_ROLE = 'OrganizationAccountAccessRole';

/**
 * AWS's Switch role page for the linked account, coming back to the console in its Region: the console has to be signed
 * into the account the city reads, or what's made there never shows (seen 23 Nov 2026). Undefined for anything that
 * isn't a 12-digit account or a valid role name.
 */
export function switchRoleUrl(accountId: string, region: string | undefined, role = DEFAULT_CONSOLE_ROLE): string | undefined {
  if (!/^\d{12}$/.test(accountId) || !/^[\w+=,.@-]{1,64}$/.test(role)) return undefined;
  const back = region && /^[a-z]{2}(-[a-z]+)+-\d$/.test(region) ? `https://${region}.console.aws.amazon.com/console/home?region=${region}` : 'https://console.aws.amazon.com/console/home';
  const q = new URLSearchParams({ account: accountId, roleName: role, displayName: `AWSCity-${accountId.slice(-4)}`, redirect_uri: back });
  return `https://signin.aws.amazon.com/switchrole?${q.toString()}`;
}

/** "US West (Oregon)"; the code itself for a Region the facts don't name. */
export const regionName = (code: string) => regionInfo(code)?.name ?? code;

/**
 * The Regions a link can use, by name: the commercial partition only. The AWSCity role trusts the city's own account
 * (arn:aws), so a GovCloud or sovereign-cloud account can't link (server/src/accounts/link.ts refuses them too).
 */
export const LINK_REGIONS: readonly LinkRegion[] = Object.entries(FACTS.regions)
  .filter(([, f]) => f.partition === 'aws')
  .map(([code, f]) => ({ code, name: regionName(code), optIn: f.optIn }))
  .sort((a, b) => a.name.localeCompare(b.name));

export const isLinkRegion = (code: string | undefined): code is string => !!code && LINK_REGIONS.some((r) => r.code === code);

/** The Region a link starts on: the one asked for last, the linked one, else the city's (each only where a link can go). */
export const defaultLinkRegion = (a: Pick<AccountLike, 'linkRegion' | 'region'>, cityRegion: string) =>
  [a.linkRegion, a.region, cityRegion].find(isLinkRegion) ?? 'us-east-1';

/**
 * A real account is being linked: a setup link is out, the server asked for an authenticator first, or the link broke.
 * The Deploy tab (where the steps are) stays in sight meanwhile (src/state/ladder.ts, src/state/simple.ts).
 */
export const linking = (a: AccountLike) => !a.linked && !!(a.linkUrl || a.mfaRequired || a.broken);

/**
 * The To-do row (and the shift's line) for a signed-in player on the hosted server with no working link: 'connect',
 * or 'relink' once the link broke. Never on the demo or the local server (it reads the developer's own account).
 */
export function connectOffer(s: { hosted: boolean; status: ConnectionStatus; account: AccountLike }): 'connect' | 'relink' | undefined {
  if (!s.hosted || s.status === 'signed-out' || s.account.linked) return undefined;
  return s.account.broken ? 'relink' : 'connect';
}

/** "Update your AWS City role (v3 → v4)": both versions known and the installed one older. */
export function roleUpdate(a: AccountLike): { from: number; to: number; templateUrl?: string } | undefined {
  if (!a.linked || a.roleVersion === undefined || a.latestRoleVersion === undefined || a.roleVersion >= a.latestRoleVersion) return undefined;
  return { from: a.roleVersion, to: a.latestRoleVersion, templateUrl: a.templateUrl };
}

/** The CloudFormation stacks page in a Region, filtered to the AWSCity stack (an AWS Console page: runtime's openUrl opens it). */
export const stacksUrl = (region: string) => `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks?filteringText=AWSCity`;

/**
 * Who the stack serves, as the setup link names it (`param_ConnectsPlayer` in the quick-create link's hash query, player
 * role v5): the stack page shows it, so a player can tell a link meant for someone else. Undefined when the link has none.
 */
export function connectsPlayer(linkUrl: string | undefined): string | undefined {
  const query = linkUrl?.split('#')[1]?.split('?').slice(1).join('?');
  if (!query) return undefined;
  return new URLSearchParams(query).get('param_ConnectsPlayer')?.trim() || undefined;
}

/**
 * The role template to read before linking ("See the exact permissions"): the one account.status names, else the one the
 * setup link carries (`templateURL` in its hash query). Only an https address on an AWS host (the template is published to
 * S3), so a link never opens anywhere else; undefined when neither has one.
 */
export function templateLink(a: Pick<AccountLike, 'templateUrl' | 'linkUrl'>): string | undefined {
  const query = a.linkUrl?.split('#')[1]?.split('?').slice(1).join('?');
  for (const raw of [a.templateUrl, query ? new URLSearchParams(query).get('templateURL') : undefined]) {
    try {
      const u = raw ? new URL(raw) : undefined;
      if (u?.protocol === 'https:' && !u.username && !u.password && u.hostname.endsWith('.amazonaws.com')) return u.toString();
    } catch {
      /* not a URL */
    }
  }
  return undefined;
}

/** What the CloudFormation console asks while the role is made (step 2 of linking). */
export const linkChecklist = (region: string) => [
  `Sign in to the AWS account you want to connect, with ${regionName(region)} picked in the console’s Region menu.`,
  'Use a sign-in that may create IAM roles and CloudFormation stacks (workshop accounts can’t).',
  'Tick “I acknowledge that AWS CloudFormation might create IAM resources with custom names.”',
  'Press Create stack and wait for CREATE_COMPLETE (about a minute).',
  'Come back here and press Verify.',
];

/**
 * Updating the AWSCity stack to the newest role, step by step. The ExternalId stays (it's the secret the link uses);
 * the newest role asks for ConnectsPlayer, the name that says who the stack serves (`label`, from a fresh setup link).
 */
export const roleUpdateSteps = (templateUrl?: string, label?: string) => [
  'In CloudFormation, open the AWSCity stack.',
  'Press Update, then pick Replace existing template.',
  templateUrl ? `Pick Amazon S3 URL and paste: ${templateUrl}` : 'Pick Amazon S3 URL and paste the new template’s address.',
  `Press Next. Set ConnectsPlayer to ${label ?? 'the name shown here'}, and keep the ExternalId as it is.`,
  'Press Next, then tick “I acknowledge that AWS CloudFormation might create IAM resources with custom names.”',
  'Press Update (or Submit). When it says UPDATE_COMPLETE, press “I’ve updated the stack” here.',
];

/** Turning small fixes on for a stack made without them (AllowFixes=true); each fix is still approved one by one. */
export const FIXES_ON_STEPS = [
  'In CloudFormation, open the AWSCity stack.',
  'Press Update, then pick Use existing template.',
  'Press Next and set AllowFixes to true. Keep the ExternalId as it is.',
  'Press Next, then tick “I acknowledge that AWS CloudFormation might create IAM resources with custom names.”',
  'Press Update (or Submit). When it says UPDATE_COMPLETE, press Check again.',
];

/**
 * What "Allow small fixes" adds to the role (infra/player-role/player-role.yaml, aws-city-fix), said before the player
 * ticks it, and who holds each to tightening: IAM can for the last two, only AWS City's server for the first three.
 */
export const FIX_GRANTS = [
  'Turn on S3 Block Public Access on any bucket in that Region.',
  'Remove an inbound rule from any security group.',
  'Turn on DynamoDB point-in-time recovery on any table.',
  'Require IMDSv2 on an instance.',
  'Turn on EBS encryption by default.',
];
export const FIX_GRANTS_CAVEAT =
  'IAM holds the last two to tightening. It can’t for the first three: the same permissions could also turn Block Public Access or backups off, or remove any rule. AWS City’s server holds those to tightening: it only turns them on, and removes only the SSH or RDP rules you approved.';

/** What the AWSCity role allows (player-role.yaml v5), read before linking: what's account-wide, and which promises the server keeps rather than IAM. */
export const ROLE_CAN = [
  'Read, in the Region you pick: your servers, security groups, disks, tables, Lambda functions, databases, APIs, CloudTrail trails, each bucket’s Block Public Access and the resource list. Once you turn live traffic on, a few request counts from CloudWatch too. Never what’s inside your buckets or tables, your logs or your secrets.',
  'Read, account-wide: the list of all your buckets, the Availability Zones of every Region and which Regions are turned on. Also your month-to-date bill: the role allows that read at any time, but AWS City’s server reads it only after you turn the bill on.',
  'Build, in that Region only: small t4g servers, tables named city-* and buckets named aws-city-<your account>-*. It stops, starts and deletes only servers and tables tagged as the city’s, and buckets with that name.',
  'Never: IAM, billing settings or passing roles.',
];

/** The local server reads the developer's own profile: fixes are a start option there, never a CloudFormation update. */
export const LOCAL_FIXES_COMMAND = 'npm run live -- --allow-fixes';

/** Steps as one block of text, numbered, for the Copy button. */
export const stepsText = (steps: readonly string[]) => steps.map((s, i) => `${i + 1}. ${s}`).join('\n');

// ── The city's own builds (managedByGame) and taking them down ──────────────────

export type RemoveKind = ResourceRemove['kind'];

/**
 * What resource.remove needs for a resource (from its ARN): an EC2 instance's id, a DynamoDB table's name or an S3
 * bucket's name. Anything else the city built is removed in the AWS console (or with its stack's Tear down).
 */
export function removeTarget(arn: string): { kind: RemoveKind; id: string } | undefined {
  const [, , service, , , ...rest] = arn.split(':');
  const res = rest.join(':');
  if (service === 'ec2' && /^instance\/i-[0-9a-f]{8,17}$/.test(res)) return { kind: 'instance', id: res.slice('instance/'.length) };
  if (service === 'dynamodb' && /^table\/[A-Za-z0-9_.-]{3,255}$/.test(res)) return { kind: 'table', id: res.slice('table/'.length) };
  if (service === 's3' && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(res)) return { kind: 'bucket', id: res };
  return undefined;
}

/** The resources the city built in the account (city.inventory `managedByGame`): they survive a reload, unlike a session's deploys. */
export const gameBuilds = (inventory: { items: readonly InventoryItem[] } | undefined): InventoryItem[] => (inventory?.items ?? []).filter((i) => i.managedByGame);

/**
 * How many things the city built are still in the account (they may keep billing after the AWS City account is gone):
 * the inventory's own, else this session's finished stacks (before the next inventory lists them; a practice build
 * made nothing).
 */
export function stillBuilt(inventory: { items: readonly InventoryItem[] } | undefined, deploys: readonly { deployId: string; status: string; findingId?: string }[]) {
  return gameBuilds(inventory).length || deploys.filter((d) => !d.findingId && d.status === 'complete' && !isPracticeDeploy(d.deployId)).length;
}
