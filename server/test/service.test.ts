import { describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../src/agents/policy.js';
import type { AwsClients } from '../src/aws.js';
import type { Poller } from '../src/state/poller.js';
import type { Judgement, WriteReview } from '../src/agents/jev.js';
import type { ApprovalRequest } from '../src/agents/service.js';
import { targetHash } from '../src/guard/gate.js';
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

const { createActionService, LINK_UNCHECKED_REASON, NEEDS_APPROVAL_REASON, REJECTED_REASON, RETIRED_REASON } = await import('../src/agents/service.js');
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

  it('an approval that arrives after the player re-linked another account never writes to the old one', async () => {
    executeAction.mockClear();
    let live = true;
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(), region: 'us-west-2', live: async () => live });
    // The player approves on the card, but meanwhile linked a different AWS account (the old world was retired).
    const approve = async () => {
      live = false;
      return true;
    };
    expect(await service.submit('launch_instance', { name: 'house' }, { approve })).toEqual({ status: 'denied', reason: RETIRED_REASON });
    expect(executeAction).not.toHaveBeenCalled();
  });

  // After Disconnect "AWS City no longer reads or changes your AWS account": the look again 4 s after a write is skipped.
  it('the look again after a write is skipped once the world is retired', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      for (const disconnect of [false, true]) {
        const retired = new AbortController();
        const poller = pollerFor();
        const refresh = vi.spyOn(poller, 'refresh');
        const service = createActionService({ clients: {} as AwsClients, poller, region: 'us-west-2', retired: retired.signal });
        const done = service.submit('create_table', { name: 'city-quest' }, { approve: async () => true });
        await vi.advanceTimersByTimeAsync(10);
        expect(await done).toMatchObject({ status: 'done' });
        expect(refresh).toHaveBeenCalledTimes(1);
        if (disconnect) retired.abort('Disconnected.');
        await vi.advanceTimersByTimeAsync(4_000);
        expect(refresh).toHaveBeenCalledTimes(disconnect ? 1 : 2);
      }
    } finally {
      vi.useRealTimers();
    }
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

  it('a store error in the live check after an approval is a plain refusal (the approved card still gets its outcome), never a throw', async () => {
    executeAction.mockClear();
    const service = createActionService({
      clients: {} as AwsClients,
      poller: pollerFor(),
      region: 'us-west-2',
      live: async () => {
        throw Object.assign(new Error('Throughput exceeds the current capacity of your table'), { name: 'ProvisionedThroughputExceededException' });
      },
    });
    const out = await service.submit('create_table', { name: 'city-quest' }, { approve: async () => true });
    expect(out).toEqual({ status: 'denied', reason: LINK_UNCHECKED_REASON });
    expect(LINK_UNCHECKED_REASON).not.toMatch(/Throughput|Exception/);
    expect(executeAction).not.toHaveBeenCalled();
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
    const bucket = 'aws-city-123456789012-photos'; // not the city's: refused, and its name carries the account id
    await service.submit('delete_bucket', { name: bucket }, { approve: async () => true });
    // The target as the gate hashes it (its audit line beside this one): never the name, never an account id.
    expect(audit.mock.calls.map(([e]) => [e.action, e.target, e.outcome])).toEqual([
      ['create_table', targetHash('city-quest'), 'done'],
      ['terminate_instance', targetHash(mine.id), 'rejected'],
      ['stop_instance', targetHash('i-00000000000000bad'), 'denied'],
      ['launch_instance', targetHash('house'), 'denied'],
      ['delete_bucket', targetHash(bucket), 'denied'],
    ]);
    const logged = JSON.stringify(audit.mock.calls);
    expect(logged).not.toMatch(/\d{12}/);
    for (const raw of ['city-quest', mine.id, 'i-00000000000000bad', '"house"', bucket]) expect(logged).not.toContain(raw);
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
    expect(judge).toHaveBeenCalledWith({ action: { type: 'terminate_instance', instanceId: mine.id }, summary: `Permanently terminate EC2 instance ${mine.id}, which has no name`, destructive: true, intent: 'knock it down', unnamedTarget: true });
  });

  // Seen 22 Nov 2026: the audit line for a new bucket said aws-city-<account>-photos-1.
  it('a bucket’s audit line hashes the real bucket name (the account filled in), never the placeholder or the name', async () => {
    const audit = vi.fn();
    const service = createActionService({ clients: {} as AwsClients, poller: pollerFor(snapshot([])), region: 'us-west-2', audit, accountKey: () => '047463438585' });
    await service.submit('create_bucket', { suffix: 'photos-1' }, { approve: async () => false });
    expect(audit.mock.calls[0]![0]).toMatchObject({ action: 'create_bucket', target: targetHash('aws-city-047463438585-photos-1'), outcome: 'rejected' });
    expect(JSON.stringify(audit.mock.calls)).not.toMatch(/047463438585|photos-1|<account>/);
  });
});
