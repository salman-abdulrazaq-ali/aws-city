import { randomUUID } from 'node:crypto';
import type { ActionName } from '../agents/actions.js';
import type { ToolCallReport } from '../agents/runner.js';
import type { ApprovalRequest } from '../agents/service.js';
import type { CityFinding, DeployChange, ServerEvent } from '../world.js';

type Emit = (e: ServerEvent) => void;

const RESOURCE_TYPE: Record<ActionName, string> = {
  launch_instance: 'AWS::EC2::Instance',
  stop_instance: 'AWS::EC2::Instance',
  start_instance: 'AWS::EC2::Instance',
  terminate_instance: 'AWS::EC2::Instance',
  create_table: 'AWS::DynamoDB::Table',
  delete_table: 'AWS::DynamoDB::Table',
  create_bucket: 'AWS::S3::Bucket',
  delete_bucket: 'AWS::S3::Bucket',
  describe_resource: 'N/A',
  review_architecture: 'N/A',
};

const COST: Partial<Record<ActionName, string>> = {
  launch_instance: 'Billed per second while running (t4g.nano/micro are the smallest Graviton sizes).',
  create_table: 'On-demand: pay per request, ~$0 when idle.',
  create_bucket: 'Pay per GB stored and per request; an empty bucket costs nothing.',
  terminate_instance: 'Stops all charges for this instance. Permanent.',
  delete_table: 'Deletes the table and every item in it. Permanent.',
  delete_bucket: 'Deletes the (empty) bucket. Permanent.',
};

/** What a fix changes, by the finding's service. */
const FIX_RESOURCE_TYPE: Record<string, string> = {
  s3: 'AWS::S3::Bucket',
  vpc: 'AWS::EC2::SecurityGroup',
  ec2: 'AWS::EC2::Instance',
  ebs: 'EBS encryption by default',
  dynamodb: 'AWS::DynamoDB::Table',
};

/** The resource's own name or id as the action gives it (a new bucket: only its suffix so far), if it gives one. */
const ownName = (a: ApprovalRequest['action']): string | undefined => {
  if ('name' in a) return String(a.name);
  if ('instanceId' in a) return String(a.instanceId);
  if ('suffix' in a) return String(a.suffix);
  return undefined;
};

/**
 * What a change touches, as the card's resource name: a bucket's full name once the account is known (so Tear down can
 * name it), else its suffix after "aws-city-…-".
 */
const labelOf = (a: ApprovalRequest['action'], accountId?: string): string =>
  'suffix' in a ? `aws-city-${accountId ?? '…'}-${String(a.suffix)}` : (ownName(a) ?? a.type);

/** What the player types before a destructive write or one a second look flagged: the resource's own name or id (never empty, never "…"). */
const typedName = (a: ApprovalRequest['action']): string => ownName(a)?.trim() || a.type;

/** What a preview cancelled because its account went away says (the world's retire reason, when it gives one). */
export const DISCONNECTED_MESSAGE = 'That account was disconnected, so nothing changed.';

/**
 * Per-socket player approvals (contract v2): a guarded write becomes deploy.preview; the player answers
 * with deploy.approve / deploy.reject. Unanswered requests expire; closing the socket rejects them all, and so does
 * the request's `signal` (its account's world was retired: disconnected or changed), with the signal's reason.
 */
export const createApprovals = (opts: { region: string | (() => string); accountId?: () => string | undefined; timeoutMs?: number }) => {
  /** v2.18: exactly where the change goes, read as each card is made. */
  const where = () => {
    const accountId = opts.accountId?.();
    return { region: typeof opts.region === 'function' ? opts.region() : opts.region, ...(accountId ? { accountId } : {}) };
  };
  const pending = new Map<string, { resolve: (ok: boolean) => void; emit: Emit; timer: NodeJS.Timeout; confirmText?: string; unwatch?: () => void }>();
  const awaitingResult = new Map<string, string>(); // taskId → deployId of the approved call in flight

  const settle = (deployId: string, ok: boolean, reason?: string) => {
    const p = pending.get(deployId);
    if (!p) return false;
    pending.delete(deployId);
    clearTimeout(p.timer);
    p.unwatch?.();
    if (!ok) p.emit({ type: 'deploy.status', deployId, status: 'rejected', message: reason ?? 'Nothing was changed.' });
    p.resolve(ok);
    return true;
  };
  /** A retired world cancels its pending previews: at once if it already was, else when it is. */
  const watch = (deployId: string, signal?: AbortSignal) => {
    if (!signal) return undefined;
    const cancel = () => settle(deployId, false, typeof signal.reason === 'string' ? signal.reason : DISCONNECTED_MESSAGE);
    if (signal.aborted) {
      queueMicrotask(cancel);
      return undefined;
    }
    signal.addEventListener('abort', cancel, { once: true });
    return () => signal.removeEventListener('abort', cancel);
  };

  return {
    /** `requestId`: a direct command's (v2.19 resource.remove), put on the preview so the client can match it. */
    request(taskId: string, req: ApprovalRequest, emit: Emit, requestId?: string): Promise<boolean> {
      const deployId = `a-${randomUUID().slice(0, 8)}`;
      const t = req.action.type;
      const change: DeployChange = {
        action: req.destructive ? 'Remove' : t === 'stop_instance' || t === 'start_instance' ? 'Modify' : 'Add',
        logicalId: labelOf(req.action, opts.accountId?.()),
        resourceType: RESOURCE_TYPE[t],
      };
      // The player types the name (v2.3 confirmText) before a destructive write (terminate, delete, a take-down), so one
      // stray Enter or Space can never approve it; and when a second look (Jev) asked for care, with why on a 'detail' line.
      const confirmText = req.check || req.destructive ? typedName(req.action) : undefined;
      const why: DeployChange[] = req.check ? [{ action: 'Modify', logicalId: `Safety check: ${req.check.reason}`, resourceType: 'detail' }] : [];
      emit({
        type: 'deploy.preview',
        ...(requestId ? { requestId } : {}),
        deployId,
        taskId,
        templateId: t,
        stackName: req.summary,
        ...where(),
        changes: [change, ...why],
        costNote: COST[t],
        ...(confirmText ? { confirmText } : {}),
      });
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(deployId, false, 'No answer within 5 minutes, so nothing was changed.'), opts.timeoutMs ?? 300_000);
        timer.unref?.();
        pending.set(deployId, { resolve: (ok) => (ok && awaitingResult.set(taskId, deployId), resolve(ok)), emit, timer, confirmText });
        pending.get(deployId)!.unwatch = watch(deployId, req.signal);
      });
    },
    /**
     * A citizen's fix (contract v2.3): the preview carries the finding, its rollback text and, for a resource the city
     * didn't build or an account-wide setting, the text the player must type. Resolves true only on approve + match.
     */
    requestFix(requestId: string, f: CityFinding & { fix: NonNullable<CityFinding['fix']> }, emit: Emit, confirmText?: string, detail: string[] = [], signal?: AbortSignal) {
      const deployId = `f-${randomUUID().slice(0, 8)}`;
      emit({
        type: 'deploy.preview',
        requestId,
        deployId,
        templateId: f.fix.fixId,
        stackName: f.fix.title,
        ...where(),
        // Names aren't unique (every VPC has a "default" group): the id says exactly which resource changes.
        changes: [
          { action: 'Modify', logicalId: f.resource.id === f.resource.name || f.resource.id.includes(':') ? f.resource.name : `${f.resource.name} (${f.resource.id})`, resourceType: FIX_RESOURCE_TYPE[f.serviceId] ?? 'AWS account setting' },
          ...detail.map((d) => ({ action: 'Modify' as const, logicalId: d, resourceType: 'detail' })),
        ],
        costNote: f.fix.costNote,
        findingId: f.id,
        rollback: f.fix.rollback,
        ...(confirmText ? { confirmText } : {}),
      });
      const approved = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => settle(deployId, false, 'No answer within 5 minutes, so nothing was changed.'), opts.timeoutMs ?? 300_000);
        timer.unref?.();
        pending.set(deployId, { resolve, emit, timer, confirmText });
        pending.get(deployId)!.unwatch = watch(deployId, signal);
      });
      return { deployId, approved };
    },
    /** From the client: returns false if the id is unknown/expired. `confirm` must match the preview's confirmText (a fix, a destructive write, or a write the second look flagged). */
    answer(deployId: string, ok: boolean, confirm?: string): boolean {
      const p = pending.get(deployId);
      if (p && ok && p.confirmText && confirm?.trim() !== p.confirmText) return settle(deployId, false, 'The name you typed didn’t match, so nothing was changed.');
      if (p && ok) p.emit({ type: 'deploy.status', deployId, status: 'creating' });
      return settle(deployId, ok);
    },
    /** After the approved tool call ran: report the real outcome on the same deployId. False if nothing was approved for it. */
    reportResult(taskId: string, call: ToolCallReport, emit: Emit): boolean {
      const deployId = awaitingResult.get(taskId);
      if (!deployId) return false;
      awaitingResult.delete(taskId);
      const ok = call.outcome === 'done';
      // ResourceId: what a launch made (its i-… id), so the card joins the later stop/terminate cards of the same server.
      emit({ type: 'deploy.status', deployId, status: ok ? 'complete' : 'failed', message: call.message, outputs: ok ? { Result: call.message, ...(call.resourceId ? { ResourceId: call.resourceId } : {}) } : undefined });
      return true;
    },
    cancelAll() {
      for (const id of [...pending.keys()]) settle(id, false, 'Connection closed, so nothing was changed.');
    },
    get size() {
      return pending.size;
    },
  };
};

export type Approvals = ReturnType<typeof createApprovals>;
