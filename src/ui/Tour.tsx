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
  /**
   * What the card never covers, most important first: the controls the stop names or the player needs next (CSS
   * selectors; the ones not on screen are skipped). The tabs and the HUD come after these on every stop (ALWAYS_CLEAR).
   */
  keepClear: string[];
  /** More to keep in sight once Try it ran: Sally's task card and its 👀 Watch (and, in the panel, the map she walks). */
  keepClearTried?: string[];
  /** The tab that holds the target: shown first when the target isn't there (the panel's Copilot switch: City). */
  tab?: 'home';
  /** Stop 2's "Try it": Sally's practice task (local in every build, never a model or AWS). */
  tryIt?: boolean;
}

/** ⋯, the HUD's menu button. */
export const MORE_BUTTON = '.more > [aria-haspopup="menu"]';
/** ⋯'s open menu. */
const MORE_MENU = '.more > [role="menu"]';

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
 * What each stop leaves in sight (seen 24 Nov 2026: the card over "Use the practice account", over Ask / Watch it done /
 * Play on a scrolled building card, over Sally's 👀 Watch): the building card's actions and its task; the box; the
 * practice account, the linked account's actions and a waiting approval; the Learn tab; the Copilot switch and ⋯.
 */
const KEEP_CLEAR: Record<string, string[]> = {
  building: ['.place-do .actions', '.place-do .agent-asks', '.place-live-task'],
  ask: ['.composer'],
  deploy: ['.card.account > .btn', '.card.account .account-actions', '.card.stack.preview .actions'],
  learn: ['#tab-learn', '.tab-body [role="group"][aria-label="Learn"]'],
  console: ['.console-btn', MORE_BUTTON, MORE_MENU],
  more: [MORE_BUTTON, MORE_MENU],
};
/** Every stop leaves the tabs pressable and the HUD in sight, after its own controls. */
export const ALWAYS_CLEAR = ['.tabs', '.hud'];

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
    const tryIt = c.id === 'ask';
    return {
      id: c.id,
      title: c.title,
      body,
      targets: TARGETS[c.id]?.(layout, building) ?? [],
      keepClear: KEEP_CLEAR[c.id] ?? [],
      // The panel's map is where Sally walks: the card folds rather than stand over it.
      keepClearTried: tryIt ? ['.task .watch-btn', '.task', ...(layout === 'panel' ? ['.stage'] : [])] : undefined,
      // The switch stands on the City tab only (seen 24 Nov 2026: from Learn, stop 5 ringed the box instead).
      tab: c.id === 'console' && layout === 'panel' ? 'home' : undefined,
      tryIt,
    };
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

/** A box on the page, in CSS pixels (a DOMRect fits). */
export type Box = { top: number; left: number; width: number; height: number };
type Rect = Box;
type Size = { w: number; h: number };

/** The part of `a` inside `b`, or undefined when less than `min` px of it shows either way. */
function clip(a: Box, b: Box, min = 1): Box | undefined {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const width = Math.min(a.left + a.width, b.left + b.width) - left;
  const height = Math.min(a.top + a.height, b.top + b.height) - top;
  return width >= min && height >= min ? { top, left, width, height } : undefined;
}

/** A building on the map shows this much at least, or it isn't ringed (the stop falls back to the map itself). */
const MIN_SEEN = 8;

/** A target's box on the page, a little bigger (the ring stands just outside it); undefined when it isn't on screen. */
function findTarget(selectors: string[]): Rect | undefined {
  for (const sel of selectors) {
    let r: Rect | undefined;
    if (sel.startsWith('@')) {
      bus.emit('locate', { id: sel.slice(1), reply: (found) => (r = found) });
      // Only the part of the map in sight: the panel's stage shrinks and scrolls, and the ring never lands on the tabs.
      const stage = document.querySelector('.stage')?.getBoundingClientRect();
      if (r && stage && stage.width > 0 && stage.height > 0) r = clip(r, stage, MIN_SEEN);
    } else {
      const b = document.querySelector(sel)?.getBoundingClientRect();
      if (b && b.width > 0 && b.height > 0) r = b;
    }
    if (r) return { top: r.top - 4, left: r.left - 4, width: r.width + 8, height: r.height + 8 };
  }
  return undefined;
}

/** An element's box when it's on the page with a size. */
function boxOf(sel: string): Box | undefined {
  const b = document.querySelector(sel)?.getBoundingClientRect();
  return b && b.width > 0 && b.height > 0 ? b : undefined;
}

/**
 * The boxes a stop keeps in sight, in its order: each selector's elements, cut to what their scrolling boxes and the
 * window show (a button scrolled out of the panel's body covers nothing); ones not there or out of sight are skipped.
 */
function keepClearBoxes(selectors: string[]): Box[] {
  const view = { top: 0, left: 0, width: window.innerWidth, height: window.innerHeight };
  const out: Box[] = [];
  for (const sel of selectors) {
    for (const el of [...document.querySelectorAll(sel)].slice(0, 8)) {
      let b: Box | undefined = el.getBoundingClientRect();
      for (let p = el.parentElement; b && p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (/auto|scroll|hidden|clip/.test(`${s.overflowX} ${s.overflowY}`)) b = clip(b, p.getBoundingClientRect());
      }
      if (b) b = clip(b, view);
      if (b) out.push(b);
    }
  }
  return out;
}

const MARGIN = 12;
const GAP = 10;
/** The pill's last resort walks the screen in steps this big. */
const STEP = 12;

/** Whether two boxes share any area (touching edges don't). */
export const overlaps = (a: Box, b: Box) => a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top;

/** Where the coach stands: the full card, or folded to the docked pill ("Quick tour · 3 of 6", Next, End tour). */
export interface CoachSpot {
  mode: 'card' | 'pill';
  top: number;
  left: number;
}

/**
 * Where the coach card stands (pure; tests/quick-tour.test.tsx checks it). The first spot that is wholly on screen, off
 * the target and off every keep-clear box: below the target, above, right, left (centred, then lined up with either
 * edge), the side column's far corner from the target, the map's far corner, a strip docked at the bottom. None: the
 * card folds to the pill, at the map's far corner, a corner of the screen or the side column, else the first clear spot
 * from the top right. Only when the keep-clear boxes leave no room even for the pill are the last of them (the HUD,
 * then the tabs) let go, one at a time.
 */
export function placeCoach({ target, keepClear = [], card, pill, view, side, stage }: { target?: Box; keepClear?: Box[]; card: Size; pill: Size; view: Size; side?: Box; stage?: Box }): CoachSpot {
  const box = (top: number, left: number, s: Size): Box => ({ top, left, width: s.w, height: s.h });
  const xIn = (v: number, w: number) => Math.max(MARGIN, Math.min(v, view.w - w - MARGIN));
  const yIn = (v: number, h: number) => Math.max(MARGIN, Math.min(v, view.h - h - MARGIN));
  const onScreen = (b: Box) => b.left >= 0 && b.top >= 0 && b.left + b.width <= view.w && b.top + b.height <= view.h;
  const clear = (b: Box, keep: Box[]) => onScreen(b) && !(target && overlaps(b, target)) && !keep.some((k) => overlaps(b, k));
  // The middle of the target (none: the middle of the screen), and a region's corners farthest from it first.
  const cx = target ? target.left + target.width / 2 : view.w / 2;
  const cy = target ? target.top + target.height / 2 : view.h / 2;
  const corners = (r: Box | undefined, s: Size): Box[] =>
    !r
      ? []
      : [r.top + MARGIN, r.top + r.height - s.h - MARGIN]
          .flatMap((top) => [box(top, r.left + MARGIN, s), box(top, r.left + r.width - s.w - MARGIN, s)])
          .map((b) => ({ b, d: Math.hypot(b.left + s.w / 2 - cx, b.top + s.h / 2 - cy) }))
          .sort((a, z) => z.d - a.d)
          .map(({ b }) => b);

  const { w, h } = card;
  const docked = box(view.h - h - MARGIN, xIn((view.w - w) / 2, w), card);
  const spots: Box[] = [];
  if (target) {
    const t = target;
    const xs = [t.left + t.width / 2 - w / 2, t.left, t.left + t.width - w].map((x) => xIn(x, w));
    const ys = [t.top + t.height / 2 - h / 2, t.top, t.top + t.height - h].map((y) => yIn(y, h));
    spots.push(...xs.map((x) => box(t.top + t.height + GAP, x, card)));
    spots.push(...xs.map((x) => box(t.top - GAP - h, x, card)));
    spots.push(...ys.map((y) => box(y, t.left + t.width + GAP, card)));
    spots.push(...ys.map((y) => box(y, t.left - GAP - w, card)));
  } else spots.push(docked);
  spots.push(...corners(side, card), ...corners(stage, card), docked);
  const spot = spots.find((b) => clear(b, keepClear));
  if (spot) return { mode: 'card', top: spot.top, left: spot.left };

  const pills = [...corners(stage, pill), ...corners({ top: 0, left: 0, width: view.w, height: view.h }, pill), ...corners(side, pill)];
  for (let n = keepClear.length; n >= 0; n--) {
    const keep = keepClear.slice(0, n);
    let p = n === keepClear.length ? pills.find((b) => clear(b, keep)) : undefined;
    for (let y = MARGIN; !p && y + pill.h <= view.h - MARGIN; y += STEP)
      for (let x = view.w - pill.w - MARGIN; !p && x >= MARGIN; x -= STEP) if (clear(box(y, x, pill), keep)) p = box(y, x, pill);
    if (p) return { mode: 'pill', top: p.top, left: p.left };
  }
  return { mode: 'pill', top: view.h - pill.h - MARGIN, left: view.w - pill.w - MARGIN };
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
 * next, Escape ends, Tab leaves it. It stands beside its target, never over it, its stop's controls or the tabs (with
 * no room it folds to the docked pill: placeCoach), follows them as the page scrolls, the layout or the camera moves,
 * and steps aside while the city sleeps (a game, an HQ, the world map) or a celebration card is up. Each stop is read
 * out (announce).
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
  const [pos, setPos] = useState<CoachSpot>();
  const card = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  /** The card's and the pill's last measured sizes (only the one on screen can be measured). */
  const sizes = useRef<{ card: Size; pill: Size }>({ card: { w: 320, h: 200 }, pill: { w: 260, h: 44 } });
  /** Sally's task card was brought into the panel's view once after Try it. */
  const taskShown = useRef(false);
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

  // The panel's Copilot switch stands on the City tab only: from another tab, the stop shows City first.
  const showTab = stop.tab;
  const firstTarget = stop.targets[0];
  useEffect(() => {
    if (live && showTab && !document.querySelector(firstTarget)) bus.emit('showTab', { tab: showTab });
  }, [live, showTab, firstTarget]);

  // Follow the target and keep the stop's controls in sight: any scroll (the panel's body, a card's list), the window,
  // the map and the side column resizing (the panel's map shrinks as its body scrolls), the page changing under the card
  // (a tab, a card, Sally's task), and for a building on the map the camera too (it pans with no change on the page).
  const targetKey = stop.targets.join('|');
  const keepKey = [...stop.keepClear, ...(tried ? (stop.keepClearTried ?? []) : []), ...ALWAYS_CLEAR].join('|');
  const bringTask = layout === 'panel' && !!stop.tryIt && tried;
  const mode = pos?.mode;
  useLayoutEffect(() => {
    if (!live) return;
    const targets = targetKey.split('|');
    const keep = keepKey.split('|');
    let frame = 0;
    const place = () => {
      frame = 0;
      const el = card.current;
      if (el?.offsetWidth) sizes.current[el.classList.contains('pill') ? 'pill' : 'card'] = { w: el.offsetWidth, h: el.offsetHeight };
      // After Try it, the panel brings Sally's steps into view once, so the task isn't finished unseen.
      const task = bringTask && !taskShown.current ? document.querySelector<HTMLElement>('.tab-body .task') : null;
      if (task) {
        taskShown.current = true;
        task.scrollIntoView?.({ block: 'nearest' });
      }
      const r = findTarget(targets);
      const p = placeCoach({
        target: r,
        keepClear: keepClearBoxes(keep),
        ...sizes.current,
        view: { w: window.innerWidth, h: window.innerHeight },
        side: boxOf('.side'),
        stage: boxOf('.stage'),
      });
      setRect((prev) => (prev && r && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height ? prev : r));
      setPos((prev) => (prev && prev.mode === p.mode && prev.top === p.top && prev.left === p.left ? prev : p));
    };
    const soon = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener('resize', soon);
    window.addEventListener('scroll', soon, true);
    const sizesSeen = typeof ResizeObserver === 'function' ? new ResizeObserver(soon) : undefined;
    for (const sel of ['.stage', '.side']) {
      const el = document.querySelector(sel);
      if (el) sizesSeen?.observe(el);
    }
    // The card's own changes (its place, its size) are left out, or it would chase itself.
    const changes = new MutationObserver((list) => {
      if (list.some((m) => !layer.current?.contains(m.target))) soon();
    });
    changes.observe(document.querySelector('.app') ?? document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const timer = targets.some((t) => t.startsWith('@')) ? setInterval(soon, 400) : undefined;
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', soon);
      window.removeEventListener('scroll', soon, true);
      sizesSeen?.disconnect();
      changes.disconnect();
      clearInterval(timer);
    };
  }, [live, targetKey, keepKey, bringTask, tried, i, mode]);

  if (!live) return null;

  const next = () => (last ? end() : setI(i + 1));
  const tryIt = () => {
    if (tried) return;
    setTried(true);
    taskShown.current = false;
    startPracticeTask();
    // Her steps are on the City tab's shift (the copy says so): it shows, a building's card or another tab giving way.
    bus.emit('showTab', { tab: 'home' });
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

  // No room beside the stop's controls: the same dialog folds to one docked row (its title and words stay for screen
  // readers, and Enter, Escape and the buttons work the same).
  const pill = pos?.mode === 'pill';

  return (
    // The layer takes no room and no presses (display: contents): only the card's own keys (Enter, Escape) are its.
    <div ref={layer} className="tour-layer" role="presentation" onKeyDown={onKey}>
      <div className={`tour-ring ${rect ? '' : 'none'}`} style={rect} aria-hidden="true" />
      <div
        ref={card}
        className={`tour-card${pill ? ' pill' : ''}`}
        role="dialog"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, opacity: 0 }}
      >
        <div className="tour-head">
          {!pill && <Portrait id="concierge" size={32} />}
          <h2 id="tour-title" className={pill ? 'sr-only' : undefined}>
            {stop.title}
          </h2>
          <button className="btn ghost tiny tour-end" onClick={end}>
            {t.end}
          </button>
        </div>
        <p id="tour-body" className={pill ? 'sr-only' : undefined}>
          {stop.body}
        </p>
        {stop.tryIt && tried && (
          <p className={`tour-tried${pill ? ' sr-only' : ''}`} role="status">
            {t.tried}
          </p>
        )}
        <div className="tour-foot">
          {pill ? (
            <span className="tour-pill-n">{fill(t.label, { n: i + 1, of: stops.length })}</span>
          ) : (
            <span className="pips" role="img" aria-label={fill(t.label, { n: i + 1, of: stops.length })}>
              {stops.map((_, k) => (
                <i key={k} className={k === i ? 'on' : k < i ? 'done' : ''} />
              ))}
            </span>
          )}
          {i > 0 && !pill && (
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
