import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { MiddlewareStack, Provider } from '@smithy/types';
import { log } from '../log.js';
import { ANY_REGION, type ChangeCommand, type ClientName, type Kind, ruleFor, type WireContext } from './rules.js';

/**
 * The deterministic gate between the server and a player's AWS account. One SDK middleware on every client made with
 * the player's credentials, at the initialize step (before the request is serialised or signed):
 *  - a command not in RULES is refused;
 *  - every request stays in the home Region, except the few account-wide reads RULES marks;
 *  - a write or fix must have the exact shape the server sends (RULES' `wire`), grant or not, and what goes on to be
 *    serialised is the gate's checked copy of it, never the caller's object;
 *  - except its DryRun (RULES' `probe`, exact too), which changes nothing and needs no grant (also sent as the checked
 *    copy, so DryRun can't be dropped after the check);
 *  - and it needs a grant (withGrant) minted for this account, naming that command and its exact target, each usable
 *    once and only while withGrant runs. Grants are minted only by ActionService (after policy and the player's
 *    approval) and care.ts (after approval, the re-read and the account lock).
 * Refusals throw GuardDeniedError. Every write/fix decision and every refused read is logged (the player as `who`, the
 * target as a short hash: no account ids or ARNs).
 *
 * It stops mistakes in the server's own code paths. It isn't a sandbox against hostile code in this process: a client's
 * config still holds the credentials (test/guard.test.ts keeps every other file away from them and from the middleware
 * stacks). The player role and IAM are the outer wall.
 */
export const GUARD_DENIED = 'AwsCityGuardDenied';

export class GuardDeniedError extends Error {
  /** What a player reads (publicError and awsFailure pass it through): the reason in plain words, no ids. */
  readonly publicMessage: string;
  constructor(readonly reason: string) {
    super(reason);
    this.name = GUARD_DENIED;
    this.publicMessage = `The city's safety gate stopped this: ${reason}`;
  }
}

/** One command a grant allows, bound to its exact target (and, for rule removals, the rule ids approved). */
export type GrantEntry = { [C in ClientName]: { client: C; command: ChangeCommand<C>; target: string; ids?: readonly string[] } }[ClientName];

export interface Grant {
  readonly id: string;
  /** What it's for (the action or fix), for the audit log. */
  readonly reason: string;
  /** The AWS account it was minted for: clients acting in any other account (or one not known yet) can't use it. */
  readonly accountId: string;
  /** For something the player made, with "Let the city change things you made" on (WireContext.cleanup). */
  readonly cleanup?: boolean;
  readonly entries: readonly GrantEntry[];
}

/** Per grant: the entries already used (each allows one request), and whether its withGrant scope has ended. */
interface GrantState {
  used: Set<GrantEntry>;
  ended: boolean;
}
/** Only grants made by mintGrant are here. */
const states = new WeakMap<Grant, GrantState>();
const current = new AsyncLocalStorage<Grant>();

/** A grant for `entries` in one account. Everything in it is a frozen copy: changing the caller's arrays later changes nothing. */
export const mintGrant = (reason: string, entries: readonly GrantEntry[], scope: { accountId: string; cleanup?: boolean }): Grant => {
  const grant: Grant = Object.freeze({
    id: randomBytes(4).toString('hex'),
    reason,
    accountId: scope.accountId,
    ...(scope.cleanup ? { cleanup: true } : {}),
    entries: Object.freeze(entries.map((e): GrantEntry => Object.freeze({ ...e, ...(e.ids ? { ids: Object.freeze([...e.ids]) } : {}) }))),
  });
  states.set(grant, { used: new Set(), ended: false });
  return grant;
};

/**
 * Runs `fn` with `grant` active: the AWS writes it names, and only those, may go out while it runs. When it ends, every
 * entry left is spent, so anything it started that outlives it (a timer, a send nobody awaited) can't use the grant.
 */
export const withGrant = async <T>(grant: Grant, fn: () => Promise<T>): Promise<T> => {
  try {
    return await current.run(grant, fn);
  } finally {
    const state = states.get(grant);
    if (state) {
      for (const e of grant.entries) state.used.add(e);
      state.ended = true;
    }
  }
};

/** What the gate needs to know about the clients it guards. */
export interface GateContext {
  /** The player's home Region. */
  home: string;
  /** The account the credentials act in, once known. */
  accountId?: () => string | undefined;
  /** Who the clients act for, as `who(sub)` (log.ts): the audit log names the player only by this hash. */
  player?: string;
}

export interface GateRequest {
  client: string;
  command: string;
  input: unknown;
  /** The Region the client sends to. */
  region: string;
}

export type Decision =
  | { allow: true; kind: 'read' }
  /** A write or fix's DryRun (RULES' `probe`): no grant used; `input` is the checked copy. */
  | { allow: true; kind: 'probe'; input: Record<string, unknown> }
  /** `input` is the checked copy (zod's output): it is what goes on to be serialised. */
  | { allow: true; kind: 'write' | 'fix'; input: Record<string, unknown>; target: string }
  | { allow: false; kind?: Kind; reason: string; detail?: string; target?: string };

const opName = (command: string) => command.replace(/Command$/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 64) || 'that request';

/** The gate's decision for one request (pure apart from using up the grant entry it allows). */
export const decide = (req: GateRequest, ctx: GateContext, grant: Grant | undefined): Decision => {
  const op = opName(req.command);
  const rule = ruleFor(req.client, req.command);
  if (!rule) return { allow: false, reason: `the city never sends ${op} to AWS.` };
  const where = rule.region ?? ctx.home;
  if (where !== ANY_REGION && req.region !== where) {
    return { allow: false, kind: rule.kind, reason: `the city sends ${op} only to ${where === ctx.home ? `your home Region (${where})` : where}.` };
  }
  if (rule.kind === 'read') return { allow: true, kind: 'read' };
  const probe = rule.probe?.safeParse(req.input ?? {});
  if (probe?.success) return { allow: true, kind: 'probe', input: probe.data as Record<string, unknown> };

  // Only a real grant (made by mintGrant) can widen what a bucket write may name.
  const wire: WireContext = { region: req.region, accountId: ctx.accountId?.(), ...(grant?.cleanup && states.has(grant) ? { cleanup: true } : {}) };
  const parsed = rule.wire(wire).safeParse(req.input ?? {});
  if (!parsed.success) {
    // Field names and issue codes only (never values): what didn't match, for the audit log.
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}:${i.code}${'keys' in i ? `(${(i.keys as string[]).join(',')})` : ''}`).join(' ');
    return { allow: false, kind: rule.kind, reason: rule.refusal, detail: detail.slice(0, 300) };
  }
  // From here on only the checked copy is read, and only it is sent.
  const input = parsed.data as Record<string, unknown>;
  const target = rule.target(input, wire);
  const state = grant && states.get(grant);
  if (!grant || !state) return { allow: false, kind: rule.kind, reason: 'changes to your AWS account need your approval, and this one has none.', target };
  if (state.ended) return { allow: false, kind: rule.kind, reason: 'that approval has ended, so nothing more goes out with it.', target };
  if (grant.accountId !== wire.accountId) return { allow: false, kind: rule.kind, reason: 'that approval was for another AWS account.', target };
  const ids = rule.ids?.(input);
  const matches = grant.entries.filter(
    (e) => e.client === req.client && e.command === req.command && target !== undefined && e.target === target && (!ids || ids.every((id) => e.ids?.includes(id))),
  );
  const entry = matches.find((e) => !state.used.has(e));
  if (!entry || target === undefined) return { allow: false, kind: rule.kind, reason: matches.length ? 'that approved change has already been sent.' : "that isn't the change you approved.", target };
  state.used.add(entry);
  return { allow: true, kind: rule.kind, input, target };
};

/**
 * A short hash of a target for the audit logs (this gate's and the tenant's `aws change` line): never the raw name
 * (bucket names carry the account id).
 */
export const targetHash = (target: string) => createHash('sha256').update(target).digest('hex').slice(0, 12);

const audit = (req: GateRequest, d: Decision, grant: Grant | undefined, ctx: GateContext) => {
  if (d.allow && d.kind === 'read') return;
  const target = 'target' in d ? d.target : undefined;
  const fields = {
    decision: d.allow ? 'allow' : 'refuse',
    player: ctx.player ?? 'unknown',
    client: req.client,
    command: req.command,
    kind: d.kind ?? 'unlisted',
    target: target === undefined ? undefined : targetHash(target),
    grant: d.allow && d.kind === 'probe' ? 'none' : (grant?.id ?? 'none'),
    reason: d.allow ? (d.kind === 'probe' ? 'dry run' : grant?.reason) : d.reason,
    detail: d.allow ? undefined : d.detail,
  };
  if (d.allow) log.info('aws gate', fields);
  else log.warn('aws gate', fields);
};

/** Any SDK v3 client: its middleware stack and its resolved Region. */
export interface Guardable {
  middlewareStack: MiddlewareStack<any, any>;
  config: { region: Provider<string> };
}

/** Puts the gate on a client (once); returns the client. */
export const guard = <C extends Guardable>(client: C, ctx: GateContext): C => {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const req: GateRequest = { client: String(context.clientName ?? ''), command: String(context.commandName ?? ''), input: args.input, region: await client.config.region() };
      const grant = current.getStore();
      const decision = decide(req, ctx, grant);
      audit(req, decision, grant, ctx);
      if (!decision.allow) throw new GuardDeniedError(decision.reason);
      // A write or fix goes on as the copy the gate checked: changing the caller's object later (or a getter, or a
      // Proxy) can't change what is serialised.
      return next(decision.kind === 'read' ? args : { ...args, input: decision.input });
    },
    { step: 'initialize', priority: 'high', name: 'awsCityGate' },
  );
  return client;
};
