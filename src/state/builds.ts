import type { DeployView } from './store';

/**
 * "My builds" for the agents' changes (src/ui/DeployPanel.tsx): one card per AWS resource, not per approval. Launch,
 * stop and terminate of one server are one card with its latest status and a history line, never three cards, and
 * never "live" after a removal (seen live, 21 Nov 2026). Pure.
 */

/** The server's action templates (server/src/agents/actions.ts, one approval per change). */
const ACTIONS = new Set(['launch_instance', 'stop_instance', 'start_instance', 'terminate_instance', 'create_table', 'delete_table', 'create_bucket', 'delete_bucket']);
const CREATES = new Set(['launch_instance', 'create_table', 'create_bucket']);
const REMOVES = new Set(['terminate_instance', 'delete_table', 'delete_bucket']);
const KIND: Record<string, string> = { 'AWS::EC2::Instance': 'Server', 'AWS::S3::Bucket': 'Bucket', 'AWS::DynamoDB::Table': 'Table' };
const DONE_WORD: Record<string, string> = {
  launch_instance: 'built',
  create_table: 'built',
  create_bucket: 'built',
  stop_instance: 'stopped',
  start_instance: 'started',
  terminate_instance: 'removed',
  delete_table: 'removed',
  delete_bucket: 'removed',
};

/** What an approval changes: its 'detail' rows are the server's words about it ("Safety check: …"), not resources. */
const resourcesOf = (d: DeployView) => d.changes.filter((c) => c.resourceType !== 'detail');

/** An approval for one of the agents' changes (not a fix, not a practice template's stack). */
export const isAgentChange = (d: DeployView) => ACTIONS.has(d.templateId) && !d.findingId && resourcesOf(d).length === 1;

/** Which resource a change is about: a launch joins its server's later cards once it knows the instance id. */
const keyOf = (d: DeployView) => `${resourcesOf(d)[0]!.resourceType}|${d.resourceId ?? resourcesOf(d)[0]!.logicalId}`;

/** Where a card stands, in words that fit what it does. */
export function statusWord(d: DeployView): string {
  switch (d.status) {
    case 'preview':
      return 'waiting for your OK';
    case 'creating':
      return 'working…';
    case 'rejected':
      return 'not approved';
    case 'failed':
      return 'didn’t work';
    case 'complete':
      return DONE_WORD[d.templateId] ?? 'done';
    default:
      return d.status;
  }
}

/** The toast when a change finishes, in its own words ("Server web is stopped", never "…is built" for a removal). */
export function doneLine(d: DeployView, practice: boolean): string {
  const where = practice ? 'the practice account' : 'your AWS account';
  if (!isAgentChange(d)) return `${d.stackName} is built in ${where}!`;
  const c = resourcesOf(d)[0]!;
  const what = `${KIND[c.resourceType] ?? 'Resource'} ${c.logicalId}`;
  return CREATES.has(d.templateId) ? `${what} is built in ${where}!` : `${what} is ${DONE_WORD[d.templateId] ?? 'done'}.`;
}

export interface BuildGroup {
  key: string;
  /** "Server web (i-0123…)", "Bucket aws-city-…-holiday-123". */
  title: string;
  /** The newest card: its status is the resource's, and a waiting approval is answered on it. */
  latest: DeployView;
  /** Every card for this resource, oldest first. */
  history: DeployView[];
  /** The resource is there now (built, and not removed since). */
  exists: boolean;
  /** What Tear down asks, in words the server reads straight away (server/src/agents/commands.ts); none once removed. */
  teardown?: string;
}

const teardownFor = (type: string, id: string): string | undefined => {
  if (type === 'AWS::EC2::Instance' && /^i-[0-9a-f]{8,17}$/.test(id)) return `Terminate ${id}`;
  if (type === 'AWS::S3::Bucket' && /^aws-city-\d{12}-[a-z0-9-]{3,40}$/.test(id)) return `Delete the bucket ${id}`;
  if (type === 'AWS::DynamoDB::Table' && /^city-[a-z0-9-]{1,40}$/.test(id)) return `Delete the table ${id}`;
  return undefined;
};

/**
 * The cards to show: the agents' changes folded into one per resource, everything else as it was; cards waiting for
 * the player's OK first, then newest first.
 */
export function arrangeBuilds(deploys: DeployView[]): { d: DeployView; group?: BuildGroup }[] {
  const groups = new Map<string, DeployView[]>();
  const order: ({ key: string } | { d: DeployView })[] = [];
  for (const d of deploys) {
    if (!isAgentChange(d)) {
      order.push({ d });
      continue;
    }
    const key = keyOf(d);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push({ key });
    }
    groups.get(key)!.push(d);
  }
  const cards = order.map((o) => {
    if ('d' in o) return { d: o.d };
    const history = groups.get(o.key)!;
    const latest = history.at(-1)!;
    const done = history.filter((d) => d.status === 'complete');
    const lastDone = done.at(-1);
    const exists = !!lastDone && !REMOVES.has(lastDone.templateId);
    const type = resourcesOf(latest)[0]!.resourceType;
    const id = history.map((d) => d.resourceId).find(Boolean) ?? resourcesOf(latest)[0]!.logicalId;
    const made = history.find((d) => CREATES.has(d.templateId));
    const name = made ? resourcesOf(made)[0]!.logicalId : id;
    const title = `${KIND[type] ?? 'Resource'} ${name}${id !== name ? ` (${id})` : ''}`;
    const teardown = exists ? teardownFor(type, id) : undefined;
    return { d: latest, group: { key: o.key, title, latest, history, exists, ...(teardown ? { teardown } : {}) } };
  });
  // Waiting for an OK first; otherwise the most recently changed first (a stop moves its server's card up).
  const at = new Map(deploys.map((d, i) => [d.deployId, i]));
  const rank = (c: { d: DeployView }) => (c.d.status === 'preview' ? 1e9 : 0) + (at.get(c.d.deployId) ?? 0);
  return cards.sort((a, b) => rank(b) - rank(a));
}
