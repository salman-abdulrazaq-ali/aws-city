import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_PAID_A_DAY, CHAT_PAID_A_DAY_TOTAL, CHAT_STARS, CLASSIFY_STARS, TASK_HELPER_STARS, TASK_PAID_A_DAY, TASK_PAID_A_DAY_TOTAL, TASK_STARS, useCity } from '@/state/store';
import type { ServerEvent } from '@/backend/contract';

// Tasks, Lookout pages and chat answers pay through the daily ledger (src/learning/dailyLedger.ts): a few a day, then nothing.
describe('daily caps on tasks, classified pages and chat answers', () => {
  let paid: [string, number][];
  const send = (e: ServerEvent) => useCity.getState().applyServerEvent(e);

  beforeEach(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    paid = [];
    useCity.setState({ tasks: {}, chats: {}, addXp: (id: string, n: number) => void paid.push([id, n]) });
  });
  afterEach(() => vi.unstubAllGlobals());

  it(`a task pays ${TASK_STARS}⭐ (a helper ${TASK_HELPER_STARS}), for a building's first ${TASK_PAID_A_DAY} a day, later ones nothing`, () => {
    expect([TASK_STARS, TASK_HELPER_STARS, TASK_PAID_A_DAY, TASK_PAID_A_DAY_TOTAL]).toEqual([3, 1, 1, 5]);
    for (let i = 0; i < TASK_PAID_A_DAY + 2; i++) send({ type: 'task.done', taskId: `t${i}`, ok: true, result: 'ok', xp: [{ serviceId: 's3', amount: 15 }, { serviceId: 'iam', amount: 5 }] });
    send({ type: 'task.done', taskId: 'other', ok: true, result: 'ok', xp: [{ serviceId: 'lambda', amount: 20 }] });
    // Whatever the server reports, the store pays a task a little: the agent did the work.
    expect(paid).toEqual([['s3', TASK_STARS], ['iam', TASK_HELPER_STARS], ['lambda', TASK_STARS]]);
  });

  it(`at most ${TASK_PAID_A_DAY_TOTAL} paid tasks a day across the city`, () => {
    const ids = ['s3', 'lambda', 'ec2', 'dynamodb', 'sqs', 'sns', 'rds'];
    for (const id of ids) send({ type: 'task.done', taskId: `city-${id}`, ok: true, result: 'ok', xp: [{ serviceId: id, amount: 15 }] });
    expect(paid).toEqual(ids.slice(0, TASK_PAID_A_DAY_TOTAL).map((id) => [id, TASK_STARS]));
  });

  it('a practice deploy pays what it reports (once per template, MockBackend), outside the task caps', () => {
    useCity.setState({ deploys: { d1: { deployId: 'd1', templateId: 'static-site', stackName: 's', region: 'us-west-2', changes: [], status: 'creating' } } as never });
    send({ type: 'task.done', taskId: 'pre', ok: true, result: 'ok', xp: [{ serviceId: 's3', amount: 15 }] });
    send({ type: 'task.done', taskId: 'd1', ok: true, result: 'deployed', xp: [{ serviceId: 's3', amount: 25 }, { serviceId: 'cloudfront', amount: 25 }] });
    expect(paid).toEqual([['s3', TASK_STARS], ['s3', 25], ['cloudfront', 25]]);
    useCity.setState({ deploys: {} });
  });

  it('a classified page pays each service once a day', () => {
    send({ type: 'page.classified', requestId: 'a', serviceIds: ['s3', 'ec2'], summary: '' });
    send({ type: 'page.classified', requestId: 'b', serviceIds: ['s3', 'lambda'], summary: '' });
    expect(paid).toEqual([['s3', CLASSIFY_STARS], ['ec2', CLASSIFY_STARS], ['lambda', CLASSIFY_STARS]]);
  });

  it(`chat answers pay ${CHAT_PAID_A_DAY} a building and ${CHAT_PAID_A_DAY_TOTAL} a day in all`, () => {
    const answer = (agentId: string, n: number) => send({ type: 'chat.answer', requestId: `${agentId}-${n}`, districtId: 'compute' as never, agentId, delta: 'hi', done: true });
    for (let i = 0; i < CHAT_PAID_A_DAY + 1; i++) answer('s3', i);
    expect(paid).toEqual(Array.from({ length: CHAT_PAID_A_DAY }, () => ['s3', CHAT_STARS]));
    for (const id of ['ec2', 'lambda', 'dynamodb', 'iam']) for (let i = 0; i < CHAT_PAID_A_DAY; i++) answer(id, i);
    expect(paid).toHaveLength(CHAT_PAID_A_DAY_TOTAL);
  });
});
