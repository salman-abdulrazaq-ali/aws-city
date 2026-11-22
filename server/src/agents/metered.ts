import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { APIUserAbortError, PermissionDeniedError } from '@anthropic-ai/sdk';
import { log, PAUSED_MESSAGE, publicErrors, setModelDenied } from '../log.js';
import { type QuotaStore, today } from '../store/types.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Llm } from './llm.js';

export { PAUSED_MESSAGE };

/**
 * Bedrock refused the model call with AccessDenied: the budget action's deny policy on the task role (or model access
 * not granted). Our Bedrock client is the Anthropic SDK's, which turns a 403 into PermissionDeniedError; AWS SDK errors
 * from the player's account never are one. Strands may wrap it (`cause`).
 */
export const isModelDenied = (err: unknown): boolean => err instanceof PermissionDeniedError || (err instanceof Error && err.cause instanceof PermissionDeniedError);
// publicError (log.ts) says the same for a denial that reaches it some other way.
setModelDenied(isModelDenied);

/** Thrown instead of calling Bedrock. The message is shown to the player as-is. */
export class ModelLimitError extends Error {
  constructor(readonly code: 'quota' | 'paused', message: string) {
    super(message);
  }
  get publicMessage() {
    return this.message;
  }
}
export const QUOTA_MESSAGE = 'You’ve used today’s AI helpers — they’ll be back tomorrow!';

/** A player is "new" for this many days from their first model call (that day and the next two). */
export const NEW_PLAYER_DAYS = 3;
/** A new player gets this share of the daily calls (100 → 20): a throwaway sign-up is worth little. */
export const NEW_PLAYER_SHARE = 1 / 5;
/** New players share at most this part of the city's daily cap (20,000 → 5,000), however many sign up. */
export const NEW_PLAYERS_GLOBAL_SHARE = 1 / 4;
/** The city's counter for new players (beside GLOBAL). */
export const NEW_PLAYERS_KEY = 'GLOBAL#NEW';

/** The player stopped it (closed their tab): the call may have cost something, so it's never given back. */
export const isAbort = (err: unknown) => err instanceof APIUserAbortError || ['AbortError', 'CancelledError'].includes((err as { name?: string })?.name ?? '');

/** Socket errors that only happen before a request is sent (no route, no name, nobody listening). */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

/**
 * Whether a failed model call proves the model never ran, so the call can be given back: Bedrock throttled it (429,
 * ThrottlingException), refused it (403, AccessDenied: the budget's deny policy) or rejected the request (400, a
 * validation error), or the connection failed before the request was sent. Never a timeout, a 5xx (Bedrock may have
 * run it) or an abort: those may have cost something.
 */
export const provenNotRun = (err: unknown): boolean => {
  if (isAbort(err)) return false;
  // The cause chain too: Strands wraps a 429 as ModelThrottledError, and a refused connection's code sits under fetch's TypeError.
  for (let c: unknown = err, depth = 0; c && depth < 5; c = (c as { cause?: unknown }).cause, depth++) {
    const e = c as { status?: number; name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
    const status = e.status ?? e.$metadata?.httpStatusCode;
    if (status === 429 || status === 403 || status === 400) return true;
    if (['ThrottlingException', 'ModelThrottledError', 'AccessDeniedException', 'ValidationException'].includes(e.name ?? '')) return true;
    if (NOT_SENT.has(e.code ?? '')) return true;
  }
  return false;
};

/** Whole days from one YYYY-MM-DD day to another. */
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/**
 * A failed model call as a hosted player should hear it: Bedrock's AccessDenied (the budget's deny policy) is "resting"
 * (code paused). The local server keeps the real error: its developer needs to see a missing model grant.
 */
export const modelError = (err: unknown) => (publicErrors() && isModelDenied(err) ? new ModelLimitError('paused', PAUSED_MESSAGE) : err);

/**
 * Kill switch: an SSM parameter set to "false" turns every model call off within ~30 s.
 * Unreadable parameter = keep running (the Budgets action is the hard stop: it denies Bedrock to the task role).
 */
export const killSwitch = (deps: { ssm?: SSMClient; name?: string; cacheMs?: number; now?: () => number }) => {
  let cached: { on: boolean; at: number } | undefined;
  const now = deps.now ?? Date.now;
  return async (): Promise<boolean> => {
    if (!deps.ssm || !deps.name) return true;
    if (cached && now() - cached.at < (deps.cacheMs ?? 30_000)) return cached.on;
    try {
      const out = await deps.ssm.send(new GetParameterCommand({ Name: deps.name }));
      cached = { on: out.Parameter?.Value?.trim().toLowerCase() !== 'false', at: now() };
    } catch (err) {
      log.warn('kill switch unreadable', { err: (err as Error).name });
      cached = { on: cached?.on ?? true, at: now() };
    }
    return cached.on;
  };
};

/**
 * Every Bedrock call for a player goes through here: kill switch → the player's daily quota (read) → the new
 * players' share → the global daily cap → the player's quota (counted). Counters are atomic (DynamoDB conditional ADD
 * when hosted), so parallel sockets or tasks can't overshoot. Open sign-up makes accounts free, so a player first seen
 * within NEW_PLAYER_DAYS gets `newDaily` calls (NEW_PLAYER_SHARE of `daily`) and all of them together at most
 * `newGlobalDaily` (NEW_PLAYERS_GLOBAL_SHARE of the global cap): ~200 throwaway accounts take 4,000 calls, never the
 * whole city's day. Only a call that proves the model never ran is given back (provenNotRun: throttled, denied, a bad
 * request, no connection); a timeout, a 5xx, an abort or a stream that sent anything isn't.
 */
export const metered = (
  llm: Llm,
  deps: { sub: string; quota: QuotaStore; daily: number; globalDaily: number; enabled: () => Promise<boolean>; now?: () => number; newDaily?: number; newGlobalDaily?: number },
): Llm => {
  const newDaily = deps.newDaily ?? Math.max(1, Math.ceil(deps.daily * NEW_PLAYER_SHARE));
  const newGlobalDaily = deps.newGlobalDaily ?? Math.floor(deps.globalDaily * NEW_PLAYERS_GLOBAL_SHARE);
  /** The day of this player's first model call (the SEEN row: saved once, never changed). The local server's one player is never new. */
  let firstDay: string | undefined;
  const isNew = async (day: string) => {
    if (deps.sub === 'local') return false;
    firstDay ??= await deps.quota.firstSeen(deps.sub, day);
    return daysBetween(firstDay, day) < NEW_PLAYER_DAYS;
  };
  /** Whether a call on `day` counted as a new player's (known without a read once a call was taken). */
  const wasNew = (day: string) => deps.sub !== 'local' && firstDay !== undefined && daysBetween(firstDay, day) < NEW_PLAYER_DAYS;
  /** What one call took, so a failed call gives exactly that back. */
  type Ticket = { day: string; fresh: boolean };
  const giveBack = async (t: Ticket, player = true) => {
    const keys = [...(player ? [deps.sub] : []), 'GLOBAL', ...(t.fresh ? [NEW_PLAYERS_KEY] : [])];
    await Promise.all(keys.map((k) => deps.quota.refund(k, t.day))).catch((err) => log.warn('quota refund failed', { err: (err as Error).name }));
  };
  const take = async (): Promise<Ticket> => {
    if (!(await deps.enabled())) throw new ModelLimitError('paused', PAUSED_MESSAGE);
    const day = today(deps.now?.());
    const fresh = await isNew(day);
    const limit = fresh ? Math.min(deps.daily, newDaily) : deps.daily;
    const overQuota = () => {
      log.metric('QuotaRejected', 1);
      return new ModelLimitError('quota', QUOTA_MESSAGE);
    };
    const paused = (metric: string) => {
      log.metric(metric, 1);
      return new ModelLimitError('paused', PAUSED_MESSAGE);
    };
    // A player already at their quota is refused before the global counts (one player can't use up the city's cap),
    // and a global refusal comes before the player's count (it doesn't burn their quota).
    if ((await deps.quota.used(deps.sub, day)) >= limit) throw overQuota();
    if (fresh && !(await deps.quota.consume(NEW_PLAYERS_KEY, day, newGlobalDaily))) throw paused('NewPlayersQuotaRejected');
    if (!(await deps.quota.consume('GLOBAL', day, deps.globalDaily))) {
      if (fresh) await deps.quota.refund(NEW_PLAYERS_KEY, day).catch(() => undefined);
      throw paused('GlobalQuotaRejected');
    }
    // Still atomic: parallel calls that all passed the read are cut off here (and give the city's counts back).
    if (!(await deps.quota.consume(deps.sub, day, limit))) {
      await giveBack({ day, fresh }, false);
      throw overQuota();
    }
    log.metric('ModelCalls', 1);
    return { day, fresh };
  };
  /** Bedrock still throttling after the SDK's own retries: counted for the ModelThrottled alarm. A failure that proves the model never ran gives the call back. */
  const call = async <T>(ticket: Ticket, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      const e = err as { status?: number; name?: string };
      if (e?.status === 429 || e?.name === 'ThrottlingException') log.metric('ModelThrottled', 1);
      if (provenNotRun(err)) await giveBack(ticket);
      throw modelError(err);
    }
  };
  /** One call taken for a model call made outside create/stream (the Strands models). */
  const gate = async () => void (await take());
  const refund = async (err?: unknown) => {
    if (!provenNotRun(err)) return;
    const day = today(deps.now?.());
    await giveBack({ day, fresh: wasNew(day) });
  };
  /** Token use per call (EMF): what the bill is made of, and whether prompt caching is working. */
  const record = (msg: Anthropic.Message) => {
    const u = msg.usage;
    if (!u) return msg;
    log.metric('InputTokens', u.input_tokens ?? 0);
    log.metric('OutputTokens', u.output_tokens ?? 0);
    log.metric('CacheReadTokens', u.cache_read_input_tokens ?? 0);
    return msg;
  };
  return {
    model: llm.model,
    family: llm.family,
    sees: llm.sees,
    small: llm.small,
    client: llm.client,
    /** The same checks for model calls made outside create/stream (the Strands citizens' model). */
    gate,
    /** Gives back one call taken by `gate` whose failure proves the model never ran (the Strands models, before any event). */
    refund,
    /** Strands models for this family, every call through the gate above and a failure before any event offered to `refund`. */
    strands: (opts) => llm.strands(opts, gate, refund),
    canFallBack: llm.canFallBack,
    async create(params, opts = {}) {
      const first = record(await call(await take(), () => llm.create(params, opts)));
      if (first.stop_reason !== 'refusal' || !llm.canFallBack(opts)) return first;
      // The client-side refusal fallback is a second Bedrock call: it goes through the same gate.
      log.warn('model refused; retrying on fallback', { light: Boolean(opts.light) });
      log.metric('Refusals', 1);
      return record(await call(await take(), () => llm.create(params, { ...opts, fallback: true })));
    },
    async stream(params, onText) {
      // A stream that sent anything (a thinking block counts) ran the model: only a failure before its first event can give the call back.
      const ticket = await take();
      let started = false;
      try {
        return record(
          await llm.stream(params, onText, () => {
            started = true;
          }),
        );
      } catch (err) {
        if (started) throw modelError(err);
        return call(ticket, () => Promise.reject(err));
      }
    },
  };
};

/** Error events caused by a limit get a machine-readable code so the UI can explain them kindly. */
export const withErrorCodes = <E extends { type: string; message?: string; code?: string }>(emit: (e: E) => void) => (e: E) => {
  if (e.type === 'error' && e.message && !e.code) {
    if (e.message.includes(QUOTA_MESSAGE)) return emit({ ...e, code: 'quota' });
    if (e.message.includes(PAUSED_MESSAGE)) return emit({ ...e, code: 'paused' });
  }
  emit(e);
};
