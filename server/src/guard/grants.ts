import type { Action } from '../agents/actions.js';
import { bucketPrefix } from '../state/model.js';
import { type Grant, type GrantEntry, mintGrant } from './gate.js';
import { launchTarget } from './rules.js';

/**
 * The grant for one approved Action: exactly the AWS writes executor.ts sends for it, each bound to its target.
 * Reads need none (undefined). Minted only by ActionService, after policy and the player's approval, for the account the
 * write goes to (the gate refuses it from clients acting in any other).
 */
export const actionGrant = (action: Action, accountId: string, opts: { cleanup?: boolean } = {}): Grant | undefined => {
  // `cleanup`: policy let a bucket the player made through ("Let the city change things you made" on).
  const mint = (entries: GrantEntry[]) => mintGrant(action.type, entries, { accountId, ...(opts.cleanup && action.type === 'delete_bucket' ? { cleanup: true } : {}) });
  switch (action.type) {
    case 'launch_instance':
      return mint([{ client: 'EC2Client', command: 'RunInstancesCommand', target: launchTarget(action.instanceType, action.name) }]);
    case 'stop_instance':
      return mint([{ client: 'EC2Client', command: 'StopInstancesCommand', target: action.instanceId }]);
    case 'start_instance':
      return mint([{ client: 'EC2Client', command: 'StartInstancesCommand', target: action.instanceId }]);
    case 'terminate_instance':
      return mint([{ client: 'EC2Client', command: 'TerminateInstancesCommand', target: action.instanceId }]);
    case 'create_table':
      return mint([{ client: 'DynamoDBClient', command: 'CreateTableCommand', target: action.name }]);
    case 'delete_table':
      return mint([{ client: 'DynamoDBClient', command: 'DeleteTableCommand', target: action.name }]);
    case 'create_bucket': {
      const name = bucketPrefix(accountId) + action.suffix;
      return mint([
        { client: 'S3Client', command: 'CreateBucketCommand', target: name },
        { client: 'S3Client', command: 'PutBucketTaggingCommand', target: name },
      ]);
    }
    case 'delete_bucket':
      return mint([{ client: 'S3Client', command: 'DeleteBucketCommand', target: action.name }]);
    case 'describe_resource':
    case 'review_architecture':
      return undefined;
  }
};
