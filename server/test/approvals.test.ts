import { describe, expect, it, vi } from 'vitest';
import { createApprovals } from '../src/contract/approvals.js';
import type { ServerEvent } from '../src/world.js';

const req = { action: { type: 'create_table', name: 'city-quest' } as never, summary: 'Create DynamoDB table "city-quest"', destructive: false };

describe('per-socket approvals (contract v2 deploy.preview → deploy.approve)', () => {
  it('emits a deploy.preview and resolves true on approve, then reports the real result', async () => {
    const events: ServerEvent[] = [];
    const a = createApprovals({ region: 'us-west-2' });
    const p = a.request('t1', req, (e) => events.push(e));
    const preview = events[0];
    expect(preview).toMatchObject({ type: 'deploy.preview', taskId: 't1', templateId: 'create_table', region: 'us-west-2' });
    if (preview?.type !== 'deploy.preview') throw new Error();
    expect(preview.changes).toEqual([{ action: 'Add', logicalId: 'city-quest', resourceType: 'AWS::DynamoDB::Table' }]);
    expect(a.answer(preview.deployId, true)).toBe(true);
    expect(await p).toBe(true);
    a.reportResult('t1', { name: 'create_table', input: {}, outcome: 'done', message: 'Table created' }, (e) => events.push(e));
    expect(events.map((e) => (e.type === 'deploy.status' ? e.status : e.type))).toEqual(['deploy.preview', 'creating', 'complete']);
  });

  it('reject, unknown ids, timeouts and socket close all resolve false', async () => {
    vi.useFakeTimers();
    const events: ServerEvent[] = [];
    const a = createApprovals({ region: 'us-west-2', timeoutMs: 1000 });
    const rejected = a.request('t', req, (e) => events.push(e));
    a.answer((events[0] as { deployId: string }).deployId, false);
    expect(await rejected).toBe(false);
    expect(a.answer('nope', true)).toBe(false);
    const timedOut = a.request('t', req, (e) => events.push(e));
    vi.advanceTimersByTime(1001);
    expect(await timedOut).toBe(false);
    const closed = a.request('t', req, (e) => events.push(e));
    a.cancelAll();
    expect(await closed).toBe(false);
    expect(a.size).toBe(0);
    vi.useRealTimers();
  });

  it('create_bucket previews its label as aws-city-…-<suffix>, and a second look asks for the typed suffix', () => {
    const events: ServerEvent[] = [];
    const a = createApprovals({ region: 'us-west-2' });
    void a.request('t', { action: { type: 'create_bucket', suffix: 'photos' } as never, summary: 'Create bucket', destructive: false, check: { reason: 'x' } } as never, (e) => events.push(e));
    const preview = events[0];
    if (preview?.type !== 'deploy.preview') throw new Error();
    expect(preview.changes[0]).toEqual({ action: 'Add', logicalId: 'aws-city-…-photos', resourceType: 'AWS::S3::Bucket' });
    expect(preview.confirmText).toBe('photos');
    a.cancelAll();
  });

  it('a destructive write always wants the name typed (no second look needed): Approve alone, or a wrong name, changes nothing', async () => {
    const events: ServerEvent[] = [];
    const a = createApprovals({ region: 'us-west-2' });
    const previewOf = (i: number) => events.filter((e): e is Extract<ServerEvent, { type: 'deploy.preview' }> => e.type === 'deploy.preview')[i]!;
    const terminate = { action: { type: 'terminate_instance', instanceId: 'i-0123456789abcdef0' } as never, summary: 'Terminate', destructive: true };
    const bare = a.request('t1', terminate, (e) => events.push(e));
    expect(previewOf(0)).toMatchObject({ confirmText: 'i-0123456789abcdef0', changes: [{ action: 'Remove', logicalId: 'i-0123456789abcdef0' }] });
    expect(previewOf(0).changes).toHaveLength(1); // no Safety check line: Jev didn't ask
    a.answer(previewOf(0).deployId, true); // one stray Enter on Approve
    expect(await bare).toBe(false);
    const wrong = a.request('t2', { action: { type: 'delete_table', name: 'city-quest' } as never, summary: 'Delete', destructive: true }, (e) => events.push(e));
    expect(previewOf(1).confirmText).toBe('city-quest');
    a.answer(previewOf(1).deployId, true, 'city-ques');
    expect(await wrong).toBe(false);
    const typed = a.request('t3', { action: { type: 'delete_bucket', name: 'aws-city-047463438585-photos' } as never, summary: 'Delete', destructive: true }, (e) => events.push(e));
    a.answer(previewOf(2).deployId, true, ' aws-city-047463438585-photos ');
    expect(await typed).toBe(true);
    // A write that isn't destructive, with no second look, still approves with one press.
    void a.request('t4', req, (e) => events.push(e));
    expect(previewOf(3)).not.toHaveProperty('confirmText');
    a.cancelAll();
  });

  it('v2.18: each card names the account and Region read when it is made (a re-link mid-socket shows the new ones)', () => {
    const events: ServerEvent[] = [];
    const where = { region: 'us-west-2', accountId: '047463438585' as string | undefined };
    const a = createApprovals({ region: () => where.region, accountId: () => where.accountId });
    void a.request('t1', req, (e) => events.push(e));
    where.region = 'eu-west-2';
    where.accountId = '111122223333';
    void a.request('t2', req, (e) => events.push(e));
    where.accountId = undefined;
    void a.request('t3', req, (e) => events.push(e));
    expect(events.map((e) => e.type === 'deploy.preview' && [e.accountId, e.region])).toEqual([
      ['047463438585', 'us-west-2'],
      ['111122223333', 'eu-west-2'],
      [undefined, 'eu-west-2'],
    ]);
    expect(events[2]).not.toHaveProperty('accountId');
    a.cancelAll();
  });
});
