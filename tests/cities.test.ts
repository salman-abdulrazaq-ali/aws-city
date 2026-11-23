import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '@/backend/contract';
import { builtCities, CARRY_MAX, carriedStars, landmarkOf, migrateCities, withLandmark } from '@/state/cities';
import { xpFor } from '@/learning/srs';
import { cardsFor } from '@/world/content';
import { TIER_XP, tierForXp } from '@/world/places';
import { mergeProgress } from '@/state/progress';
import { isDiscovered, tierOf, useCity } from '@/state/store';
import { FACTS } from '@/world/regions';

const base = (): Progress => ({ version: 2, landmarks: {}, updatedAt: '2026-10-10T10:00:00.000Z' });
const s = () => useCity.getState();

describe('each Region is its own city (contract v2.7)', () => {
  it('a Region landmark lives in that city only; a global one stands in every city', () => {
    let p = withLandmark(base(), 's3', 'us-west-2', { discovered: true, xp: 40 });
    p = withLandmark(p, 'iam', 'us-west-2', { discovered: true, xp: 10 });
    expect(isDiscovered(p, 's3', 'us-west-2')).toBe(true);
    expect(isDiscovered(p, 's3', 'eu-central-1')).toBe(false);
    expect(tierOf(p, 's3', 'eu-central-1')).toBe(-1);
    // IAM is global (shared/region-facts.json), so Frankfurt has it too.
    expect(FACTS.global).toContain('iam');
    expect(isDiscovered(p, 'iam', 'eu-central-1')).toBe(true);
    expect(p.landmarks.iam).toBeDefined();
    expect(p.landmarks.s3).toBeUndefined();
  });

  it('without a Region, a landmark is the best anywhere (what the player knows travels with them)', () => {
    let p = withLandmark(base(), 's3', 'us-west-2', { discovered: true, xp: 40 });
    p = withLandmark(p, 's3', 'eu-central-1', { discovered: true, xp: 5 });
    expect(landmarkOf(p, 's3')).toEqual({ discovered: true, xp: 40 });
    expect(builtCities(p)).toEqual({ 'us-west-2': 1, 'eu-central-1': 1 });
  });

  it('old saves move their Region landmarks into the city being built, once', () => {
    const old: Progress = { ...base(), landmarks: { s3: { discovered: true, xp: 12 }, route53: { discovered: true, xp: 2 } } };
    const p = migrateCities(old, 'us-west-2');
    expect(p.landmarks).toEqual({ route53: { discovered: true, xp: 2 } });
    expect(p.cities?.['us-west-2']?.landmarks.s3).toEqual({ discovered: true, xp: 12 });
    expect(migrateCities(p, 'us-west-2')).toBe(p);
  });

  it('two copies merge city by city, so nothing earned in either is lost', () => {
    const a = withLandmark(base(), 's3', 'us-west-2', { discovered: true, xp: 40 });
    const b = withLandmark({ ...base(), updatedAt: '2026-10-11T10:00:00.000Z' }, 'lambda', 'eu-central-1', { discovered: true, xp: 3 });
    const m = mergeProgress(a, b);
    expect(m.cities?.['us-west-2']?.landmarks.s3?.xp).toBe(40);
    expect(m.cities?.['eu-central-1']?.landmarks.lambda?.xp).toBe(3);
  });
});

describe('the store builds in the city you are in', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    s().resetSession();
  });
  afterEach(() => {
    s().resetSession();
    vi.useRealTimers();
  });

  it('a new Region starts from zero', () => {
    useCity.setState({ cityRegion: 'us-west-2' });
    s().addXp('s3', 15);
    expect(isDiscovered(s().progress, 's3', 'us-west-2')).toBe(true);
    useCity.setState({ cityRegion: 'eu-central-1' });
    expect(isDiscovered(s().progress, 's3', 'eu-central-1')).toBe(false);
    s().addXp('s3', 2);
    expect(landmarkOf(s().progress, 's3', 'eu-central-1')?.xp).toBe(2);
    expect(landmarkOf(s().progress, 's3', 'us-west-2')?.xp).toBe(15);
  });

  it('loading an old save migrates it', () => {
    useCity.setState({ cityRegion: 'us-west-2' });
    s().loadProgress({ ...base(), landmarks: { s3: { discovered: true, xp: 12 } } });
    expect(s().progress.cities?.['us-west-2']?.landmarks.s3?.xp).toBe(12);
  });
});

describe('what you know comes with you to a new city', () => {
  const DAY = 86_400_000;
  /** Cards of a service the player knows (answered Knew it), and one answered "Didn't know" (not known yet). */
  const knowing = (serviceId: string, n: number, extra: Partial<Progress> = {}): Progress => {
    const deck = cardsFor(serviceId);
    const cards = Object.fromEntries(deck.slice(0, n).map((c) => [c.id, { interval: 3, ease: 2.5, due: Date.now() + 3 * DAY, reps: 2 }]));
    cards[deck[n].id] = { interval: 0, ease: 2.3, due: Date.now(), reps: 0 };
    return { ...base(), cards, ...extra };
  };

  it('a building starts with the new-card stars for each card known, capped below Expert', () => {
    const NEW = xpFor(undefined, 'good');
    expect(carriedStars(knowing('s3', 6), 's3')).toBe(6 * NEW);
    expect(carriedStars(knowing('s3', 6), 'lambda')).toBe(0);
    expect(carriedStars(base(), 's3')).toBe(0);
    expect(CARRY_MAX).toBeLessThan(TIER_XP[3]);
    // Every card of every service known: never Expert from the carry alone.
    const deck = cardsFor('ec2');
    const all: Progress = { ...base(), cards: Object.fromEntries(deck.map((c) => [c.id, { interval: 9, ease: 2.5, due: 0, reps: 3, remembered: true as const }])) };
    expect(carriedStars(all, 'ec2')).toBe(Math.min(CARRY_MAX, deck.length * NEW));
    expect(tierForXp(CARRY_MAX)).toBeLessThan(3);
  });

  describe('in the store', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      s().resetSession();
    });
    afterEach(() => {
      s().resetSession();
      vi.useRealTimers();
    });

    it('putting a building up in a second city credits it once, from the cards known; the first city keeps its own', () => {
      const NEW = xpFor(undefined, 'good');
      useCity.setState({ cityRegion: 'eu-central-1', progress: knowing('s3', 8, { cities: { 'us-west-2': { landmarks: { s3: { discovered: true, xp: 150 } } } } }) });
      s().discover('s3', { quiet: true });
      expect(landmarkOf(s().progress, 's3', 'eu-central-1')?.xp).toBe(8 * NEW);
      expect(landmarkOf(s().progress, 's3', 'us-west-2')?.xp).toBe(150);
      // Put up already: no second credit (and learning there adds as usual).
      s().discover('s3');
      s().addXp('s3', 2);
      expect(landmarkOf(s().progress, 's3', 'eu-central-1')?.xp).toBe(8 * NEW + 2);
    });

    it('a card reviewed where its building isn’t up yet: the building starts from the cards known before it, and the card pays once', () => {
      const NEW = xpFor(undefined, 'good');
      const p = knowing('s3', 5);
      useCity.setState({ cityRegion: 'eu-central-1', progress: p });
      const fresh = cardsFor('s3')[7];
      const { stars } = s().reviewCard(fresh.id, 'good');
      expect(stars).toBe(NEW);
      expect(landmarkOf(s().progress, 's3', 'eu-central-1')?.xp).toBe(5 * NEW + NEW);
    });

    it('two surfaces putting the same building up merge to one credit, not two', () => {
      const NEW = xpFor(undefined, 'good');
      const start = knowing('lambda', 7);
      useCity.setState({ cityRegion: 'ap-southeast-2', progress: start });
      s().discover('lambda', { quiet: true });
      const panel = s().progress;
      s().resetSession();
      useCity.setState({ cityRegion: 'ap-southeast-2', progress: { ...start, updatedAt: '2026-10-12T10:00:00.000Z' } });
      s().discover('lambda', { quiet: true });
      const tab = s().progress;
      const merged = mergeProgress(panel, tab);
      expect(landmarkOf(merged, 'lambda', 'ap-southeast-2')?.xp).toBe(7 * NEW);
      expect(mergeProgress(merged, panel)).toEqual(merged);
    });
  });
});
