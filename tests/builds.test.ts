// "My builds": one card per AWS resource for the agents' changes (src/state/builds.ts). Seen live, 21 Nov 2026: a
// server's launch, stop and terminate were three cards, the terminate read "live" and still offered Tear down.
import { describe, expect, it } from 'vitest';
import { arrangeBuilds, doneLine, statusWord } from '@/state/builds';
import type { DeployView } from '@/state/store';

const card = (deployId: string, templateId: string, logicalId: string, resourceType: string, status: DeployView['status'], extra: Partial<DeployView> = {}): DeployView => ({
  deployId,
  templateId,
  stackName: `${templateId} ${logicalId}`,
  region: 'us-west-2',
  changes: [{ action: templateId.startsWith('launch') || templateId.startsWith('create') ? 'Add' : templateId.startsWith('stop') || templateId.startsWith('start') ? 'Modify' : 'Remove', logicalId, resourceType }],
  status,
  ...extra,
});
const EC2 = 'AWS::EC2::Instance';
const ID = 'i-03e06cc3ce2a69cfe';

describe('arrangeBuilds', () => {
  it('a server launched, stopped and terminated is one card: latest status, history, no Tear down once removed', () => {
    const launch = card('a1', 'launch_instance', 'web', EC2, 'complete', { resourceId: ID });
    const stop = card('a2', 'stop_instance', ID, EC2, 'complete');
    const term = card('a3', 'terminate_instance', ID, EC2, 'complete');
    const [one, ...rest] = arrangeBuilds([launch, stop, term]);
    expect(rest).toEqual([]);
    expect(one!.group).toMatchObject({ title: `Server web (${ID})`, exists: false });
    expect(one!.group!.teardown).toBeUndefined();
    expect(one!.group!.history.map(statusWord)).toEqual(['built', 'stopped', 'removed']);
    expect(statusWord(one!.d)).toBe('removed');
  });

  it('a stopped server still exists: Tear down asks to terminate it by its id, in words the server reads at once', () => {
    const [one] = arrangeBuilds([card('a1', 'launch_instance', 'web', EC2, 'complete', { resourceId: ID }), card('a2', 'stop_instance', ID, EC2, 'complete')]);
    expect(one!.group).toMatchObject({ exists: true, teardown: `Terminate ${ID}` });
  });

  it('buckets and tables: Tear down names them in full; a bucket card without the account (old server) offers none', () => {
    const [bucket] = arrangeBuilds([card('b1', 'create_bucket', 'aws-city-047463438585-holiday-123', 'AWS::S3::Bucket', 'complete')]);
    expect(bucket!.group!.teardown).toBe('Delete the bucket aws-city-047463438585-holiday-123');
    const [table] = arrangeBuilds([card('t1', 'create_table', 'city-scores', 'AWS::DynamoDB::Table', 'complete')]);
    expect(table!.group!.teardown).toBe('Delete the table city-scores');
    const [old] = arrangeBuilds([card('b2', 'create_bucket', 'aws-city-…-holiday-123', 'AWS::S3::Bucket', 'complete')]);
    expect(old!.group!.teardown).toBeUndefined();
  });

  it('a waiting approval comes first; then the most recently changed; practice stacks stay as they are', () => {
    const practice: DeployView = { deployId: 'p1', templateId: 'static-site', stackName: 'aws-city-site', region: 'us-west-2', changes: [], status: 'complete' };
    const table = card('t1', 'create_table', 'city-scores', 'AWS::DynamoDB::Table', 'complete');
    const waiting = card('b1', 'create_bucket', 'aws-city-047463438585-photos', 'AWS::S3::Bucket', 'preview');
    const order = arrangeBuilds([practice, table, waiting]).map((c) => c.d.deployId);
    expect(order).toEqual(['b1', 't1', 'p1']);
    expect(arrangeBuilds([practice])[0]!.group).toBeUndefined();
  });

  it('nothing built yet (rejected or failed) never offers Tear down', () => {
    expect(arrangeBuilds([card('a1', 'launch_instance', 'web', EC2, 'rejected')])[0]!.group).toMatchObject({ exists: false });
    expect(statusWord(card('a1', 'launch_instance', 'web', EC2, 'rejected'))).toBe('not approved');
    expect(statusWord(card('a1', 'launch_instance', 'web', EC2, 'failed'))).toBe('didn’t work');
  });
});

describe('doneLine', () => {
  it('says what happened: built for a creation, stopped or removed otherwise', () => {
    expect(doneLine(card('a1', 'launch_instance', 'web', EC2, 'complete'), false)).toBe('Server web is built in your AWS account!');
    expect(doneLine(card('a2', 'terminate_instance', ID, EC2, 'complete'), false)).toBe(`Server ${ID} is removed.`);
    expect(doneLine(card('a3', 'stop_instance', ID, EC2, 'complete'), false)).toBe(`Server ${ID} is stopped.`);
    const practice: DeployView = { deployId: 'p1', templateId: 'static-site', stackName: 'aws-city-site', region: 'us-west-2', changes: [], status: 'complete' };
    expect(doneLine(practice, true)).toBe('aws-city-site is built in the practice account!');
  });

  it('a safety check line on the approval (a detail row) is words, not a second resource: still one card, still "removed"', () => {
    const term = card('a3', 'terminate_instance', ID, EC2, 'complete');
    const checked = { ...term, changes: [...term.changes, { action: 'Modify' as const, logicalId: 'Safety check: it holds data', resourceType: 'detail' }] };
    expect(doneLine(checked, false)).toBe(`Server ${ID} is removed.`);
    const [one, ...rest] = arrangeBuilds([card('a1', 'launch_instance', 'web', EC2, 'complete', { resourceId: ID }), checked]);
    expect(rest).toEqual([]);
    expect(one!.group).toMatchObject({ title: `Server web (${ID})`, exists: false });
  });
});
