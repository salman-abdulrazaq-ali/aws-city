// Each AWS Region is its own city, like real AWS: what you build in Oregon isn't in Frankfurt, and a new Region starts
// from scratch. Global services (IAM, Route 53, CloudFront: `isGlobalService`, shared/region-facts.json `global`)
// stand in every city at once, so they live in `Progress.landmarks`; a Region's own landmarks live in
// `Progress.cities[region].landmarks` (contract v2.7). What a player *knows* (cards, quests, puzzles, citizens) is theirs
// everywhere, and a building put up in a new city starts from it (`carriedStars`). Pure, so the store, the scene and
// tests agree.

import type { LandmarkProgress, Progress } from '@/backend/contract';
import { xpFor } from '@/learning/srs';
import { cardsFor } from '@/world/content';
import { TIER_XP } from '@/world/places';
import { isGlobalService } from '@/world/regions';
import { isKnown } from './srs';

/** What a building can start a new city with: just under Expert (the rest is learned there, crowns included). */
export const CARRY_MAX = TIER_XP[3] - 1;

/**
 * Stars a building starts with when it's first put up in a city: the new-card stars (xpFor a new card) for each of its
 * cards the player knows already, at most CARRY_MAX. Read from the cards alone, so every surface works out the same
 * number; it's the landmark's starting xp (store.discover), and copies merge by the higher xp, so it's paid once per
 * city however many surfaces put the building up.
 */
export function carriedStars(p: Progress, serviceId: string): number {
  const known = cardsFor(serviceId).filter((c) => isKnown(p.cards?.[c.id])).length;
  return Math.min(CARRY_MAX, known * xpFor(undefined, 'good'));
}

const better = (x: LandmarkProgress | undefined, y: LandmarkProgress | undefined): LandmarkProgress | undefined =>
  !x ? y : !y ? x : { discovered: x.discovered || y.discovered, xp: Math.max(x.xp, y.xp) };

/**
 * One landmark's progress. With a Region: that city's (or the shared one, for a global service). Without one: the best
 * anywhere, for what follows the player (which decks they can study, certifications, which agents they've met).
 */
export function landmarkOf(p: Progress, serviceId: string, region?: string): LandmarkProgress | undefined {
  if (isGlobalService(serviceId)) return p.landmarks[serviceId];
  if (region !== undefined) return p.cities?.[region]?.landmarks[serviceId];
  let best: LandmarkProgress | undefined = p.landmarks[serviceId];
  for (const c of Object.values(p.cities ?? {})) best = better(best, c.landmarks[serviceId]);
  return best;
}

/** A copy of `p` with one landmark set, in the right place for that service and Region. */
export function withLandmark(p: Progress, serviceId: string, region: string, l: LandmarkProgress): Progress {
  if (isGlobalService(serviceId)) return { ...p, landmarks: { ...p.landmarks, [serviceId]: l } };
  const city = p.cities?.[region];
  return { ...p, cities: { ...p.cities, [region]: { ...city, landmarks: { ...city?.landmarks, [serviceId]: l } } } };
}

/** Regions with at least one discovered landmark of their own, and how many. */
export function builtCities(p: Progress): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [r, c] of Object.entries(p.cities ?? {})) {
    const n = Object.values(c.landmarks).filter((l) => l.discovered).length;
    if (n) out[r] = n;
  }
  return out;
}

/**
 * Progress saved before v2.7 kept every landmark in `landmarks`: the Region ones move into `home` (the city the player
 * was building). Idempotent, and returns `p` itself when there's nothing to move.
 */
export function migrateCities(p: Progress, home: string): Progress {
  const moving = Object.keys(p.landmarks).filter((id) => !isGlobalService(id));
  if (!moving.length) return p;
  const landmarks: Progress['landmarks'] = {};
  const city = { ...p.cities?.[home]?.landmarks };
  for (const [id, l] of Object.entries(p.landmarks)) {
    if (isGlobalService(id)) landmarks[id] = l;
    else city[id] = better(city[id], l)!;
  }
  return { ...p, landmarks, cities: { ...p.cities, [home]: { landmarks: city } } };
}
