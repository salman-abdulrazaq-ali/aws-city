import { describe, expect, it } from 'vitest';
import { busyResources, deployPhase, progressLine, type StackEventLike } from '../lib/deploy-progress.js';

const S = 'AWSCity-prod-Service';
const ev = (LogicalResourceId: string, ResourceType: string, ResourceStatus: string): StackEventLike => ({ LogicalResourceId, ResourceType, ResourceStatus });

describe('the deploy says what AWS is doing, so a long step never looks stuck', () => {
  it('reads only the current operation: each resource’s newest event, kept while it is still in progress', () => {
    const newestFirst = [
      ev('TaskDef', 'AWS::ECS::TaskDefinition', 'UPDATE_COMPLETE'),
      ev('Service', 'AWS::ECS::Service', 'UPDATE_IN_PROGRESS'),
      ev('TaskDef', 'AWS::ECS::TaskDefinition', 'UPDATE_IN_PROGRESS'),
      ev(S, 'AWS::CloudFormation::Stack', 'UPDATE_IN_PROGRESS'),
      // The previous deploy: never read.
      ev('OldThing', 'AWS::S3::Bucket', 'UPDATE_IN_PROGRESS'),
    ];
    expect(busyResources(S, newestFirst).map((e) => e.LogicalResourceId)).toEqual(['Service']);
  });

  it('names the slow steps in plain words: ECS swapping the servers first, then the image build', () => {
    expect(deployPhase('UPDATE_IN_PROGRESS', [ev('Service', 'AWS::ECS::Service', 'UPDATE_IN_PROGRESS'), ev('X', 'AWS::IAM::Policy', 'UPDATE_IN_PROGRESS')])).toMatch(/ECS is swapping the servers.*rolls back by itself/);
    expect(deployPhase('UPDATE_IN_PROGRESS', [ev('ServerImage7A1B2C', 'Custom::CDKContainerImageBuild', 'UPDATE_IN_PROGRESS')])).toMatch(/CodeBuild is building the server image/);
    expect(deployPhase('UPDATE_IN_PROGRESS', [ev('Dist', 'AWS::CloudFront::Distribution', 'UPDATE_IN_PROGRESS')])).toMatch(/CloudFront/);
    expect(deployPhase('UPDATE_IN_PROGRESS', [ev('Queue', 'AWS::SQS::Queue', 'CREATE_IN_PROGRESS')])).toBe('updating Queue (AWS::SQS::Queue).');
    expect(deployPhase('UPDATE_IN_PROGRESS', [])).toMatch(/working out the changes/);
  });

  it('says when the new version is already live, and when a failure is being rolled back', () => {
    expect(deployPhase('UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', [])).toMatch(/new one is already live/);
    expect(deployPhase('UPDATE_ROLLBACK_IN_PROGRESS', [])).toMatch(/putting the previous version back/);
  });

  it('one line with the time taken', () => {
    const newestFirst = [ev('Service', 'AWS::ECS::Service', 'UPDATE_IN_PROGRESS'), ev(S, 'AWS::CloudFormation::Stack', 'UPDATE_IN_PROGRESS')];
    expect(progressLine(S, 'UPDATE_IN_PROGRESS', newestFirst, 7 * 60_000 + 5_000)).toMatch(/^⏳ 7 min · AWSCity-prod-Service: ECS is swapping/);
    expect(progressLine(S, 'UPDATE_IN_PROGRESS', newestFirst, 20_000)).toMatch(/^⏳ under a minute · /);
  });
});
