import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BLOCKED_REASON,
  createJev,
  DEFAULT_JEV_MODEL,
  DEFAULT_JEV_THRESHOLDS,
  JEV_URL,
  type JevConfig,
  jevState,
  MAX_INTENT_CHARS,
  MAX_JEV_BYTES,
  MISMATCH_REASON,
  RISK_LEVELS,
  RISKY_REASON,
  UNCHECKED_REASON,
  verdictFor,
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
const answers = (intent: number | undefined, risk: number) => ({
  ...(intent === undefined ? {} : { intent: { type: 'noul', noul: intent } }),
  risk: { type: 'score', score: risk, confidence: 0.8, legend: { '0': RISK_LEVELS[0] }, probabilities: { '0': 0.1, '1': 0.8, '2': 0.1 } },
});
const reply = (a: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: DEFAULT_JEV_MODEL, answers: a, usage: { input_tokens: 321, output_tokens: 4 }, ...over }), { status: 200, headers: { 'content-type': 'application/json' } });
/** Answers the way the request asks: the intent answer only when the intent question was sent. */
const scored = (intent: number, risk: number) => (body: Body) => reply(answers('intent' in body.questions ? intent : undefined, risk));

const setup = (respond: Parameters<typeof stubJev>[0], s = snapshot([instance(I_ABC, 'running')])) => {
  const jev = stubJev(respond);
  const { clients, sent } = recording();
  // A short timeout so the timeout case runs through the service too (the default is 3 s).
  const service = createActionService({ clients, poller: pollerFor(s), region: 'us-west-2', judge: createJev(CFG, { fetch: jev.fetch, timeoutMs: 20 }) });
  return { service, sent, ...jev };
};
const terminate = { instanceId: I_ABC };
const review = (over: Partial<WriteReview> = {}): WriteReview => {
  const action = { type: 'terminate_instance', instanceId: I_ABC } as const;
  return { action, summary: describeAction(action), destructive: true, intent: ASKED, ...over };
};

describe('Jev policy: the answers to a verdict (arithmetic in code)', () => {
  const t = DEFAULT_JEV_THRESHOLDS;
  it('blocks below 0.2, asks below 0.6 or from risk 1.2, else allows (edges included)', () => {
    expect(verdictFor({ intent: 0.19, risk: 0 }, t)).toBe('block');
    expect(verdictFor({ intent: 0.2, risk: 0 }, t)).toBe('ask');
    expect(verdictFor({ intent: 0.59, risk: 0 }, t)).toBe('ask');
    expect(verdictFor({ intent: 0.6, risk: 0 }, t)).toBe('allow');
    expect(verdictFor({ intent: 1, risk: 1.19 }, t)).toBe('allow');
    expect(verdictFor({ intent: 1, risk: 1.2 }, t)).toBe('ask');
    expect(verdictFor({ intent: 0, risk: 2 }, t)).toBe('block');
  });
  it('without the player’s words only risk counts', () => {
    expect(verdictFor({ risk: 0 }, t)).toBe('allow');
    expect(verdictFor({ risk: 1.19 }, t)).toBe('allow');
    expect(verdictFor({ risk: 1.2 }, t)).toBe('ask');
  });
  it('follows configured thresholds', () => {
    const c = { blockBelow: 0.5, askBelow: 0.9, askRiskAtLeast: 2 };
    expect(verdictFor({ intent: 0.49, risk: 0 }, c)).toBe('block');
    expect(verdictFor({ intent: 0.5, risk: 0 }, c)).toBe('ask');
    expect(verdictFor({ intent: 0.9, risk: 1.99 }, c)).toBe('allow');
    expect(verdictFor({ intent: 0.9, risk: 2 }, c)).toBe('ask');
  });
});

describe('what TypeSafe is sent', () => {
  it('one POST to the fixed host, shaped as documented: model, state, a noul and a score question', async () => {
    const jev = stubJev(scored(0.9, 0.4));
    expect(await createJev(CFG, { fetch: jev.fetch })(review())).toEqual({ verdict: 'allow' });
    expect(jev.calls).toHaveLength(1);
    const { url, init, body } = jev.calls[0]!;
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(url).toBe(JEV_URL);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state']);
    expect(body.model).toBe('jev-1.13.0');
    expect(body.state).toEqual({ request: ASKED, action: 'terminate_instance', change: `Permanently terminate EC2 instance ${I_ABC}`, destructive: true });
    expect(Object.keys(body.questions).sort()).toEqual(['intent', 'risk']);
    expect(body.questions.intent).toEqual({
      type: 'noul',
      instructions: expect.stringContaining('Does this AWS change do what the player asked for?'),
      criteria: { true: expect.any(String), false: expect.any(String) },
    });
    expect(body.questions.risk).toEqual({ type: 'score', instructions: expect.any(String), criteria: RISK_LEVELS });
    expect(RISK_LEVELS).toHaveLength(3);
  });

  it('asks no intent question without the player’s words', async () => {
    const jev = stubJev(scored(0.9, 0.4));
    await createJev(CFG, { fetch: jev.fetch })(review({ intent: undefined }));
    await createJev(CFG, { fetch: jev.fetch })(review({ intent: '   ' }));
    for (const { body } of jev.calls) {
      expect(Object.keys(body.questions)).toEqual(['risk']);
      expect(body.state).not.toHaveProperty('request');
    }
  });

  it('never sends an account id or an ARN, and caps the player’s words', () => {
    const name = `aws-city-${ACCOUNT}-photos`;
    const action = { type: 'delete_bucket', name } as const;
    const state = jevState({ action, summary: describeAction(action), destructive: true, intent: `delete ${name} in ${ACCOUNT}, arn:aws:s3:::${name}` });
    expect(state).toEqual({ request: 'delete aws-city-<account>-photos in <account>, <arn>', action: 'delete_bucket', change: 'Delete S3 bucket "aws-city-<account>-photos"', destructive: true });
    expect(JSON.stringify(state)).not.toMatch(/\d{12}/);
    expect(jevState(review({ intent: 'x'.repeat(5000) })).request).toHaveLength(MAX_INTENT_CHARS);
  });
});

describe('Jev in ActionService: it only tightens', () => {
  it('allow: the player is asked as usual (no typed name) and the write runs', async () => {
    const { service, sent, calls } = setup(scored(0.95, 0.5));
    const approve = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await service.submit('terminate_instance', terminate, { approve, intent: ASKED })).toMatchObject({ status: 'done' });
    expect(calls).toHaveLength(1);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]![0]).toEqual({ action: { type: 'terminate_instance', instanceId: I_ABC }, summary: `Permanently terminate EC2 instance ${I_ABC}`, destructive: true });
    expect(approve.mock.calls[0]![0]).not.toHaveProperty('check');
    expect(sent).toEqual(['TerminateInstances']);
  });

  it('ask: the player still decides, with a reason; a no sends nothing', async () => {
    const { service, sent } = setup(scored(0.4, 0.3));
    const approve = vi.fn(async (_req: ApprovalRequest) => false);
    expect(await service.submit('terminate_instance', terminate, { approve, intent: ASKED })).toEqual({ status: 'denied', reason: REJECTED_REASON });
    expect(approve.mock.calls[0]![0].check).toEqual({ reason: MISMATCH_REASON });
    expect(sent).toEqual([]);

    const risky = setup(scored(0.95, 1.6));
    const approve2 = vi.fn(async (_req: ApprovalRequest) => true);
    expect(await risky.service.submit('terminate_instance', terminate, { approve: approve2, intent: ASKED })).toMatchObject({ status: 'done' });
    expect(approve2.mock.calls[0]![0].check).toEqual({ reason: RISKY_REASON });
  });

  it('ask becomes a preview the player must type the name on (v2.3 confirmText); a wrong or missing name changes nothing', async () => {
    const { service, sent } = setup(scored(0.4, 0.3));
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
    const { service, sent } = setup(scored(0.05, 2));
    const approve = vi.fn(async () => true);
    expect(await service.submit('terminate_instance', terminate, { approve, intent: 'make me a bucket for my photos' })).toEqual({ status: 'denied', reason: BLOCKED_REASON });
    expect(BLOCKED_REASON).toMatch(/safety check stopped this.*AWS Console/);
    expect(approve).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it.each([
    ['a timeout', (_b: Body, init: RequestInit) => new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))],
    ['a 500', () => new Response('upstream broke', { status: 500 })],
    ['a 401', () => new Response('{"detail":"bad key"}', { status: 401 })],
    ['malformed JSON', () => new Response('{"model": "jev-1.13.0", "answers": {', { status: 200 })],
    ['a missing answer', () => reply(answers(undefined, 0.1))],
    ['an answer of the wrong type', () => reply({ intent: { type: 'noul', noul: 0.9 }, risk: { type: 'choice', choice: '0', confidence: 1 } })],
    ['a score off the scale', () => reply(answers(0.9, 7))],
    ['no usage (not the documented shape)', () => reply(answers(0.9, 0.1), { usage: undefined })],
    ['a reply over the size cap', () => reply(answers(0.9, 0.1), { pad: 'x'.repeat(MAX_JEV_BYTES) })],
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
    const { service, spy } = setup(scored(0.95, 0));
    const approve = vi.fn(async () => true);
    await service.submit('describe_resource', { id: I_ABC }, { approve, intent: ASKED });
    await service.submit('review_architecture', {}, { approve, intent: ASKED });
    // Not built by the game: policy denies before anyone (Jev or the player) is asked.
    expect(await service.submit('terminate_instance', { instanceId: 'i-0000000000000009f' }, { approve, intent: ASKED })).toMatchObject({ status: 'denied' });
    expect(await service.submit('terminate_instance', terminate, { intent: ASKED })).toEqual({ status: 'denied', reason: NEEDS_APPROVAL_REASON });
    expect(spy).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it('logs each decision (id, model, scores, verdict, latency, tokens) and never the key or the state', async () => {
    const info = vi.spyOn(log, 'info');
    const warn = vi.spyOn(log, 'warn');
    const name = `aws-city-${ACCOUNT}-photos`;
    const action = { type: 'delete_bucket', name } as const;
    await createJev(CFG, { fetch: stubJev(scored(0.3, 1.5)).fetch })({ action, summary: describeAction(action), destructive: true, intent: `${ASKED} ${ACCOUNT}` });
    expect(info.mock.calls).toEqual([
      [
        'jev',
        {
          decision: expect.stringMatching(/^j-[0-9a-f]{8}$/),
          model: DEFAULT_JEV_MODEL,
          verdict: 'ask',
          intent: 0.3,
          risk: 1.5,
          riskConfidence: 0.8,
          ms: expect.any(Number),
          inputTokens: 321,
          outputTokens: 4,
          action: 'delete_bucket',
        },
      ],
    ]);
    // An alias moved: the answer still counts, and the operator hears about it.
    await createJev(CFG, { fetch: stubJev((b) => reply(answers('intent' in b.questions ? 0.9 : undefined, 0), { model: 'jev-1.14.0' })).fetch })(review());
    expect(warn).toHaveBeenCalledWith('jev answered with another model', expect.objectContaining({ pinned: DEFAULT_JEV_MODEL, model: 'jev-1.14.0' }));
    await createJev(CFG, { fetch: stubJev(() => new Response('no', { status: 503 })).fetch })(review());
    expect(warn).toHaveBeenCalledWith('jev', expect.objectContaining({ verdict: 'ask', error: 'status 503' }));
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain(KEY);
    expect(logged).not.toContain('knock down');
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
  it('is off without TYPESAFE_API_KEY, on with it, pinned to jev-1.13.0 by default', () => {
    expect(loadConfig({}).jev).toBeUndefined();
    expect(loadConfig({ TYPESAFE_API_KEY: '' }).jev).toBeUndefined();
    expect(loadConfig({ TYPESAFE_API_KEY: KEY }).jev).toEqual({ apiKey: KEY, model: 'jev-1.13.0', thresholds: { blockBelow: 0.2, askBelow: 0.6, askRiskAtLeast: 1.2 } });
    expect(
      loadConfig({ TYPESAFE_API_KEY: KEY, AWS_CITY_JEV_MODEL: 'jev-1.14.0', AWS_CITY_JEV_BLOCK_BELOW: '0.1', AWS_CITY_JEV_ASK_BELOW: '0.7', AWS_CITY_JEV_ASK_RISK: '1' }).jev,
    ).toEqual({ apiKey: KEY, model: 'jev-1.14.0', thresholds: { blockBelow: 0.1, askBelow: 0.7, askRiskAtLeast: 1 } });
  });

  it('refuses bad numbers and a bad key, without printing the key', () => {
    const bad = (env: NodeJS.ProcessEnv) => {
      const full = { TYPESAFE_API_KEY: KEY, ...env };
      let err: unknown;
      try {
        loadConfig(full);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).not.toContain(full.TYPESAFE_API_KEY);
      return (err as Error).message;
    };
    expect(bad({ AWS_CITY_JEV_ASK_BELOW: 'lots' })).toMatch(/AWS_CITY_JEV_ASK_BELOW/);
    expect(bad({ AWS_CITY_JEV_BLOCK_BELOW: '1.5' })).toMatch(/from 0 to 1/);
    expect(bad({ AWS_CITY_JEV_ASK_RISK: '3' })).toMatch(/from 0 to 2/);
    expect(bad({ AWS_CITY_JEV_ASK_RISK: 'NaN' })).toMatch(/AWS_CITY_JEV_ASK_RISK/);
    expect(bad({ AWS_CITY_JEV_BLOCK_BELOW: '0.7', AWS_CITY_JEV_ASK_BELOW: '0.5' })).toMatch(/not be above/);
    expect(bad({ AWS_CITY_JEV_MODEL: 'jev latest; rm' })).toMatch(/AWS_CITY_JEV_MODEL/);
    expect(bad({ TYPESAFE_API_KEY: 'tsk two words' })).toMatch(/TYPESAFE_API_KEY must be one printable token/);
    expect(bad({ TYPESAFE_API_KEY: `${KEY}\n` })).toMatch(/TYPESAFE_API_KEY/);
  });
});
