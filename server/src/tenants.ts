import { socialFor } from './social.js';
import type { Knowledge } from './knowledge/mcp.js';
import type { AwsCredentialIdentityProvider } from '@smithy/types';
import type { AccountLinker } from './accounts/link.js';
import { connectsPlayerLabel, LinkError } from './accounts/link.js';
import type { Llm } from './agents/llm.js';
import { metered, withErrorCodes } from './agents/metered.js';
import { type CityCare, createCityCare } from './agents/care.js';
import { type AgentRunner, createAgentRunner } from './agents/runner.js';
import { createStrandsRunner } from './citizens/engine.js';
import { isCitizen } from './citizens/roles.js';
import { type ActionService, createActionService, REJECTED_REASON } from './agents/service.js';
import type { ActionName } from './agents/actions.js';
import type { Approvals } from './contract/approvals.js';
import { createJev } from './agents/jev.js';
import type { Principal } from './auth.js';
import { type AwsClients, clientsFor } from './aws.js';
import type { Config } from './config.js';
import { feedEvents, welcomeEvents } from './contract/aws-feed.js';
import { createConsoleCopilot, type ConsoleCopilot } from './contract/console.js';
import { createOrchestrator, type Orchestrator } from './contract/orchestrator.js';
import type { UploadStore, UploadTarget, ImageType } from './contract/uploads.js';
import { log, who } from './log.js';
import type { NewsFeed } from './news/feed.js';
import { type Bill, createBill } from './state/bill.js';
import { createFlow, type Flow } from './state/flow.js';
import { diffSnapshots } from './state/diff.js';
import { SERVICES, type WorldSnapshot } from './state/model.js';
import { createPoller, type Poller } from './state/poller.js';
import type { AccountRecord, PutResult, Stores } from './store/types.js';
import { memoryLocks } from './store/local.js';
import { type AccountStatusEvent, CONTRACT_VERSION, type PlayerDataExport, type Progress, type ResourceRemove, type ServerEvent } from './world.js';

type Emit = (e: ServerEvent) => void;

/**
 * Everything one player's sockets share: their AWS world (poller, agents, orchestrator), their progress
 * and screenshots, and their account link. Per-socket state (approvals, Copilot tasks) stays on the socket.
 */
export interface Tenant {
  readonly sub: string;
  readonly region: string;
  orchestrator(): Orchestrator;
  /** City care (citizens, findings, fixes) for a linked account. */
  care(): CityCare | undefined;
  createCopilot(): ConsoleCopilot | undefined;
  /** v2.5: bill.enable (the month-to-date bill on or off). */
  bill(on: boolean, emit: Emit): Promise<void>;
  /** v2.8: flow.enable (live traffic from CloudWatch on or off). */
  flow(on: boolean, emit: Emit): Promise<void>;
  welcome(): Promise<ServerEvent[]>;
  subscribe(emit: Emit): () => void;
  /** Wraps a socket's emit: adds error codes for limit errors. */
  emitter(emit: Emit): Emit;
  snapshot(): Promise<WorldSnapshot | undefined>;
  /** v2.11: the live city and leaderboards, for this player (server/src/social.ts). */
  social: ReturnType<typeof socialFor>;
  /** A fresh poll (coalesced with one in flight), or undefined with no linked account: workshop checks read it. */
  fresh(): Promise<WorldSnapshot | undefined>;
  progress: { get(): Promise<Progress | null>; put(input: unknown): Promise<PutResult> };
  uploads: { create(contentType: ImageType): Promise<UploadTarget> };
  /** v2.17 `allowFixes`: the setup link asks for AllowFixes=true. */
  link(requestId: string, region: string, emit: Emit, allowFixes?: boolean): Promise<void>;
  verify(requestId: string, roleArn: string, emit: Emit): Promise<void>;
  /** v2.17 account.unlink: forget the link, stop reading the account, tell every tab. No MFA: taking access away. */
  unlink(requestId: string, emit: Emit): Promise<void>;
  /**
   * v2.17 resource.remove: take down one thing the city built, through the ActionService (policy, the gate, this socket's
   * approval), with no model call. deploy.preview → deploy.status, or error {requestId} if refused before any preview.
   */
  remove(cmd: Omit<ResourceRemove, 'action'>, emit: Emit, approvals: Approvals): Promise<void>;
  deleteMe(): Promise<void>;
  /** v2.17 GET /me/export: everything stored about the player (the account link as metadata: never the ExternalId). */
  exportMe(): Promise<PlayerDataExport>;
}

/** What REST needs: a player's saved data, without assuming their role or polling their AWS account. */
export type PlayerData = Pick<Tenant, 'progress' | 'uploads' | 'deleteMe' | 'exportMe'>;

export interface TenantHub {
  acquire(p: Principal): Promise<Tenant>;
  /** The live tenant's data if the player has a city open, else straight from the stores. */
  data(p: Principal): PlayerData;
  release(p: Principal): void;
  /** Stops every poller (graceful shutdown). */
  closeAll(): void;
}

/** A city with no AWS account yet: nothing to see, nothing can be built. */
export const emptyWorld = (region: string): WorldSnapshot => ({
  takenAt: new Date().toISOString(),
  region,
  accountId: 'not-linked',
  credentials: 'ok',
  services: Object.fromEntries(SERVICES.map((s) => [s, 'ok'])) as WorldSnapshot['services'],
  resources: [],
});

export const UNLINKED_REASON = 'Connect your AWS account first (Deploy tab → Connect your AWS), then I can build this for real.';

const unlinkedActions = (): ActionService =>
  ({
    submit: async () => ({ status: 'denied', reason: UNLINKED_REASON }),
    describe: (name: unknown) => `Run ${String(name)}`,
  }) as unknown as ActionService;

/** How often the account's full resource list is re-read for the city's mirror (the poller itself runs every ~10 s). */
const INVENTORY_EVERY_MS = 5 * 60_000;

/** v2.17: polls in a row on which STS refused the player role before the link counts as broken and polling stops. */
export const BROKEN_AFTER = 3;

/** v2.17 resource.remove: the existing destructive action for each kind the city builds, and what the city calls it. */
const REMOVE: Record<ResourceRemove['kind'], { action: ActionName; input: (id: string) => Record<string, string>; label: string }> = {
  instance: { action: 'terminate_instance', input: (id) => ({ instanceId: id }), label: 'house (EC2 instance)' },
  table: { action: 'delete_table', input: (id) => ({ name: id }), label: 'library (DynamoDB table)' },
  bucket: { action: 'delete_bucket', input: (id) => ({ name: id }), label: 'warehouse (S3 bucket)' },
};

/** v2.17: the account link as the player may see it (an allowlist: the ExternalId and role ARN never leave). */
const linkMetadata = (r: AccountRecord): NonNullable<PlayerDataExport['account']> => ({
  status: r.status,
  region: r.region,
  ...(r.accountId ? { accountId: r.accountId } : {}),
  ...(r.linkedAt ? { linkedAt: r.linkedAt } : {}),
  ...(r.roleVersion !== undefined ? { roleVersion: r.roleVersion } : {}),
  ...(r.fixes !== undefined ? { fixes: r.fixes } : {}),
  ...(r.brokenAt ? { broken: true } : {}),
});

/** v2.17 GET /me/export, read straight from the stores (the same with or without a city open). */
const exportFor = async (stores: Stores, sub: string): Promise<PlayerDataExport> => {
  const [progress, record, social] = await Promise.all([stores.progress.get(sub), stores.accounts.get(sub), stores.social.mine(sub)]);
  return { exportedAt: new Date().toISOString(), contract: CONTRACT_VERSION, progress, ...(record ? { account: linkMetadata(record) } : {}), social };
};

/**
 * Agent turns: citizens always run on Strands; landmark agents too when AWS_CITY_AGENT_ENGINE=strands (else the
 * classic loop in agents/runner.ts). Same interface either way.
 */
const routedRunner = (classic: AgentRunner, strands: AgentRunner, landmarksOnStrands: boolean): AgentRunner => ({
  turn: (agentId, text, hooks) => (isCitizen(agentId) || landmarksOnStrands ? strands : classic).turn(agentId, text, hooks),
  reset: (agentId) => (classic.reset(agentId), strands.reset(agentId)),
});

interface World {
  poller?: Poller;
  care?: CityCare;
  /** A linked world's writes (resource.remove goes straight here, no model). */
  actions?: ActionService;
  bill: Bill;
  flow: Flow;
  inventoryTimer?: NodeJS.Timeout;
  orchestrator: Orchestrator;
  snapshot: () => Promise<WorldSnapshot>;
  linked: boolean;
  /** v2.17: the link is kept but STS refuses its role: nothing is read (an unlinked world that knows its account). */
  broken?: boolean;
  region: string;
  accountId?: string;
  /** v2.17: whether fixes are allowed (hosted: the record's DryRun answer, absent = unknown; local: the server's setting). */
  fixes?: boolean;
  /** v2.17: the installed player-role template version (hosted). */
  roleVersion?: number;
}

export interface TenantDeps {
  config: Config;
  stores: Stores;
  uploads: UploadStore;
  llm: Llm;
  /** AWS documentation grounding (shared by every player; cached). */
  knowledge?: Knowledge;
  /** v2.6: AWS's public Health Dashboard and What's New, read once for every player. */
  news?: NewsFeed;
  enabled: () => Promise<boolean>;
  /**
   * The player's AWS access, or undefined if they haven't linked an account. Local mode: always the
   * workshop profile. Hosted: the assumed player role from their account record.
   */
  awsFor: (sub: string, record: AccountRecord | undefined) => { clients: AwsClients; accountId: string; region: string } | undefined;
  linker?: AccountLinker;
  /** Extra per-player cleanup on DELETE /me (e.g. the Cognito user, which needs the username). */
  onDelete?: (p: Principal) => Promise<void>;
  evictAfterMs?: number;
  walkMs?: number;
}

export const createTenants = (deps: TenantDeps): TenantHub => {
  const tenants = new Map<string, { tenant: Tenant; refs: number; evict?: NodeJS.Timeout; stop: () => void }>();
  // Jev's second opinion on agents' writes (only tightens): one judge for every player, off without TYPESAFE_API_KEY.
  const judge = deps.config.jev ? createJev(deps.config.jev) : undefined;

  const build = async (p: Principal) => {
    const sub = p.sub;
    const subscribers = new Set<Emit>();
    const broadcast = (events: ServerEvent[]) => {
      for (const emit of subscribers) for (const e of events) emit(e);
    };
    const llm = metered(deps.llm, { sub, quota: deps.stores.quota, daily: deps.config.dailyModelCalls, globalDaily: deps.config.globalDailyModelCalls, enabled: deps.enabled });

    /** v2.8: live traffic's switch, kept across worlds (linking an account rebuilds the world). */
    let flowOn = false;
    const active = () => subscribers.size > 0;
    const makeWorld = async (record: AccountRecord | undefined): Promise<World> => {
      // A broken link reads nothing until the player links again or verifies (a restart doesn't retry it either).
      const aws = record?.brokenAt ? undefined : deps.awsFor(sub, record);
      if (!aws) {
        const region = record?.region ?? deps.config.region;
        const snapshot = async () => emptyWorld(region);
        const runnerDeps = { llm, actions: unlinkedActions(), snapshot, knowledge: deps.knowledge };
        const runner = routedRunner(createAgentRunner(runnerDeps), createStrandsRunner(runnerDeps), deps.config.agentEngine === 'strands');
        const bill = createBill({ sub, store: deps.stores.bills, broadcast });
        const flow = createFlow({ sub, region, initialOn: flowOn, broadcast, active });
        const broken = record?.brokenAt && record.status === 'linked' ? { broken: true, accountId: record.accountId, ...(record.roleVersion !== undefined ? { roleVersion: record.roleVersion } : {}) } : {};
        return { orchestrator: createOrchestrator({ llm, runner, snapshot, uploads: deps.uploads, owner: sub, walkMs: deps.walkMs, knowledge: deps.knowledge }), snapshot, linked: false, region, bill, flow, ...broken };
      }
      let care: CityCare | undefined;
      let self: World | undefined;
      /** Polls in a row on which STS refused the role (BROKEN_AFTER of them break the link). */
      let refusedPolls = 0;
      const poller = createPoller({
        clients: aws.clients,
        accountId: aws.accountId,
        region: aws.region,
        intervalMs: deps.config.pollIntervalMs,
        onSnapshot(prev, next) {
          if (next.roleRefused) {
            refusedPolls++;
            if (refusedPolls >= BROKEN_AFTER && self) {
              poller.stop();
              void markBroken(self).catch((err) => log.warn('marking the link broken failed', { who: who(sub), err: (err as Error).name }));
            }
            // Nothing was read: no feed lessons and no finding changes from a poll that saw nothing.
            return;
          }
          refusedPolls = 0;
          for (const event of diffSnapshots(prev, next)) broadcast(feedEvents(event));
          if (care) broadcast(care.update(next));
        },
      });
      const snapshot = async () => poller.current() ?? poller.refresh();
      const locks = deps.stores.locks ?? memoryLocks();
      const actions = createActionService({ clients: aws.clients, poller, region: aws.region, locks, accountKey: () => aws.accountId, judge });
      const runnerDeps = { llm, actions, snapshot, knowledge: deps.knowledge };
      const strands = createStrandsRunner(runnerDeps);
      const runner = routedRunner(createAgentRunner(runnerDeps), strands, deps.config.agentEngine === 'strands');
      care = createCityCare({
        clients: aws.clients,
        region: aws.region,
        accountId: aws.accountId,
        runner: strands,
        withLock: (fn) => locks.withLock(aws.accountId, fn),
        refresh: () => poller.refresh(),
        progress: () => deps.stores.progress.get(sub),
        snapshot: () => poller.current(),
        // Hosted: what the DryRun at verify found (unknown: the server's setting, and AWS has the last word); local: the setting.
        fixesEnabled: record?.fixes ?? deps.config.allowFixes,
      });
      await poller.refresh().catch((err) => log.warn('first poll failed', { who: who(sub), err: (err as Error).name }));
      poller.start();
      const readInventory = () =>
        void care!
          .refreshInventory()
          .then((e) => e && broadcast([e]))
          .catch((err) => log.warn('inventory failed', { who: who(sub), err: (err as Error).name }));
      readInventory();
      // v2.5: the bill (only while the player has it on; Cost Explorer is read at most once a day).
      const bill = createBill({ sub, store: deps.stores.bills, ce: () => aws.clients.costExplorer(), accountId: aws.accountId, broadcast });
      // v2.8: live traffic (only while the player has it on and a tab is open; CloudWatch at most every 5 minutes).
      const flow = createFlow({ sub, cw: () => aws.clients.cloudwatch(), region: aws.region, initialOn: flowOn, broadcast, active });
      const inventoryTimer = setInterval(() => {
        readInventory();
        void bill.tick().catch((err) => log.warn('bill failed', { who: who(sub), err: (err as Error).name }));
        void flow.tick().catch((err) => log.warn('flow failed', { who: who(sub), err: (err as Error).name }));
      }, INVENTORY_EVERY_MS);
      inventoryTimer.unref?.();
      const fixes = record ? record.fixes : deps.config.allowFixes;
      self = {
        poller,
        care,
        actions,
        bill,
        flow,
        inventoryTimer,
        orchestrator: createOrchestrator({ llm, runner, snapshot, uploads: deps.uploads, owner: sub, walkMs: deps.walkMs, knowledge: deps.knowledge }),
        snapshot,
        linked: true,
        region: aws.region,
        accountId: aws.accountId,
        ...(fixes !== undefined ? { fixes } : {}),
        ...(record?.roleVersion !== undefined ? { roleVersion: record.roleVersion } : {}),
      };
      return self;
    };

    let world = await makeWorld(await deps.stores.accounts.get(sub));
    // v2.6: AWS's public status reaches every player, linked or not.
    const unsubscribeNews = deps.news?.subscribe(broadcast);
    /** Copilot model-call times for this player, shared by all their sockets (the budget survives reconnects). */
    const copilotCalls: number[] = [];
    let stopped = false;
    /** Swap in a new world and stop the old one; a world built after eviction is stopped at once. */
    const replaceWorld = (next: World) => {
      const old = world;
      world = next;
      old.poller?.stop();
      clearInterval(old.inventoryTimer);
      if (stopped) {
        next.poller?.stop();
        clearInterval(next.inventoryTimer);
      }
    };
    // Link, verify and delete each rebuild the world: run them one at a time so no poller is orphaned.
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = queue.then(fn, fn);
      queue = run.catch(() => undefined);
      return run;
    };

    /** v2.17, hosted only: the newest player-role template, for "Update your AWS City role". */
    const latestRole = () =>
      deps.linker ? { ...(deps.linker.latestRoleVersion !== undefined ? { latestRoleVersion: deps.linker.latestRoleVersion } : {}), templateUrl: deps.linker.templateUrl } : {};
    const roleOf = (w: World) => ({ ...(deps.linker && w.roleVersion !== undefined ? { roleVersion: w.roleVersion } : {}), ...latestRole() });
    const accountStatus = (requestId?: string): AccountStatusEvent =>
      world.linked
        ? {
            type: 'account.status',
            requestId,
            linked: true,
            accountId: world.accountId,
            region: world.region,
            message: deps.config.awsMode === 'profile' ? 'Workshop AWS account (local server). Every change needs your approval.' : 'Your AWS account is connected. Every change needs your approval.',
            ...(world.fixes !== undefined ? { fixes: world.fixes } : {}),
            ...roleOf(world),
          }
        : world.broken
          ? {
              type: 'account.status',
              requestId,
              linked: false,
              broken: true,
              accountId: world.accountId,
              region: world.region,
              message: `I can’t use the AWSCity role in ${world.accountId} (${world.region}) any more. Was the stack deleted? Link again, or disconnect.`,
              ...roleOf(world),
            }
          : { type: 'account.status', requestId, linked: false, region: world.region, message: 'Connect your AWS account to let agents build for real.' };

    /** STS refused the role BROKEN_AFTER polls in a row: keep the link marked broken, stop reading, tell every tab. */
    const markBroken = (was: World) =>
      serial(async () => {
        // A link, verify or unlink since (or an evicted city) settled it already.
        if (world !== was || stopped) return;
        const record = await deps.stores.accounts.get(sub);
        if (record?.status !== 'linked' || record.accountId !== was.accountId) return;
        const broken = { ...record, brokenAt: new Date().toISOString() };
        await deps.stores.accounts.put(sub, broken);
        replaceWorld(await makeWorld(broken));
        log.warn('account role refused: polling stopped', { who: who(sub), polls: BROKEN_AFTER });
        broadcast([accountStatus()]);
      });

    const tenant: Tenant = {
      sub,
      get region() {
        return world.region;
      },
      orchestrator: () => world.orchestrator,
      care: () => world.care,
      createCopilot: () => createConsoleCopilot({ llm, calls: copilotCalls }),
      bill: (on, emit) => world.bill.enable(on, emit),
      flow: (on, emit) => ((flowOn = on), world.flow.enable(on, emit)),
      async welcome() {
        const events: ServerEvent[] = [accountStatus()];
        if (world.linked) events.push(...welcomeEvents(await world.snapshot()), ...(world.care?.welcome() ?? []));
        events.push(...(await world.bill.welcome()));
        events.push(...world.flow.welcome());
        events.push(...(deps.news?.welcome() ?? []));
        return events;
      },
      subscribe(emit) {
        subscribers.add(emit);
        return () => subscribers.delete(emit);
      },
      emitter: (emit) => withErrorCodes(emit),
      snapshot: async () => (world.linked ? world.snapshot() : undefined),
      fresh: async () => (world.linked && world.poller ? world.poller.refresh() : undefined),
      progress: {
        get: () => deps.stores.progress.get(sub),
        put: async (input) => {
          const was = (await deps.stores.progress.get(sub))?.profile?.public;
          const res = await deps.stores.progress.put(sub, input);
          // A profile turned private leaves the live city and every leaderboard at once.
          if (res.ok && was && !(input as { profile?: { public?: boolean } })?.profile?.public) await deps.stores.social.forget(sub);
          return res;
        },
      },
      social: socialFor({ store: deps.stores.social, sub, profile: async () => (await deps.stores.progress.get(sub))?.profile }),
      uploads: { create: (contentType) => deps.uploads.create(contentType, sub) },
      link: (requestId, region, emit, allowFixes) => serial(async () => {
        if (!deps.linker) return emit(accountStatus(requestId));
        try {
          // The stack names who it connects (ConnectsPlayer): the public Mayor name, else a masked id (accounts/link.ts).
          const label = connectsPlayerLabel(p, (await deps.stores.progress.get(sub))?.profile);
          const { url, externalId } = await deps.linker.link(sub, region, { label, ...(allowFixes ? { allowFixes } : {}) });
          emit({ type: 'account.linkUrl', requestId, url, externalId });
          // A broken link went back to pending: the city waits for the new stack now, so it isn't "broken" any more.
          if (world.broken) {
            replaceWorld(await makeWorld(await deps.stores.accounts.get(sub)));
            broadcast([accountStatus()]);
          }
        } catch (err) {
          emit({ type: 'error', requestId, message: err instanceof LinkError ? err.message : 'Couldn’t make a setup link. Try again.' });
        }
      }),
      verify: (requestId, roleArn, emit) => serial(async () => {
        if (!deps.linker) return emit(accountStatus(requestId));
        try {
          const record = await deps.linker.verify(sub, roleArn);
          replaceWorld(await makeWorld(record));
          log.info('account linked', { who: who(sub), region: record.region });
          // Every open tab of this player sees the account arrive (the asking socket is a subscriber too).
          broadcast([accountStatus(requestId), ...welcomeEvents(await world.snapshot())]);
          if (subscribers.size === 0) emit(accountStatus(requestId));
        } catch (err) {
          log.warn('account verify failed', { who: who(sub) });
          // A refusal is an error for the request, never an account.status: a status with a requestId always means it
          // worked. Nothing changed, so a linked account stays linked and usable (the last status still stands).
          emit({ type: 'error', requestId, message: err instanceof LinkError ? err.message : 'Couldn’t check that account. Try again.' });
        }
      }),
      unlink: (requestId, emit) => serial(async () => {
        if (!deps.linker) return emit({ ...accountStatus(requestId), message: 'The local server uses the workshop AWS profile, so there’s no account to disconnect.' });
        await deps.stores.accounts.delete(sub);
        replaceWorld(await makeWorld(undefined));
        log.info('account unlinked', { who: who(sub) });
        const status: AccountStatusEvent = {
          ...accountStatus(requestId),
          message: 'Disconnected: AWS City no longer reads or changes your AWS account. To remove its role too, delete the AWSCity stack in CloudFormation.',
        };
        // Every open tab of this player sees the account go (the asking socket is a subscriber too).
        broadcast([status]);
        if (subscribers.size === 0) emit(status);
      }),
      async remove({ requestId, kind, id }, emit, approvals) {
        const w = world;
        if (!w.linked || !w.actions) return emit({ type: 'error', requestId, code: 'unlinked', message: 'Connect your AWS account first: the city hasn’t built anything there yet.' });
        const r = (await w.snapshot()).resources.find((x) => x.kind === kind && x.id === id);
        if (!r) return emit({ type: 'error', requestId, message: `There’s no ${REMOVE[kind].label} “${id}” in the city right now.` });
        if (!r.managedByGame) return emit({ type: 'error', requestId, message: `“${r.name}” wasn’t built by the city, so the city won’t remove it. You can in the AWS console.` });
        const { action, input } = REMOVE[kind];
        // An approval that lands after the account was disconnected or relinked changes nothing in the old one.
        let stale = false;
        const approve = async (req: Parameters<typeof approvals.request>[1]) => {
          const ok = await approvals.request(requestId, req, emit, requestId);
          stale = ok && world !== w;
          return ok && !stale;
        };
        // The same path as an agent's write: policy, Jev if on, this socket's approval (MFA on deploy.approve), the gate.
        const out = await w.actions.submit(action, input(id), { approve });
        // A "no" already said so on the preview's own deploy.status.
        if (out.status === 'denied' && out.reason === REJECTED_REASON && !stale) return;
        const message = stale
          ? 'Your AWS account was disconnected or changed meanwhile, so nothing was changed.'
          : out.status === 'done' || out.status === 'failed'
            ? out.result.message
            : out.status === 'denied'
              ? out.reason
              : out.error;
        // After an approval: the outcome on the same deployId. Refused before any preview: an error for the request.
        if (!approvals.reportResult(requestId, { name: action, input: input(id), outcome: out.status, message }, emit)) emit({ type: 'error', requestId, message });
      },
      exportMe: () => exportFor(deps.stores, sub),
      deleteMe: () => serial(async () => {
        world.poller?.stop();
        clearInterval(world.inventoryTimer);
        await deps.stores.deleteUser(sub);
        await deps.uploads.deleteOwner(sub);
        await deps.onDelete?.(p);
        replaceWorld(await makeWorld(undefined));
        log.info('player deleted', { who: who(sub) });
      }),
    };
    return {
      tenant,
      stop: () => {
        stopped = true;
        unsubscribeNews?.();
        world.poller?.stop();
        clearInterval(world.inventoryTimer);
      },
    };
  };

  const pending = new Map<string, Promise<void>>();

  return {
    data(p) {
      const live = tenants.get(p.sub)?.tenant;
      if (live) return live;
      return {
        progress: { get: () => deps.stores.progress.get(p.sub), put: (input) => deps.stores.progress.put(p.sub, input) },
        uploads: { create: (contentType) => deps.uploads.create(contentType, p.sub) },
        exportMe: () => exportFor(deps.stores, p.sub),
        async deleteMe() {
          await deps.stores.deleteUser(p.sub);
          await deps.uploads.deleteOwner(p.sub);
          await deps.onDelete?.(p);
          log.info('player deleted', { who: who(p.sub) });
        },
      };
    },
    async acquire(p) {
      // Two sockets of the same player connecting at once share one tenant.
      while (pending.has(p.sub)) await pending.get(p.sub);
      let entry = tenants.get(p.sub);
      if (!entry) {
        const creating = build(p).then((built) => {
          tenants.set(p.sub, { ...built, refs: 0 });
        });
        pending.set(p.sub, creating.catch(() => undefined));
        try {
          await creating;
        } finally {
          pending.delete(p.sub);
        }
        entry = tenants.get(p.sub)!;
      }
      clearTimeout(entry.evict);
      entry.refs++;
      return entry.tenant;
    },
    release(p) {
      const entry = tenants.get(p.sub);
      if (!entry) return;
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs > 0) return;
      // Keep a recently used city warm for a while (reconnects, tab switches), then stop its poller.
      entry.evict = setTimeout(() => {
        entry.stop();
        tenants.delete(p.sub);
      }, deps.evictAfterMs ?? 10 * 60_000);
      entry.evict.unref?.();
    },
    closeAll() {
      for (const e of tenants.values()) {
        clearTimeout(e.evict);
        e.stop();
      }
      tenants.clear();
    },
  };
};

/** Credentials helper for hosted mode, kept here so main.ts stays a composition root. */
export const playerAws = (
  record: AccountRecord | undefined,
  sub: string,
  credentialsFor: (o: { roleArn: string; externalId: string; sub: string; region: string }) => AwsCredentialIdentityProvider,
) => {
  if (record?.status !== 'linked' || !record.roleArn || !record.accountId) return undefined;
  const credentials = credentialsFor({ roleArn: record.roleArn, externalId: record.externalId, sub, region: record.region });
  const accountId = record.accountId;
  return { clients: clientsFor({ region: record.region, credentials, accountId: () => accountId, player: who(sub) }), accountId, region: record.region };
};
