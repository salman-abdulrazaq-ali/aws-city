import { memorySocial } from '../social.js';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createProgressStore } from '../contract/progress.js';
import { type Resource, resourceKey } from '../state/model.js';
import { type AccountLocks, type AccountRecord, type BillRecord, type BillStore, DELETED_TOMBSTONE_MS, type MfaStore, type ProgressStore, type QuotaStore, sameLink, type Stores } from './types.js';

/** Progress as JSON files: progress.json for the local player, progress-<hash>.json for anyone else. */
export const fileProgress = (file: string): ProgressStore & { fileFor(sub: string): string; forget(sub: string): void } => {
  const stores = new Map<string, ReturnType<typeof createProgressStore>>();
  const fileFor = (sub: string) => (sub === 'local' ? file : join(dirname(file), `progress-${createHash('sha256').update(sub).digest('hex').slice(0, 24)}.json`));
  const forSub = (sub: string) => {
    let s = stores.get(sub);
    if (!s) stores.set(sub, (s = createProgressStore(fileFor(sub))));
    return s;
  };
  return { get: (sub) => forSub(sub).get(), put: (sub, input) => forSub(sub).put(input), fileFor, forget: (sub) => void stores.delete(sub) };
};

/** A per-player JSON file beside progress: <name>.json for the local player, <name>-<hash>.json for anyone else. */
const playerFile = (progressFile: string, name: string) => (sub: string) =>
  join(dirname(progressFile), sub === 'local' ? `${name}.json` : `${name}-${createHash('sha256').update(sub).digest('hex').slice(0, 24)}.json`);

/** Writes `value` as JSON through a temp file renamed over `file`, so a reader never sees half of it. */
const writeJson = async (file: string, value: unknown) => {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value));
  await rename(tmp, file);
};

/** Runs the calls given to it one at a time (one process), so one call's read and write can't interleave with another's. */
const serialQueue = () => {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
};

/** The bill cache as JSON files beside progress: bill.json for the local player, bill-<hash>.json for anyone else. */
export const fileBills = (progressFile: string): BillStore & { fileFor(sub: string): string } => {
  const fileFor = playerFile(progressFile, 'bill');
  const get = async (sub: string) => {
    try {
      const r = JSON.parse(await readFile(fileFor(sub), 'utf8')) as BillRecord;
      return typeof r?.on === 'boolean' ? r : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (sub: string, record: BillRecord) => writeJson(fileFor(sub), record);
  // Writes run one at a time, so saveRead's check and write can't interleave with a put.
  const serial = serialQueue();
  return {
    fileFor,
    get,
    put: (sub, record) => serial(() => write(sub, record)),
    setOn: (sub, on) => serial(async () => write(sub, { ...(await get(sub)), on })),
    saveRead: (sub, read) =>
      serial(async () => {
        const r = await get(sub);
        if (!r?.on) return false;
        await write(sub, { ...r, ...read, on: true });
        return true;
      }),
  };
};

/** Step-up MFA's "authenticator on since" as JSON files beside progress: mfa.json for the local player, mfa-<hash>.json for anyone else. */
export const fileMfa = (progressFile: string): MfaStore & { fileFor(sub: string): string } => {
  const fileFor = playerFile(progressFile, 'mfa');
  // The read and the write of since() can't interleave with another call.
  const serial = serialQueue();
  return {
    fileFor,
    since: (sub, now) =>
      serial(async () => {
        try {
          const saved = (JSON.parse(await readFile(fileFor(sub), 'utf8')) as { since?: unknown }).since;
          if (typeof saved === 'number') return saved;
        } catch {
          // none yet (or unreadable): this is the first sight
        }
        await writeJson(fileFor(sub), { since: now });
        return now;
      }),
    get: async (sub) => {
      try {
        const saved = (JSON.parse(await readFile(fileFor(sub), 'utf8')) as { since?: unknown }).since;
        return typeof saved === 'number' ? saved : undefined;
      } catch {
        return undefined;
      }
    },
    forget: (sub) => serial(() => rm(fileFor(sub), { force: true })),
  };
};

export const memoryQuota = (): QuotaStore => {
  const counts = new Map<string, number>();
  const first = new Map<string, string>();
  return {
    async consume(key, day, limit) {
      const k = `${key}|${day}`;
      const n = counts.get(k) ?? 0;
      if (n >= limit) return false;
      counts.set(k, n + 1);
      return true;
    },
    async used(key, day) {
      return counts.get(`${key}|${day}`) ?? 0;
    },
    async refund(key, day) {
      const k = `${key}|${day}`;
      const n = counts.get(k) ?? 0;
      if (n > 0) counts.set(k, n - 1);
    },
    async firstSeen(sub, day) {
      if (!first.has(sub)) first.set(sub, day);
      return first.get(sub)!;
    },
    async firstDay(sub) {
      return first.get(sub);
    },
  };
};

/** In-process lock chain + just-created list (one server process). */
export const memoryLocks = (): AccountLocks => {
  const chains = new Map<string, Promise<unknown>>();
  const recent = new Map<string, Map<string, { resource: Resource; until: number }>>();
  return {
    withLock(key, fn) {
      // One process: the lock can't be lost, so the lease never aborts.
      const run = () => fn(new AbortController().signal);
      const next = (chains.get(key) ?? Promise.resolve()).then(run, run);
      chains.set(key, next.catch(() => undefined));
      return next;
    },
    async pending(key) {
      const m = recent.get(key);
      if (!m) return [];
      const now = Date.now();
      for (const [k, e] of m) if (e.until < now) m.delete(k);
      return [...m.values()].map((e) => e.resource);
    },
    async remember(key, resource, ttlMs) {
      let m = recent.get(key);
      if (!m) recent.set(key, (m = new Map()));
      m.set(resourceKey(resource), { resource, until: Date.now() + ttlMs });
    },
  };
};

export const localStores = (progressFile: string): Stores => {
  const progress = fileProgress(progressFile);
  const bills = fileBills(progressFile);
  const mfa = fileMfa(progressFile);
  const accounts = new Map<string, AccountRecord>();
  /** sub → until (epoch ms): players who deleted their account (DELETE /me). */
  const tombstones = new Map<string, number>();
  const social = memorySocial();
  return {
    progress,
    bills,
    accounts: {
      get: async (sub) => accounts.get(sub),
      // One process, and the check and the write are one synchronous step: nothing can land between them.
      put: async (sub, r, ifLink) => {
        if (ifLink === 'new' ? accounts.has(sub) : ifLink && !sameLink(accounts.get(sub), ifLink)) return false;
        accounts.set(sub, r);
        return true;
      },
      update: async (sub, fields, ifLink) => {
        const r = accounts.get(sub);
        if (!r || !sameLink(r, ifLink)) return undefined;
        const next = { ...r, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
        accounts.set(sub, next);
        return next;
      },
      delete: async (sub) => void accounts.delete(sub),
    },
    quota: memoryQuota(),
    mfa,
    locks: memoryLocks(),
    social,
    async deleteUser(sub) {
      tombstones.set(sub, Date.now() + DELETED_TOMBSTONE_MS);
      await social.forget(sub);
      accounts.delete(sub);
      await rm(progress.fileFor(sub), { force: true });
      await rm(bills.fileFor(sub), { force: true });
      await mfa.forget(sub);
      progress.forget(sub);
    },
    // One process: tombstones live in memory (a restart forgets them, as it forgets sockets).
    async deletedRecently(sub) {
      const until = tombstones.get(sub);
      if (until !== undefined && until <= Date.now()) tombstones.delete(sub);
      return until !== undefined && until > Date.now();
    },
  };
};
