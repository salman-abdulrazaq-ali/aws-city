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
const { Tour, CoachTips, quickTourStops, placeCard, tourBuilding, TOUR_FALLBACK_MS, startQuickTourAfterDive } = await import('@/ui/Tour');
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
  'Every change waits for your OK',
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
    expect(quickTourStops('panel', 'hosted', 'sidepanel')[2].body).toMatch(/role you install; every write needs your OK and your authenticator/);
    expect(quickTourStops('panel', 'local', 'sidepanel')[2].body).not.toMatch(/practice account|authenticator/);
    // The tab has no Copilot switch: stop 5 points at ⋯ and says where the helpers work.
    const tab = quickTourStops('full', 'demo', 'sidepanel');
    expect(tab[4].targets).toEqual(['.more > [aria-haspopup="menu"]']);
    expect(tab[4].body).toMatch(/browser's side panel, next to the AWS Console/);
    expect(quickTourStops('full', 'demo', 'sidebar')[4].body).toMatch(/browser's sidebar/);
    expect(quickTourStops('full', 'demo', 'tab')[4].body).toMatch(/^Safari has no side panel/);
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

describe('the card stands beside its target, never over it', () => {
  const view = { w: 400, h: 860 };
  const box = { w: 376, h: 190 };
  const overlaps = (p: { top: number; left: number }, t: { top: number; left: number; width: number; height: number }) =>
    p.left < t.left + t.width && p.left + box.w > t.left && p.top < t.top + t.height && p.top + box.h > t.top;
  it('below a tab, above the box at the bottom, beside a building on the map, at the bottom with no target', () => {
    const tabs = { top: 300, left: 200, width: 90, height: 36 };
    const composer = { top: 790, left: 10, width: 380, height: 50 };
    const lake = { top: 120, left: 150, width: 90, height: 80 };
    for (const t of [tabs, composer, lake]) {
      const p = placeCard(t, box, view);
      expect(overlaps(p, t)).toBe(false);
      expect(p.top).toBeGreaterThanOrEqual(12);
      expect(p.top + box.h).toBeLessThanOrEqual(view.h - 12);
    }
    expect(placeCard(tabs, box, view).top).toBe(tabs.top + tabs.height + 10);
    expect(placeCard(composer, box, view).top).toBe(composer.top - 10 - box.h);
    // The tab: a tall target on a wide map, no room below or above: to its side.
    const low = { top: 60, left: 400, width: 120, height: 800 };
    const wide = placeCard(low, { w: 320, h: 200 }, { w: 1400, h: 880 });
    expect(wide.left).toBe(low.left + low.width + 10);
    expect(placeCard(undefined, box, view).top).toBe(view.h - box.h - 12);
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
    expect(screen.getByRole('dialog', { name: 'Ask for anything' })).toBeTruthy();
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
