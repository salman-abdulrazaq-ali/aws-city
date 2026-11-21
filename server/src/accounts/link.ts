import { randomBytes } from 'node:crypto';
import { EC2Client } from '@aws-sdk/client-ec2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import { fixesAllowed } from '../agents/fixes.js';
import { assumedRole, SDK_DEFAULTS } from '../aws.js';
import { guard } from '../guard/gate.js';
import { type AccountRecord, type AccountStore, sameLink } from '../store/types.js';

/** The player role's fixed name (infra/player-role/player-role.yaml): players only need their account id. */
export const playerRoleName = (region: string, prefix = 'AWSCityPlayerRole') => `${prefix}-${region}`;
/** Commercial-partition Regions only: our account (the trusted principal) is arn:aws, so GovCloud/China roles can't trust it. */
const REGION = /^[a-z]{2}-[a-z]+-\d$/;
const ROLE_ARN = /^arn:aws:iam::(\d{12}):role\/(AWSCityPlayerRole-[a-z0-9-]+)$/;

export class LinkError extends Error {}

/** A conditional write found another link (or none) than the one read: a Disconnect, DELETE /me or link on another task. */
export const LINK_CHANGED_MESSAGE = 'Your AWS account link changed meanwhile. Try again.';
const DELETED_MESSAGE = 'This AWS City account was just deleted, so I won’t link an AWS account to it.';

/** A setup link is good for a day: verify refuses an older one, so a link phished from another player ages out. */
export const LINK_TTL_MS = 24 * 60 * 60_000;

/** The template version a player-role template URL names (…/player-role/v<N>.yaml: infra/lib/data-stack.ts PLAYER_ROLE_KEY). */
export const templateVersion = (url: string): number | undefined => {
  const v = /\/v(\d+)\.yaml(?:[?#]|$)/.exec(url)?.[1];
  return v === undefined ? undefined : Number(v);
};

/** The characters the template's ConnectsPlayer parameter allows (its AllowedPattern), and its length. */
const LABEL_CHARS = /[^A-Za-z0-9 ._@*-]/g;
const LABEL_MAX = 64;

/**
 * Who a setup link connects, shown as the AWSCity stack's ConnectsPlayer parameter (visible on the quick-create page,
 * not NoEcho), so a player handed someone else's link can see it isn't theirs. Never a secret and never the raw email:
 * the public Mayor name ("Mayor Kind Otter") while the profile is public, else the email masked ("a***@e***.com") when
 * the sign-in carries one, else "Player " and the first 8 characters of the sign-in id. The Deploy tab shows the same
 * label (it's in the link) so the player knows what to look for.
 */
export const connectsPlayerLabel = (p: { sub: string; email?: string }, profile?: { public?: boolean; name?: string } | null): string => {
  const clean = (s: string) => s.replace(LABEL_CHARS, '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  const mayor = profile?.public && profile.name ? clean(`Mayor ${profile.name}`) : '';
  if (mayor.length > 'Mayor '.length) return mayor;
  const at = p.email?.lastIndexOf('@') ?? -1;
  if (p.email && at > 0) {
    const [local, domain] = [p.email.slice(0, at), p.email.slice(at + 1)];
    const dot = domain.lastIndexOf('.');
    const masked = clean(`${local[0]}***@${domain[0] ?? ''}***${dot > 0 ? domain.slice(dot) : ''}`);
    if (/^[A-Za-z0-9]/.test(masked)) return masked;
  }
  return `Player ${p.sub.replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'unknown'}`;
};

/**
 * Connecting a player's own AWS account:
 *  1. link: we mint a per-player ExternalId and hand back a CloudFormation quick-create URL for the
 *     player role (trusting only our task role, with that ExternalId), naming the player it connects
 *     (ConnectsPlayer) and, if they asked, AllowFixes=true. The link is good for LINK_TTL_MS.
 *  2. verify: we assume the role and check who we are before saving anything, then ask (a DryRun that
 *     changes nothing) whether the role allows fixes. The role version is the template version the link pointed at,
 *     recorded only when the player installed or updated the stack from that link (a first verify, another Region or
 *     account, or `updated`): the account can't be read for it. A template version that changes what the role allows
 *     must add a probe like fixes' DryRun, or the city would trust a version the stack doesn't have.
 *  3. recheck ("Check again"): the same DryRun for the linked role, read-only; the role version stays as it was.
 * We never see or store the player's keys; only the role ARN and the ExternalId. Every write is conditional on the record
 * it read (a first link only creates), so a DELETE /me or Disconnect on another task is never written back, and a player
 * deleted a moment ago (`deleted`) can neither link nor verify.
 */
export const createAccountLinker = (deps: {
  accounts: AccountStore;
  templateUrl: string;
  selfAccountId: string;
  /** AWSCityPlayerRole (prod) or AWSCityPlayerRole-<env>. */
  playerRolePrefix?: string;
  /** Hosted: the player's DELETE /me tombstone (Stores.deletedRecently). */
  deleted?: (sub: string) => Promise<boolean>;
  /**
   * Credentials for a role (a test seam; assumedRole). `feedsBreaker: false` (verify): its refusals stay out of the shared
   * refusal breaker (aws.ts): a stack not finished yet, or made from an older link, is refused the same way.
   */
  credentialsFor?: (o: { roleArn: string; externalId: string; sub: string; region: string; feedsBreaker?: boolean }) => AwsCredentialIdentityProvider;
  /** Test seam: GetCallerIdentity with those credentials. */
  whoAmI?: (region: string, credentials: AwsCredentialIdentityProvider) => Promise<{ Account?: string; Arn?: string }>;
  /** Test seam: whether the role allows fixes (fixesAllowed's DryRun), or undefined when it can't tell. */
  canFix?: (region: string, credentials: AwsCredentialIdentityProvider, accountId: string) => Promise<boolean | undefined>;
  now?: () => number;
}) => {
  const credentialsFor = deps.credentialsFor ?? assumedRole;
  const now = deps.now ?? Date.now;
  // Gated like every client with a player's credentials: this one can send GetCallerIdentity and nothing else.
  const whoAmI =
    deps.whoAmI ?? ((region, credentials) => guard(new STSClient({ ...SDK_DEFAULTS, region, credentials }), { home: region }).send(new GetCallerIdentityCommand({})));
  // Gated too: the only write-shaped request it can send without a grant is the EBS fix's DryRun.
  const canFix =
    deps.canFix ?? ((region, credentials, accountId) => fixesAllowed(guard(new EC2Client({ ...SDK_DEFAULTS, region, credentials }), { home: region, accountId: () => accountId })));
  /** The newest template version: the one every setup link points at. */
  const latestRoleVersion = templateVersion(deps.templateUrl);

  const quickCreateUrl = (region: string, externalId: string, opts: LinkOptions) => {
    const params: Record<string, string> = {
      templateURL: deps.templateUrl,
      stackName: 'AWSCity',
      param_ExternalId: externalId,
      // Visible on the quick-create page: who this link connects (a stranger's link names a stranger).
      param_ConnectsPlayer: opts.label,
      ...(opts.allowFixes ? { param_AllowFixes: 'true' } : {}),
      // No trust parameters: the published template has our account fixed in it.
    };
    // %20 for spaces (not form-encoding's +), so the console reads the label as written.
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    return `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/quickcreate?${query}`;
  };

  return {
    templateUrl: deps.templateUrl,
    latestRoleVersion,

    async link(sub: string, region: string, opts: LinkOptions) {
      if (!REGION.test(region)) throw new LinkError('That doesn’t look like an AWS region (e.g. us-west-2).');
      if (await deps.deleted?.(sub)) throw new LinkError(DELETED_MESSAGE);
      const existing = await deps.accounts.get(sub);
      // Every link starts a fresh day to verify in, and names the template version it points at.
      const issued = { linkIssuedAt: new Date(now()).toISOString(), ...(latestRoleVersion !== undefined ? { linkRoleVersion: latestRoleVersion } : {}) };
      // Re-linking keeps the same ExternalId, so a stack the player already installed keeps working. A linked account
      // stays linked (and usable) until verify succeeds for the new Region. A broken link goes back to pending.
      let record: AccountRecord;
      if (existing?.status === 'linked' && !existing.brokenAt) {
        const { pendingRegion: _, linkRoleVersion: _v, ...linked } = existing;
        record = { ...(existing.region === region ? linked : { ...linked, pendingRegion: region }), ...issued };
      } else record = { status: 'pending', externalId: existing?.externalId ?? randomBytes(24).toString('base64url'), region, ...issued };
      // Onto the record read (a first link only creates): another task's first link, a DELETE /me or Disconnect since wins.
      if (!(await deps.accounts.put(sub, record, existing ?? 'new'))) throw new LinkError(LINK_CHANGED_MESSAGE);
      return { url: quickCreateUrl(region, record.externalId, opts), externalId: record.externalId };
    },

    /**
     * Accepts the stack's RoleArn output or just the 12-digit account id. `updated`: the player says they updated the
     * stack with the latest link's template ("I've updated the stack"), so its version becomes the role version.
     */
    async verify(sub: string, input: string, opts: { updated?: boolean } = {}): Promise<AccountRecord & { status: 'linked' }> {
      if (await deps.deleted?.(sub)) throw new LinkError(DELETED_MESSAGE);
      const stored = await deps.accounts.get(sub);
      if (!stored) throw new LinkError('Start with “Get my setup link” first.');
      const issuedAt = stored.linkIssuedAt ? Date.parse(stored.linkIssuedAt) : Number.NaN;
      if (!(now() - issuedAt <= LINK_TTL_MS))
        throw new LinkError('Your setup link is more than a day old, so I won’t use it. Press “Get my setup link” again (a stack you already made from it keeps working), then check again.');
      // The Region asked for last (a linked player's new Region, else the record's own). What verify learns is fresh.
      const { pendingRegion, brokenAt: _b, fixes: _f, roleVersion: _r, ...rest } = stored;
      const record = { ...rest, region: pendingRegion ?? stored.region };
      const trimmed = input.trim();
      const prefix = deps.playerRolePrefix ?? 'AWSCityPlayerRole';
      const roleArn = /^\d{12}$/.test(trimmed) ? `arn:aws:iam::${trimmed}:role/${playerRoleName(record.region, prefix)}` : trimmed;
      const m = ROLE_ARN.exec(roleArn);
      if (!m || !m[2]!.startsWith(`${prefix}-`)) throw new LinkError('Paste your 12-digit AWS account id (or the RoleArn from the AWSCity stack).');
      if (m[1] === deps.selfAccountId) throw new LinkError('That’s the city’s own account — use your account.');
      let id: { Account?: string; Arn?: string };
      // Not a link that worked yet: a refusal here (Verify before CREATE_COMPLETE, an older link's stack) is no outage.
      const credentials = credentialsFor({ roleArn, externalId: record.externalId, sub, region: record.region, feedsBreaker: false });
      try {
        id = await whoAmI(record.region, credentials);
      } catch {
        throw new LinkError(`I couldn’t use the AWSCity role in ${m[1]} (${record.region}). Is the stack finished, in that region, and made from your latest setup link?`);
      }
      if (id.Account !== m[1] || !id.Arn?.includes(`:assumed-role/${m[2]}/`)) throw new LinkError('That role isn’t the AWSCity player role.');
      // Changes nothing: a DryRun (undefined when AWS's answer can't tell).
      const fixes = await canFix(record.region, credentials, m[1]).catch(() => undefined);
      // Installed from this link: a first verify (pending), a new Region or account, or the player updated the stack.
      const installed = stored.status !== 'linked' || pendingRegion !== undefined || stored.accountId !== m[1] || opts.updated === true;
      const roleVersion = installed ? record.linkRoleVersion : stored.roleVersion;
      const linked = {
        ...record,
        status: 'linked' as const,
        roleArn,
        accountId: m[1],
        linkedAt: new Date(now()).toISOString(),
        ...(roleVersion !== undefined ? { roleVersion } : {}),
        ...(fixes !== undefined ? { fixes } : {}),
      };
      // Onto the record it started from: a DELETE /me or Disconnect on another task meanwhile is never written back.
      if (!(await deps.accounts.put(sub, linked, stored))) throw new LinkError(LINK_CHANGED_MESSAGE);
      return linked;
    },

    /**
     * "Check again": asks the linked role, without changing anything, whether it allows fixes (the DryRun verify makes).
     * No new link window and the role version stays; only `fixes` is written (an unclear answer keeps the known one).
     * Refused (LinkError) with nothing linked, a role that can't be used, or a link that changed while it asked.
     */
    async recheck(sub: string): Promise<AccountRecord & { status: 'linked' }> {
      const stored = await deps.accounts.get(sub);
      if (stored?.status !== 'linked' || !stored.roleArn || !stored.accountId) throw new LinkError('Connect your AWS account first.');
      if (stored.brokenAt) throw new LinkError('The AWSCity role stopped working. Link again, or disconnect.');
      const { region, accountId } = stored;
      const credentials = credentialsFor({ roleArn: stored.roleArn, externalId: stored.externalId, sub, region });
      try {
        const id = await whoAmI(region, credentials);
        if (id.Account !== accountId) throw new Error('another account');
      } catch {
        throw new LinkError(`I couldn’t use the AWSCity role in ${accountId} (${region}) just now. Is the stack still there? Try again in a minute.`);
      }
      const probed = await canFix(region, credentials, accountId).catch(() => undefined);
      // Only while it's still this link: a Disconnect, DELETE /me or a new link on another task meanwhile is never written
      // back (the ExternalId and role ARN would outlive them).
      const latest = await deps.accounts.get(sub);
      if (latest?.status !== 'linked' || latest.accountId !== accountId || latest.region !== region || !sameLink(latest, stored)) throw new LinkError(LINK_CHANGED_MESSAGE);
      // A DryRun that can't tell keeps the known answer: nothing to write.
      if (probed === undefined) return { ...latest, status: 'linked' };
      // Only `fixes`, in place and conditional on the same link: whatever else changed since (a new setup link on another
      // task: pendingRegion, its window) stays.
      const next = await deps.accounts.update(sub, { fixes: probed }, stored);
      if (next?.status !== 'linked') throw new LinkError(LINK_CHANGED_MESSAGE);
      return { ...next, status: 'linked' };
    },
  };
};

/** What a setup link carries besides the ExternalId. */
export interface LinkOptions {
  /** The stack's ConnectsPlayer (connectsPlayerLabel). */
  label: string;
  /** v2.17: AllowFixes=true on the quick-create page (the player ticked "Allow small fixes"). */
  allowFixes?: boolean;
}

export type AccountLinker = ReturnType<typeof createAccountLinker>;
