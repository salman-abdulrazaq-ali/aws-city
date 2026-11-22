// The one polite live region's lines (src/state/announce.ts): each line gets its own update, the newest is always
// heard, a repeat is heard too; and `]` / `[` name each building as its sign does, never by its id.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '@/state/bus';
import { ANNOUNCE_GAP_MS, announce, stepLine } from '@/state/announce';
import { placeFor } from '@/world/places';
import { districtById } from '@/world/taxonomy';

describe('announce', () => {
  let heard: string[];
  let off: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    heard = [];
    off = bus.on('announce', ({ text }) => heard.push(text));
  });
  afterEach(() => {
    vi.runAllTimers();
    off();
    vi.useRealTimers();
  });

  it('gives lines sent together their own update, one gap apart (a single render would keep only the last)', () => {
    announce('Round starts.');
    announce('Parcel 🍎.');
    expect(heard.map((t) => t.trim())).toEqual(['Round starts.']);
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(heard.map((t) => t.trim())).toEqual(['Round starts.', 'Parcel 🍎.']);
  });

  it('replace drops the lines still waiting, so quick presses always end on the newest', () => {
    announce('S3 Lake. 1 of 10.', { replace: true });
    announce('Day 1 Office. 2 of 10.', { replace: true });
    announce('Golden Jacket Hall. 3 of 10.', { replace: true });
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS * 3);
    expect(heard.map((t) => t.trim())).toEqual(['S3 Lake. 1 of 10.', 'Golden Jacket Hall. 3 of 10.']);
  });

  it('the same line twice still changes the region, so it is heard twice', () => {
    announce('It got away.');
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    announce('It got away.');
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS);
    expect(heard).toHaveLength(2);
    expect(heard[0]).not.toBe(heard[1]);
    expect(heard.map((t) => t.trim())).toEqual(['It got away.', 'It got away.']);
  });

  it('never says an empty line, and keeps speech close behind play', () => {
    announce('   ');
    expect(heard).toEqual([]);
    for (let i = 1; i <= 8; i++) announce(`line ${i}`);
    vi.advanceTimersByTime(ANNOUNCE_GAP_MS * 10);
    expect(heard.map((t) => t.trim())).toEqual(['line 1', 'line 6', 'line 7', 'line 8']);
  });
});

describe('] and [ name the building', () => {
  it('a service by its place and its plain line', () => {
    const s3 = placeFor('s3')!;
    expect(stepLine('s3', s3.place, 1, 10)).toBe(`${s3.place}. ${s3.simple} 1 of 10.`);
  });

  it('a culture or campus site by its sign, even with no label passed (never "day1office", "coe" or "fulfilment")', () => {
    expect(stepLine('day1office', 'Day 1 Office', 3, 10)).toBe('Day 1 Office. 3 of 10.');
    expect(stepLine('coe', undefined, 6, 10)).toBe('Correction of Error board. 6 of 10.');
    expect(stepLine('fulfilment', undefined, 1, 10)).toBe('Amazon.com Fulfilment Centre. 1 of 10.');
    expect(stepLine('hq:storage', undefined, 2, 10)).toBe(`${districtById('storage')!.hq}. 2 of 10.`);
    expect(stepLine('nowhere-1', '  ', 4, 10)).toBe('A building. 4 of 10.');
  });
});
