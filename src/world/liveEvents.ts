// AWS City Live: what AWS is doing this week, in the city. Pure (no React, no Phaser, no clock of its own): the events
// are data (shared/events.json, each with its official page), and every function takes `now`, so the banner, the
// Events board, the tests and a stage preview (?date=2026-12-01) all agree.

import data from '../../shared/events.json' with { type: 'json' };

export type EventKind = 'reinvent' | 'summit' | 'community' | 'meetup';

export interface LiveEvent {
  id: string;
  kind: EventKind;
  name: string;
  /** Where it happens, in a word or two ("Las Vegas"). */
  place: string;
  /** ISO 8601 with the event's own offset. */
  start: string;
  end: string;
  /** The event's own page: aws.amazon.com, or a meetup's page on meetup.com (`isEventUrl`). */
  url?: string;
  /** One or two plain sentences, facts from that page only. */
  blurb: string;
}

export const LIVE_EVENTS: readonly LiveEvent[] = data.events as LiveEvent[];

const DAY = 86_400_000;
/** An upcoming event shows on the banner from this many days before it starts. */
export const BANNER_DAYS = 14;

export type EventPhase = { kind: 'upcoming'; days: number } | { kind: 'live'; day: number; of: number } | { kind: 'past' };

/** Where an event is at `now`: days to go (1 = within a day), day N of M while it runs, or over. */
export function eventPhase(e: LiveEvent, now: number): EventPhase {
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  if (now > end) return { kind: 'past' };
  if (now >= start) return { kind: 'live', day: Math.floor((now - start) / DAY) + 1, of: Math.max(1, Math.ceil((end - start) / DAY)) };
  return { kind: 'upcoming', days: Math.max(1, Math.ceil((start - now) / DAY)) };
}

export interface PhasedEvent {
  event: LiveEvent;
  phase: EventPhase;
}

/** What's live, then what's coming (soonest first); nothing that's over. */
export function boardEvents(events: readonly LiveEvent[], now: number): PhasedEvent[] {
  const rank = (p: PhasedEvent) => (p.phase.kind === 'live' ? 0 : 1);
  return events
    .map((event) => ({ event, phase: eventPhase(event, now) }))
    .filter((p) => p.phase.kind !== 'past')
    .sort((a, b) => rank(a) - rank(b) || Date.parse(a.event.start) - Date.parse(b.event.start));
}

/** The one event on the City tab's banner: a live one, else the soonest within BANNER_DAYS. */
export function bannerEvent(events: readonly LiveEvent[], now: number): PhasedEvent | undefined {
  return boardEvents(events, now).find((p) => p.phase.kind === 'live' || (p.phase.kind === 'upcoming' && p.phase.days <= BANNER_DAYS));
}

/** "Live now · day 2 of 5", "Starts within a day", "In 6 days". */
export function phaseLine(p: EventPhase): string {
  if (p.kind === 'live') return p.of > 1 ? `Live now · day ${p.day} of ${p.of}` : 'Live now';
  if (p.kind === 'past') return 'Over';
  return p.days <= 1 ? 'Starts within a day' : `In ${p.days} days`;
}

/** re:Invent week (or any live event of this kind): the city reads launches more often and celebrates them. */
export const isLive = (events: readonly LiveEvent[], now: number, kind?: EventKind) =>
  events.some((e) => (!kind || e.kind === kind) && eventPhase(e, now).kind === 'live');

/** The event pages the game opens: AWS's own, and meetups on meetup.com. https only, no credentials in the URL. */
export const EVENT_HOSTS = ['aws.amazon.com', 'www.meetup.com'] as const;
export const isEventUrl = (raw: string) => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && (EVENT_HOSTS as readonly string[]).includes(u.hostname);
  } catch {
    return false;
  }
};

/**
 * "Now" for the events: the real clock, or a day to preview from the page's address (`?date=2026-12-01`, noon UTC
 * that day), like `?season=` for the art. A preview only moves the events, never the player's progress.
 */
export function eventNow(search: string, fallback: number): number {
  const d = new URLSearchParams(search).get('date');
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return fallback;
  const t = Date.parse(`${d}T12:00:00Z`);
  return Number.isNaN(t) ? fallback : t;
}
