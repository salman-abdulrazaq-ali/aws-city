import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitoAuth } from '@/backend/auth';
import type { ServerEvent } from '@/backend/contract';
import { MockBackend } from '@/backend/MockBackend';
import { isPracticeTask, isPracticeTemplate, PRACTICE_SCRIPTS, PRACTICE_TASK_PREFIX } from '@/backend/practiceTasks';
import { isPracticeDeploy, ServerBackend } from '@/backend/ServerBackend';
import { FIRST_STEPS } from '@/state/firstSteps';

// The first steps' "Watch Sally work" and her plan are practice in every build: played inside the extension, never sent.
// On the hosted server with a real AWS account linked, nothing reaches the socket (no task.submit, no deploy.plan,
// deploy.approve or deploy.reject), so nothing reaches the ActionService, AWS or MFA step-up.

class FakeSocket {
  static OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: (ev: { code: number }) => void;
  onmessage?: (ev: { data: string }) => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  close(code = 1000) {
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code }));
  }
}

const auth = { token: async () => 'player-token', signOut: async () => {}, signIn: async () => {}, forgetAccessToken: async () => {}, onChange: () => () => {} } as unknown as CognitoAuth;

describe('practice tasks and practice builds on the hosted server, a real account linked', () => {
  let fetches: string[];
  beforeEach(() => {
    FakeSocket.all = [];
    fetches = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('fetch', async (u: URL | string) => {
      fetches.push(String(u));
      return new Response('{}', { status: 200 });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function linkedBackend() {
    const backend = new ServerBackend({ wsUrl: 'wss://api.example/ws', apiUrl: 'https://api.example', auth });
    const events: ServerEvent[] = [];
    backend.onEvent((e) => events.push(e));
    backend.connect();
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    const ws = FakeSocket.all[0]!;
    ws.open();
    // The server says the player's own AWS account is linked.
    ws.onmessage?.({ data: JSON.stringify({ type: 'account.status', linked: true, accountId: '123456789012', region: 'us-west-2' }) });
    expect(events.some((e) => e.type === 'account.status' && e.linked)).toBe(true);
    fetches.length = 0;
    return { backend, events, ws };
  }

  it('Watch Sally work plays its script here and sends nothing', async () => {
    const { backend, events, ws } = await linkedBackend();
    vi.useFakeTimers();
    const taskId = backend.practiceTask(FIRST_STEPS.task.id);
    expect(taskId?.startsWith(PRACTICE_TASK_PREFIX)).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    const mine = events.filter((e) => 'taskId' in e && e.taskId === taskId);
    expect(mine[0]).toMatchObject({ type: 'task.plan', agentId: 's3', steps: FIRST_STEPS.task.steps });
    expect(mine.at(-1)).toMatchObject({ type: 'task.done', ok: true, result: FIRST_STEPS.task.result });
    // Plain words only: no API name the task card would list as a real AWS call.
    for (const e of events) if (e.type === 'agent.state' && e.detail) expect(e.detail).not.toMatch(/^[a-z0-9-]+:[A-Za-z]+$/);
    expect(ws.sent).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('her plan (photo-bucket) is a practice build: approve and reject are answered here, never sent', async () => {
    const { backend, events, ws } = await linkedBackend();
    const preview = async (requestId: string) => {
      backend.send({ action: 'deploy.plan', requestId, templateId: 'photo-bucket' });
      await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.preview' && e.requestId === requestId)).toBe(true));
      return events.find((e): e is Extract<ServerEvent, { type: 'deploy.preview' }> => e.type === 'deploy.preview' && e.requestId === requestId)!;
    };
    const p1 = await preview('r1');
    expect(isPracticeDeploy(p1.deployId)).toBe(true);
    expect(p1).toMatchObject({ templateId: 'photo-bucket', region: 'practice', costNote: FIRST_STEPS.steps[5].practice });
    expect(p1.accountId).toBeUndefined();
    expect(p1.changes).toEqual([{ action: 'Add', logicalId: 'PhotoBucket', resourceType: 'AWS::S3::Bucket' }]);
    backend.send({ action: 'deploy.approve', deployId: p1.deployId });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.status' && e.deployId === p1.deployId && e.status === 'complete')).toBe(true));

    const p2 = await preview('r2');
    backend.send({ action: 'deploy.reject', deployId: p2.deployId });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.status' && e.deployId === p2.deployId && e.status === 'rejected')).toBe(true));
    // A typed confirmation is never asked for, so nothing waits on a name either.
    expect(p1.confirmText).toBeUndefined();
    expect(ws.sent).toEqual([]);
    expect(fetches).toEqual([]);
  });

  it('an ordinary request still goes to the server (the seam is only the practice)', async () => {
    const { backend, ws } = await linkedBackend();
    backend.send({ action: 'task.submit', taskId: 't1', prompt: 'Create a bucket', context: {} });
    expect(ws.sent.map((x) => JSON.parse(x).action)).toEqual(['task.submit']);
  });
});

describe('practice in the demo', () => {
  it('plays the same script and the same practice build', async () => {
    const backend = new MockBackend({ speed: 1000 });
    const events: ServerEvent[] = [];
    backend.onEvent((e) => events.push(e));
    const taskId = backend.practiceTask(FIRST_STEPS.task.id, `${PRACTICE_TASK_PREFIX}demo`)!;
    await vi.waitFor(() => expect(events.some((e) => e.type === 'task.done' && e.taskId === taskId)).toBe(true));
    backend.send({ action: 'deploy.plan', requestId: 'r1', templateId: 'photo-bucket' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.preview')).toBe(true));
    const p = events.find((e): e is Extract<ServerEvent, { type: 'deploy.preview' }> => e.type === 'deploy.preview')!;
    expect(isPracticeDeploy(p.deployId)).toBe(true);
    backend.send({ action: 'deploy.approve', deployId: p.deployId });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'deploy.status' && e.status === 'complete')).toBe(true));
    // A practice build pays no deploy stars (none in any build).
    expect(events.some((e) => e.type === 'task.done' && e.taskId === p.deployId)).toBe(false);
  });

  it('knows its scripts and templates', () => {
    expect(PRACTICE_SCRIPTS[FIRST_STEPS.task.id]?.agentId).toBe('s3');
    expect(isPracticeTemplate('photo-bucket')).toBe(true);
    expect(isPracticeTemplate('static-site')).toBe(false);
    expect(isPracticeTask(`${PRACTICE_TASK_PREFIX}x`)).toBe(true);
    expect(isPracticeTask('abc')).toBe(false);
  });

  it('an unknown script says so and plays nothing', async () => {
    const backend = new MockBackend({ speed: 1000 });
    const events: ServerEvent[] = [];
    backend.onEvent((e) => events.push(e));
    expect(backend.practiceTask('nope')).toBeUndefined();
    await vi.waitFor(() => expect(events.some((e) => e.type === 'error')).toBe(true));
    expect(events.some((e) => e.type === 'task.plan')).toBe(false);
  });
});

describe('the store: a practice task is not an answered request', () => {
  it('ticks a watch step, never an ask step', async () => {
    const { useCity } = await import('@/state/store');
    const s = () => useCity.getState();
    s().resetSession();
    // An "ask" step under way (a legacy save mid-quest): the practice task doesn't count for it.
    useCity.setState({ progress: { ...s().progress, quests: { 'aiml-first-model-call': { status: 'active', step: 2 } } } });
    s().applyServerEvent({ type: 'task.plan', taskId: `${PRACTICE_TASK_PREFIX}z`, agentId: 's3', targetServiceId: 's3', steps: ['a'] });
    s().applyServerEvent({ type: 'task.done', taskId: `${PRACTICE_TASK_PREFIX}z`, ok: true, result: 'ok', xp: [] });
    expect(s().progress.quests?.['aiml-first-model-call']?.step).toBe(2);
    s().resetSession();
  });
});
