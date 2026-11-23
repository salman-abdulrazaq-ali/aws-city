import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '@/state/bus';
import { browsedText, consoleName, useCity } from '@/state/store';
import { isDiscovered } from '@/state/selectors';
import type { PageFocus } from '@/state/types';
import { landmarkOf } from '@/state/cities';

// "Browsing grew it": opening a service's console page is a moment the player sees: a toast with the building's icon,
// what grew and its growth line, and the camera flies there (at most once a minute a service). It pays 2⭐ once a day a
// service (the daily ledger); docs pages pay nothing.
const s = () => useCity.getState();
const S3: PageFocus = { url: 'https://us-west-2.console.aws.amazon.com/s3/buckets', title: 'S3', kind: 'console', serviceId: 's3', tabId: 1 };
let clock = Date.UTC(2026, 9, 19, 9);

beforeEach(() => {
  // The daily ledger lives in localStorage: a fresh one per test.
  const mem = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
  vi.useFakeTimers();
  // Each test starts well past the last one's once-a-minute window.
  clock += 10 * 60_000;
  vi.setSystemTime(clock);
  s().resetSession();
  s().clearToasts();
  s().setView({ name: 'city' });
});
afterEach(() => {
  s().resetSession();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flights = () => {
  const ids: string[] = [];
  const off = bus.on('flyTo', ({ id }) => ids.push(id));
  return { ids, off };
};

describe('browsing grew it', () => {
  it('names the console and the building', () => {
    expect(consoleName('s3')).toBe('S3');
    expect(consoleName('lambda')).toBe('Lambda');
    expect(browsedText('s3', 2)).toBe('You opened the S3 console: S3 Lake +2⭐');
    expect(browsedText('s3', 0)).toMatch(/^You opened the S3 console: S3 Lake is going up!$/);
    expect(browsedText('s3', 0, true)).toBe('You opened the S3 console: S3 Lake (today’s visit stars are in)');
  });

  it('a first visit finds the building with the browsing toast (not the generic one)', () => {
    const f = flights();
    s().setFocus(S3);
    f.off();
    expect(isDiscovered(s().progress, 's3', s().cityRegion)).toBe(true);
    expect(s().toasts).toHaveLength(1);
    expect(s().toasts[0]).toMatchObject({ serviceId: 's3', text: browsedText('s3', 0) });
    expect(s().toasts[0].detail).toMatch(/^S3 Lake · 0\/\d+ to /);
    // The discovery flies the camera itself (CityScene.onDiscovered): no second flight.
    expect(f.ids).toEqual([]);
  });

  it('a later visit pays 2⭐ once a day, with its growth line, and flies the camera there; the moment comes back each minute', () => {
    const xp = () => landmarkOf(s().progress, 's3', s().cityRegion)?.xp ?? 0;
    s().setFocus(S3);
    s().clearToasts();
    vi.setSystemTime(clock + 61_000);
    const f = flights();
    s().setFocus(S3);
    expect(s().toasts[0]).toMatchObject({ serviceId: 's3', text: 'You opened the S3 console: S3 Lake +2⭐' });
    expect(s().toasts[0].detail).toMatch(/^S3 Lake · 2\/\d+ to /);
    expect(f.ids).toEqual(['s3']);
    expect(xp()).toBe(2);
    // Within the minute: nothing more (no stars, no toast, no flight).
    s().clearToasts();
    vi.setSystemTime(clock + 90_000);
    s().setFocus({ ...S3, url: `${S3.url}?again` });
    expect(s().toasts).toHaveLength(0);
    expect(f.ids).toEqual(['s3']);
    // Minutes later the same day: the moment again (toast and camera), but no more stars.
    vi.setSystemTime(clock + 200_000);
    s().setFocus({ ...S3, url: `${S3.url}?later` });
    f.off();
    expect(s().toasts[0]).toMatchObject({ serviceId: 's3', text: 'You opened the S3 console: S3 Lake (today’s visit stars are in)' });
    expect(f.ids).toEqual(['s3', 's3']);
    expect(xp()).toBe(2);
  });

  it('waits behind a celebration card or a game: the toast queues, the camera stays put', () => {
    s().setFocus(S3);
    s().clearToasts();
    vi.setSystemTime(clock + 61_000);
    s().setView({ name: 'game', game: 'fishing' });
    const f = flights();
    s().setFocus(S3);
    f.off();
    expect(f.ids).toEqual([]);
    expect(s().toasts).toHaveLength(0); // held, shown once the game closes
  });

  it('docs pages and other sites never make the moment, and pay nothing', () => {
    s().setFocus(S3);
    s().clearToasts();
    const before = landmarkOf(s().progress, 's3', s().cityRegion)?.xp;
    vi.setSystemTime(clock + 61_000);
    const f = flights();
    s().setFocus({ url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html', title: 'S3 docs', kind: 'docs', serviceId: 's3' });
    vi.setSystemTime(clock + 200_000);
    s().setFocus({ url: 'https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html?again', title: 'S3 docs', kind: 'docs', serviceId: 's3' });
    f.off();
    expect(s().toasts).toHaveLength(0);
    expect(f.ids).toEqual([]);
    expect(landmarkOf(s().progress, 's3', s().cityRegion)?.xp).toBe(before);
  });
});
