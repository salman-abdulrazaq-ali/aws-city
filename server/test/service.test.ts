import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/agents/policy.js';
import type { AwsClients } from '../src/aws.js';
import type { Poller } from '../src/state/poller.js';
import type { Judgement, WriteReview } from '../src/agents/jev.js';
import type { ApprovalRequest } from '../src/agents/service.js';
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

const { createActionService, NEEDS_APPROVAL_REASON, REJECTED_REASON } = await import('../src/agents/service.js');
const { UNCHECKED_REASON } = await import('../src/agents/jev.js');

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
});

describe('a second opinion on writes (judge = Jev) only tightens', () => {
  const judged = (...verdicts: (Judgement | Error)[]) => {
    executeAction.mockClear();
    const judge = vi.fn(async (_r: WriteReview): Promise<Judgement> => {
      const next = verdicts.shift()!;
      if (next instanceof Error) throw next;
      return next;
    });
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(), region: 'us-west-2', judge });
    return { service, judge };
  };

  it('block refuses without asking the player; ask adds a typed check; allow asks as before', async () => {
    const { service } = judged({ verdict: 'block', reason: 'Stopped by the check.' }, { verdict: 'ask', reason: 'Look twice.' }, { verdict: 'allow' });
    const approve = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await service.submit('create_table', { name: 'city-quest' }, { approve })).toEqual({ status: 'denied', reason: 'Stopped by the check.' });
    expect(approve).not.toHaveBeenCalled();
    expect(executeAction).not.toHaveBeenCalled();

    expect(await service.submit('create_table', { name: 'city-quest' }, { approve })).toMatchObject({ status: 'done' });
    expect(approve.mock.calls[0]![0]).toMatchObject({ destructive: false, check: { reason: 'Look twice.' } });

    expect(await service.submit('create_table', { name: 'city-quest' }, { approve })).toMatchObject({ status: 'done' });
    expect(approve.mock.calls[1]![0]).not.toHaveProperty('check');
    expect(executeAction).toHaveBeenCalledTimes(2);
  });

  it("ask can't skip the player: a no still changes nothing", async () => {
    const { service } = judged({ verdict: 'ask', reason: 'Look twice.' });
    expect(await service.submit('create_table', { name: 'city-quest' }, { approve: async () => false })).toEqual({ status: 'denied', reason: REJECTED_REASON });
    expect(executeAction).not.toHaveBeenCalled();
  });

  it('a judge that throws counts as ask', async () => {
    const { service } = judged(new Error('boom'));
    const approve = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await service.submit('create_table', { name: 'city-quest' }, { approve })).toMatchObject({ status: 'done' });
    expect(approve.mock.calls[0]![0].check).toEqual({ reason: UNCHECKED_REASON });
  });

  it("gets the player's words and the write after policy; never a read, a denied write or one with no approval channel", async () => {
    const mine = instance('i-0000000000000001a', 'running');
    executeAction.mockClear();
    const judge = vi.fn(async (_r: WriteReview): Promise<Judgement> => ({ verdict: 'allow' }));
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(snapshot([mine])), region: 'us-west-2', judge });
    const approve = async () => true;
    await service.submit('describe_resource', { id: mine.id }, { approve, intent: 'what is this?' });
    await service.submit('terminate_instance', { instanceId: 'i-0000000000000009f' }, { approve, intent: 'knock it down' });
    expect(await service.submit('terminate_instance', { instanceId: mine.id }, { intent: 'knock it down' })).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    expect(judge).not.toHaveBeenCalled();
    await service.submit('terminate_instance', { instanceId: mine.id }, { approve, intent: 'knock it down' });
    expect(judge).toHaveBeenCalledWith({ action: { type: 'terminate_instance', instanceId: mine.id }, summary: `Permanently terminate EC2 instance ${mine.id}`, destructive: true, intent: 'knock it down' });
  });
});
