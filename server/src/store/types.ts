import type { Resource } from '../state/model.js';
import type { CityBillEvent, Progress } from '../world.js';
import type { SocialStore } from '../social.js';

export type PutResult = { ok: true } | { ok: false; error: string };

/** A player's saved city. "Newest wins" by updatedAt (the side panel and the full tab both write). */
export interface ProgressStore {
  get(sub: string): Promise<Progress | null>;
  put(sub: string, input: unknown): Promise<PutResult>;
}

/** The link between a player and their own AWS account (hosted mode). */
export interface AccountRecord {
  status: 'pending' | 'linked';
  /** Per-player secret the player role's trust policy requires (sts:ExternalId). Never logged. */
  externalId: string;
  region: string;
  roleArn?: string;
  accountId?: string;
  linkedAt?: string;
  /** A linked player asked for a setup link in another Region: verify checks that Region; until then the link stays as is. */
  pendingRegion?: string;
  /** v2.17: when the last setup link was made (ISO): verify is refused a day after it (a link phished from someone else ages out). */
  linkIssuedAt?: string;
  /** v2.17: the player-role template version that link pointed at (`v<N>` of its template URL). */
  linkRoleVersion?: number;
  /** v2.17: the template version installed: the link's, recorded at verify. Absent: linked before v2.17. */
  roleVersion?: number;
  /** v2.17: whether the role allows fixes (AllowFixes), from a DryRun at verify that changes nothing. Absent: unknown. */
  fixes?: boolean;
  /**
   * v2.17: when STS refused the role on BROKEN_AFTER polls in a row (the stack was deleted or changed): the server stopped
   * reading the account. A new setup link (back to pending) or a successful verify clears it.
   */
  brokenAt?: string;
}

/** What tells one link apart from the next: a verify sets a new linkedAt, a disconnect forgets the ExternalId. */
export type LinkIdentity = Pick<AccountRecord, 'externalId' | 'linkedAt'>;

/** Whether `r` is still the link `id` names (same ExternalId and linkedAt). */
export const sameLink = (r: AccountRecord | undefined, id: LinkIdentity) => r !== undefined && r.externalId === id.externalId && r.linkedAt === id.linkedAt;

export interface AccountStore {
  get(sub: string): Promise<AccountRecord | undefined>;
  /**
   * Saves the record; true when written. `ifLink`: only while the stored record is still that link (sameLink), checked
   * atomically with the write, so a Disconnect, DELETE /me or a new verify on another task meanwhile is never written
   * over: false, and nothing written.
   */
  put(sub: string, record: AccountRecord, ifLink?: LinkIdentity): Promise<boolean>;
  /** v2.17 account.unlink: forgets the link (role ARN, account id and ExternalId); a no-op when there's none. */
  delete(sub: string): Promise<void>;
}

/**
 * Daily counters. consume() is atomic: false once `limit` is reached for that key and day. Keys are a player's sub,
 * or GLOBAL… for the whole city's counters (agents/metered.ts).
 */
export interface QuotaStore {
  consume(key: string, day: string, limit: number): Promise<boolean>;
  used(key: string, day: string): Promise<number>;
  /** Gives one call back (a model call that failed before it cost anything); never below zero. */
  refund(key: string, day: string): Promise<void>;
  /** The day this player made their first model call: `day` is saved the first time, then always the saved one. */
  firstSeen(sub: string, day: string): Promise<string>;
  /** The saved first day, or undefined; a read only, never saves one (GET /me/export). */
  firstDay(sub: string): Promise<string | undefined>;
}

/**
 * Step-up MFA (accounts/mfa.ts): when the server first saw a player with an authenticator on (epoch ms). Only a
 * session that signed in after it may link an account or approve a write.
 */
export interface MfaStore {
  /** The saved time, or `now` saved and returned the first time. */
  since(sub: string, now: number): Promise<number>;
  /** The saved time, or undefined; a read only, never saves one (GET /me/export). */
  get(sub: string): Promise<number | undefined>;
  /** The authenticator is off: forget the time, so turning it on again starts a new one. */
  forget(sub: string): Promise<void>;
}

/** A deleted player is refused this long: longer than a Cognito access token lives (60 min), so no token outlives it. */
export const DELETED_TOMBSTONE_MS = 2 * 60 * 60_000;

/** The account lock was lost mid-change: whatever hadn't been written yet wasn't. */
export class LockLostError extends Error {
  constructor() {
    super('The city lost its hold on this AWS account mid-change (another change may have started), so it stopped before changing anything else. Try again in a moment.');
    this.name = 'LockLostError';
  }
}

/**
 * Writes to one AWS account are serialised, and resources just created are remembered for a minute,
 * so parallel requests (even from two players who linked the same account) can't all slip under the
 * same limit before the eventually consistent AWS listings catch up.
 */
export interface AccountLocks {
  /**
   * Runs fn holding the account's lock. `lease` aborts if the lock is lost while fn runs (a lease that couldn't be
   * renewed may be taken by another task): fn checks it (`lease.throwIfAborted()`) before each AWS write.
   */
  withLock<T>(accountKey: string, fn: (lease: AbortSignal) => Promise<T>): Promise<T>;
  pending(accountKey: string): Promise<Resource[]>;
  remember(accountKey: string, resource: Resource, ttlMs: number): Promise<void>;
}

/** v2.5: the player's bill switch and the last Cost Explorer read (each read costs $0.01, so it's cached a day). */
export interface BillRecord {
  on: boolean;
  bill?: CityBillEvent;
  /** Epoch ms of the last read, and how long it counts as fresh (a day; an hour after a passing failure). */
  fetchedAt?: number;
  retryMs?: number;
  /** The AWS account the cached bill is for (a different linked account reads again). */
  accountId?: string;
}

export interface BillStore {
  get(sub: string): Promise<BillRecord | undefined>;
  put(sub: string, record: BillRecord): Promise<void>;
  /** bill.enable: sets only `on`, keeping the cached read (a failed or stale read of the record can't wipe it). */
  setOn(sub: string, on: boolean): Promise<void>;
  /**
   * Saves a Cost Explorer read only while the bill is still on, without touching `on` (atomically: a read that was in
   * flight when the player turned it off never turns it back on). False when it was off.
   */
  saveRead(sub: string, read: Omit<BillRecord, 'on'>): Promise<boolean>;
}

export interface Stores {
  progress: ProgressStore;
  /** v2.11: live city and leaderboards (server/src/social.ts). */
  social: SocialStore;
  accounts: AccountStore;
  bills: BillStore;
  quota: QuotaStore;
  mfa: MfaStore;
  locks: AccountLocks;
  /**
   * Removes everything stored for a player (DELETE /me), leaving a tombstone for DELETED_TOMBSTONE_MS (written first,
   * so a write racing the delete is refused too).
   */
  deleteUser(sub: string): Promise<void>;
  /** True while a deleted player's tombstone lasts (one read; hosted checks it where data would be recreated). */
  deletedRecently(sub: string): Promise<boolean>;
}

export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
