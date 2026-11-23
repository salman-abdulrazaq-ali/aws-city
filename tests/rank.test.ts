import { describe, expect, it } from 'vitest';
import type { Progress } from '@/backend/contract';
import { BADGES, earnedBadges, newBadges } from '@/state/badges';
import { cityPoints, cityRank, LEVEL_POINTS, mayorOf, nextRankLine, RANKS, TOKEN_POINTS } from '@/state/rank';
import { afterQuests } from '@/state/next';
import { WORKSHOPS } from '@/world/workshops';
import { placeFor, TIER_XP } from '@/world/places';
import { SERVICES } from '@/world/taxonomy';
import { CARDS, PUZZLES, QUESTS } from '@/world/content';
import { REGIONS } from '@/world/culture';
import { levelOf, MAX_CROWNS } from '@/state/mastery';
import { TOKENS_PER_CITY } from '@/world/tokens';
import { isGlobalService } from '@/world/regions';

// The Mayor's city rank grows only with learning (building levels) and walking (golden tokens); badges read progress.
const city = (xp: Record<string, number>, region = 'us-west-2', extra: Partial<Progress> = {}): Progress =>
  ({ version: 2, landmarks: {}, cities: { [region]: { landmarks: Object.fromEntries(Object.entries(xp).map(([id, x]) => [id, { discovered: true, xp: x }])) } }, updatedAt: '', ...extra }) as Progress;

describe('city rank', () => {
  it('counts building levels and tokens in this city only', () => {
    const p = city({ lambda: TIER_XP[2], s3: TIER_XP[1] }, 'us-west-2', { finds: { 'us-west-2:0': '2026-10-17', 'eu-west-1:0': '2026-10-17' } });
    expect(cityPoints(p, 'us-west-2')).toBe(3 * LEVEL_POINTS + TOKEN_POINTS);
    expect(cityPoints(p, 'eu-west-1')).toBe(TOKEN_POINTS);
  });

  it('climbs Village → Town → … and says what the next rank needs', () => {
    expect(cityRank(city({}), 'us-west-2').rank.id).toBe('village');
    const r = cityRank(city({ lambda: TIER_XP[4], s3: TIER_XP[1] }), 'us-west-2');
    expect(r.rank.id).toBe('village');
    expect(r.next?.id).toBe('town');
    expect(nextRankLine(r)).toBe('10 more points to Town: each building level is 10, each golden token 5.');
    expect(cityRank(city({ lambda: TIER_XP[4], s3: TIER_XP[2] }), 'us-west-2').rank.id).toBe('town');
    const six = Object.fromEntries(['lambda', 's3', 'ec2', 'dynamodb', 'sqs', 'vpc'].map((id) => [id, TIER_XP[4]]));
    expect(cityRank(city(six), 'us-west-2').rank.id).toBe('town');
    const seven = Object.fromEntries(['lambda', 's3', 'ec2', 'dynamodb', 'sqs', 'vpc', 'rds'].map((id) => [id, TIER_XP[4]]));
    expect(cityRank(city(seven), 'us-west-2').rank.id).toBe('city');
    expect(RANKS.map((x) => x.at)).toEqual([0, 60, 250, 700, 1400, 2200, 2800, 3400, 4000]);
    expect(RANKS.map((x) => x.at)).toEqual([...RANKS.map((x) => x.at)].sort((a, b) => a - b));
    expect(mayorOf('us-west-2')).toBe('Mayor of Oregon');
  });

  it('has Global City above Megacity, then three crown ranks that presence.beat sends as Global City (contract v2.12)', () => {
    expect(RANKS.map((x) => x.title)).toEqual(['Village', 'Town', 'City', 'Metropolis', 'Megacity', 'Global City', 'Crown City', 'Cloud Capital', 'Legendary City']);
    // The wire name is one of the contract's six; below the crowns it's the rank's own title.
    for (const x of RANKS.slice(0, 6)) expect(x.name).toBe(x.title);
    for (const x of RANKS.slice(6)) expect(x.name).toBe('Global City');
    const top = RANKS.at(-1)!;
    expect(top).toMatchObject({ id: 'legendary', title: 'Legendary City' });
    expect(nextRankLine({ rank: top, points: 4090, pct: 1 })).toMatch(/^Legendary City: the top rank/);
    expect(nextRankLine(cityRank(city({}, 'us-west-2', { finds: {} }), 'us-west-2'))).toMatch(/to Town:/);
  });

  it('the crown ranks need crowns, and the top is within reach in every Region', () => {
    const DAY = 86_400_000;
    // Everything learned: every card remembered for a month, every drawing passed, every quest done, every game played.
    const knowsAll = (region: string, level: 'master' | 'legend'): Progress => {
      // Global services (IAM, Route 53…) stand in every city: their buildings live in `landmarks`.
      const p = city(Object.fromEntries(SERVICES.filter((s) => !isGlobalService(s.id)).map((s) => [s.id, TIER_XP[4]])), region, {
        landmarks: Object.fromEntries(SERVICES.filter((s) => isGlobalService(s.id)).map((s) => [s.id, { discovered: true, xp: TIER_XP[4] }])),
        finds: Object.fromEntries(Array.from({ length: TOKENS_PER_CITY }, (_, i) => [`${region}:${i}`, '2026-11-20'])),
      });
      if (level === 'master') return p;
      const cards = Object.fromEntries(Object.values(CARDS).flat().map((c) => [c.id, { interval: 40, ease: 2.5, due: Date.now() + 40 * DAY, reps: 6 }]));
      const games = Object.fromEntries(SERVICES.flatMap((s) => (placeFor(s.id)?.game ? [[placeFor(s.id)!.game!, { best: 100, plays: 5, scored: 5 }]] : [])));
      return {
        ...p,
        cards,
        games,
        puzzles: Object.fromEntries(PUZZLES.map((z) => [z.id, { best: 100 }])),
        quests: Object.fromEntries(QUESTS.map((q) => [q.id, { status: 'done' as const, step: q.steps.length }])),
      };
    };
    // All 58 at Master: 2,320 + 30 for the tokens is Global City, not yet a crown rank.
    const master = knowsAll('us-west-2', 'master');
    expect(cityPoints(master, 'us-west-2')).toBe(SERVICES.length * 4 * LEVEL_POINTS + TOKENS_PER_CITY * TOKEN_POINTS);
    expect(cityRank(master, 'us-west-2').rank.id).toBe('global');
    // Every crown: the top, in every Region (a service AWS doesn't offer there still counts what the player knows).
    for (const r of REGIONS.regions) {
      const all = knowsAll(r.code, 'legend');
      expect(SERVICES.every((s) => levelOf(all, s.id, r.code) === 4 + MAX_CROWNS), r.code).toBe(true);
      const top = cityRank(all, r.code);
      expect(top.points, r.code).toBe(SERVICES.length * (4 + MAX_CROWNS) * LEVEL_POINTS + TOKENS_PER_CITY * TOKEN_POINTS);
      expect(top.rank.id, r.code).toBe('legendary');
      expect(top.points - RANKS.at(-1)!.at, r.code).toBeLessThan(LEVEL_POINTS * 10);
    }
  });
});

describe('after every quest (src/state/next.ts)', () => {
  it('offers putting up a new building before growing the ones already up', () => {
    const p = city({ lambda: TIER_XP[1] });
    expect(afterQuests({ ...p, workshops: Object.fromEntries(WORKSHOPS.map((w) => [w.id, { steps: {}, done: '2026-10-17' }])) }, 'us-west-2')?.kind).toBe('build');
  });
});

describe('badges', () => {
  it('have unique ids and read straight from progress', () => {
    expect(new Set(BADGES.map((b) => b.id)).size).toBe(BADGES.length);
    expect(earnedBadges(city({}))).toEqual([]);
    const p = city({ lambda: TIER_XP[4] }, 'us-west-2', { streak: { days: 3, last: '2026-10-17', best: 3 }, workshops: { w: { steps: { a: 'real' } } } });
    expect(earnedBadges(p)).toEqual(expect.arrayContaining(['first-building', 'practitioner', 'master', 'streak-3', 'first-workshop-step', 'real-step']));
    expect(earnedBadges(p)).not.toContain('first-crown');
  });

  it('newBadges names only what changed', () => {
    const before = city({ lambda: TIER_XP[1] });
    const after = city({ lambda: TIER_XP[2] });
    expect(newBadges(before, after)).toEqual(['practitioner']);
    expect(newBadges(after, after)).toEqual([]);
  });
});
