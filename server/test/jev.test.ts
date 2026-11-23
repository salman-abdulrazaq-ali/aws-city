import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '../src/agents/actions.js';
import {
  BLOCKED_REASON,
  changeFor,
  createJev,
  serverName,
  decide,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_THRESHOLDS,
  JEV_QUESTIONS,
  JEV_URL,
  type JevAnswers,
  type JevConfig,
  type JevQuestionId,
  jevState,
  MAX_INTENT_CHARS,
  MAX_JEV_BYTES,
  MISMATCH_REASON,
  NO_REMOVAL_REASON,
  reading,
  REMOVAL_UNCLEAR_REASON,
  UNCHECKED_REASON,
  UNNAMED_TARGET_REASON,
  type WriteReview,
} from '../src/agents/jev.js';
import { describeAction } from '../src/agents/policy.js';
import { createAgentRunner, submitOpts } from '../src/agents/runner.js';
import { type ApprovalRequest, createActionService, NEEDS_APPROVAL_REASON, REJECTED_REASON } from '../src/agents/service.js';
import { clientsFor } from '../src/aws.js';
import { ConfigError, loadConfig } from '../src/config.js';
import { createApprovals } from '../src/contract/approvals.js';
import { createOrchestrator } from '../src/contract/orchestrator.js';
import { createUploadStore } from '../src/contract/uploads.js';
import { log } from '../src/log.js';
import type { WorldSnapshot } from '../src/state/model.js';
import type { Poller } from '../src/state/poller.js';
import type { ServerEvent } from '../src/world.js';
import { emptySnapshot, fakeActions, fakeLlm, message, text, toolUse } from './fakes.js';
import { ACCOUNT, instance, snapshot } from './fixtures.js';

const KEY = 'tsk_test_SECRET_key_0001';
const CFG: JevConfig = { apiKey: KEY, model: DEFAULT_JEV_MODEL, thresholds: DEFAULT_JEV_THRESHOLDS };
const I_ABC = 'i-0abc0000000000001';
const ASKED = 'please knock down my old test server';

afterEach(() => vi.restoreAllMocks());

/** The real clientsFor (the gate on), with a stub HTTP handler that records every request reaching AWS. */
const recording = () => {
  const sent: string[] = [];
  const requestHandler = {
    async handle(r: { method: string; hostname: string; path: string; headers: Record<string, string>; body?: unknown }) {
      const body = typeof r.body === 'string' ? r.body : r.body instanceof Uint8Array ? Buffer.from(r.body).toString('latin1') : '';
      sent.push(/(?:^|&)Action=(\w+)/.exec(body)?.[1] ?? `${r.method} ${r.hostname.split('.')[0]}${r.path}`);
      return { response: { statusCode: 200, headers: {}, body: new TextEncoder().encode('') } };
    },
  };
  const credentials = async () => ({ accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'not-a-secret' });
  return { sent, clients: clientsFor({ region: 'us-west-2', credentials, accountId: () => ACCOUNT, requestHandler: requestHandler as never }) };
};
const pollerFor = (s: WorldSnapshot) => ({ current: () => s, refresh: async () => s, start() {}, stop() {} }) as Poller;

type Body = { model: string; state: Record<string, unknown>; questions: Record<string, { type: string; instructions?: string; criteria?: unknown }> };
/** A stand-in for TypeSafe: answers each request with `respond` and records it. */
const stubJev = (respond: (body: Body, init: RequestInit) => Response | Promise<Response>) => {
  const calls: { url: string; init: RequestInit; body: Body }[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Body;
    calls.push({ url: String(url), init: init!, body });
    return respond(body, init!);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, spy: fetch };
};
type Nouls = Partial<Record<JevQuestionId, number>>;
/** Answers as TypeSafe documents them: one `{type: 'noul', noul}` per id given. */
const answers = (n: Nouls) => Object.fromEntries(Object.entries(n).map(([id, noul]) => [id, { type: 'noul', noul }]));
const reply = (a: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: DEFAULT_JEV_MODEL, answers: a, usage: { input_tokens: 321, output_tokens: 3 }, ...over }), { status: 200, headers: { 'content-type': 'application/json' } });
/** Answers exactly the questions the request asks, from `n` (the removal questions default to a clear yes). */
const nouls =
  (n: Nouls) =>
  (body: Body): Response => {
    const all: Nouls = { asks_to_remove: 0.95, names_target: 0.95, ...n };
    return reply(answers(Object.fromEntries(Object.keys(body.questions).map((id) => [id, all[id as JevQuestionId]]))));
  };

// The server has a Name tag that ASKED describes, so Jev's reading decides (an unnamed one asks by code: serverName).
const setup = (respond: Parameters<typeof stubJev>[0], s = snapshot([instance(I_ABC, 'running', true, 'old-test-server')])) => {
  const jev = stubJev(respond);
  const { clients, sent } = recording();
  // A short timeout so the timeout case runs through the service too (the default is 3 s).
  const service = createActionService({ clients, poller: pollerFor(s), region: 'us-west-2', judge: createJev(CFG, { fetch: jev.fetch, timeoutMs: 20 }) });
  return { service, sent, ...jev };
};
const terminate = { instanceId: I_ABC };
const reviewOf = (action: Action, intent: string | undefined, destructive: boolean): WriteReview => ({ action, summary: describeAction(action), destructive, intent });
const review = (over: Partial<WriteReview> = {}): WriteReview => ({ ...reviewOf({ type: 'terminate_instance', instanceId: I_ABC }, ASKED, true), ...over });

describe('the decision table (Jev answers, code decides)', () => {
  const t = DEFAULT_JEV_THRESHOLDS;
  const Y = 0.95;
  const N = 0.05;
  const U = 0.5;
  const write = (asked_for: number): JevAnswers => ({ destructive: false, asked_for });
  const removal = (asked_for: number, asks_to_remove: number, names_target: number): JevAnswers => ({ destructive: true, asked_for, asks_to_remove, names_target });

  it('reads a Noul at TypeSafe’s starting thresholds: ≤ 0.3 no, ≥ 0.7 yes, between unsettled (edges included)', () => {
    expect(t).toEqual({ no: 0.3, yes: 0.7 });
    expect([0, 0.3, 0.3001, 0.5, 0.6999, 0.7, 1].map((p) => reading(p, t))).toEqual(['no', 'no', 'unsettled', 'unsettled', 'unsettled', 'yes', 'yes']);
  });

  it('a write that removes nothing: asked_for alone decides', () => {
    expect(decide(write(0.3), t)).toEqual({ verdict: 'block', reason: BLOCKED_REASON, row: 'not_asked_for' });
    expect(decide(write(0.31), t)).toEqual({ verdict: 'ask', reason: MISMATCH_REASON, row: 'asked_for_unsettled' });
    expect(decide(write(0.69), t)).toEqual({ verdict: 'ask', reason: MISMATCH_REASON, row: 'asked_for_unsettled' });
    expect(decide(write(0.7), t)).toEqual({ verdict: 'allow', row: 'allow' });
  });

  it.each([
    // asked_for, asks_to_remove, names_target → row
    [N, Y, Y, 'block', BLOCKED_REASON, 'not_asked_for'],
    [N, N, N, 'block', BLOCKED_REASON, 'not_asked_for'],
    [Y, N, Y, 'block', NO_REMOVAL_REASON, 'removal_not_asked'],
    [U, N, Y, 'block', NO_REMOVAL_REASON, 'removal_not_asked'], // a block row wins over an ask row
    [U, Y, Y, 'ask', MISMATCH_REASON, 'asked_for_unsettled'],
    [U, U, N, 'ask', MISMATCH_REASON, 'asked_for_unsettled'], // the first ask row that holds names the reason
    [Y, U, Y, 'ask', REMOVAL_UNCLEAR_REASON, 'removal_unsettled'],
    [Y, U, N, 'ask', REMOVAL_UNCLEAR_REASON, 'removal_unsettled'],
    [Y, Y, N, 'ask', UNNAMED_TARGET_REASON, 'target_not_named'],
    [Y, Y, U, 'ask', UNNAMED_TARGET_REASON, 'target_not_named'],
    [Y, Y, Y, 'allow', undefined, 'allow'],
    // edges
    [0.7, 0.7, 0.7, 'allow', undefined, 'allow'],
    [0.7, 0.7, 0.69, 'ask', UNNAMED_TARGET_REASON, 'target_not_named'],
    [0.7, 0.3, 0.7, 'block', NO_REMOVAL_REASON, 'removal_not_asked'],
    [0.7, 0.31, 0.7, 'ask', REMOVAL_UNCLEAR_REASON, 'removal_unsettled'],
    [0.3, 0.7, 0.7, 'block', BLOCKED_REASON, 'not_asked_for'],
  ] as const)('a removal: asked_for %s, asks_to_remove %s, names_target %s → %s', (a, r, n, verdict, reason, row) => {
    expect(decide(removal(a, r, n), t)).toEqual({ verdict, row, ...(reason ? { reason } : {}) });
  });

  it('every combination of answers to a removal has an outcome, and a block always wins', () => {
    const levels = { no: N, unsettled: U, yes: Y } as const;
    const names = Object.keys(levels) as (keyof typeof levels)[];
    let seen = 0;
    for (const a of names)
      for (const r of names)
        for (const n of names) {
          const { verdict } = decide(removal(levels[a], levels[r], levels[n]), t);
          const expected = a === 'no' || r === 'no' ? 'block' : a === 'yes' && r === 'yes' && n === 'yes' ? 'allow' : 'ask';
          expect(verdict, `${a}/${r}/${n}`).toBe(expected);
          seen++;
        }
    expect(seen).toBe(27);
  });

  it('follows configured thresholds', () => {
    const c = { no: 0.1, yes: 0.9 };
    expect(decide(write(0.1), c).verdict).toBe('block');
    expect(decide(write(0.2), c).verdict).toBe('ask');
    expect(decide(write(0.89), c).verdict).toBe('ask');
    expect(decide(write(0.9), c).verdict).toBe('allow');
    expect(decide(removal(0.95, 0.95, 0.8), c).row).toBe('target_not_named');
  });
});

describe('what TypeSafe is sent', () => {
  it('the questions, word for word (one place to audit them: jev-config.ts)', () => {
    expect(JEV_QUESTIONS).toEqual({
      asked_for: {
        type: 'noul',
        instructions: 'Does `change` do what the player asked for in `request`?',
        criteria: { true: '`change` is what the player asked for, or one step of it.', false: 'The player asked for something different, and `change` is not part of it.' },
      },
      asks_to_remove: {
        type: 'noul',
        instructions: 'Does the player ask in `request` to delete, terminate or remove something?',
        criteria: { true: 'The player asks for something to be deleted, terminated, removed or torn down.', false: 'The player only asks to create, change, check or learn about something.' },
      },
      names_target: {
        type: 'noul',
        instructions: 'Does `request` name or describe the resource that `change` removes?',
        criteria: { true: 'The player names this resource, or describes it clearly enough to tell which one they mean.', false: "The player doesn't name or describe this resource." },
      },
    });
  });

  it('one POST to the fixed host, shaped as documented: the pinned model, the state and the Noul questions', async () => {
    const jev = stubJev(nouls({ asked_for: 0.9 }));
    expect(await createJev(CFG, { fetch: jev.fetch })(review({ intent: 'terminate i-0abc0000000000001, I am done with it' }))).toEqual({ verdict: 'allow' });
    expect(jev.calls).toHaveLength(1);
    const { url, init, body } = jev.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(url).toBe(JEV_URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.model).toBe('jev-1.14.0');
    expect(body.state).toEqual({ request: 'terminate i-0abc0000000000001, I am done with it', change: `Permanently terminate EC2 instance ${I_ABC}` });
    expect(body.questions).toEqual(JEV_QUESTIONS);
  });

  it.each<[string, Action, string, JevQuestionId[]]>([
    ['launch_instance', { type: 'launch_instance', name: 'web', instanceType: 't4g.nano' }, 'Launch a t4g.nano EC2 instance named "web"', ['asked_for']],
    ['stop_instance', { type: 'stop_instance', instanceId: I_ABC }, `Stop EC2 instance ${I_ABC}`, ['asked_for']],
    ['start_instance', { type: 'start_instance', instanceId: I_ABC }, `Start EC2 instance ${I_ABC}`, ['asked_for']],
    ['create_table', { type: 'create_table', name: 'city-scores' }, 'Create DynamoDB table "city-scores"', ['asked_for']],
    ['create_bucket', { type: 'create_bucket', suffix: 'photos' }, 'Create S3 bucket with suffix "photos"', ['asked_for']],
    ['terminate_instance', { type: 'terminate_instance', instanceId: I_ABC }, `Permanently terminate EC2 instance ${I_ABC}`, ['asked_for', 'asks_to_remove', 'names_target']],
    ['delete_table', { type: 'delete_table', name: 'city-scores' }, 'Delete DynamoDB table "city-scores" and all its items', ['asked_for', 'asks_to_remove', 'names_target']],
    ['delete_bucket', { type: 'delete_bucket', name: `aws-city-${ACCOUNT}-photos` }, 'Delete S3 bucket "aws-city-<account>-photos"', ['asked_for', 'asks_to_remove', 'names_target']],
  ])('%s: state is only the words and the change; its questions', async (_kind, action, change, ids) => {
    const jev = stubJev(nouls({ asked_for: 0.9 }));
    const destructive = ids.length === 3;
    expect(await createJev(CFG, { fetch: jev.fetch })(reviewOf(action, 'do the thing I asked', destructive))).toEqual({ verdict: 'allow' });
    expect(jev.calls[0]!.body.state).toEqual({ request: 'do the thing I asked', change });
    expect(Object.keys(jev.calls[0]!.body.questions)).toEqual(ids);
    for (const id of ids) expect(jev.calls[0]!.body.questions[id]).toEqual(JEV_QUESTIONS[id]);
  });

  it('no call without the player’s words: allow at once, nothing sent or logged', async () => {
    const jev = stubJev(nouls({ asked_for: 0.9 }));
    const info = vi.spyOn(log, 'info');
    const warn = vi.spyOn(log, 'warn');
    const judge = createJev(CFG, { fetch: jev.fetch });
    for (const intent of [undefined, '', '   \n\t ']) {
      expect(await judge(review({ intent }))).toEqual({ verdict: 'allow' });
      expect(await judge(reviewOf({ type: 'create_bucket', suffix: 'photos' }, intent, false))).toEqual({ verdict: 'allow' });
      expect(jevState(review({ intent }))).toBeUndefined();
    }
    expect(jev.spy).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never sends an account id or an ARN, and caps the player’s words', () => {
    const name = `aws-city-${ACCOUNT}-photos`;
    const action = { type: 'delete_bucket', name } as const;
    const state = jevState(reviewOf(action, `delete ${name} in ${ACCOUNT}, arn:aws:s3:::${name}`, true));
    expect(state).toEqual({ request: 'delete aws-city-<account>-photos in <account>, <arn>', change: 'Delete S3 bucket "aws-city-<account>-photos"' });
    expect(JSON.stringify(state)).not.toMatch(/\d{12}/);
    expect(jevState(review({ intent: 'x'.repeat(5000) }))?.request).toHaveLength(MAX_INTENT_CHARS);
    expect(jevState(review({ intent: `  ${'y'.repeat(MAX_INTENT_CHARS - 1)} z` }))?.request).toBe('y'.repeat(MAX_INTENT_CHARS - 1));
  });
});

describe('Jev in ActionService: it only tightens', () => {
  it('allow: the player is asked as usual (no typed name) and the write runs', async () => {
    const { service, sent, calls } = setup(nouls({ asked_for: 0.95 }));
    const approve = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await service.submit('terminate_instance', terminate, { approve, intent: ASKED })).toMatchObject({ status: 'done' });
    expect(calls).toHaveLength(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toEqual({ action: { type: 'terminate_instance', instanceId: I_ABC }, summary: `Permanently terminate EC2 instance ${I_ABC}`, destructive: true });
    expect(approve.mock.calls[0]![0]).not.toHaveProperty('check');
    expect(sent).toEqual(['TerminateInstances']);
  });

  it('without the player’s words (a take-down, city care) Jev is never called: the ordinary approval', async () => {
    const { service, sent, spy } = setup(nouls({ asked_for: 0.05 }));
    const approve = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await service.submit('terminate_instance', terminate, { approve })).toMatchObject({ status: 'done' });
    expect(spy).not.toHaveBeenCalled();
    expect(approve.mock.calls[0]![0]).not.toHaveProperty('check');
    expect(sent).toEqual(['TerminateInstances']);
  });

  it('ask: the player still decides, with the row’s reason; a no sends nothing', async () => {
    const { service, sent } = setup(nouls({ asked_for: 0.5 }));
    const approve = vi.fn(async (_req: ApprovalRequest) => false);
    expect(await service.submit('terminate_instance', terminate, { approve, intent: ASKED })).toEqual({ status: 'denied', reason: REJECTED_REASON });
    expect(approve.mock.calls[0]![0].check).toEqual({ reason: MISMATCH_REASON });
    expect(sent).toEqual([]);

    const unnamed = setup(nouls({ asked_for: 0.95, names_target: 0.4 }));
    const approve2 = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await unnamed.service.submit('terminate_instance', terminate, { approve: approve2, intent: ASKED })).toMatchObject({ status: 'done' });
    expect(approve2.mock.calls[0]![0].check).toEqual({ reason: UNNAMED_TARGET_REASON });
  });

  it('ask becomes a preview the player must type the name on (v2.3 confirmText); a wrong or missing name changes nothing', async () => {
    const { service, sent } = setup(nouls({ asked_for: 0.5 }));
    const approvals = createApprovals({ region: 'us-west-2' });
    const events: ServerEvent[] = [];
    let previews = 0;
    const ask = () => service.submit('terminate_instance', terminate, { approve: (req) => approvals.request('t1', req, (e) => events.push(e)), intent: ASKED });
    const preview = async () => {
      await vi.waitFor(() => expect(events.filter((e) => e.type === 'deploy.preview').length).toBeGreaterThan(previews));
      previews++;
      return events.filter((e) => e.type === 'deploy.preview').at(-1)!;
    };

    const first = ask();
    const p1 = await preview();
    expect(p1).toMatchObject({
      confirmText: I_ABC,
      changes: [
        { action: 'Remove', logicalId: I_ABC, resourceType: 'AWS::EC2::Instance' },
        { action: 'Modify', logicalId: `Safety check: ${MISMATCH_REASON}`, resourceType: 'detail' },
      ],
    });
    if (p1.type !== 'deploy.preview') throw new Error();
    approvals.answer(p1.deployId, true); // Approve pressed without typing the name
    expect(await first).toEqual({ status: 'denied', reason: REJECTED_REASON });
    expect(events).toContainEqual(expect.objectContaining({ type: 'deploy.status', deployId: p1.deployId, status: 'rejected' }));
    expect(sent).toEqual([]);

    const second = ask();
    const p2 = await preview();
    if (p2.type !== 'deploy.preview') throw new Error();
    approvals.answer(p2.deployId, true, ` ${I_ABC} `);
    expect(await second).toMatchObject({ status: 'done' });
    expect(sent).toEqual(['TerminateInstances']);
  });

  it('block: refused with a plain reason, the player is never asked and nothing reaches AWS', async () => {
    const { service, sent } = setup(nouls({ asked_for: 0.05 }));
    const approve = vi.fn(async () => true);
    expect(await service.submit('terminate_instance', terminate, { approve, intent: 'make me a bucket for my photos' })).toEqual({ status: 'denied', reason: BLOCKED_REASON });
    expect(BLOCKED_REASON).toMatch(/safety check stopped this.*AWS Console/);
    expect(approve).not.toHaveBeenCalled();
    expect(sent).toEqual([]);

    const notRemoval = setup(nouls({ asked_for: 0.8, asks_to_remove: 0.1 }));
    expect(await notRemoval.service.submit('terminate_instance', terminate, { approve, intent: 'stop my server for tonight' })).toEqual({ status: 'denied', reason: NO_REMOVAL_REASON });
    expect(NO_REMOVAL_REASON).toMatch(/safety check stopped this.*AWS Console/);
    expect(approve).not.toHaveBeenCalled();
    expect(notRemoval.sent).toEqual([]);
  });

  it.each([
    ['a timeout', (_b: Body, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))],
    ['a 500', () => new Response('upstream broke', { status: 500 })],
    ['a 401', () => new Response('{"detail":"bad key"}', { status: 401 })],
    ['malformed JSON', () => new Response('{"model": "jev-1.14.0", "answers": {', { status: 200 })],
    ['no answers at all', () => reply({})],
    ['a removal question unanswered (never read as a no)', () => reply(answers({ asked_for: 0.05, asks_to_remove: 0.05 }))],
    ['asked_for unanswered', () => reply(answers({ asks_to_remove: 0.95, names_target: 0.95 }))],
    ['an answer of the wrong type', () => reply({ ...answers({ asks_to_remove: 0.9, names_target: 0.9 }), asked_for: { type: 'score', score: 1, confidence: 0.9 } })],
    ['a noul off the scale', () => reply(answers({ asked_for: 1.7, asks_to_remove: 0.9, names_target: 0.9 }))],
    ['a negative noul', () => reply(answers({ asked_for: 0.9, asks_to_remove: -0.1, names_target: 0.9 }))],
    ['a noul given as text', () => reply({ ...answers({ asks_to_remove: 0.9, names_target: 0.9 }), asked_for: { type: 'noul', noul: '0.9' } })],
    ['no usage (not the documented shape)', () => reply(answers({ asked_for: 0.9, asks_to_remove: 0.9, names_target: 0.9 }), { usage: undefined })],
    ['a reply over the size cap', () => reply(answers({ asked_for: 0.9, asks_to_remove: 0.9, names_target: 0.9 }), { pad: 'x'.repeat(MAX_JEV_BYTES) })],
    ['a redirect (fetch refuses it)', () => Promise.reject(new TypeError('fetch failed'))],
  ])('fails closed to ask on %s', async (_what, respond) => {
    const { service, sent } = setup(respond);
    const approve = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await createJev(CFG, { fetch: stubJev(respond).fetch, timeoutMs: 20 })(review())).toEqual({ verdict: 'ask', reason: UNCHECKED_REASON });
    expect(await service.submit('terminate_instance', terminate, { approve, intent: ASKED })).toMatchObject({ status: 'done' });
    expect(approve.mock.calls[0]![0].check).toEqual({ reason: UNCHECKED_REASON });
    expect(sent).toEqual(['TerminateInstances']);
  });

  it('off (no judge): exactly today’s approval, and nothing is sent to TypeSafe', async () => {
    const net = vi.spyOn(globalThis, 'fetch');
    const { clients, sent } = recording();
    const service = createActionService({ clients, poller: pollerFor(snapshot([instance(I_ABC, 'running')])), region: 'us-west-2' });
    const approve = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await service.submit('terminate_instance', terminate, { approve, intent: ASKED })).toMatchObject({ status: 'done' });
    expect(approve.mock.calls[0]![0]).toEqual({ action: { type: 'terminate_instance', instanceId: I_ABC }, summary: `Permanently terminate EC2 instance ${I_ABC}`, destructive: true });
    expect(approve.mock.calls[0]![0]).not.toHaveProperty('check');
    expect(sent).toEqual(['TerminateInstances']);
    expect(net).not.toHaveBeenCalled();
  });

  it('never sees reads, policy-denied writes or writes without an approval channel', async () => {
    const { service, spy } = setup(nouls({ asked_for: 0.95 }));
    const approve = vi.fn(async () => true);
    await service.submit('describe_resource', { id: I_ABC }, { approve, intent: ASKED });
    await service.submit('review_architecture', {}, { approve, intent: ASKED });
    // Not built by the game: policy denies before anyone (Jev or the player) is asked.
    expect(await service.submit('terminate_instance', { instanceId: 'i-0000000000000009f' }, { approve, intent: ASKED })).toMatchObject({ status: 'denied' });
    expect(await service.submit('terminate_instance', terminate, { intent: ASKED })).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    expect(spy).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('logs each decision (id, model, each answer, verdict, row, latency, tokens) and never the key or the state', async () => {
    const info = vi.spyOn(log, 'info');
    const warn = vi.spyOn(log, 'warn');
    const name = `aws-city-${ACCOUNT}-photos`;
    const action = { type: 'delete_bucket', name } as const;
    await createJev(CFG, { fetch: stubJev(nouls({ asked_for: 0.9, asks_to_remove: 0.85, names_target: 0.4 })).fetch })(reviewOf(action, `${ASKED} ${ACCOUNT}`, true));
    await createJev(CFG, { fetch: stubJev(nouls({ asked_for: 0.2 })).fetch })(reviewOf({ type: 'create_bucket', suffix: 'photos' }, 'knock down the photos bucket', false));
    const line = { decision: expect.stringMatching(/^j-[0-9a-f]{8}$/), model: DEFAULT_JEV_MODEL, ms: expect.any(Number), inputTokens: 321, outputTokens: 3 };
    expect(info.mock.calls).toEqual([
      ['jev', { ...line, verdict: 'ask', row: 'target_not_named', asked_for: 0.9, asks_to_remove: 0.85, names_target: 0.4, action: 'delete_bucket' }],
      ['jev', { ...line, verdict: 'block', row: 'not_asked_for', asked_for: 0.2, action: 'create_bucket' }],
    ]);
    // An alias moved: the answer still counts, and the operator hears about it.
    await createJev(CFG, { fetch: stubJev((b) => reply(answers(Object.fromEntries(Object.keys(b.questions).map((id) => [id, 0.9]))), { model: 'jev-1.15.0' })).fetch })(review());
    expect(warn).toHaveBeenCalledWith('jev answered with another model', expect.objectContaining({ pinned: DEFAULT_JEV_MODEL, model: 'jev-1.15.0' }));
    await createJev(CFG, { fetch: stubJev(() => new Response('no', { status: 503 })).fetch })(review());
    expect(warn).toHaveBeenCalledWith('jev', expect.objectContaining({ verdict: 'ask', error: 'status 503' }));
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('knock down');
    expect(logged).not.toContain('photos');
    expect(logged).not.toMatch(/\d{12}/);
  });
});

describe("the player's words reach the judge", () => {
  it('task.submit passes its prompt as the intent of each write', async () => {
    const { llm } = fakeLlm([
      message([toolUse('p1', 'plan_task', { agentId: 's3', steps: ['Make a bucket'], reply: 'A job for S3!' })], 'tool_use'),
      message([toolUse('t1', 'create_bucket', { suffix: 'photos' })], 'tool_use'),
      message([text('Done')], 'end_turn'),
    ]);
    const actions = fakeActions();
    const runner = createAgentRunner({ llm, actions, snapshot: emptySnapshot });
    const orchestrator = createOrchestrator({ llm, runner, snapshot: emptySnapshot, uploads: createUploadStore('http://127.0.0.1:8787'), walkMs: 0, paceMs: 0 });
    await orchestrator.submitTask({ taskId: 't1', prompt: 'store my holiday photos', context: {} }, () => undefined, createApprovals({ region: 'us-west-2' }));
    expect(actions.submit).toHaveBeenCalledWith('create_bucket', { suffix: 'photos' }, { approve: expect.any(Function), intent: 'store my holiday photos' });
  });

  it('a turn without the player’s words (city care) sends none', () => {
    const approve = async () => true;
    expect(submitOpts({ approve })).toEqual({ approve });
    expect(submitOpts({ approve, intent: 'make a table' })).toEqual({ approve, intent: 'make a table' });
  });
});

describe('Jev config', () => {
  it('is off without TYPESAFE_API_KEY, on with it, pinned to jev-1.14.0 with Noul thresholds 0.3 / 0.7 by default', () => {
    expect(loadConfig({}).jev).toBeUndefined();
    expect(loadConfig({ TYPESAFE_API_KEY: '' }).jev).toBeUndefined();
    expect(loadConfig({ TYPESAFE_API_KEY: KEY }).jev).toEqual({ apiKey: KEY, model: 'jev-1.14.0', thresholds: { no: 0.3, yes: 0.7 } });
    expect(loadConfig({ TYPESAFE_API_KEY: KEY, AWS_CITY_JEV_MODEL: 'jev-1.13.0', AWS_CITY_JEV_NO: '0.2', AWS_CITY_JEV_YES: '0.8' }).jev).toEqual({
      apiKey: KEY,
      model: 'jev-1.13.0',
      thresholds: { no: 0.2, yes: 0.8 },
    });
    expect(loadConfig({ TYPESAFE_API_KEY: KEY, AWS_CITY_JEV_NO: '0', AWS_CITY_JEV_YES: '1' }).jev?.thresholds).toEqual({ no: 0, yes: 1 });
  });

  const bad = (env: NodeJS.ProcessEnv) => {
    let err: unknown;
    try {
      loadConfig(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    if (env.TYPESAFE_API_KEY) expect((err as Error).message).not.toContain(env.TYPESAFE_API_KEY);
    return (err as Error).message;
  };
  const withKey = (env: NodeJS.ProcessEnv) => bad({ TYPESAFE_API_KEY: KEY, ...env });

  it('refuses bad numbers, NO not below YES, a bad model and a bad key, without printing the key', () => {
    expect(withKey({ AWS_CITY_JEV_NO: 'lots' })).toMatch(/AWS_CITY_JEV_NO/);
    expect(withKey({ AWS_CITY_JEV_YES: '1.5' })).toMatch(/AWS_CITY_JEV_YES.*from 0 to 1/);
    expect(withKey({ AWS_CITY_JEV_NO: '-0.1' })).toMatch(/from 0 to 1/);
    expect(withKey({ AWS_CITY_JEV_YES: 'NaN' })).toMatch(/AWS_CITY_JEV_YES/);
    expect(withKey({ AWS_CITY_JEV_NO: '0.7', AWS_CITY_JEV_YES: '0.7' })).toMatch(/AWS_CITY_JEV_NO must be below AWS_CITY_JEV_YES/);
    expect(withKey({ AWS_CITY_JEV_NO: '0.8' })).toMatch(/AWS_CITY_JEV_NO must be below AWS_CITY_JEV_YES/);
    expect(withKey({ AWS_CITY_JEV_MODEL: 'jev latest; rm' })).toMatch(/AWS_CITY_JEV_MODEL/);
    expect(withKey({ TYPESAFE_API_KEY: 'tsk two words' })).toMatch(/TYPESAFE_API_KEY must be one printable token/);
    expect(withKey({ TYPESAFE_API_KEY: `${KEY}\n` })).toMatch(/TYPESAFE_API_KEY/);
  });

  it.each(['AWS_CITY_JEV_BLOCK_BELOW', 'AWS_CITY_JEV_ASK_BELOW', 'AWS_CITY_JEV_ASK_RISK'])('refuses the retired %s (with or without a key), naming the new settings', (name) => {
    for (const msg of [withKey({ [name]: '0.5' }), bad({ [name]: '0.5' })]) expect(msg).toMatch(new RegExp(`${name} is no longer read.*AWS_CITY_JEV_NO.*AWS_CITY_JEV_YES`));
    expect(loadConfig({ TYPESAFE_API_KEY: KEY, [name]: '' }).jev).toBeDefined(); // empty counts as unset, as for every setting
  });
});

describe('the change names the server (state a person could judge)', () => {
  it('a terminate carries the instance Name tag, or says it has none; buckets and tables are already named', () => {
    const t = { type: 'terminate_instance', instanceId: I_ABC } as const;
    const said = describeAction(t);
    expect(serverName(t, [{ id: I_ABC, name: 'old-test-server' }])).toBe('old-test-server');
    expect(serverName(t, [{ id: I_ABC, name: I_ABC }])).toBeUndefined();
    expect(serverName(t, [])).toBeUndefined();
    expect(serverName(t, [{ id: I_ABC, name: 'x'.repeat(200) }])).toBe('x'.repeat(64));
    expect(changeFor(said, t, 'old-test-server')).toBe(`${said}, named "old-test-server"`);
    expect(changeFor(said, t, undefined)).toBe(`${said}, which has no name`);
    const bucket = { type: 'delete_bucket', name: 'aws-city-photos' } as const;
    expect(serverName(bucket, [{ id: 'aws-city-photos', name: 'photos' }])).toBeUndefined();
    expect(changeFor(describeAction(bucket), bucket, undefined)).toBe(describeAction(bucket));
  });

  it('ActionService gives Jev the named change and keeps the approval card in its own words', async () => {
    const judge = vi.fn(async () => ({ verdict: 'allow' as const }));
    const cards: string[] = [];
    const { clients } = recording();
    const service = createActionService({
      clients,
      poller: pollerFor(snapshot([instance(I_ABC, 'running', true, 'old-test-server')])),
      region: 'us-west-2',
      judge,
    });
    await service.submit('terminate_instance', { instanceId: I_ABC }, {
      intent: ASKED,
      approve: async (r: ApprovalRequest) => (cards.push(r.summary), false),
    });
    expect(judge).toHaveBeenCalledWith(expect.objectContaining({ summary: `Permanently terminate EC2 instance ${I_ABC}, named "old-test-server"` }));
    expect(cards).toEqual([`Permanently terminate EC2 instance ${I_ABC}`]);
  });

  it('code decides an unnamed server: a description alone never counts as naming it, its id does', async () => {
    const jev = stubJev((body) => reply(Object.fromEntries(Object.keys(body.questions).map((q) => [q, { type: 'noul', noul: 0.95 }]))));
    const judge = createJev(CFG, { fetch: jev.fetch });
    const unnamed = { ...review({ intent: 'please knock down my old test server' }), unnamedTarget: true };
    expect(await judge(unnamed)).toMatchObject({ verdict: 'ask' });
    expect(await judge({ ...unnamed, intent: `terminate ${I_ABC}` })).toEqual({ verdict: 'allow' });
    expect(await judge({ ...unnamed, unnamedTarget: undefined })).toEqual({ verdict: 'allow' });
  });
});
