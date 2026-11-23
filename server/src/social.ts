import { createHash } from 'node:crypto';
import type { SocialRow } from './world.js';

/**
 * Live city and leaderboards (contract v2.11). A player is never stored here by their id: rows carry a salted hash of
 * it (`who`), and only a public profile's generated Mayor name (two words from fixed lists) is ever shown to others.
 * Presence rows live 90 s; leaderboard rows one ISO week plus 8 weeks of history; DELETE /me removes both
 * (Stores.deleteUser via `forget`).
 */
export interface Mayor {
  name: string;
  rank: string;
}
interface BoardEntry {
  name: string;
  score: number;
  you?: boolean;
}
export interface SocialStore {
  /** The player is in `region` now; `mayor` only for a public profile (a private one is counted, never named). */
  beat(region: string, sub: string, mayor: Mayor | undefined): Promise<void>;
  presence(region: string): Promise<{ online: number; mayors: Mayor[] }>;
  /** Keeps the player's best score on the board this week. */
  submit(board: string, week: string, sub: string, name: string, score: number): Promise<void>;
  top(board: string, week: string, sub: string, limit: number): Promise<BoardEntry[]>;
  /** Removes the player's presence and every leaderboard row (a profile turned private, or DELETE /me). */
  forget(sub: string): Promise<void>;
  /** v2.17 GET /me/export: every presence and leaderboard row filed under this player (no one else's). */
  mine(sub: string): Promise<SocialRow[]>;
}

export const PRESENCE_MS = 90_000;
export const BOARD_TTL_MS = 9 * 7 * 86_400_000;
export const MAX_MAYORS = 12;
const BOARD_SIZE = 10;

/** The salted hash a player is filed under (never their Cognito sub). */
export const whoOf = (sub: string) => createHash('sha256').update(`aws-city-social:${sub}`).digest('hex').slice(0, 20);

/** Boards: one per mini-game, and "Mayors of <Region>" (city rank points). */
const GAME_BOARDS = ['fishing', 'shield', 'route53', 'lambda', 'ec2', 'dynamodb', 'redteam', 'launch', 'queue', 'iamgate', 'edge'] as const;
export const isBoard = (b: string) => (GAME_BOARDS as readonly string[]).includes(b) || /^mayors:[a-z]{2}(-[a-z]+)+-\d$/.test(b);
/** The most a real round (or a city) can score: anything above is clamped, so a forged score can't top a board by much. */
export const maxScore = (board: string) => (board.startsWith('mayors:') ? 3_000 : 2_000);

/** ISO-8601 week of a UTC date, as "2026-W42" (the same rule as src/state/events.ts). */
export function isoWeekUtc(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** In memory: local mode and tests (one server process). */
export function memorySocial(now: () => number = Date.now): SocialStore {
  const presence = new Map<string, Map<string, { until: number; mayor?: Mayor }>>();
  const boards = new Map<string, Map<string, { name: string; score: number }>>();
  return {
    async beat(region, sub, mayor) {
      const m = presence.get(region) ?? new Map();
      // One region at a time: arriving somewhere else leaves the last city.
      for (const other of presence.values()) other.delete(whoOf(sub));
      m.set(whoOf(sub), { until: now() + PRESENCE_MS, mayor });
      presence.set(region, m);
    },
    async presence(region) {
      const live = [...(presence.get(region)?.values() ?? [])].filter((p) => p.until > now());
      return { online: live.length, mayors: live.flatMap((p) => (p.mayor ? [p.mayor] : [])).slice(0, MAX_MAYORS) };
    },
    async submit(board, week, sub, name, score) {
      const key = `${board}#${week}`;
      const who = whoOf(sub);
      const b = boards.get(key) ?? new Map();
      const had = b.get(who);
      b.set(who, { name, score: Math.max(score, had?.score ?? 0) });
      boards.set(key, b);
    },
    async top(board, week, sub, limit) {
      const who = whoOf(sub);
      const b = boards.get(`${board}#${week}`);
      return [...(b?.entries() ?? [])]
        .sort((x, y) => y[1].score - x[1].score)
        .slice(0, limit)
        .map(([w, e]) => ({ name: e.name, score: e.score, ...(w === who ? { you: true } : {}) }));
    },
    async forget(sub) {
      const who = whoOf(sub);
      for (const m of presence.values()) m.delete(who);
      for (const b of boards.values()) b.delete(who);
    },
    async mine(sub) {
      const who = whoOf(sub);
      const rows: SocialRow[] = [];
      for (const [region, m] of presence) {
        const p = m.get(who);
        if (p && p.until > now()) rows.push({ kind: 'presence', region, until: new Date(p.until).toISOString(), ...(p.mayor ?? {}) });
      }
      for (const [key, b] of boards) {
        const e = b.get(who);
        if (!e) continue;
        // The key is `${board}#${week}` (submit).
        const cut = key.lastIndexOf('#');
        rows.push({ kind: 'leaderboard', board: key.slice(0, cut), week: key.slice(cut + 1), name: e.name, score: e.score });
      }
      return rows;
    },
  };
}

/** Most board answers kept at once; past this the cache starts again (forgetting one only costs a read). */
const MAX_CACHED_BOARDS = 5_000;

/**
 * Presence answers are cached per Region for `ms` (each socket beats every 30 s; one Query serves them all). Board
 * answers are cached per player and board for `ms` too: a board read is up to 4 pages, and a socket may otherwise ask
 * 10 times a second. A player's own submit clears theirs, so they see their new score at once.
 */
export function withPresenceCache(store: SocialStore, ms = 15_000, now: () => number = Date.now): SocialStore {
  const cache = new Map<string, { at: number; value: Promise<{ online: number; mayors: Mayor[] }> }>();
  const boards = new Map<string, { at: number; value: Promise<BoardEntry[]> }>();
  const boardKey = (board: string, week: string, sub: string, limit: number) => `${board}#${week}#${limit}#${whoOf(sub)}`;
  return {
    ...store,
    presence(region) {
      const hit = cache.get(region);
      if (hit && now() - hit.at < ms) return hit.value;
      const value = store.presence(region);
      cache.set(region, { at: now(), value });
      value.catch(() => cache.delete(region));
      return value;
    },
    top(board, week, sub, limit) {
      const key = boardKey(board, week, sub, limit);
      const hit = boards.get(key);
      if (hit && now() - hit.at < ms) return hit.value;
      if (boards.size >= MAX_CACHED_BOARDS) boards.clear();
      const value = store.top(board, week, sub, limit);
      boards.set(key, { at: now(), value });
      value.catch(() => boards.delete(key));
      return value;
    },
    async submit(board, week, sub, name, score) {
      await store.submit(board, week, sub, name, score);
      for (const key of boards.keys()) if (key.startsWith(`${board}#${week}#`) && key.endsWith(`#${whoOf(sub)}`)) boards.delete(key);
    },
  };
}

export type RankName = 'Village' | 'Town' | 'City' | 'Metropolis' | 'Megacity' | 'Global City';

/**
 * One player's side of it: reads their stored profile (public or not, and the name) before anything is shown, so a
 * client can't name itself or appear while private.
 */
export function socialFor(deps: { store: SocialStore; sub: string; profile: () => Promise<{ public: boolean; name: string } | undefined>; now?: () => Date }) {
  const { store, sub } = deps;
  const week = () => isoWeekUtc(deps.now?.() ?? new Date());
  const shown = async () => {
    const p = await deps.profile();
    return p?.public ? p.name : undefined;
  };
  const board = async (b: string) => ({ type: 'leaderboard.state' as const, board: b, week: week(), entries: await store.top(b, week(), sub, BOARD_SIZE) });
  return {
    async beat(region: string, rank: RankName | undefined) {
      const name = await shown();
      await store.beat(region, sub, name && rank ? { name, rank } : undefined);
      return { type: 'presence.state' as const, region, ...(await store.presence(region)) };
    },
    async submit(b: string, score: number) {
      const name = await shown();
      if (name && isBoard(b)) await store.submit(b, week(), sub, name, Math.max(0, Math.min(maxScore(b), Math.round(score))));
      return board(b);
    },
    board,
  };
}
