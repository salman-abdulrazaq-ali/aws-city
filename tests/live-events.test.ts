// AWS City Live (src/world/liveEvents.ts): what AWS is doing this week, in the city. The events are data with an
// official page each; the banner shows a live event first, else the soonest within BANNER_DAYS; a stage can preview a
// day with ?date=; a launch that arrives while the city is open celebrates on its building (not the batch on connect).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AwsNewsEvent, AwsNewsItem } from '@/backend/contract';
import { bannerEvent, BANNER_DAYS, boardEvents, eventNow, eventPhase, EVENT_HOSTS, isEventUrl, isLive, LIVE_EVENTS, phaseLine, type LiveEvent } from '@/world/liveEvents';
import { launchesFor, WHATS_NEW_MAX } from '@/ui/WhatsNew';

const at = (iso: string) => Date.parse(iso);
const reinvent = LIVE_EVENTS.find((e) => e.id === 'reinvent-2026')!;
const meetup: LiveEvent = { id: 'm', kind: 'meetup', name: 'AWS Meetup', place: 'Newcastle', start: '2026-11-24T18:00:00Z', end: '2026-11-24T21:00:00Z', blurb: 'x' };

describe('the events (shared/events.json)', () => {
  it('each has a name, a place, a blurb, a start before its end and an official page', () => {
    expect(LIVE_EVENTS.length).toBeGreaterThan(0);
    for (const e of LIVE_EVENTS) {
      expect(e.name && e.place && e.blurb).toBeTruthy();
      expect(Date.parse(e.start)).toBeLessThan(Date.parse(e.end));
      expect(e.url === undefined || isEventUrl(e.url), `${e.id}: ${e.url}`).toBe(true);
      expect(['reinvent', 'summit', 'community', 'meetup']).toContain(e.kind);
    }
    expect(new Set(LIVE_EVENTS.map((e) => e.id)).size).toBe(LIVE_EVENTS.length);
  });

  it('re:Invent 2026 is 30 Nov – 4 Dec in Las Vegas (aws.amazon.com/events/reinvent)', () => {
    expect(reinvent.place).toBe('Las Vegas');
    expect(eventPhase(reinvent, at('2026-11-30T12:00:00-08:00'))).toEqual({ kind: 'live', day: 1, of: 5 });
    expect(eventPhase(reinvent, at('2026-12-04T20:00:00-08:00'))).toEqual({ kind: 'live', day: 5, of: 5 });
    expect(eventPhase(reinvent, at('2026-12-05T09:00:00-08:00')).kind).toBe('past');
  });
});

describe('phases and the banner', () => {
  it('counts down, then runs day N of M, then is over', () => {
    // Workshop day, noon UTC: re:Invent opens at midnight in Las Vegas on the 30th (08:00 UTC), 5 days 20 hours away.
    expect(eventPhase(reinvent, at('2026-11-24T12:00:00Z'))).toEqual({ kind: 'upcoming', days: 6 });
    expect(phaseLine({ kind: 'upcoming', days: 6 })).toBe('In 6 days');
    expect(phaseLine({ kind: 'upcoming', days: 1 })).toBe('Starts within a day');
    expect(phaseLine({ kind: 'live', day: 2, of: 5 })).toBe('Live now · day 2 of 5');
    expect(phaseLine(eventPhase(meetup, at('2026-11-24T19:00:00Z')))).toBe('Live now');
  });

  it('shows a live event first, else the soonest within BANNER_DAYS, else nothing', () => {
    const events = [reinvent, meetup];
    // Workshop night: the Meetup is live, re:Invent is a week away.
    expect(bannerEvent(events, at('2026-11-24T19:00:00Z'))?.event.id).toBe('m');
    expect(boardEvents(events, at('2026-11-24T19:00:00Z')).map((p) => p.event.id)).toEqual(['m', 'reinvent-2026']);
    // The morning after: the Meetup is over, re:Invent leads.
    expect(bannerEvent(events, at('2026-11-25T09:00:00Z'))?.event.id).toBe('reinvent-2026');
    // Too far out, or all over: no banner.
    expect(bannerEvent([reinvent], at('2026-11-30T08:00:00Z') - (BANNER_DAYS + 2) * 86_400_000)).toBeUndefined();
    expect(bannerEvent([reinvent], at('2026-11-30T08:00:00Z') - (BANNER_DAYS - 1) * 86_400_000)?.phase).toEqual({ kind: 'upcoming', days: BANNER_DAYS - 1 });
    expect(bannerEvent(events, at('2027-01-10T00:00:00Z'))).toBeUndefined();
  });

  it('knows when re:Invent is live (the server reads launches more often then)', () => {
    expect(isLive(LIVE_EVENTS, at('2026-12-01T18:00:00Z'), 'reinvent')).toBe(true);
    expect(isLive(LIVE_EVENTS, at('2026-11-20T18:00:00Z'), 'reinvent')).toBe(false);
  });

  it('previews a day from the address (?date=), and ignores anything else', () => {
    expect(eventNow('?date=2026-12-01', 5)).toBe(at('2026-12-01T12:00:00Z'));
    expect(eventNow('?x=1&date=2026-11-24', 5)).toBe(at('2026-11-24T12:00:00Z'));
    for (const bad of ['', '?date=tomorrow', '?date=2026-13-45', '?date=2026-12-01T00:00']) expect(eventNow(bad, 5)).toBe(5);
  });
});

describe('event links', () => {
  it('open only AWS pages and meetup.com, over https, with no credentials', () => {
    expect(EVENT_HOSTS).toEqual(['aws.amazon.com', 'www.meetup.com']);
    expect(isEventUrl('https://aws.amazon.com/events/reinvent/')).toBe(true);
    expect(isEventUrl('https://www.meetup.com/some-aws-user-group/events/123/')).toBe(true);
    for (const bad of ['http://aws.amazon.com/events/', 'https://evil.com/aws.amazon.com', 'https://user:pw@aws.amazon.com/', 'javascript:alert(1)', 'not a url'])
      expect(isEventUrl(bad), bad).toBe(false);
  });
});

describe("a building's launches", () => {
  const item = (id: string, date: string, serviceIds = ['s3']): AwsNewsItem => ({ id, title: `Launch ${id}`, url: 'https://aws.amazon.com/about-aws/whats-new/x/', date, serviceIds });
  it("are this service's newest, at most WHATS_NEW_MAX", () => {
    const items = [item('a', '2026-11-01'), item('b', '2026-11-03'), item('c', '2026-11-02', ['lambda']), item('d', '2026-11-04'), item('e', '2026-10-01')];
    expect(launchesFor(items, 's3').map((n) => n.id)).toEqual(['d', 'b', 'a'].slice(0, WHATS_NEW_MAX));
    expect(launchesFor(items, 'ec2')).toEqual([]);
  });
});

describe('a launch that lands while the city is open', () => {
  afterEach(() => vi.restoreAllMocks());
  const news = (ids: string[]): AwsNewsEvent => ({ type: 'aws.news', asOf: '2026-12-01T10:00:00Z', items: ids.map((id) => ({ id, title: `Launch ${id}`, url: 'https://aws.amazon.com/about-aws/whats-new/x/', date: '2026-12-01', serviceIds: ['s3'] })) });

  it('celebrates the new ones only (not the batch on connect), once the news rung is open', async () => {
    const { useCity } = await import('@/state/store');
    const { bus } = await import('@/state/bus');
    const seen: string[] = [];
    const off = bus.on('launch', ({ item }) => seen.push(item.id));
    const toast = vi.fn();
    useCity.setState({ news: undefined, account: { ...useCity.getState().account, linked: true }, toast } as never);
    const apply = (e: AwsNewsEvent) => useCity.getState().applyServerEvent(e);
    apply(news(['a', 'b']));
    expect(seen).toEqual([]);
    apply(news(['a', 'b', 'c']));
    expect(seen).toEqual(['c']);
    expect(toast).toHaveBeenCalledWith('🚀', 'New from AWS: Launch c');
    // Before the news rung (no quest done, no linked account): the ticker isn't on, so the city stays quiet too.
    useCity.setState({ account: { ...useCity.getState().account, linked: false } } as never);
    apply(news(['a', 'b', 'c', 'd']));
    expect(seen).toEqual(['c']);
    off();
  });
});
