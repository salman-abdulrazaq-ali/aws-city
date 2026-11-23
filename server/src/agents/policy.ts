import { bucketPrefix, type Resource, type WorldSnapshot } from '../state/model.js';
import { publicErrors } from '../log.js';
import { type Action, DESTRUCTIVE } from './actions.js';

export const LIMITS = { instances: 3, tables: 5, buckets: 3 } as const;

export type PolicyDecision =
  | { verdict: 'allow' }
  | { verdict: 'deny'; reason: string }
  | { verdict: 'confirm'; summary: string };

const LIVE_INSTANCE_STATES = new Set(['pending', 'running', 'stopping', 'stopped']);

const find = (snapshot: WorldSnapshot, kind: Resource['kind'], id: string) =>
  snapshot.resources.find((r) => r.kind === kind && r.id === id);

/** What the switch is called where the player turns it on (Deploy → Your AWS account). */
export const CLEANUP_SWITCH = 'Let the city change things you made';

/**
 * Only what the city built may change, unless `cleanup`: the player turned on "Let the city change things you made" and
 * their AWS role allows it (AllowCleanup, player role v6). It covers servers and buckets the player made, never tables
 * (asked for on 23 Nov 2026). Every removal still needs the typed name, MFA and Approve.
 */
const requireGameOwned = (r: Resource | undefined, label: string, id: string, cleanup?: boolean): PolicyDecision | null => {
  if (!r) return { verdict: 'deny', reason: `There is no ${label} "${id}" in the city right now.` };
  if (!r.managedByGame) {
    if (cleanup) return null;
    return {
      verdict: 'deny',
      reason:
        cleanup === false
          ? `"${r.name}" wasn't built by the city, so the agents can look at it but not change it. To let them, turn on “${CLEANUP_SWITCH}” in Deploy → Your AWS account.`
          : `"${r.name}" wasn't built by the game, so players and agents can look at it but not change it.`,
    };
  }
  return null;
};

/**
 * Guardrails for every write. Rules:
 *  - only resources the game created (tagged / name-prefixed) can be changed
 *  - count limits keep the workshop account small and cheap
 *  - destructive actions need explicit player approval (`confirmed`)
 */
export const checkAction = (action: Action, snapshot: WorldSnapshot, opts: { confirmed: boolean; cleanup?: boolean }): PolicyDecision => {
  // Servers and buckets the player made: false names the switch in the refusal, true lets them through.
  const cleanup = opts.cleanup ?? false;
  const count = (pred: (r: Resource) => boolean) => snapshot.resources.filter(pred).length;

  if (snapshot.credentials === 'expired') {
    // Hosted, the player role's short-lived credentials renew themselves; locally the developer's profile keys need a refresh.
    return { verdict: 'deny', reason: publicErrors() ? "The city's access to your AWS account expired. Try again in a moment." : 'AWS credentials have expired. Refresh the workshop keys first.' };
  }

  switch (action.type) {
    case 'describe_resource':
    case 'review_architecture':
      return { verdict: 'allow' };

    case 'launch_instance': {
      const live = count((r) => r.kind === 'instance' && r.managedByGame && LIVE_INSTANCE_STATES.has(r.state));
      if (live >= LIMITS.instances) {
        return { verdict: 'deny', reason: `The city already has ${live} game-built houses (limit ${LIMITS.instances}). Stop or demolish one first.` };
      }
      break;
    }

    case 'stop_instance':
    case 'start_instance':
    case 'terminate_instance': {
      const r = find(snapshot, 'instance', action.instanceId);
      const denied = requireGameOwned(r, 'house (EC2 instance)', action.instanceId, cleanup);
      if (denied) return denied;
      if (r!.state === 'terminated' || r!.state === 'shutting-down') return { verdict: 'deny', reason: `"${r!.name}" is already being demolished.` };
      break;
    }

    case 'create_table': {
      if (find(snapshot, 'table', action.name)) return { verdict: 'deny', reason: `A library called "${action.name}" already exists.` };
      const tables = count((r) => r.kind === 'table' && r.managedByGame);
      if (tables >= LIMITS.tables) return { verdict: 'deny', reason: `Library limit reached (${LIMITS.tables}).` };
      break;
    }

    case 'delete_table': {
      const denied = requireGameOwned(find(snapshot, 'table', action.name), 'library (DynamoDB table)', action.name);
      if (denied) return denied;
      break;
    }

    case 'create_bucket': {
      const buckets = count((r) => r.kind === 'bucket' && r.managedByGame);
      if (buckets >= LIMITS.buckets) return { verdict: 'deny', reason: `Warehouse limit reached (${LIMITS.buckets}).` };
      if (find(snapshot, 'bucket', bucketPrefix(snapshot.accountId) + action.suffix)) {
        return { verdict: 'deny', reason: 'That warehouse already exists.' };
      }
      break;
    }

    case 'delete_bucket': {
      const r = find(snapshot, 'bucket', action.name);
      if (!action.name.startsWith(bucketPrefix(snapshot.accountId))) {
        if (!r) return { verdict: 'deny', reason: `There is no warehouse (S3 bucket) "${action.name}" in your account.` };
        // A bucket the player made: only with the switch on, and only in the home Region (the role allows no other).
        const denied = requireGameOwned({ ...r, managedByGame: false }, 'warehouse (S3 bucket)', action.name, cleanup);
        if (denied) return denied;
        const where = r.meta.bucketRegion;
        if (typeof where === 'string' && where !== snapshot.region) {
          return { verdict: 'deny', reason: `"${r.name}" is in ${where}; the city changes things only in your home Region (${snapshot.region}).` };
        }
        break;
      }
      const denied = requireGameOwned(r, 'warehouse (S3 bucket)', action.name);
      if (denied) return denied;
      break;
    }
  }

  if (DESTRUCTIVE.has(action.type) && !opts.confirmed) return { verdict: 'confirm', summary: describeAction(action) };
  return { verdict: 'allow' };
};

export const describeAction = (action: Action): string => {
  switch (action.type) {
    case 'launch_instance':
      return `Launch a ${action.instanceType} EC2 instance named "${action.name}"`;
    case 'stop_instance':
      return `Stop EC2 instance ${action.instanceId}`;
    case 'start_instance':
      return `Start EC2 instance ${action.instanceId}`;
    case 'terminate_instance':
      return `Permanently terminate EC2 instance ${action.instanceId}`;
    case 'create_table':
      return `Create DynamoDB table "${action.name}"`;
    case 'delete_table':
      return `Delete DynamoDB table "${action.name}" and all its items`;
    case 'create_bucket':
      return `Create S3 bucket with suffix "${action.suffix}"`;
    case 'delete_bucket':
      return `Delete S3 bucket "${action.name}"`;
    case 'describe_resource':
      return `Describe ${action.id}`;
    case 'review_architecture':
      return 'Well-Architected review of the city';
  }
};
