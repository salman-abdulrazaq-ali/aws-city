import type { Action } from '../agents/actions.js';
import { bucketPrefix } from '../state/model.js';
import { type Grant, mintGrant } from './gate.js';
import { launchTarget } from './rules.js';

/**
 * The grant for one approved Action: exactly the AWS writes executor.ts sends for it, each bound to its target.
 * Reads need none (undefined). Minted only by ActionService, after policy and the player's approval.
 */
export const actionGrant = (action: Action, accountId: string): Grant | undefined => {
  switch (action.type) {
    case 'launch_instance':
      return mintGrant(action.type, [{ client: 'EC2Client', command: 'RunInstancesCommand', target: launchTarget(action.instanceType, action.name) }]);
    case 'stop_instance':
      return mintGrant(action.type, [{ client: 'EC2Client', command: 'StopInstancesCommand', target: action.instanceId }]);
    case 'start_instance':
      return mintGrant(action.type, [{ client: 'EC2Client', command: 'StartInstancesCommand', target: action.instanceId }]);
    case 'terminate_instance':
      return mintGrant(action.type, [{ client: 'EC2Client', command: 'TerminateInstancesCommand', target: action.instanceId }]);
    case 'create_table':
      return mintGrant(action.type, [{ client: 'DynamoDBClient', command: 'CreateTableCommand', target: action.name }]);
    case 'delete_table':
      return mintGrant(action.type, [{ client: 'DynamoDBClient', command: 'DeleteTableCommand', target: action.name }]);
    case 'create_bucket': {
      const name = bucketPrefix(accountId) + action.suffix;
      return mintGrant(action.type, [
        { client: 'S3Client', command: 'CreateBucketCommand', target: name },
        { client: 'S3Client', command: 'PutBucketTaggingCommand', target: name },
      ]);
    }
    case 'delete_bucket':
      return mintGrant(action.type, [{ client: 'S3Client', command: 'DeleteBucketCommand', target: action.name }]);
    case 'describe_resource':
    case 'review_architecture':
      return undefined;
  }
};
