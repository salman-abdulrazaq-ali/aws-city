import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { APIUserAbortError } from '@anthropic-ai/sdk';
import { isModelDenied, log, PAUSED_MESSAGE, publicErrors } from '../log.js';
import { type QuotaStore, today } from '../store/types.js';
import type Anthropic from '@anthropic-ai/sdk';
import type { Llm } from './llm.js';

export { PAUSED_MESSAGE };

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

/** A player first seen today gets this share of the daily calls (100 → 20): a throwaway sign-up is worth little. */
export const NEW_PLAYER_SHARE = 1 / 5;
/** Players first seen today share at most this part of the city's daily cap (20,000 → 5,000), however many sign up. */
export const NEW_PLAYERS_GLOBAL_SHARE = 1 / 4;
/** The city's counter for players first seen today (beside GLOBAL). */
export const NEW_PLAYERS_KEY = 'GLOBAL#NEW';

/** The player stopped it (closed their tab): the call may have cost something, so it's never given back. */
export const isAbort = (err: unknown) => err instanceof APIUserAbortError || ['AbortError', 'CancelledError'].includes((err as { name?: string })?.name ?? '');

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
 * players' share (players first seen today) → the global daily cap → the player's quota (counted). Counters are
 * atomic (DynamoDB conditional ADD when hosted), so parallel sockets or tasks can't overshoot. Open sign-up makes
 * accounts free, so a player first seen today gets `newDaily` calls (NEW_PLAYER_SHARE of `daily`) and all of them
 * together at most `newGlobalDaily` (NEW_PLAYERS_GLOBAL_SHARE of the global cap): ~200 throwaway accounts take 4,000
 * calls, never the whole city's day. A call that fails before Bedrock answers (throttled, refused, denied) is given
 * back; one the player aborted isn't.
 */
export const metered = (
  llm: Llm,
  deps: { sub: string; quota: QuotaStore; daily: number; globalDaily: number; enabled: () => Promise<boolean>; now?: () => number; newDaily?: number; newGlobalDaily?: number },
): Llm => {
  const newDaily = deps.newDaily ?? Math.max(1, Math.ceil(deps.daily * NEW_PLAYER_SHARE));
  const newGlobalDaily = deps.newGlobalDaily ?? Math.floor(deps.globalDaily * NEW_PLAYERS_GLOBAL_SHARE);
  /** Whether this player was first seen today; once they weren't, they never are again. The local server's one player never is. */
  let seen: { day: string; fresh: boolean } | undefined;
  const firstSeenToday = async (day: string) => {
    if (deps.sub === 'local') return false;
    if (seen && (!seen.fresh || seen.day === day)) return seen.fresh;
    seen = { day, fresh: (await deps.quota.firstSeen(deps.sub, day)) >= day };
    return seen.fresh;
  };
  /** What one call took, so a failed call gives exactly that back. */
  type Ticket = { day: string; fresh: boolean };
  const giveBack = async (t: Ticket, player = true) => {
    const keys = [...(player ? [deps.sub] : []), 'GLOBAL', ...(t.fresh ? [NEW_PLAYERS_KEY] : [])];
    await Promise.all(keys.map((k) => deps.quota.refund(k, t.day))).catch((err) => log.warn('quota refund failed', { err: (err as Error).name }));
  };
  const take = async (): Promise<Ticket> => {
    if (!(await deps.enabled())) throw new ModelLimitError('paused', PAUSED_MESSAGE);
    const day = today(deps.now?.());
    const fresh = await firstSeenToday(day);
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
  /** Bedrock still throttling after the SDK's own retries: counted for the ModelThrottled alarm. A failure gives the call back. */
  const call = async <T>(ticket: Ticket, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      const e = err as { status?: number; name?: string };
      if (e?.status === 429 || e?.name === 'ThrottlingException') log.metric('ModelThrottled', 1);
      if (!isAbort(err)) await giveBack(ticket);
      throw modelError(err);
    }
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
    client: llm.client,
    /** The same checks for model calls made outside create/stream (the Strands citizens' model). */
    gate: async () => void (await take()),
    /** Gives back one call taken by `gate` that failed before Bedrock answered (the Strands citizens' model). */
    refund: async () => {
      const day = today(deps.now?.());
      await giveBack({ day, fresh: seen?.day === day && seen.fresh });
    },
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
      // A stream that already sent text cost something: only a failure before the first word gives the call back.
      const ticket = await take();
      let spoke = false;
      try {
        return record(
          await llm.stream(params, (d) => {
            spoke = true;
            onText(d);
          }),
        );
      } catch (err) {
        if (spoke) throw modelError(err);
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
