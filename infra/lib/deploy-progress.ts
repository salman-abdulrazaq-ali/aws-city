// What a deploy is doing, in one line, from its stack's CloudFormation events. `npm run setup` prints it every minute
// while a stack is busy, so a long step (the server image build, ECS swapping the servers) never looks stuck. Pure.

/** The fields of a CloudFormation stack event this reads (DescribeStackEvents returns them newest first). */
export interface StackEventLike {
  LogicalResourceId?: string;
  ResourceType?: string;
  ResourceStatus?: string;
}

/**
 * The resources still in progress in the stack's current operation: each resource's newest event since the stack's own
 * latest `*_IN_PROGRESS` event, kept when that newest status is still `*_IN_PROGRESS`.
 */
export const busyResources = (stackName: string, newestFirst: readonly StackEventLike[]): StackEventLike[] => {
  const seen = new Map<string, StackEventLike>();
  for (const e of newestFirst) {
    const id = e.LogicalResourceId ?? '';
    if (id === stackName && e.ResourceType === 'AWS::CloudFormation::Stack') {
      if (e.ResourceStatus?.endsWith('_IN_PROGRESS') && !e.ResourceStatus.includes('CLEANUP')) break;
      continue;
    }
    if (!seen.has(id)) seen.set(id, e);
  }
  return [...seen.values()].filter((e) => e.ResourceStatus?.endsWith('_IN_PROGRESS'));
};

/** The slow steps first: ECS swapping the servers, then the server image build, then anything else. */
const rank = (e: StackEventLike) => (e.ResourceType === 'AWS::ECS::Service' ? 0 : /ServerImage/.test(e.LogicalResourceId ?? '') ? 1 : 2);

/** One sentence for what the stack is doing now. */
export const deployPhase = (stackStatus: string | undefined, busy: readonly StackEventLike[]): string => {
  if (stackStatus?.includes('CLEANUP')) return 'removing the previous version (the new one is already live).';
  if (stackStatus?.startsWith('ROLLBACK') || stackStatus?.includes('_ROLLBACK_')) return 'something failed, so CloudFormation is putting the previous version back.';
  const e = [...busy].sort((a, b) => rank(a) - rank(b))[0];
  if (!e) return 'CloudFormation is working out the changes.';
  const type = e.ResourceType ?? '';
  if (type === 'AWS::ECS::Service')
    return 'ECS is swapping the servers: it starts the new version, checks it is healthy, lets the old one finish its players’ connections, then watches the error alarm for a few minutes (it rolls back by itself if errors show up).';
  if (/ServerImage/.test(e.LogicalResourceId ?? '')) return 'AWS CodeBuild is building the server image (about 3–6 minutes after a code change).';
  if (type === 'AWS::ECS::TaskDefinition') return 'registering the new server version.';
  if (type === 'AWS::CloudFront::Distribution') return 'CloudFront is updating its edge locations around the world (this can take several minutes).';
  if (type === 'AWS::Cognito::UserPool' || type === 'AWS::Cognito::UserPoolClient') return 'updating sign-in (Cognito).';
  return `updating ${e.LogicalResourceId} (${type}).`;
};

/** "⏳ 7 min · AWSCity-prod-Service: …" */
export const progressLine = (stackName: string, stackStatus: string | undefined, newestFirst: readonly StackEventLike[], elapsedMs: number): string => {
  const min = Math.floor(elapsedMs / 60_000);
  return `⏳ ${min < 1 ? 'under a minute' : `${min} min`} · ${stackName}: ${deployPhase(stackStatus, busyResources(stackName, newestFirst))}`;
};
