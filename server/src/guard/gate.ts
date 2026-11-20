import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { MiddlewareStack, Provider } from '@smithy/types';
import { log } from '../log.js';
import { ANY_REGION, type ChangeCommand, type ClientName, type Kind, ruleFor, type WireContext } from './rules.js';

/**
 * The deterministic gate between the server and a player's AWS account. One SDK middleware on every client made with
 * the player's credentials, at the initialize step (before the request is serialised or signed):
 *  - a command not in RULES is refused;
 *  - every request stays in the home Region, except the few account-wide reads RULES marks;
 *  - a write or fix must have the exact shape the server sends (RULES' `wire`), grant or not;
 *  - and it needs a grant (withGrant) naming that command and its exact target, each usable once. Grants are minted
 *    only by ActionService (after policy and the player's approval) and fixes.ts (after approval and its re-read).
 * Refusals throw GuardDeniedError. Every write/fix decision and every refused read is logged (no account ids or ARNs).
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
  readonly entries: readonly GrantEntry[];
}

/** Entries already used, per grant: each allows one request. Only grants made by mintGrant are here. */
const spent = new WeakMap<Grant, Set<GrantEntry>>();
const current = new AsyncLocalStorage<Grant>();

export const mintGrant = (reason: string, entries: GrantEntry[]): Grant => {
  const grant: Grant = Object.freeze({ id: randomBytes(4).toString('hex'), reason, entries: Object.freeze(entries.map((e) => Object.freeze({ ...e }))) });
  spent.set(grant, new Set());
  return grant;
};

/** Runs `fn` with `grant` active: the AWS writes it names, and only those, may go out while it runs. */
export const withGrant = <T>(grant: Grant, fn: () => Promise<T>): Promise<T> => current.run(grant, fn);

/** What the gate needs to know about the clients it guards. */
export interface GateContext {
  /** The player's home Region. */
  home: string;
  /** The account the credentials act in, once known. */
  accountId?: () => string | undefined;
}

export interface GateRequest {
  client: string;
  command: string;
  input: unknown;
  /** The Region the client sends to. */
  region: string;
}

export type Decision = { allow: true; kind: Kind } | { allow: false; kind?: Kind; reason: string; detail?: string };

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

  const wire: WireContext = { region: req.region, accountId: ctx.accountId?.() };
  const parsed = rule.wire(wire).safeParse(req.input ?? {});
  if (!parsed.success) {
    // Field names and issue codes only (never values): what didn't match, for the audit log.
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}:${i.code}${'keys' in i ? `(${(i.keys as string[]).join(',')})` : ''}`).join(' ');
    return { allow: false, kind: rule.kind, reason: rule.refusal, detail: detail.slice(0, 300) };
  }
  const used = grant && spent.get(grant);
  if (!grant || !used) return { allow: false, kind: rule.kind, reason: 'changes to your AWS account need your approval, and this one has none.' };
  const input = parsed.data as Record<string, unknown>;
  const target = rule.target(input, wire);
  const ids = rule.ids?.(input);
  const matches = grant.entries.filter(
    (e) => e.client === req.client && e.command === req.command && target !== undefined && e.target === target && (!ids || ids.every((id) => e.ids?.includes(id))),
  );
  const entry = matches.find((e) => !used.has(e));
  if (!entry) return { allow: false, kind: rule.kind, reason: matches.length ? 'that approved change has already been sent.' : "that isn't the change you approved." };
  used.add(entry);
  return { allow: true, kind: rule.kind };
};

const audit = (req: GateRequest, d: Decision, grant: Grant | undefined) => {
  if (d.allow && d.kind === 'read') return;
  const fields = {
    decision: d.allow ? 'allow' : 'refuse',
    client: req.client,
    command: req.command,
    kind: d.kind ?? 'unlisted',
    grant: grant?.id ?? 'none',
    reason: d.allow ? grant?.reason : d.reason,
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
      audit(req, decision, grant);
      if (!decision.allow) throw new GuardDeniedError(decision.reason);
      return next(args);
    },
    { step: 'initialize', priority: 'high', name: 'awsCityGate' },
  );
  return client;
};
