import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { log } from '../log.js';
import type { Action } from './actions.js';
import { DEFAULT_JEV_MODEL, DEFAULT_JEV_THRESHOLDS, JEV_QUESTIONS, type JevConfig, type JevQuestionId, type JevThresholds } from './jev-config.js';

export { DEFAULT_JEV_MODEL, DEFAULT_JEV_THRESHOLDS, JEV_QUESTIONS, type JevConfig, type JevQuestionId, type JevThresholds };

/**
 * TypeSafe's Jev (docs/jev.md): a second opinion on an agent's AWS write, asked after policy passes and before the
 * player is. It only tightens: "ask" makes the player type the resource's name to approve, "block" refuses. It can't
 * allow what policy or the gate deny, skip or answer the player's approval, or see a read. Off without
 * TYPESAFE_API_KEY, and never called without the player's own words (it would have nothing to judge). Jev answers
 * yes/no questions (`JEV_QUESTIONS`, jev-config.ts); code decides (`decide`). Any failure (timeout, non-2xx, too big,
 * a reply that doesn't fit the documented shape, an answer missing) is "ask", never read as an answer.
 * Injected text can sway Jev, which is why it may never loosen anything.
 */
export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_TIMEOUT_MS = 3_000;
export const MAX_JEV_BYTES = 32 * 1024;
/** The player's words sent at most (Jev's long-state mode is slower and less accurate). */
export const MAX_INTENT_CHARS = 500;

export type Verdict = 'allow' | 'ask' | 'block';

/** What the judge is told about one write (ActionService fills it once policy has passed). */
export interface WriteReview {
  action: Action;
  /** describeAction(action). */
  summary: string;
  destructive: boolean;
  /** The player's own request, when the caller has it (task.submit's prompt). */
  intent?: string;
  /** A terminate whose server has no Name tag (ActionService reads it from the city's snapshot, `serverName`). */
  unnamedTarget?: boolean;
}
export interface Judgement {
  verdict: Verdict;
  /** One plain sentence for the player (ask and block). */
  reason?: string;
}
/** Never throws in practice; ActionService treats a throw as "ask" anyway. */
export type Judge = (review: WriteReview) => Promise<Judgement>;

export const BLOCKED_REASON =
  "The city's safety check stopped this: it doesn't look like what you asked for, so nothing was changed. Ask again in your own words, or make the change yourself in the AWS Console.";
export const NO_REMOVAL_REASON =
  "The city's safety check stopped this: it removes something, and you didn't ask for anything to be removed, so nothing was changed. Ask again in your own words, or make the change yourself in the AWS Console.";
export const MISMATCH_REASON = 'This may not be what you asked for.';
export const REMOVAL_UNCLEAR_REASON = "This removes something, and it isn't clear you asked for anything to be removed.";
export const UNNAMED_TARGET_REASON = "This removes something your request didn't name.";
export const UNCHECKED_REASON = "The safety check couldn't look at this one, so check it carefully.";

/** How code reads one Noul (the probability of yes): at or below `no` is a no, at or above `yes` a yes, else unsettled. */
export type Reading = 'yes' | 'no' | 'unsettled';
export const reading = (noul: number, t: JevThresholds): Reading => (noul <= t.no ? 'no' : noul >= t.yes ? 'yes' : 'unsettled');

/** Jev's answers, by question id: a destructive write is asked all three questions, any other write `asked_for` only. */
export type JevAnswers =
  | { destructive: false; asked_for: number }
  | { destructive: true; asked_for: number; asks_to_remove: number; names_target: number };

/** The decision table's rows, logged with each decision. */
export type JevRow = 'not_asked_for' | 'removal_not_asked' | 'asked_for_unsettled' | 'removal_unsettled' | 'target_not_named' | 'allow';
export interface Decision extends Judgement {
  row: JevRow;
}

/**
 * Pure: the decision table. Jev only answers the questions; this decides. The first row that holds wins, so a block
 * always wins over an ask, and every combination of answers has an outcome:
 *
 * | row                 | when                                              | verdict |
 * |---------------------|---------------------------------------------------|---------|
 * | not_asked_for       | `asked_for` no                                    | block   |
 * | removal_not_asked   | destructive and `asks_to_remove` no               | block   |
 * | asked_for_unsettled | `asked_for` unsettled                             | ask     |
 * | removal_unsettled   | destructive and `asks_to_remove` unsettled        | ask     |
 * | target_not_named    | destructive and `names_target` no or unsettled    | ask     |
 * | allow               | otherwise                                         | allow   |
 */
export const decide = (a: JevAnswers, t: JevThresholds): Decision => {
  const askedFor = reading(a.asked_for, t);
  const remove = a.destructive ? reading(a.asks_to_remove, t) : undefined;
  const named = a.destructive ? reading(a.names_target, t) : undefined;
  if (askedFor === 'no') return { verdict: 'block', reason: BLOCKED_REASON, row: 'not_asked_for' };
  if (remove === 'no') return { verdict: 'block', reason: NO_REMOVAL_REASON, row: 'removal_not_asked' };
  if (askedFor === 'unsettled') return { verdict: 'ask', reason: MISMATCH_REASON, row: 'asked_for_unsettled' };
  if (remove === 'unsettled') return { verdict: 'ask', reason: REMOVAL_UNCLEAR_REASON, row: 'removal_unsettled' };
  if (named !== undefined && named !== 'yes') return { verdict: 'ask', reason: UNNAMED_TARGET_REASON, row: 'target_not_named' };
  return { verdict: 'allow', row: 'allow' };
};

const ACCOUNT_ID = /(?<!\d)\d{12}(?!\d)/g;
const ARN = /\barn:[^\s"'<>]*/gi;
/** Account ids (bucket names embed them) and ARNs never leave for TypeSafe. */
export const redact = (s: string) => s.replace(ARN, '<arn>').replace(ACCOUNT_ID, '<account>');

/**
 * The whole state: the player's words (redacted, capped) and the change's one-line summary (redacted). Nothing else:
 * code already knows the action's type and whether it destroys something, and a field no question needs can sway the
 * answers. Undefined without the player's words: there's nothing for Jev to judge.
 */
/** A name a person would recognise, at most this long. */
const MAX_NAME_CHARS = 64;
/**
 * The change as a person would see it: a terminate names the server by its Name tag, or says it has none, because an
 * instance id alone can't tell anyone whether it is "my old test server" (probe case described-only, 23 Nov 2026:
 * `names_target` 0.76 on an id). Buckets and tables are already named in the summary. Only Jev's state uses this;
 * the approval card keeps `describeAction`'s words.
 */
export const serverName = (action: Action, resources: readonly { id: string; name: string }[] = []): string | undefined => {
  if (action.type !== 'terminate_instance') return undefined;
  const name = resources.find((r) => r.id === action.instanceId)?.name?.trim().slice(0, MAX_NAME_CHARS);
  return name && name !== action.instanceId ? name : undefined;
};
export const changeFor = (summary: string, action: Action, name: string | undefined): string => {
  if (action.type !== 'terminate_instance') return summary;
  return name ? `${summary}, named "${name}"` : `${summary}, which has no name`;
};

export const jevState = (r: WriteReview): { request: string; change: string } | undefined => {
  const request = redact(r.intent?.trim() ?? '')
    .slice(0, MAX_INTENT_CHARS)
    .trim();
  return request ? { request, change: redact(r.summary) } : undefined;
};

/** The questions asked about a write: `asked_for` always, the two removal questions only for a destructive one. */
export const questionIds = (destructive: boolean): readonly JevQuestionId[] =>
  destructive ? ['asked_for', 'asks_to_remove', 'names_target'] : ['asked_for'];
export const jevQuestions = (destructive: boolean) => Object.fromEntries(questionIds(destructive).map((id) => [id, JEV_QUESTIONS[id]]));

/** The documented response (fields beyond these are ignored). */
const JevResponse = z.object({
  model: z.string().min(1).max(100),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }),
});
const NoulAnswer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });

/** The body as text, or undefined past `max` bytes (checked while streaming). */
const readCapped = async (res: Response, max: number): Promise<string | undefined> => {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

/**
 * The judge: one POST to TypeSafe's fixed host per write that comes with the player's words, no redirects, a timeout
 * and a size cap. Each decision is logged with its id, the model that answered, each answer, the verdict and the row
 * that decided it, latency and token usage; never the state or the key.
 */
export const createJev =
  (cfg: JevConfig, opts: { fetch?: typeof fetch; timeoutMs?: number } = {}): Judge =>
  async (review) => {
    const state = jevState(review);
    // No words, no question: Jev can't judge intent, and the code already knows the risk (a destructive write always
    // carries confirmText, contract/approvals.ts). Nothing is sent to TypeSafe.
    if (!state) return { verdict: 'allow' };
    const decision = `j-${randomUUID().slice(0, 8)}`;
    const started = Date.now();
    const unchecked = (error: string): Judgement => {
      log.warn('jev', { decision, verdict: 'ask', error, ms: Date.now() - started, action: review.action.type });
      return { verdict: 'ask', reason: UNCHECKED_REASON };
    };
    let text: string | undefined;
    try {
      const res = await (opts.fetch ?? fetch)(JEV_URL, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(opts.timeoutMs ?? JEV_TIMEOUT_MS),
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.model, state, questions: jevQuestions(review.destructive) }),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return unchecked(`status ${res.status}`);
      }
      text = await readCapped(res, MAX_JEV_BYTES);
    } catch (err) {
      return unchecked((err as Error)?.name ?? 'Error');
    }
    if (text === undefined) return unchecked('too large');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return unchecked('not json');
    }
    const body = JevResponse.safeParse(json);
    if (!body.success) return unchecked('schema');
    // Every question asked must come back as a Noul; a missing or malformed answer is never read as a no.
    const noul = (id: JevQuestionId) => NoulAnswer.safeParse(body.data.answers[id]);
    const askedFor = noul('asked_for');
    if (!askedFor.success) return unchecked('missing answer');
    let answers: JevAnswers = { destructive: false, asked_for: askedFor.data.noul };
    if (review.destructive) {
      const remove = noul('asks_to_remove');
      const named = noul('names_target');
      if (!remove.success || !named.success) return unchecked('missing answer');
      // An exact lookup belongs in code: a server with no name can only be pointed at by its id, so unless the player's
      // words hold that id, a description can't make it a yes (probe case described-unnamed, 23 Nov 2026: "my old test
      // server" read as naming an unnamed server, 0.73).
      const idSaid = review.action.type === 'terminate_instance' && (review.intent ?? '').includes(review.action.instanceId);
      const namesTarget = review.unnamedTarget && !idSaid ? Math.min(named.data.noul, cfg.thresholds.no) : named.data.noul;
      answers = { destructive: true, asked_for: askedFor.data.noul, asks_to_remove: remove.data.noul, names_target: namesTarget };
    }

    const { row, ...judgement } = decide(answers, cfg.thresholds);
    if (body.data.model !== cfg.model) log.warn('jev answered with another model', { decision, pinned: cfg.model, model: body.data.model });
    const { destructive: _, ...nouls } = answers;
    log.info('jev', {
      decision,
      model: body.data.model,
      verdict: judgement.verdict,
      row,
      ...nouls,
      ms: Date.now() - started,
      inputTokens: body.data.usage.input_tokens,
      outputTokens: body.data.usage.output_tokens,
      action: review.action.type,
    });
    return judgement;
  };
