// The first steps on the canvas (src/state/firstSteps.ts is the path itself): the rules the city, the world map and S3
// Fishing follow while a beginner is on it. Pure (no Phaser), so tests read them directly; the scenes act on the result.

import type { Progress } from '@/backend/contract';
import { FIRST_STEPS, quietContext, TUTORIAL_DECK, type FirstStepsPrefs } from '@/state/firstSteps';
import { requestFor, type CitizenRequest } from '@/state/requests';
import { shows } from '@/state/simple';
import type { QuestStep } from '@/world/content';
import type { Tile } from '@/world/layout';

type CityPrefs = FirstStepsPrefs & { simple?: boolean };

/** The canvas extras that wait in the quiet city (src/state/simple.ts OUTSIDE_THE_PATH). */
export type QuietFeature = 'tokens' | 'citizenRequests';

let memo: { progress?: Progress; prefs?: CityPrefs; on: Record<QuietFeature, boolean> } = { on: { tokens: true, citizenRequests: true } };

/**
 * Whether the city shows golden tokens or random citizens' questions now: never on the first steps (shows() with the
 * path's context), so they come back at graduation without a reload. Read every frame, so it's worked out once per
 * store change (progress and prefs are replaced, never mutated).
 */
export function cityShows(feature: QuietFeature, progress: Progress, prefs: CityPrefs): boolean {
  if (memo.progress !== progress || memo.prefs !== prefs) {
    const ctx = quietContext(progress, prefs);
    memo = { progress, prefs, on: { tokens: shows('tokens', prefs, ctx), citizenRequests: shows('citizenRequests', prefs, ctx) } };
  }
  return memo.on[feature];
}

/**
 * The street's questions this frame. Random ones wait while the city is quiet (and one already up is dropped, so it
 * isn't seen); the first steps' planted citizen never waits.
 */
export function streetQuestions(quiet: boolean, current: 'none' | 'random' | 'planted'): { spawnRandom: boolean; dropCurrent: boolean } {
  return { spawnRandom: !quiet && current === 'none', dropCurrent: quiet && current === 'random' };
}

/** The service whose planted citizen the path's step wants (its `request` step), else undefined. */
export const plantedFor = (step: QuestStep | undefined) => (step?.kind === 'request' ? step.serviceId : undefined);

const dist = (a: Tile, b: Tile) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** How far from Kai the planted citizen stands: close enough to see together, far enough that walking over is a step. */
export const PLANT_NEAR = 2;
export const PLANT_FAR = 4;

/**
 * Where the planted citizen stands: a street tile PLANT_NEAR–PLANT_FAR tiles from Kai, the one nearest the building
 * (S3 Lake's work spot), then nearest 3 tiles from Kai, then by row and column, so the same city always picks the same
 * tile (no random draw). None in reach: the nearest street tile to Kai that isn't his. Undefined with no streets.
 */
export function plantTile(kai: Tile, building: Tile | undefined, streets: readonly Tile[]): Tile | undefined {
  const near = building ?? kai;
  const by = (key: (t: Tile) => number[]) => (a: Tile, b: Tile) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  };
  const inReach = streets.filter((t) => dist(t, kai) >= PLANT_NEAR && dist(t, kai) <= PLANT_FAR);
  if (inReach.length) return [...inReach].sort(by((t) => [dist(t, near), Math.abs(dist(t, kai) - 3), t.y, t.x]))[0];
  const rest = streets.filter((t) => dist(t, kai) > 0);
  return [...rest].sort(by((t) => [dist(t, kai), dist(t, near), t.y, t.x]))[0];
}

/** A stable number from a card id: where the right answer sits among the three (the same card, the same order). */
const seedOf = (s: string) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);

/**
 * The planted citizen's question: one of the tutorial deck's cards (`cardId` when the UI named one, else the one the
 * player last answered "Didn't know"), its wrong answers the deck's other cards. A service with no tutorial card asks
 * one of its own cards.
 */
export function plantedRequest(p: Progress, serviceId: string, cardId?: string): CitizenRequest | undefined {
  const pick = requestFor(p, serviceId, { deck: TUTORIAL_DECK, cardId }) ?? requestFor(p, serviceId, { cardId });
  if (!pick) return undefined;
  const deck = TUTORIAL_DECK.includes(pick.cardId) ? TUTORIAL_DECK : undefined;
  return requestFor(p, serviceId, { deck, cardId: pick.cardId, seed: seedOf(pick.cardId) }) ?? pick;
}

/** On the path's walk to its building, the camera walks with Kai (and settles on the building when he's there). */
export const followsKai = (step: QuestStep | undefined, id: string) => step?.kind === 'visit' && step.serviceId === id;

// ── The world map ─────────────────────────────────────────────

/**
 * How an AWS Health storm looks on the world map. A first-run map (no Region picked yet) keeps the suggested Region as
 * its only pulse: storms are small still grey marks. Later visits keep today's throbbing red and amber rings.
 */
export const stormLook = (firstRun: boolean): 'still' | 'pulse' => (firstRun ? 'still' : 'pulse');

/** A storm Region's line on a first-run map for a player with no AWS account linked; else today's line. */
export const stormLine = (firstRun: boolean, linked: boolean, today: string) => (firstRun && !linked && FIRST_STEPS.map.storm ? FIRST_STEPS.map.storm : today);

// ── S3 Fishing's end card ─────────────────────────────────────

export type FishingEndAction = 'again' | 'expert' | 'leave';

export interface FishingEnd {
  /** In the card's order; exactly one is the amber primary. */
  buttons: { action: FishingEndAction; label: string; primary: boolean }[];
  /** "Tip: Lifecycle rules…" and each catch's tips (CloudFront, lifecycle rules) under the last answer. */
  tips: boolean;
  /** The City Coins line (coins wait in the quiet city until graduation). */
  coins: boolean;
  /** The keys line read out with the card on the first steps (undefined: today's, games/say.ts endKeysLine). */
  keysLine?: string;
}

/**
 * The fishing end card. On the first steps "Back to the city" is the one primary (Enter or Escape) and Play again is
 * graphite (Space); no tips, no Expert round, no coins. Otherwise today's card: Play again primary (Space or Enter), the
 * Expert round once it's open (X), "← City" (Escape).
 */
export function fishingEnd(onPath: boolean, expertOpen: boolean): FishingEnd {
  if (onPath)
    return {
      buttons: [
        { action: 'leave', label: `${FIRST_STEPS.steps[1]?.end ?? 'Back to the city'} (Enter)`, primary: true },
        { action: 'again', label: '🎣 Play again (Space)', primary: false },
      ],
      tips: false,
      coins: false,
      keysLine: 'Press Enter or Escape to go back to the city, or Space to play again.',
    };
  return {
    buttons: [
      { action: 'again', label: '🎣 Play again (Space)', primary: true },
      ...(expertOpen ? [{ action: 'expert' as const, label: '⚡ Expert', primary: false }] : []),
      { action: 'leave', label: '← City', primary: false },
    ],
    tips: true,
    coins: true,
  };
}

/** The end card's keys on the first steps (gameKeys.ts fishingKey has today's): Enter or Escape leaves, Space plays again. */
export function pathEndKey(key: string): FishingEndAction | undefined {
  if (key === 'Enter' || key === 'Escape') return 'leave';
  if (key === ' ') return 'again';
  return undefined;
}

/** A catch's verdict on the end card: on the first steps just right or wrong (the catch's tip is a jargon tail there). */
export const verdictLine = (right: boolean, answer: string | undefined, why: string, tips: boolean) =>
  `${right ? '✅ Correct!' : `❌ Not quite: it’s ${answer}.`}${tips ? ` ${why}` : ''}`;
