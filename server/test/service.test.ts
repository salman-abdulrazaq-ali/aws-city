import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/agents/policy.js';
import type { AwsClients } from '../src/aws.js';
import type { Poller } from '../src/state/poller.js';
import { instance, snapshot } from './fixtures.js';

const { executeAction } = vi.hoisted(() => {
  let launched = 0;
  return {
    executeAction: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      launched++;
      return { ok: true, message: 'Launching.', resourceId: `i-00000000000000${String(launched).padStart(3, '0')}` };
    }),
  };
});
vi.mock('../src/agents/executor.js', () => ({ executeAction }));

const { ACCOUNT_CHANGED_REASON, createActionService, NEEDS_APPROVAL_REASON, REJECTED_REASON } = await import('../src/agents/service.js');

const pollerFor = (resources = snapshot([])) => ({ current: () => resources, refresh: async () => resources, start() {}, stop() {} }) as Poller;

describe('action service', () => {
  it('does not let parallel launches exceed the instance limit before AWS listings catch up', async () => {
    // The snapshot never shows the new instances (eventually consistent listing).
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(), region: 'us-west-2' });
    const approve = async () => true;
    const outcomes = await Promise.all(Array.from({ length: LIMITS.instances + 3 }, (_, n) => service.submit('launch_instance', { name: `house ${n}` }, { approve })));
    expect(outcomes.filter((o) => o.status === 'done')).toHaveLength(LIMITS.instances);
    expect(outcomes.filter((o) => o.status === 'denied')).toHaveLength(3);
  });

  it('refuses every write without an approval channel; only reads run', async () => {
    executeAction.mockClear();
    const mine = instance('i-0000000000000001a', 'running');
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(snapshot([mine])), region: 'us-west-2' });
    expect(await service.submit('terminate_instance', { instanceId: mine.id })).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    expect(await service.submit('launch_instance', { name: 'house' })).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    expect(await service.submit('create_table', { name: 'city-quest' })).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    expect(await service.submit('stop_instance', { instanceId: mine.id })).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('an approval that arrives after the player re-linked another account never writes to the old one', async () => {
    executeAction.mockClear();
    let live = true;
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(), region: 'us-west-2', live: () => live });
    // The player approves on the card, but meanwhile linked a different AWS account (the old world was retired).
    const approve = async () => {
      live = false;
      return true;
    };
    expect(await service.submit('launch_instance', { name: 'house' }, { approve })).toEqual({ status: 'denied', reason: ACCOUNT_CHANGED_REASON });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('rejects invalid input before policy or AWS', async () => {
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(), region: 'us-west-2' });
    expect(await service.submit('launch_instance', { name: 'x', instanceType: 'm5.large' })).toMatchObject({ status: 'invalid' });
  });

  it('with an approval channel, asks the player before any write and only runs on approve', async () => {
    executeAction.mockClear();
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(), region: 'us-west-2' });
    const approve = vi.fn(async () => false);
    expect(await service.submit('create_table', { name: 'city-quest' }, { approve })).toEqual({ status: 'denied', reason: REJECTED_REASON });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ destructive: false, summary: expect.stringContaining('city-quest') }));
    expect(executeAction).not.toHaveBeenCalled();
    approve.mockResolvedValueOnce(true);
    expect(await service.submit('create_table', { name: 'city-quest' }, { approve })).toMatchObject({ status: 'done' });
    expect(executeAction).toHaveBeenCalledTimes(1);
  });

  it('lets destructive actions run only after explicit approval, and never asks about denied ones', async () => {
    executeAction.mockClear();
    const mine = instance('i-0000000000000001a', 'running');
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(snapshot([mine])), region: 'us-west-2' });
    const approve = vi.fn(async () => true);
    expect(await service.submit('terminate_instance', { instanceId: mine.id }, { approve })).toMatchObject({ status: 'done' });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }));
    approve.mockClear();
    // not built by the game → policy denies before the player is even asked
    expect(await service.submit('terminate_instance', { instanceId: 'i-0000000000000009f' }, { approve })).toMatchObject({ status: 'denied' });
    expect(approve).not.toHaveBeenCalled();
  });

  it('reads never need approval', async () => {
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(), region: 'us-west-2' });
    const approve = vi.fn(async () => false);
    await service.submit('describe_resource', { id: 'anything' }, { approve });
    expect(approve).not.toHaveBeenCalled();
  });

  it('audits every write asked for, done or refused, and never a read or input that did not parse', async () => {
    const mine = instance('i-0000000000000001a', 'running');
    const audit = vi.fn();
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(snapshot([mine])), region: 'us-west-2', audit });
    await service.submit('create_table', { name: 'city-quest' }, { approve: async () => true });
    await service.submit('terminate_instance', { instanceId: mine.id }, { approve: async () => false });
    await service.submit('stop_instance', { instanceId: 'i-00000000000000bad' }, { approve: async () => true }); // not the city's
    await service.submit('launch_instance', { name: 'house' }); // no Approve button
    await service.submit('describe_resource', { id: mine.id });
    await service.submit('create_bucket', { suffix: 'X' }, { approve: async () => true });
    expect(audit.mock.calls.map(([e]) => [e.action, e.target, e.outcome])).toEqual([
      ['create_table', 'city-quest', 'done'],
      ['terminate_instance', mine.id, 'rejected'],
      ['stop_instance', 'i-00000000000000bad', 'denied'],
      ['launch_instance', 'house', 'denied'],
    ]);
  });

  // Seen 22 Nov 2026: the audit line for a new bucket said aws-city-<account>-photos-1.
  it('a bucket’s audit line names the real bucket, with the account', async () => {
    const audit = vi.fn();
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(snapshot([])), region: 'us-west-2', audit, accountKey: () => '047463438585' });
    await service.submit('create_bucket', { suffix: 'photos-1' }, { approve: async () => false });
    expect(audit.mock.calls[0]![0]).toMatchObject({ action: 'create_bucket', target: 'aws-city-047463438585-photos-1', outcome: 'rejected' });
  });
});
