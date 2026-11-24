// @vitest-environment jsdom
// The quick tour (src/ui/Tour.tsx, DESIGN-tutorial §5): six non-modal coach marks for players who already know AWS. The
// stops and their targets (in the side panel and the tab), the card never over its target, the map still takes presses
// and focus mid-tour, "Try it" plays Sally's practice task locally (nothing sent), ⋯ → Show the quick tour, the world
// map's "I already know AWS" starting it after the dive, Escape ending it. Plus the three verify fixes beside it: a coach
// tip goes when the first steps start, the citizen names the stars it really added, and bubbles wait behind a
// celebration card.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '@/backend/contract';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" />, agentColor: () => undefined }));
// The App renders here (the stop targets in both layouts); the city's canvas and Phaser stay out of jsdom.
vi.mock('phaser', () => ({ default: { Geom: { Rectangle: class {}, RectangleContains: () => true }, GameObjects: { Container: class {} }, Scene: class {} } }));
vi.mock('@/app/GameCanvas', () => ({ GameCanvas: () => <div className="game" tabIndex={0} data-testid="map" /> }));

const rt = vi.hoisted(() => ({
  startPracticeTask: vi.fn(() => 'practice-task-1'),
  // What would reach a model or AWS: Try it calls none of them (the practice task itself sends nothing in any build:
  // tests/practice-task.test.ts).
  submitPrompt: vi.fn(),
  startConsoleCopilot: vi.fn(),
  askDistrict: vi.fn(),
  planDeploy: vi.fn(),
}));
vi.mock('@/app/runtime', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/app/runtime')>()), ...rt }));

const { useCity } = await import('@/state/store');
const { bus } = await import('@/state/bus');
const { FIRST_STEPS } = await import('@/state/firstSteps');
const { Tour, CoachTips, quickTourStops, placeCoach, overlaps, ALWAYS_CLEAR, MORE_BUTTON, tourBuilding, TOUR_FALLBACK_MS, startQuickTourAfterDive } = await import('@/ui/Tour');
const { Hud } = await import('@/ui/Hud');
const { App } = await import('@/app/App');
const { freshLines, HELD_LINE_FRESH_MS } = await import('@/game/calm');
const { RequestCard } = await import('@/ui/RequestCard');
const { THANKS_STARS } = await import('@/state/requests');
const { readPref, TIP_ASK_KEY } = await import('@/ui/logic');

const REGION = 'us-west-2';
/** A player who already knows AWS: the first steps skipped, Everything on. */
const builder: Progress = {
  version: 2,
  landmarks: {},
  updatedAt: '',
  quests: { 'first-steps': { status: 'done', step: 6 } },
  cities: { [REGION]: { landmarks: { s3: { discovered: true, xp: 12 } } } },
};

beforeEach(() => {
  localStorage.clear();
  for (const f of Object.values(rt)) f.mockClear();
  useCity.setState({
    cityRegion: REGION,
    view: { name: 'city' },
    backendKind: 'mock',
    backendStatus: 'connected',
    hosted: false,
    progress: builder,
    tasks: {},
    taskOrder: [],
    deploys: {},
    toasts: [],
    feed: [],
    account: { linked: false },
    celebration: undefined,
    settle: 0,
    selected: undefined,
    build: undefined,
    tourOpen: false,
    prefs: { chatter: false, stage: 'compact', region: REGION, firstSteps: 'skipped', builder: true, simple: false },
  } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const TITLES = [
  'Every building is an AWS service',
  'Ask in plain words',
  'Real changes wait for your OK',
  'Learn, then prove it',
  'Beside your console',
  'Your account as a map',
];

const card = () => screen.getByRole('dialog', { name: /./ });

describe('the six stops', () => {
  it('are the design’s, in order, with the build’s and the layout’s own words', () => {
    const demo = quickTourStops('panel', 'demo', 'sidepanel');
    expect(demo.map((s) => s.title)).toEqual(TITLES);
    expect(demo.map((s) => s.targets[0])).toEqual(['@s3', '.composer', '#tab-deploy', '#tab-learn', '.console-btn', '.more > [aria-haspopup="menu"]']);
    expect(demo.filter((s) => s.tryIt).map((s) => s.id)).toEqual(['ask']);
    expect(demo[2].body).toMatch(/practice account: nothing real is made/);
    expect(quickTourStops('panel', 'hosted', 'sidepanel')[2].body).toMatch(/role you install; every write needs your Approve and your authenticator/);
    expect(quickTourStops('panel', 'local', 'sidepanel')[2].body).not.toMatch(/practice account|authenticator/);
    // The hosted and local tab have no Copilot switch: stop 5 points at ⋯ and says where the helpers work.
    const tab = quickTourStops('full', 'hosted', 'sidepanel');
    expect(tab[4].targets).toEqual(['.more > [aria-haspopup="menu"]']);
    expect(tab[4].body).toMatch(/browser's side panel, next to the AWS Console/);
    expect(tab[4].practiceConsole).toBeUndefined();
    expect(quickTourStops('full', 'local', 'sidebar')[4].body).toMatch(/browser's sidebar/);
    expect(quickTourStops('full', 'hosted', 'tab')[4].body).toMatch(/^Safari has no side panel/);
  });

  // Seen 24 Nov 2026: stop 3 promised "Every change waits for your OK" while Try it, a plain Ask and the demo Copilot's
  // bucket finished with no approval card. Practice tasks are said to build nothing; real changes wait for an OK.
  it('stop 3 says what waits for an OK and what doesn’t, in each build; stop 2 promises no more than the demo does', () => {
    const [, ask, deploy] = quickTourStops('panel', 'demo', 'sidepanel');
    expect(deploy.title).toBe('Real changes wait for your OK');
    expect(deploy.title).not.toMatch(/every change/i);
    expect(deploy.body).toMatch(/^In the demo, tasks are practice: they show the steps and build nothing\. A build in Deploy waits for your Approve\./);
    const hosted = quickTourStops('panel', 'hosted', 'sidepanel');
    expect(hosted[2].body).toMatch(/^Practice tasks like Try it build nothing\. Real changes wait for your OK in Deploy/);
    expect(quickTourStops('full', 'local', 'sidepanel')[2].body).toMatch(/^Practice tasks like Try it build nothing\. .*until you approve it\.$/);
    // The demo's Ask plays scripted examples; the hosted and local agents do what's typed.
    expect(ask.body).toMatch(/shows you the steps\. The demo plays scripted examples; the hosted city does what you type\./);
    expect(ask.body).not.toMatch(/does it while you watch/);
    expect(hosted[1].body).toMatch(/does it while you watch/);
    expect(quickTourStops('panel', 'local', 'sidepanel')[1].body).toMatch(/does it while you watch/);
  });

  it('stop 6 has other words once an account is linked (seen 24 Nov 2026: “once an account is linked” right after linking)', () => {
    expect(quickTourStops('panel', 'demo', 'sidepanel')[5].body).toMatch(/once an account is linked/);
    for (const build of ['demo', 'hosted'] as const) {
      const linked = quickTourStops('full', build, 'sidepanel', 's3', true)[5].body;
      expect(linked).toBe(FIRST_STEPS.tour.stops[5].linked);
      expect(linked).toMatch(/^⋯ → My AWS, live draws your linked account's resources, costs and traffic\./);
      expect(linked).not.toMatch(/once an account is linked/);
    }
    // Only stop 6 changes.
    expect(quickTourStops('panel', 'demo', 'sidepanel', 's3', true).slice(0, 5)).toEqual(quickTourStops('panel', 'demo', 'sidepanel').slice(0, 5));
  });

  it('stop 1 points at S3 Lake, or a building already up when S3 Lake isn’t (its lot when none is)', () => {
    expect(tourBuilding({ s3: { discovered: true }, ec2: { discovered: true } })).toBe('s3');
    expect(tourBuilding({ ec2: { discovered: true }, s3: { discovered: false } })).toBe('ec2');
    expect(tourBuilding(undefined)).toBe('s3');
    expect(quickTourStops('panel', 'demo', 'sidepanel', 'ec2')[0].targets).toEqual(['@ec2', '.stage']);
  });

  for (const layout of ['panel', 'full'] as const) {
    it(`each stop’s target is on screen in the ${layout === 'panel' ? 'side panel' : 'tab'} with Everything on`, () => {
      const { container } = render(<App layout={layout} />);
      for (const stop of quickTourStops(layout, 'demo')) {
        const css = stop.targets.filter((t) => !t.startsWith('@'));
        // The building is on the canvas (asked of the city); its fallback is the map itself.
        const found = css.find((sel) => container.querySelector(sel));
        expect(found, `${stop.id} in ${layout}`).toBe(stop.id === 'building' ? '.stage' : stop.targets[0]);
      }
    });
  }
});

describe('where the card stands: never over its target, its stop’s controls or the tabs', () => {
  type B = { top: number; left: number; width: number; height: number };
  const at = (top: number, left: number, width: number, height: number): B => ({ top, left, width, height });
  const card = { w: 320, h: 210 };
  const pill = { w: 260, h: 40 };
  /** Asserts the spot is on screen and covers neither the target nor anything kept clear; returns its box. */
  const check = (o: Parameters<typeof placeCoach>[0]) => {
    const spot = placeCoach(o);
    const size = spot.mode === 'card' ? o.card : o.pill;
    const b = { top: spot.top, left: spot.left, width: size.w, height: size.h };
    expect(b.left).toBeGreaterThanOrEqual(0);
    expect(b.top).toBeGreaterThanOrEqual(0);
    expect(b.left + b.width).toBeLessThanOrEqual(o.view.w);
    expect(b.top + b.height).toBeLessThanOrEqual(o.view.h);
    if (o.target) expect(overlaps(b, o.target), 'over the target').toBe(false);
    for (const k of o.keepClear ?? []) expect(overlaps(b, k), `over ${JSON.stringify(k)}`).toBe(false);
    return { spot, b };
  };

  // The side panel, 400 × 860: the HUD, the map (44–330), the side column with the tabs (340–390), the box at the bottom.
  const panel = { view: { w: 400, h: 860 }, card, pill, stage: at(44, 0, 400, 286), side: at(330, 0, 400, 530) };
  const pHud = at(0, 0, 400, 44);
  const pTabs = at(340, 0, 400, 50);
  const pComposer = at(800, 8, 384, 48);
  // The tab, 1400 × 880: the map on the left, the side column from x = 1000.
  const tab = { view: { w: 1400, h: 880 }, card, pill, stage: at(48, 0, 1000, 832), side: at(48, 1000, 400, 832) };
  const tHud = at(0, 0, 1400, 48);
  const tTabs = at(48, 1000, 400, 48);

  it('below a tab, above the box at the bottom, beside a building, docked at the bottom with no target', () => {
    const tabs = at(300, 200, 90, 36);
    expect(check({ ...panel, target: tabs }).spot).toEqual({ mode: 'card', top: tabs.top + tabs.height + 10, left: 68 });
    expect(check({ ...panel, target: pComposer }).spot.top).toBe(pComposer.top - 10 - card.h);
    check({ ...panel, target: at(120, 150, 90, 80) });
    expect(check({ ...panel }).spot).toEqual({ mode: 'card', top: 860 - card.h - 12, left: 40 });
    // A tall target on a wide map, no room below or above: to its side.
    const low = at(60, 400, 120, 800);
    expect(check({ ...tab, target: low }).spot.left).toBe(low.left + low.width + 10);
  });

  it('stop 3 in the panel: never over “Use the practice account” or the linked account’s actions', () => {
    const deployTab = at(336, 296, 108, 58);
    const practice = at(470, 16, 368, 36);
    const actions = at(520, 16, 368, 36);
    const { spot, b } = check({ ...panel, target: deployTab, keepClear: [practice, actions, pTabs, pHud] });
    expect(spot.mode).toBe('card');
    // Over the map, above the tab it names (the old rule put it below, over the practice button).
    expect(b.top + b.height).toBeLessThanOrEqual(deployTab.top);
    // Linked, with a waiting approval's Approve / Reject further down: still clear of all of them.
    check({ ...panel, target: deployTab, keepClear: [at(400, 16, 368, 36), at(450, 16, 368, 36), at(700, 16, 368, 40), pTabs, pHud] });
  });

  it('stop 1 in the panel after scrolling: the map shrank to 200 px, the building card’s actions stay pressable', () => {
    const stage = at(44, 0, 400, 200);
    const lake = at(120, 160, 90, 70);
    const actions = [at(310, 16, 368, 40), at(360, 16, 368, 32), at(400, 16, 368, 160), at(600, 16, 368, 200)];
    const { spot } = check({ ...panel, stage, side: at(244, 0, 400, 616), target: lake, keepClear: [...actions, at(254, 0, 400, 50), pHud] });
    // The card can't stand anywhere clear (the map is too short): the pill, off the building.
    expect(spot.mode).toBe('pill');
  });

  it('the tabs always stay pressable (panel stop 1, the tab’s stop 5)', () => {
    const lake = at(250, 150, 90, 70); // low on the panel's map: below it would be the tabs
    check({ ...panel, target: lake, keepClear: [pTabs, pHud] });
    // The tab's ⋯ at the top right: below it are the side column's tabs.
    const more = at(4, 1350, 44, 44);
    const menu = at(52, 1150, 240, 420);
    const { spot } = check({ ...tab, target: more, keepClear: [more, menu, tTabs, tHud] });
    expect(spot.mode).toBe('card');
  });

  it('the tab: a stop in the side column (x ≥ 1000) takes the map beside it when its controls fill the column', () => {
    const deployTab = at(44, 1296, 108, 56);
    const practice = at(150, 1016, 368, 36);
    const { b } = check({ ...tab, target: deployTab, keepClear: [practice, at(200, 1016, 368, 620), tTabs, tHud] });
    expect(b.left + b.width).toBeLessThanOrEqual(1000);
  });

  it('crowded: the card folds to the pill, which covers nothing', () => {
    const task = at(450, 8, 384, 290);
    const keep = [pComposer, at(460, 300, 60, 28), task, panel.stage, pTabs, pHud];
    const { spot, b } = check({ ...panel, target: pComposer, keepClear: keep });
    expect(spot.mode).toBe('pill');
    expect(b.top).toBeGreaterThanOrEqual(pTabs.top + pTabs.height);
    expect(b.top + b.height).toBeLessThanOrEqual(task.top);
  });

  it('every stop keeps its own controls clear; the panel’s stop 5 rings the Copilot switch on the City tab', () => {
    for (const layout of ['panel', 'full'] as const)
      for (const stop of quickTourStops(layout, 'demo', 'sidepanel')) expect(stop.keepClear.length, `${stop.id} ${layout}`).toBeGreaterThan(0);
    const [building, ask, deploy, learn, consoleStop, more] = quickTourStops('panel', 'demo', 'sidepanel');
    expect(building.keepClear).toEqual(['.place-do .actions', '.place-do .agent-asks', '.place-live-task']);
    expect(ask.keepClearTried).toEqual(['.task .watch-btn', '.task', '.stage']);
    expect(quickTourStops('full', 'demo', 'sidepanel')[1].keepClearTried).toEqual(['.task .watch-btn', '.task']);
    expect(deploy.keepClear).toContain('.card.account > .btn');
    expect(learn.keepClear[0]).toBe('#tab-learn');
    expect(consoleStop.targets[0]).toBe('.console-btn');
    expect(consoleStop.tab).toBe('home');
    expect(consoleStop.keepClear[0]).toBe('.console-btn');
    expect(more.keepClear[0]).toBe(MORE_BUTTON);
    expect(quickTourStops('full', 'demo', 'sidepanel')[4].tab).toBeUndefined();
    expect(ALWAYS_CLEAR).toEqual(['.tabs', '.hud']);
  });
});

describe('the coach engine', () => {
  const openTour = () => act(() => useCity.getState().setTourOpen(true));

  it('walks the six stops with Next, announces each, and ends on Start exploring', () => {
    render(<Tour layout="panel" />);
    openTour();
    for (const [i, title] of TITLES.entries()) {
      const c = card();
      expect(within(c).getByRole('heading').textContent).toBe(title);
      expect(within(c).getByRole('img').getAttribute('aria-label')).toBe(`Quick tour · ${i + 1} of 6`);
      const next = within(c).getByRole('button', { name: i === 5 ? 'Start exploring' : 'Next' });
      // Amber only for Try it (stop 2) and Start exploring (stop 6): Next is graphite beside the shift's own button.
      expect([...c.querySelectorAll('.btn.primary')].map((b) => b.textContent)).toEqual(i === 1 ? ['Try it'] : i === 5 ? ['Start exploring'] : []);
      fireEvent.click(next);
    }
    expect(useCity.getState().tourOpen).toBe(false);
    expect(readPref('awscity.tourDone')).toBe('1');
  });

  it('is not modal: no scrim, no aria-modal, Tab leaves it, the map stays pressable and focusable', () => {
    render(
      <>
        <button data-testid="building">S3 Lake</button>
        <Tour layout="panel" />
      </>,
    );
    openTour();
    const c = card();
    expect(c.getAttribute('aria-modal')).toBeNull();
    expect(document.querySelector('.tour')).toBeNull(); // the old full-screen layer
    expect(document.querySelector('.tour-ring')?.getAttribute('aria-hidden')).toBe('true');
    // Tab from the card's last button isn't pulled back into it.
    const buttons = within(c).getAllByRole('button');
    buttons.at(-1)!.focus();
    const tab = fireEvent.keyDown(buttons.at(-1)!, { key: 'Tab' });
    expect(tab).toBe(true); // not prevented
    // The map behind it still takes a press and the focus.
    const map = screen.getByTestId('building');
    const press = vi.fn();
    map.addEventListener('click', press);
    fireEvent.click(map);
    map.focus();
    expect(press).toHaveBeenCalled();
    expect(document.activeElement).toBe(map);
    expect(useCity.getState().tourOpen).toBe(true);
  });

  it('Escape ends it, Enter goes next', () => {
    render(<Tour layout="full" />);
    openTour();
    fireEvent.keyDown(within(card()).getByRole('heading'), { key: 'Enter' });
    expect(within(card()).getByRole('heading').textContent).toBe(TITLES[1]);
    fireEvent.keyDown(card(), { key: 'Escape' });
    expect(useCity.getState().tourOpen).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('steps aside while the city sleeps or a celebration card is up, and comes back where it was', () => {
    render(<Tour layout="panel" />);
    openTour();
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    act(() => useCity.setState({ view: { name: 'game', game: 's3' } } as never));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useCity.setState({ view: { name: 'city' }, celebration: 'storage-static-site' } as never));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useCity.setState({ celebration: undefined } as never));
    expect(within(card()).getByRole('heading').textContent).toBe(TITLES[1]);
  });

  it('stop 1 sends the camera to S3 Lake and rings it', () => {
    const fly = vi.fn();
    const off = bus.on('flyTo', fly);
    const offLocate = bus.on('locate', ({ id, reply }) => reply(id === 's3' ? { top: 100, left: 120, width: 80, height: 60 } : undefined));
    render(<Tour layout="panel" />);
    openTour();
    expect(fly).toHaveBeenCalledWith({ id: 's3' });
    const ring = document.querySelector<HTMLElement>('.tour-ring')!;
    expect(ring.className).not.toMatch(/none/);
    expect(ring.style.top).toBe('96px');
    off();
    offLocate();
  });
});

describe('Try it', () => {
  it('plays Sally’s practice task, then the card goes on with Next', () => {
    render(<Tour layout="panel" />);
    act(() => useCity.getState().setTourOpen(true));
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Try it' }));
    expect(rt.startPracticeTask).toHaveBeenCalledTimes(1);
    expect(within(card()).queryByRole('button', { name: 'Try it' })).toBeNull();
    expect(within(card()).getByRole('status').textContent).toBe(FIRST_STEPS.tour.tried);
    expect(card().querySelector('[data-primary]')?.textContent).toBe('Next');
  });

  it('hands the keys to Next once Try it goes (never to <body>)', async () => {
    render(<Tour layout="panel" />);
    act(() => useCity.getState().setTourOpen(true));
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    const t = within(card()).getByRole('button', { name: 'Try it' });
    t.focus();
    fireEvent.click(t);
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(document.activeElement?.textContent).toBe('Next');
  });

  it('sends nothing: no prompt, no Copilot, no chat, no deploy (a hosted player too)', () => {
    useCity.setState({ backendKind: 'server', hosted: true, account: { linked: true } } as never);
    render(<Tour layout="panel" />);
    act(() => useCity.getState().setTourOpen(true));
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Try it' }));
    expect(rt.startPracticeTask).toHaveBeenCalledWith();
    for (const f of [rt.submitPrompt, rt.startConsoleCopilot, rt.askDistrict, rt.planDeploy]) expect(f).not.toHaveBeenCalled();
  });
});

describe('the card follows the page and folds when there’s no room', () => {
  /** Gives an element a box (jsdom has no layout). */
  const boxed = (el: Element, top: number, left: number, width: number, height: number) =>
    (el.getBoundingClientRect = () => ({ top, left, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }));

  it('stop 1: the building card’s actions fill the screen, so the card folds to the pill; stop 2 unfolds it', () => {
    const offLocate = bus.on('locate', ({ reply }) => reply({ top: 100, left: 100, width: 80, height: 60 }));
    const { container } = render(
      <>
        <section className="place-do">
          <div className="actions">
            <button>💬 Ask a question</button>
          </div>
        </section>
        <Tour layout="panel" />
      </>,
    );
    boxed(container.querySelector('.place-do .actions')!, 0, 0, window.innerWidth, window.innerHeight - 100);
    act(() => useCity.getState().setTourOpen(true));
    const c = card();
    expect(c.className).toMatch(/\bpill\b/);
    // Still the same dialog: its name, the stop's words for screen readers, Next and End tour, the keys.
    expect(within(c).getByRole('heading').textContent).toBe(TITLES[0]);
    expect(c.textContent).toContain('Quick tour · 1 of 6');
    expect(within(c).getByRole('button', { name: 'End tour' })).toBeTruthy();
    const top = parseFloat(c.style.top);
    expect(top).toBeGreaterThanOrEqual(window.innerHeight - 100);
    fireEvent.keyDown(within(c).getByRole('heading'), { key: 'Enter' });
    expect(within(card()).getByRole('heading').textContent).toBe(TITLES[1]);
    expect(card().className).not.toMatch(/\bpill\b/);
    offLocate();
  });

  it('a stop placed again when the page under it changes (a card opening below the target)', async () => {
    const offLocate = bus.on('locate', ({ reply }) => reply({ top: 100, left: 100, width: 80, height: 60 }));
    const { container } = render(
      <>
        <section className="place-do" />
        <Tour layout="panel" />
      </>,
    );
    act(() => useCity.getState().setTourOpen(true));
    expect(card().className).not.toMatch(/\bpill\b/);
    // The building's card opens with its actions over most of the screen: the tour moves aside on the next frame.
    const actions = document.createElement('div');
    actions.className = 'actions';
    boxed(actions, 0, 0, window.innerWidth, window.innerHeight - 100);
    act(() => void container.querySelector('.place-do')!.append(actions));
    for (let k = 0; k < 2; k++) await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(card().className).toMatch(/\bpill\b/);
    offLocate();
  });

  it('panel stop 5 shows the City tab first when the Copilot switch isn’t there (another tab)', () => {
    const tabs: string[] = [];
    const off = bus.on('showTab', ({ tab }) => tabs.push(tab));
    render(<Tour layout="panel" />);
    act(() => useCity.getState().setTourOpen(true));
    for (let k = 0; k < 4; k++) fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    expect(within(card()).getByRole('heading').textContent).toBe(TITLES[4]);
    expect(tabs).toEqual(['home']);
    off();
  });

  it('not when the switch is already on screen, nor in the tab (its stop 5 points at ⋯)', () => {
    const tabs: string[] = [];
    const off = bus.on('showTab', ({ tab }) => tabs.push(tab));
    const { unmount } = render(
      <>
        <button className="console-btn">Do it in my console</button>
        <Tour layout="panel" />
      </>,
    );
    act(() => useCity.getState().setTourOpen(true));
    for (let k = 0; k < 4; k++) fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    unmount();
    act(() => useCity.getState().setTourOpen(false));
    render(<Tour layout="full" />);
    act(() => useCity.getState().setTourOpen(true));
    for (let k = 0; k < 4; k++) fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    expect(tabs).toEqual([]);
    off();
  });

  it('Try it shows the City tab, where Sally’s steps are', () => {
    const tabs: string[] = [];
    const off = bus.on('showTab', ({ tab }) => tabs.push(tab));
    render(<Tour layout="panel" />);
    act(() => useCity.getState().setTourOpen(true));
    fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    fireEvent.click(within(card()).getByRole('button', { name: 'Try it' }));
    expect(tabs).toEqual(['home']);
    off();
  });
});

// Seen 24 Nov 2026: the tab's stop 5 had no way to the Copilot (no switch in the tab, nothing in ⋯, no button).
describe('the tab’s stop 5 in the demo: the practice console', () => {
  const toStop5 = () => {
    act(() => useCity.getState().setTourOpen(true));
    for (let k = 0; k < 4; k++) fireEvent.click(within(card()).getByRole('button', { name: 'Next' }));
    expect(within(card()).getByRole('heading').textContent).toBe(TITLES[4]);
  };

  it('offers “Try it in the practice console” (graphite), which starts the demo Copilot on a safe sample goal', async () => {
    const stop = quickTourStops('full', 'demo', 'sidepanel')[4];
    expect(stop.practiceConsole).toBe(true);
    expect(stop.targets).toEqual([]);
    expect(stop.body).toBe(FIRST_STEPS.tour.stops[4].demoTab);
    // Safari's tab too: the practice console works from every surface in the demo.
    expect(quickTourStops('full', 'demo', 'tab')[4].practiceConsole).toBe(true);
    expect(quickTourStops('panel', 'demo', 'sidepanel')[4].practiceConsole).toBeUndefined();
    render(<Tour layout="full" />);
    toStop5();
    const c = card();
    const go = within(c).getByRole('button', { name: FIRST_STEPS.tour.consoleTry });
    expect(go.className).not.toMatch(/primary/);
    expect(c.querySelectorAll('.btn.primary')).toHaveLength(0);
    fireEvent.click(go);
    expect(rt.startConsoleCopilot).toHaveBeenCalledWith(FIRST_STEPS.tour.consoleGoal);
    expect(FIRST_STEPS.tour.consoleGoal).toMatch(/^Create a bucket called [a-z0-9-]+$/);
    expect(within(card()).queryByRole('button', { name: FIRST_STEPS.tour.consoleTry })).toBeNull();
    expect(within(card()).getByRole('status').textContent).toBe(FIRST_STEPS.tour.consoleTried);
    // The keys go to Next (never to <body>).
    await act(() => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    expect(document.activeElement?.textContent).toBe('Next');
    for (const f of [rt.submitPrompt, rt.startPracticeTask, rt.planDeploy]) expect(f).not.toHaveBeenCalled();
  });

  it('not in a hosted or local tab, nor in the side panel', () => {
    for (const s of [{ backendKind: 'server', hosted: true }, { backendKind: 'server', hosted: false }]) {
      useCity.setState(s as never);
      const { unmount } = render(<Tour layout="full" />);
      toStop5();
      expect(within(card()).queryByRole('button', { name: FIRST_STEPS.tour.consoleTry })).toBeNull();
      unmount();
      act(() => useCity.getState().setTourOpen(false));
    }
    useCity.setState({ backendKind: 'mock', hosted: false } as never);
    render(<Tour layout="panel" />);
    toStop5();
    expect(within(card()).queryByRole('button', { name: FIRST_STEPS.tour.consoleTry })).toBeNull();
    expect(rt.startConsoleCopilot).not.toHaveBeenCalled();
  });
});

describe('where it starts', () => {
  it('⋯ → How you play → Show the quick tour, any time (in the city, on the City tab)', () => {
    useCity.setState({ view: { name: 'world' } } as never);
    const tabs: string[] = [];
    const off = bus.on('showTab', ({ tab }) => tabs.push(tab));
    render(<Hud layout="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: FIRST_STEPS.menu.tour }));
    expect(useCity.getState().tourOpen).toBe(true);
    expect(useCity.getState().view.name).toBe('city');
    expect(tabs).toEqual(['home']);
    off();
  });

  it('not from ⋯ while the first steps run', () => {
    useCity.setState({ progress: { ...builder, quests: { 'first-steps': { status: 'active', step: 1, count: 0 } } }, prefs: { ...useCity.getState().prefs, firstSteps: 'beginner', builder: undefined } } as never);
    render(<Hud layout="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: FIRST_STEPS.menu.tour })).toBeNull();
  });

  it('“I already know AWS” starts it once the dive has arrived, under automation too', () => {
    vi.useFakeTimers();
    useCity.setState({ view: { name: 'world' } } as never);
    startQuickTourAfterDive();
    expect(useCity.getState().tourOpen).toBe(false);
    act(() => useCity.setState({ view: { name: 'city' } } as never));
    expect(useCity.getState().tourOpen).toBe(false); // the city is still arriving
    act(() => bus.emit('arrived', { region: REGION } as never));
    expect(useCity.getState().tourOpen).toBe(true);
  });

  it('with no arrival moment, opens after the fallback', () => {
    vi.useFakeTimers();
    startQuickTourAfterDive();
    act(() => void vi.advanceTimersByTime(TOUR_FALLBACK_MS + 10));
    expect(useCity.getState().tourOpen).toBe(true);
  });

  it('the world map’s button calls it (src/ui/WorldIntro.tsx)', async () => {
    const src = (await import('node:fs')).readFileSync('src/ui/WorldIntro.tsx', 'utf8');
    expect(src).toMatch(/skipFirstSteps\(\);\s*dive\(\);[\s\S]{0,200}startQuickTourAfterDive\(\);/);
  });
});

describe('the three verify fixes', () => {
  it('a coach tip already up goes when the first steps (or a replay) start, and when the tour opens', () => {
    useCity.setState({ prefs: { ...useCity.getState().prefs } } as never);
    localStorage.setItem('awscity.tourDone', '1');
    const { container } = render(
      <>
        <form className="composer">
          <input aria-label="Ask" />
        </form>
        <CoachTips layout="full" />
      </>,
    );
    // jsdom has no layout: give the box a size so the tip has a target.
    (container.querySelector('.composer') as HTMLElement).getBoundingClientRect = () => ({ top: 500, left: 10, width: 300, height: 40, right: 310, bottom: 540, x: 10, y: 500, toJSON: () => ({}) });
    Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => false });
    fireEvent.focusIn(screen.getByLabelText('Ask'));
    expect(screen.getByRole('dialog', { name: 'Ask for anything' }).textContent).toMatch(/shows you the steps\. The demo plays scripted examples\./);
    expect(readPref(TIP_ASK_KEY)).toBe('1');
    act(() => useCity.getState().playFirstSteps());
    expect(screen.queryByRole('dialog', { name: 'Ask for anything' })).toBeNull();
    delete (navigator as { webdriver?: boolean }).webdriver;
  });

  it('the citizen’s “Right!” names the stars it really added (the card’s review and the thank-you)', () => {
    const p = { ...builder, quests: { 'first-steps': { status: 'active' as const, step: 3, count: 0 } } };
    useCity.setState({ progress: p, prefs: { ...useCity.getState().prefs, firstSteps: 'beginner', builder: undefined } } as never);
    render(<RequestCard />);
    const before = useCity.getState().progress.cities?.[REGION]?.landmarks.s3?.xp ?? 0;
    act(() => bus.emit('citizenRequest', { request: { serviceId: 's3', cardId: 's3-01', question: 'What is a bucket?', options: ['A box for files', 'A server', 'A queue'], right: 0, answer: 'A box for files' }, name: 'Ada' } as never));
    fireEvent.click(screen.getByRole('button', { name: /A box for files/ }));
    const after = useCity.getState().progress.cities?.[REGION]?.landmarks.s3?.xp ?? 0;
    const added = after - before;
    expect(added).toBeGreaterThan(THANKS_STARS);
    expect(document.querySelector('p.request-verdict')?.textContent).toBe(`Right! +${added} ⭐ for S3 Lake.`);
  });

  it('bubbles said behind a celebration card wait for it: the latest per speaker, while still fresh', () => {
    const held = new Map([
      ['lena', { text: 'old', at: 0 }],
      ['sally', { text: 'new', at: 5_000 }],
    ]);
    expect(freshLines(held, HELD_LINE_FRESH_MS + 1_000).map(([k]) => k)).toEqual(['sally']);
    expect(freshLines(held, 6_000).map(([k]) => k)).toEqual(['lena', 'sally']);
  });
});
