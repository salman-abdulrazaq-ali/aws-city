import { useEffect, useState } from 'react';
import { openEvent } from '@/app/runtime';
import { bannerEvent, boardEvents, eventNow, LIVE_EVENTS, phaseLine, type PhasedEvent } from '@/world/liveEvents';
import { feel } from './feedback';

/** The events change by the day: a minute's clock is plenty (and it pauses with the page). */
const TICK_MS = 60_000;

function useEventClock() {
  const read = () => eventNow(typeof location === 'undefined' ? '' : location.search, Date.now());
  const [now, setNow] = useState(read);
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setNow(read()), TICK_MS);
    return () => clearInterval(t);
  }, []);
  return now;
}

const ICON: Record<PhasedEvent['event']['kind'], string> = { reinvent: '🎪', summit: '🏛️', community: '🤝', meetup: '🍕' };

/**
 * AWS City Live: one line on the City tab for what AWS is doing this week (re:Invent, a Summit, the player's Meetup),
 * like a game's live-event banner. Tapping it opens the Events board: what's live, what's coming, each with its official
 * page. It's never the City tab's primary button (one goal, one celebration), and it says nothing when nothing is near.
 */
export function EventBanner() {
  const now = useEventClock();
  const [open, setOpen] = useState(false);
  const pick = bannerEvent(LIVE_EVENTS, now);
  if (!pick) return null;
  const board = boardEvents(LIVE_EVENTS, now);
  const live = pick.phase.kind === 'live';
  return (
    <section className={`event-banner ${pick.event.kind}${live ? ' live' : ''}`} aria-label="AWS events">
      <button
        className="event-line"
        aria-expanded={open}
        aria-controls="event-board"
        onClick={() => {
          feel.tap();
          setOpen((o) => !o);
        }}
      >
        <span className="event-icon" aria-hidden="true">
          {ICON[pick.event.kind]}
        </span>
        <span className="event-tag">{live ? 'Live' : 'Soon'}</span>
        <span className="event-text">
          <b>{pick.event.name}</b>
          <span className="event-when">
            {phaseLine(pick.phase)} · {pick.event.place}
          </span>
        </span>
        <span className="event-more" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <ul id="event-board" className="event-board" aria-label="Events board">
          {board.map(({ event, phase }) => (
            <li key={event.id}>
              <div className="event-board-head">
                <span aria-hidden="true">{ICON[event.kind]}</span> <b>{event.name}</b>
              </div>
              <span className="event-when">
                {phaseLine(phase)} · {event.place}
              </span>
              <p>{event.blurb}</p>
              {event.url && (
                <button className="btn tiny ghost" onClick={() => (feel.tap(), openEvent(event.url!))}>
                  Open the event page <span aria-hidden="true">↗</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
