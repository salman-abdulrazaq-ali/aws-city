// @vitest-environment jsdom
// Room in the 400 px side panel and one thing over its short map at a time (the Impeccable pass, 23 Nov 2026): the
// Copilot switch stands where it's useful, the AI note folds into the composer (still the box's description), the coins
// note and the news ticker step aside for a toast, the ⋯ menu is labelled groups with Decorate as a plain action, the
// HUD's City Lights count is a 24 px target with its words, and Connie's first card docks under the panel's map.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { PromptBar } = await import('@/ui/PromptBar');
const { AI_NOTE } = await import('@/ui/AiNote');
const { Hud, COINS_TIP_MS, SHORT_MAP_PX } = await import('@/ui/Hud');
const { NewsTicker } = await import('@/ui/NewsTicker');
const { WorldIntro } = await import('@/ui/WorldIntro');
const { setDiver } = await import('@/game/worldUi');

const news = { type: 'aws.news', items: [{ id: 'n1', title: 'Amazon S3 adds a thing', url: 'https://aws.amazon.com/about-aws/whats-new/x', date: new Date().toISOString(), serviceIds: ['s3'] }] };
const toast = { id: 1, icon: '🧩', text: 'Combo found', kind: 'info', ms: 4000 };

beforeEach(() => {
  localStorage.clear();
  useCity.setState({ cityRegion: 'us-west-2', view: { name: 'city' }, backendKind: 'mock', hosted: false, toasts: [], focus: undefined, build: undefined, prefs: { chatter: false, stage: 'compact', region: 'us-west-2', simple: false } } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the prompt bar in the side panel', () => {
  const describedBy = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent;

  it('offers the Copilot switch where it’s useful: the City tab, a console page beside it, or while it’s on', () => {
    const { unmount } = render(<PromptBar layout="panel" consoleHere={false} />);
    expect(screen.queryByRole('switch')).toBeNull();
    unmount();
    useCity.setState({ focus: { kind: 'console', url: 'https://us-west-2.console.aws.amazon.com/s3/home' } } as never);
    render(<PromptBar layout="panel" consoleHere={false} />);
    expect(screen.getByRole('switch', { name: /Do it in my console/ })).toBeTruthy();
  });

  it('folds the AI note into the composer: above the box, and still what the box says to a screen reader', () => {
    const { container } = render(<PromptBar layout="panel" consoleHere={false} />);
    const box = screen.getByRole('textbox', { name: 'Ask the city' });
    expect(describedBy(box)).toBe(AI_NOTE);
    const bar = container.querySelector('.prompt-bar')!;
    const note = bar.querySelector('.ai-note')!;
    expect(note.compareDocumentPosition(bar.querySelector('form')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The stylesheet shows it while the box has focus or words in it (visually hidden otherwise, never display: none).
    const css = readFileSync('src/app/styles/08-chat.css', 'utf8');
    expect(css).toMatch(/\.prompt-bar:not\(:focus-within\):not\(:has\(\.composer input:not\(:placeholder-shown\)\)\) \.ai-note \{[^}]*clip-path: inset\(50%\)/);
    expect(css).toMatch(/\.ai-note \{[^}]*font-size: var\(--fs-xs\)/);
  });
});

describe('one thing over the short map at a time', () => {
  it('the coins note steps aside while a toast shows, comes back after, and is read after a while on screen', () => {
    vi.useFakeTimers();
    const p = useCity.getState().progress;
    useCity.setState({ progress: { ...p, wallet: { earned: 20, spent: 0 } } } as never);
    render(<Hud layout="panel" />);
    expect(screen.getByRole('note').textContent).toMatch(/You've earned 20 City Coins: spend them in 🌳 Decorate\./);
    act(() => useCity.setState({ toasts: [toast] } as never));
    expect(screen.queryByRole('note')).toBeNull();
    act(() => useCity.setState({ toasts: [] } as never));
    expect(screen.getByRole('note')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(COINS_TIP_MS));
    expect(screen.queryByRole('note')).toBeNull();
    expect(localStorage.getItem('awscity.tip.coins')).toBe('1');
  });

  // B9b (finding #10): the ticker plus a three-line note under it covered a third of the panel's ~250 px map.
  it('on a short map the coins note is one line in the ticker’s place; the ticker steps aside and comes back after', () => {
    const map = (height: number) => ({ x: 8, y: 48, top: 48, left: 8, width: 384, height, right: 392, bottom: 48 + height, toJSON: () => ({}) }) as DOMRect;
    let height = 290;
    const zero = map(0);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.classList.contains('stage') ? map(height) : zero;
    });
    const p = useCity.getState().progress;
    useCity.setState({ news, progress: { ...p, wallet: { earned: 20, spent: 0 } } } as never);
    const Page = () => (
      <>
        <Hud layout="panel" />
        <div className="stage">
          <NewsTicker layout="panel" />
        </div>
      </>
    );
    const { container, unmount } = render(<Page />);
    const note = screen.getByRole('note');
    expect(note.classList.contains('hud-tip-line')).toBe(true);
    // At the map's top-left, where the ticker's line stands (--s-3 in), under the coin counter.
    expect([note.style.position, note.style.top, note.style.left]).toEqual(['fixed', '54px', '14px']);
    expect(note.textContent).toMatch(/You've earned 20 City Coins: spend them in 🌳 Decorate\./); // the line hides the extra words in CSS
    expect(container.querySelector('.ticker')).toBeNull();
    // A toast takes the top edge from both, then the note has its line back.
    act(() => useCity.setState({ toasts: [toast] } as never));
    expect(screen.queryByRole('note')).toBeNull();
    expect(container.querySelector('.ticker')).toBeNull();
    act(() => useCity.setState({ toasts: [] } as never));
    expect(screen.getByRole('note')).toBeTruthy();
    expect(container.querySelector('.ticker')).toBeNull();
    // Read: the ticker is back on its line.
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(screen.queryByRole('note')).toBeNull();
    expect(container.querySelector('.ticker')).toBeTruthy();
    unmount();
    // The tab's tall map has room for both: the note hangs under the ticker as before.
    localStorage.clear();
    height = SHORT_MAP_PX + 340;
    const tall = render(<Page />);
    expect(screen.getByRole('note').classList.contains('hud-tip-line')).toBe(false);
    expect(tall.container.querySelector('.ticker')).toBeTruthy();
    vi.restoreAllMocks();
  });

  // Seen in B9b's shots: pressing Got it over the map also picked the building under it (Phaser hears presses on the window).
  it('presses on the note and the ticker stay off the map (Phaser’s window listeners never hear them)', () => {
    const p = useCity.getState().progress;
    useCity.setState({ news, progress: { ...p, wallet: { earned: 20, spent: 0 } } } as never);
    const heard: string[] = [];
    const hear = (e: Event) => heard.push(e.type);
    for (const t of ['mousedown', 'mouseup', 'touchstart', 'touchend']) window.addEventListener(t, hear);
    render(
      <>
        <Hud layout="panel" />
        <div className="stage">
          <NewsTicker layout="panel" />
        </div>
      </>,
    );
    // (jsdom lays nothing out, so the note keeps itself hidden on a 0 px map: found by its class.)
    for (const el of [document.querySelector('.hud-tip .btn')!, screen.getByRole('button', { name: /AWS news/ })]) {
      fireEvent.mouseDown(el);
      fireEvent.mouseUp(el);
      fireEvent.touchStart(el);
      fireEvent.touchEnd(el);
    }
    for (const t of ['mousedown', 'mouseup', 'touchstart', 'touchend']) window.removeEventListener(t, hear);
    expect(heard).toEqual([]);
  });

  it('the line keeps “Got it” a 24 px target and the ticker is one compact line in a narrow window', () => {
    const hud = readFileSync('src/app/styles/02-hud.css', 'utf8');
    expect(hud).toMatch(/\.hud-tip-line \.tip-more \{\s*display: none;/);
    expect(hud).toMatch(/\.hud-tip-line \.btn\.tiny \{\s*min-height: 24px;/);
    const status = readFileSync('src/app/styles/21-status-and-cards.css', 'utf8');
    expect(status).toMatch(/@media \(max-width: 719px\) \{\s*\.ticker-line \{\s*min-height: 24px;/);
  });

  it('in the panel the news ticker gives a toast its place; in the tab it stays', () => {
    useCity.setState({ news } as never);
    const { container, unmount } = render(<NewsTicker layout="panel" />);
    expect(container.querySelector('.ticker')).toBeTruthy();
    act(() => useCity.setState({ toasts: [toast] } as never));
    expect(container.querySelector('.ticker')).toBeNull();
    unmount();
    const tab = render(<NewsTicker layout="full" />);
    expect(tab.container.querySelector('.ticker')).toBeTruthy();
  });
});

describe('the ⋯ menu', () => {
  it('is labelled groups, and Decorate is a plain action that opens and closes the drawer', () => {
    render(<Hud layout="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    for (const name of ['Sound and view', 'Accessibility', 'How you play', 'Your city']) expect(screen.getByRole('group', { name })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'How you play' }).textContent).toMatch(/Keep it simple.*I already build on AWS/);
    expect(screen.getByRole('group', { name: 'Accessibility' }).textContent).not.toMatch(/I already build on AWS|Keep it simple/);
    const decorate = screen.getByRole('menuitem', { name: '🌳 Decorate' });
    expect(decorate.querySelector('.switch')).toBeNull();
    fireEvent.click(decorate);
    expect(useCity.getState().build).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '🌳 Done decorating' }));
    expect(useCity.getState().build).toBeUndefined();
  });
});

describe('the HUD', () => {
  it('City Lights is a 24 px target that says its count in words where there’s room, and the panel keeps Decorate’s word', () => {
    const { container } = render(<Hud layout="full" />);
    expect(container.querySelector('.hud-lights .hud-lights-word')?.textContent).toMatch(/windows? lit$/);
    const css = readFileSync('src/app/styles/02-hud.css', 'utf8');
    expect(css).toMatch(/\.hud \.progress-readout \.hud-lights \{[^}]*min-height: 24px/);
    expect(css).toMatch(/\.app-panel \.hud \.build-toggle \.build-word \{\s*display: inline;/);
  });
});

describe('the first screen', () => {
  it('docks Connie’s card under the side panel’s map (not over the dots); the tab keeps it on the map', () => {
    useCity.setState({ view: { name: 'world' }, prefs: {} } as never);
    const offMap = setDiver(() => true); // the world map is drawn (the card waits for it)
    const { container, unmount } = render(<WorldIntro docked />);
    expect(container.querySelector('.world-intro.docked')).toBeTruthy();
    unmount();
    const tab = render(<WorldIntro />);
    expect(tab.container.querySelector('.world-intro:not(.docked)')).toBeTruthy();
    const app = readFileSync('src/app/App.tsx', 'utf8');
    expect(app).toMatch(/layout === 'full' && <WorldIntro \/>/);
    expect(app).toMatch(/layout === 'panel' && <WorldIntro docked \/>/);
    offMap();
  });
});

// perf.md plan B: city.html under ~420 px gave the map 2 px beside the 400 px panel (its canvas 0 wide, which Chromium
// then draws once a second). jsdom can't lay a grid out, so this reads the rule: under 720 px the tab stacks like the panel.
describe('the tab in a narrow window', () => {
  it('stacks the map above the panel instead of squeezing it to nothing', () => {
    const css = readFileSync('src/app/styles/01-layout.css', 'utf8');
    const narrow = css.slice(css.indexOf('@media (max-width: 719px)'));
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow).toMatch(/\.app-full \{[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*grid-template-rows: auto minmax\(220px, 45%\) minmax\(0, 1fr\);[^}]*grid-template-areas: 'hud' 'stage' 'side';/);
    expect(narrow).toMatch(/\.app-full\.view-game \.side \{\s*display: none;/);
  });

  it('beside the map, the side column narrows to 320 px before the map is squeezed, and grows a little past 2000 px', () => {
    // Adapt pass (23 Nov 2026): the column kept 400 px down to 720, so a 760 px window's map was 342 px.
    const css = readFileSync('src/app/styles/01-layout.css', 'utf8');
    const m = css.match(/--side-w: max\(clamp\((\d+)px, (\d+)px \+ (\d+)vw, (\d+)px\), min\((\d+)vw, (\d+)px\)\);/);
    expect(m).toBeTruthy();
    const [lo, base, slope, hi, wide, cap] = m!.slice(1).map(Number);
    const side = (w: number) => Math.max(Math.min(Math.max(lo, base + (slope * w) / 100), hi), Math.min((wide * w) / 100, cap));
    // The stage's margins and border take 18 px.
    const mapW = (w: number) => w - side(w) - 18;
    expect(side(720)).toBe(320);
    expect(mapW(720)).toBeGreaterThanOrEqual(382);
    expect(mapW(760)).toBe(422);
    for (const w of [1280, 1366, 1536, 1920]) expect(side(w), `${w}`).toBe(400);
    expect(side(2560)).toBe(480);
    for (let w = 720; w <= 3840; w += 10) expect(mapW(w)).toBeGreaterThanOrEqual(mapW(w - 10));
    expect(css).toMatch(/\.app-full \{[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--side-w\);/);
  });
});
