import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { startPracticeTask, type Layout } from '@/app/runtime';
import { SURFACE, SURFACE_NAME, type Surface } from '@/app/surface';
import { announce } from '@/state/announce';
import { bus } from '@/state/bus';
import { useCity } from '@/state/store';
import { FIRST_STEPS, fill } from '@/state/firstSteps';
import { isTourDone, markTourDone, readPref, TIP_ASK_KEY, TIP_COPILOT_KEY, writePref } from './logic';
import { Portrait } from './Portrait';
import { shows } from '@/state/simple';
import { useFirstSteps, useQuiet } from './FirstSteps';

// ── The quick tour (DESIGN-tutorial §5): six coach marks over the real UI for players who already know AWS ──

/** Which build the tour talks to: the demo (practice account), the hosted city (your own linked account) or a local server. */
export type TourBuild = 'demo' | 'hosted' | 'local';

export interface TourStop {
  id: string;
  title: string;
  body: string;
  /**
   * Where the card points, tried in order; the first one on screen is ringed. A CSS selector, or `@<id>`: Kai (`@player`)
   * or a landmark (`@s3`) on the map, asked of the city (bus `locate`). None found: the card stands at the bottom.
   */
  targets: string[];
  /** Stop 2's "Try it": Sally's practice task (local in every build, never a model or AWS). */
  tryIt?: boolean;
}

/** ⋯, the HUD's menu button. */
export const MORE_BUTTON = '.more > [aria-haspopup="menu"]';

/** What each stop points at, by layout (the copy is data: shared/first-steps.json `tour`). */
const TARGETS: Record<string, (layout: Layout, building: string) => string[]> = {
  building: (_, building) => [`@${building}`, '.stage'],
  ask: () => ['.composer', '.prompt-bar'],
  deploy: () => ['#tab-deploy', '.tabs'],
  learn: () => ['#tab-learn', '.tabs'],
  // The panel's Copilot switch stands above the box on the City tab; the tab has none (the helpers need the panel): ⋯.
  console: (layout) => (layout === 'panel' ? ['.console-btn', '.composer', MORE_BUTTON] : [MORE_BUTTON]),
  more: () => [MORE_BUTTON],
};

/**
 * The six stops for this surface and build: a stop's body is its build's or layout's own where the copy has one. Stop 1
 * points at `building` (tourBuilding: S3 Lake, or a building already up when S3 Lake isn't).
 */
export function quickTourStops(layout: Layout, build: TourBuild, surface: Surface = SURFACE, building = 's3'): TourStop[] {
  return FIRST_STEPS.tour.stops.map((c) => {
    let body = c.body;
    if (build === 'hosted' && c.hosted) body = c.hosted;
    if (build === 'local' && c.local) body = c.local;
    if (layout === 'full' && c.tab) body = surface === 'tab' && c.safari ? c.safari : fill(c.tab, { surface: SURFACE_NAME[surface] });
    return { id: c.id, title: c.title, body, targets: TARGETS[c.id]?.(layout, building) ?? [], tryIt: c.id === 'ask' };
  });
}

/**
 * Stop 1's building: S3 Lake when it's up in this city, else the first building that is (a player who skipped the first
 * steps may have none yet: then S3 Lake's lot, which the city rings all the same).
 */
export function tourBuilding(landmarks: Record<string, { discovered?: boolean }> | undefined): string {
  const up = Object.entries(landmarks ?? {}).filter(([, l]) => l.discovered).map(([id]) => id);
  return up.includes('s3') || !up.length ? 's3' : up[0];
}

type Rect = { top: number; left: number; width: number; height: number };

/** A target's box on the page, a little bigger (the ring stands just outside it); undefined when it isn't on screen. */
function findTarget(selectors: string[]): Rect | undefined {
  for (const sel of selectors) {
    let r: Rect | undefined;
    if (sel.startsWith('@')) bus.emit('locate', { id: sel.slice(1), reply: (found) => (r = found) });
    else {
      const b = document.querySelector(sel)?.getBoundingClientRect();
      if (b && b.width > 0 && b.height > 0) r = b;
    }
    if (r) return { top: r.top - 4, left: r.left - 4, width: r.width + 8, height: r.height + 8 };
  }
  return undefined;
}

const MARGIN = 12;
const GAP = 10;

/**
 * Where the coach card stands: below its target, else above, else to the right, else to the left, always on screen and
 * never over the target. Only when no side has room does it take the roomier side's edge. No target: the bottom middle.
 * Pure (tests/quick-tour.test.tsx checks it).
 */
export function placeCard(t: Rect | undefined, card: { w: number; h: number }, view: { w: number; h: number }): { top: number; left: number } {
  const x = (v: number) => Math.max(MARGIN, Math.min(v, view.w - card.w - MARGIN));
  const y = (v: number) => Math.max(MARGIN, Math.min(v, view.h - card.h - MARGIN));
  if (!t) return { top: y(view.h - card.h - MARGIN), left: x((view.w - card.w) / 2) };
  const cx = x(t.left + t.width / 2 - card.w / 2);
  const cy = y(t.top + t.height / 2 - card.h / 2);
  const below = t.top + t.height + GAP;
  const above = t.top - GAP - card.h;
  const right = t.left + t.width + GAP;
  const left = t.left - GAP - card.w;
  if (below + card.h <= view.h - MARGIN) return { top: below, left: cx };
  if (above >= MARGIN) return { top: above, left: cx };
  if (right + card.w <= view.w - MARGIN) return { top: cy, left: right };
  if (left >= MARGIN) return { top: cy, left };
  return t.top > view.h - (t.top + t.height) ? { top: MARGIN, left: cx } : { top: y(below), left: cx };
}

/** After the city has arrived, the tour waits this long at most for the `arrived` moment. */
export const TOUR_FALLBACK_MS = 900;

/**
 * "I already know AWS" on the world map (src/ui/WorldIntro.tsx) and a first run's "Skip to the quick tour": the quick
 * tour opens once the city is up and has arrived (or TOUR_FALLBACK_MS after it's up), so the dive comes first. A choice
 * the player made, so it opens under automation too (the first-run tour below doesn't).
 */
export function startQuickTourAfterDive() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let offArrived = () => {};
  const open = () => {
    clearTimeout(timer);
    offArrived();
    if (useCity.getState().view.name === 'city') useCity.getState().setTourOpen(true);
  };
  const arm = () => {
    offArrived = bus.on('arrived', open);
    timer = setTimeout(open, TOUR_FALLBACK_MS);
  };
  if (useCity.getState().view.name === 'city') return arm();
  const offView = useCity.subscribe((s) => {
    if (s.view.name !== 'city') return;
    offView();
    arm();
  });
}

/**
 * The first-run tour opens once the city has arrived, for a player who never chose (a save from before the first steps)
 * and never saw a tour: the quick tour. Not on the world map, and not under automation, so scripted smoke runs aren't
 * blocked (they open it with awsCity.useCity.getState().setTourOpen(true)). Never for a player who chose the first steps
 * or the quick tour, is on them, is past them or is back from a replay: their tour is marked done (seen 24 Nov 2026: a
 * replay's end cleared its pref and the old tour opened over graduation's card).
 */
export function useFirstRunTour() {
  const city = useCity((s) => s.view.name === 'city');
  const setOpen = useCity((s) => s.setTourOpen);
  const chosen = useCity((s) => !!s.prefs.firstSteps);
  const fs = useFirstSteps();
  const path = chosen || fs.active || fs.graduated;
  useEffect(() => {
    if (path) markTourDone();
  }, [path]);
  useEffect(() => {
    if (!city || path || isTourDone() || navigator.webdriver) return;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const open = () => {
      clearTimeout(timer);
      off();
      if (!isTourDone() && useCity.getState().view.name === 'city') setOpen(true);
    };
    const off = bus.on('arrived', open);
    timer = setTimeout(open, TOUR_FALLBACK_MS);
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [city, setOpen, path]);
}

/**
 * The coach engine: one card at a time over the real UI, never modal. No scrim and nothing over the map (the ring takes no
 * presses), so the player can tap a building or type in the box mid-tour. The card is a non-modal dialog: Enter goes
 * next, Escape ends, Tab leaves it. It stands beside its target, never over it, follows it as the layout or the camera
 * moves, and steps aside while the city sleeps (a game, an HQ, the world map) or a celebration card is up. Each stop is
 * read out (announce).
 */
export function Tour({ layout }: { layout: Layout }) {
  const open = useCity((s) => s.tourOpen);
  const setOpen = useCity((s) => s.setTourOpen);
  const build = useCity((s): TourBuild => (s.backendKind === 'mock' ? 'demo' : s.hosted ? 'hosted' : 'local'));
  const shown = useCity((s) => s.view.name === 'city' && !s.celebration);
  const building = useCity((s) => tourBuilding(s.progress.cities?.[s.cityRegion]?.landmarks));
  const [i, setI] = useState(0);
  const [tried, setTried] = useState(false);
  const [rect, setRect] = useState<Rect>();
  const [pos, setPos] = useState<{ top: number; left: number }>();
  const card = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  const stops = quickTourStops(layout, build, SURFACE, building);
  const stop = stops[Math.min(i, stops.length - 1)];
  const last = i === stops.length - 1;
  const live = open && shown;

  const end = useCallback(() => {
    const inCard = !!card.current?.contains(document.activeElement);
    markTourDone();
    setOpen(false);
    setI(0);
    setTried(false);
    if (!inCard) return;
    const back = opener.current instanceof HTMLElement && opener.current.isConnected ? opener.current : document.getElementById('city-tabpanel');
    back?.focus({ preventScroll: true });
  }, [setOpen]);

  useEffect(() => {
    if (open) opener.current = document.activeElement;
  }, [open]);

  // The building stop: the camera goes there (and rings it); again if the city's own arrival moved it meanwhile (seen
  // 24 Nov 2026 in the panel, right after the dive), but only in the stop's first seconds, never against the player.
  const flyId = stop.id === 'building' ? building : undefined;
  useEffect(() => {
    if (!live || !flyId) return;
    const fly = () => bus.emit('flyTo', { id: flyId });
    const again = () => !findTarget([`@${flyId}`]) && fly();
    fly();
    const timers = [setTimeout(again, 1200), setTimeout(again, 2600)];
    return () => timers.forEach(clearTimeout);
  }, [live, flyId]);

  // Each stop is read out, and the keys come to its primary unless the player is busy elsewhere (it isn't modal).
  useEffect(() => {
    if (!live) return;
    announce(`Quick tour, ${i + 1} of ${stops.length}: ${stop.title}. ${stop.body}`, { replace: true });
    const a = document.activeElement;
    const free = !a || a === document.body || a === opener.current || !!card.current?.contains(a);
    if (free) card.current?.querySelector<HTMLButtonElement>('[data-primary]')?.focus({ preventScroll: true });
  }, [live, i, stops.length, stop.title, stop.body]);

  // Follow the target: the layout settles, the camera pans, the panel's rows slide.
  const targetKey = stop.targets.join('|');
  useLayoutEffect(() => {
    if (!live) return;
    const targets = targetKey.split('|');
    const place = () => {
      const r = findTarget(targets);
      const box = card.current;
      const p = placeCard(r, { w: box?.offsetWidth || 320, h: box?.offsetHeight || 200 }, { w: window.innerWidth, h: window.innerHeight });
      setRect((prev) => (prev && r && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height ? prev : r));
      setPos((prev) => (prev && prev.top === p.top && prev.left === p.left ? prev : p));
    };
    place();
    window.addEventListener('resize', place);
    const timer = setInterval(place, 400);
    return () => {
      window.removeEventListener('resize', place);
      clearInterval(timer);
    };
  }, [live, targetKey, tried, i]);

  if (!live) return null;

  const next = () => (last ? end() : setI(i + 1));
  const tryIt = () => {
    if (tried) return;
    setTried(true);
    startPracticeTask();
    // Try it goes from the card: the keys move to Next, the new amber button (never to <body>).
    requestAnimationFrame(() => card.current?.querySelector<HTMLButtonElement>('[data-next]')?.focus({ preventScroll: true }));
    bus.emit('flyTo', { id: `agent:${FIRST_STEPS.task.agentId}` });
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      end();
    } else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      next();
    }
  };
  const t = FIRST_STEPS.tour;
  // Amber only for Try it and Start exploring (DESIGN-tutorial §7 adv.try, adv.done): Next stays graphite, so the shift's
  // own amber button isn't matched by a second one on most stops. The keys go to Try it until it's been tried, then Next.
  const tryFirst = !!stop.tryIt && !tried;

  return (
    // The layer takes no room and no presses (display: contents): only the card's own keys (Enter, Escape) are its.
    <div className="tour-layer" role="presentation" onKeyDown={onKey}>
      <div className={`tour-ring ${rect ? '' : 'none'}`} style={rect} aria-hidden="true" />
      <div ref={card} className="tour-card" role="dialog" aria-labelledby="tour-title" aria-describedby="tour-body" style={pos ?? { top: 0, left: 0, opacity: 0 }}>
        <div className="tour-head">
          <Portrait id="concierge" size={32} />
          <h2 id="tour-title">{stop.title}</h2>
          <button className="btn ghost tiny tour-end" onClick={end}>
            {t.end}
          </button>
        </div>
        <p id="tour-body">{stop.body}</p>
        {stop.tryIt && tried && (
          <p className="tour-tried" role="status">
            {t.tried}
          </p>
        )}
        <div className="tour-foot">
          <span className="pips" role="img" aria-label={fill(t.label, { n: i + 1, of: stops.length })}>
            {stops.map((_, k) => (
              <i key={k} className={k === i ? 'on' : k < i ? 'done' : ''} />
            ))}
          </span>
          {i > 0 && (
            <button className="btn" onClick={() => setI(i - 1)}>
              {t.back}
            </button>
          )}
          <button className={`btn${last ? ' primary' : ''}`} data-next data-primary={tryFirst ? undefined : true} onClick={next}>
            {last ? t.done : t.next}
          </button>
          {tryFirst && (
            <button className="btn primary" data-try data-primary onClick={tryIt}>
              {t.try}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Coach tips: one card, once each, when the thing it explains first shows up (instead of more tour steps) ──

type TipId = 'ask' | 'copilot' | 'rank' | 'workshop';
const TIPS: Record<TipId, { key: string; title: string; body: (layout: Layout) => string; target: string }> = {
  ask: {
    key: TIP_ASK_KEY,
    title: 'Ask for anything',
    body: () => 'Say it in plain words, like “Store my holiday photos cheaply”, and the right agent walks over and does it.',
    target: '.composer',
  },
  copilot: {
    key: TIP_COPILOT_KEY,
    title: 'Console Copilot: let it drive your console',
    body: (layout) =>
      layout === 'panel'
        ? 'Turn on the Do it in my console switch above the box and an agent clicks through your AWS console tab, explaining each step. Stop it any time.'
        : `Open the ${SURFACE_NAME[SURFACE]} and turn on the Do it in my console switch above the box.`,
    target: '.console-btn',
  },
  rank: {
    key: 'awscity.tip.rank',
    title: 'You are the Mayor',
    body: () => 'Your city has a rank, from Village to Global City and on to Legendary City. Every building level and golden token raises it. Tap it to see everything you have earned.',
    target: '.rank-chip',
  },
  workshop: {
    key: 'awscity.tip.workshop',
    title: 'Workshops: hands on, step by step',
    body: () => 'Practise each command in the terminal here, or run it for real in AWS CloudShell. Every step grows the building.',
    target: '.workshop-list',
  },
};
/** A tip's height, about (its card: a title, two or three lines and a button). */
const TIP_H = 160;

/**
 * Where a coach tip stands: above its target when there's room, else below it; never over the City tab's To-do list or
 * the shift's big button (the screen's one amber button): then over the map instead.
 */
function tipTop(rect: Rect | undefined, vh: number): number {
  const top = rect ? (rect.top > TIP_H + 10 ? rect.top - TIP_H : Math.min(rect.top + rect.height + 10, vh - TIP_H - 10)) : vh / 2 - 80;
  const task = document.querySelector('.todo, .next')?.getBoundingClientRect();
  if (!task || task.height === 0 || top >= task.bottom || top + TIP_H <= task.top) return top;
  const map = document.querySelector('.stage')?.getBoundingClientRect();
  return map && map.height > 0 ? Math.max(map.top + 8, map.bottom - TIP_H - 8) : top;
}

/** Tips that show the first time their target appears on screen (after the city has given the player a reason). */
const WATCHED: TipId[] = ['workshop'];

/**
 * "Ask" the first time the player puts focus in the box; "Copilot" (panel only) the next time, once "Ask" was put away:
 * each comes from the player's own move, never on its own over the To-do list (seen 24 Nov 2026: the Copilot tip, with
 * its own amber button, over the To-do right after graduation).
 */
export function CoachTips({ layout }: { layout: Layout }) {
  const tourOpen = useCity((s) => s.tourOpen);
  // They wait while the first steps run (the quiet city), and come after graduation: a player on the path never sees
  // the old tour, so "tour done" alone would hold them back for good.
  const prefs = useCity((s) => s.prefs);
  const quiet = useQuiet();
  // After graduation's card, what opened comes one thing at a time (store SETTLE): tips come last.
  const allowed = useCity((s) => s.settle === 0) && shows('coachTips', prefs, quiet);
  const { graduated, active: onPath } = useFirstSteps();
  // Never over a celebration card (graduation's included): the tip comes once it closes.
  const celebrating = useCity((s) => !!s.celebration);
  const [tip, setTip] = useState<TipId>();
  const [rect, setRect] = useState<Rect>();
  const showing = useRef<TipId | undefined>(undefined);
  showing.current = tip;
  // A tip already up when the first steps (or a replay of them) or the quick tour start goes: it's been seen, and
  // the guide or the tour speaks now (seen 24 Nov 2026: the Workshops tip stayed through a replay).
  useEffect(() => {
    if (onPath || tourOpen) setTip(undefined);
  }, [onPath, tourOpen]);

  const offer = useCallback(
    (id: TipId) => {
      // Never over the tour, never before it (the tour comes first), never twice, never under automation.
      if (showing.current || tourOpen || celebrating || !allowed || !(isTourDone() || graduated) || navigator.webdriver || readPref(TIPS[id].key) === '1') return;
      if (!findTarget([TIPS[id].target])) return;
      writePref(TIPS[id].key, '1');
      setTip(id);
    },
    [tourOpen, allowed, graduated, celebrating],
  );

  // The rank tip waits for the first building, so there's something to be Mayor of.
  const built = useCity((s) => Object.values(s.progress.cities?.[s.cityRegion]?.landmarks ?? {}).some((l) => l.discovered));
  useEffect(() => {
    if (built) offer('rank');
  }, [built, offer]);
  useEffect(() => {
    const left = WATCHED.filter((id) => readPref(TIPS[id].key) !== '1');
    if (!left.length) return;
    const check = () => {
      for (const id of left) if (document.querySelector(TIPS[id].target)) offer(id);
      if (left.every((id) => readPref(TIPS[id].key) === '1')) mo.disconnect();
    };
    const mo = new MutationObserver(check);
    check();
    mo.observe(document.body, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [offer]);
  useEffect(() => {
    const onFocus = (e: FocusEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.composer')) return;
      // The second time (Ask already seen and put away): the Copilot switch above the box, in the panel.
      if (readPref(TIP_ASK_KEY) === '1') return void (layout === 'panel' && offer('copilot'));
      offer('ask');
    };
    document.addEventListener('focusin', onFocus);
    return () => document.removeEventListener('focusin', onFocus);
  }, [offer, layout]);

  useLayoutEffect(() => {
    if (!tip) return;
    const place = () => setRect(findTarget([TIPS[tip].target]));
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [tip]);

  if (!tip) return null;
  const t = TIPS[tip];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(280, vw - 24);
  const left = rect ? Math.max(12, Math.min(rect.left + rect.width / 2 - w / 2, vw - w - 12)) : (vw - w) / 2;
  const top = tipTop(rect, vh);
  return (
    <div className="coach-tip" role="dialog" aria-labelledby="coach-title" style={{ top, left }}>
      <b id="coach-title">{t.title}</b>
      <p>{t.body(layout)}</p>
      {/* Graphite: the screen's one amber button stays the task's (the To-do's, the guide's). */}
      <button className="btn tiny" onClick={() => setTip(undefined)}>
        Got it
      </button>
    </div>
  );
}
