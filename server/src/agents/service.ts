import type { AwsClients } from '../aws.js';
import { type Resource, resourceKey, type WorldSnapshot } from '../state/model.js';
import type { Poller } from '../state/poller.js';
import { type Action, DESTRUCTIVE, parseAction, READ_ONLY } from './actions.js';
import { type ExecutionResult, executeAction } from './executor.js';
import { checkAction, describeAction } from './policy.js';
import { memoryLocks } from '../store/local.js';
import type { AccountLocks } from '../store/types.js';
import { log } from '../log.js';
import { withGrant } from '../guard/gate.js';
import { actionGrant } from '../guard/grants.js';
import { BLOCKED_REASON, type Judge, type Judgement, UNCHECKED_REASON } from './jev.js';

export type SubmitOutcome =
  | { status: 'done'; result: ExecutionResult }
  | { status: 'failed'; result: ExecutionResult }
  | { status: 'denied'; reason: string }
  | { status: 'invalid'; error: string };

/**
 * Every AWS write needs the player's OK (contract v2 deploy.preview → deploy.approve). Without an approval
 * channel, writes are refused rather than run unattended; only reads run.
 */
export const NEEDS_APPROVAL_REASON =
  "Changing AWS needs the player's approval, and there's no Approve button on this connection. Ask the player to do it in the AWS Console instead.";
export const REJECTED_REASON = 'The player said no, so nothing was changed.';
/** The account this world acts in was disconnected or changed (unlink, a new link, another task's change): nothing runs. */
export const RETIRED_REASON = 'Your AWS account was disconnected or changed meanwhile, so nothing was changed.';
/** The stored link couldn't be read right before the write (a store error): nothing runs. */
export const LINK_UNCHECKED_REASON = 'I couldn’t check your AWS account link just now, so nothing was changed. Try again in a moment.';

export interface ApprovalRequest {
  action: Action;
  summary: string;
  destructive: boolean;
  /**
   * The second opinion (Jev, agents/jev.ts) asked for more care: the player must type the resource's name to approve
   * (the preview's v2.3 confirmText), and `reason` says why. Absent: the ordinary preview.
   */
  check?: { reason: string };
  /** Aborted when the world this write belongs to is retired: the preview is cancelled (Approvals). */
  signal?: AbortSignal;
}
/** Asks the player (contract v2 deploy.preview); resolves true only on an explicit deploy.approve. */
export type Approve = (req: ApprovalRequest) => Promise<boolean>;

/**
 * The one path from "an agent wants to do X" to AWS: parse → policy → (second opinion) → approval → execute → re-poll.
 * Writes are serialised, and resources just created are counted before the (eventually consistent)
 * AWS listings show them, so parallel requests can't all slip under the same limit.
 */
export const createActionService = (deps: {
  clients: AwsClients;
  poller: Poller;
  region: string;
  /** Per-AWS-account lock + just-created list; in-process by default, DynamoDB when hosted. */
  locks?: AccountLocks;
  /** Which AWS account these writes go to (the lock key). */
  accountKey?: () => string;
  /** A second opinion on writes that may only tighten (Jev, with TYPESAFE_API_KEY). Undefined = off. */
  judge?: Judge;
  /**
   * Whether this world may still act on its account, asked inside the account lock right before anything runs (a write:
   * right before its grant is minted). `write`: also re-read the stored link. False refuses with RETIRED_REASON.
   */
  live?: (write: boolean) => Promise<boolean>;
  /** Aborted when this world is retired: pending previews are cancelled (the signal's reason says why). */
  retired?: AbortSignal;
}) => {
  const locks = deps.locks ?? memoryLocks();
  const accountKey = deps.accountKey ?? (() => deps.poller.current()?.accountId ?? 'local');
  const serialised = <T>(fn: (lease: AbortSignal) => Promise<T>): Promise<T> => locks.withLock(accountKey(), fn);

  const withJustCreated = async (snapshot: WorldSnapshot): Promise<WorldSnapshot> => {
    const seen = new Set(snapshot.resources.map(resourceKey));
    const extra = (await locks.pending(accountKey())).filter((r) => !seen.has(resourceKey(r)));
    return extra.length ? { ...snapshot, resources: [...snapshot.resources, ...extra] } : snapshot;
  };

  const remember = async (action: Action, result: ExecutionResult) => {
    const kind = action.type === 'launch_instance' ? 'instance' : action.type === 'create_table' ? 'table' : action.type === 'create_bucket' ? 'bucket' : null;
    if (!kind || !result.ok || !result.resourceId) return;
    const service = kind === 'instance' ? 'ec2' : kind === 'table' ? 'dynamodb' : 's3';
    const resource: Resource = { id: result.resourceId, service, kind, name: result.resourceId, state: 'pending', managedByGame: true, meta: {} };
    await locks.remember(accountKey(), resource, 60_000);
  };

  const run = (action: Action, confirmed: boolean) =>
    serialised(async (lease): Promise<SubmitOutcome> => {
      const snapshot = await withJustCreated(deps.poller.current() ?? (await deps.poller.refresh()));
      const decision = checkAction(action, snapshot, { confirmed });
      if (decision.verdict === 'deny') return { status: 'denied', reason: decision.reason };
      if (decision.verdict === 'confirm') return { status: 'denied', reason: NEEDS_APPROVAL_REASON };
      // The account may have been disconnected or changed while the player decided (or another task changed the link).
      // A store error reading the link refuses too (a plain sentence), so an approved card still gets its outcome.
      let live: boolean;
      try {
        live = !deps.live || (await deps.live(confirmed));
      } catch (err) {
        log.warn('link re-read failed', { err: (err as Error)?.name });
        return { status: 'denied', reason: LINK_UNCHECKED_REASON };
      }
      if (!live) return { status: 'denied', reason: RETIRED_REASON };

      // Past policy and the player's approval: the gate lets through exactly this action's writes, once each.
      const grant = confirmed ? actionGrant(action, snapshot.accountId) : undefined;
      const execute = () => executeAction(action, deps.clients, snapshot, deps.region, lease);
      const result = await (grant ? withGrant(grant, execute) : execute());
      await remember(action, result);
      if (result.ok && !READ_ONLY.has(action.type)) {
        const refresh = () => void deps.poller.refresh().catch((err) => log.warn('refresh after write failed', { err: (err as Error).name })); // the next scheduled poll retries
        refresh();
        // State transitions (pending → running, CREATING → ACTIVE) take a few seconds; look again soon.
        setTimeout(refresh, 4_000).unref();
      }
      return { status: result.ok ? 'done' : 'failed', result };
    });

  return {
    /**
     * Validates untrusted input (a model's tool call) and runs it through policy.
     * Every write is shown to the player first (no `approve` means no writes); policy is checked before asking
     * (don't ask about things that would be denied) and again inside the write lock after approval.
     * `intent`: the player's own words for this turn, for the second opinion (absent when the text isn't theirs).
     */
    async submit(name: unknown, input: unknown, opts: { approve?: Approve; intent?: string } = {}): Promise<SubmitOutcome> {
      const parsed = parseAction(name, input);
      if (!parsed.ok) return { status: 'invalid', error: parsed.error };
      const action = parsed.action;
      if (READ_ONLY.has(action.type)) return run(action, false);
      if (!opts.approve) return { status: 'denied', reason: NEEDS_APPROVAL_REASON };
      const snapshot = await withJustCreated(deps.poller.current() ?? (await deps.poller.refresh()));
      const pre = checkAction(action, snapshot, { confirmed: true });
      if (pre.verdict === 'deny') return { status: 'denied', reason: pre.reason };
      const summary = describeAction(action);
      const destructive = DESTRUCTIVE.has(action.type);
      // The second opinion only tightens: it can refuse, or make the player type the name; the approval below still runs.
      const second = deps.judge
        ? await deps.judge({ action, summary, destructive, intent: opts.intent }).catch((): Judgement => ({ verdict: 'ask', reason: UNCHECKED_REASON }))
        : undefined;
      if (second?.verdict === 'block') return { status: 'denied', reason: second.reason ?? BLOCKED_REASON };
      const check = second && second.verdict !== 'allow' ? { check: { reason: second.reason ?? UNCHECKED_REASON } } : {};
      const ok = await opts.approve({ action, summary, destructive, ...check, ...(deps.retired ? { signal: deps.retired } : {}) });
      if (!ok) return { status: 'denied', reason: deps.retired?.aborted ? RETIRED_REASON : REJECTED_REASON };
      return run(action, true);
    },
    describe: (name: unknown, input: unknown) => {
      const parsed = parseAction(name, input);
      return parsed.ok ? describeAction(parsed.action) : `Invalid ${String(name)}`;
    },
  };
};

export type ActionService = ReturnType<typeof createActionService>;
