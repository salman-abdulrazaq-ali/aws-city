// @vitest-environment jsdom
// Persona fixes (Lena, Tom, Jay, Dana; 22 Nov 2026): focus never falls to <body> (a button that went away, a dialog
// opened from ⋯), "Walk to" opens the building's card when Kai gets there, the demo says where its data goes, the ⋯
// "I already build on AWS" switch turns Everything on like the world intro's, and Decorate's HUD button has its name.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));
const privacy = vi.hoisted(() => ({ url: undefined as string | undefined, open: vi.fn() }));
vi.mock('@/app/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/runtime')>()),
  privacyPolicyUrl: () => privacy.url,
  openPrivacyPolicy: privacy.open,
}));

const { useCity, emptyProgress } = await import('@/state/store');
const { bus } = await import('@/state/bus');
const { Hud, DEMO_PRIVACY_LINE } = await import('@/ui/Hud');
const { Collection } = await import('@/ui/Collection');
const { BuildToggle } = await import('@/ui/BuildDrawer');
const { useKeepFocus } = await import('@/ui/useDialog');
const { walkTo, cardWaitsForKai } = await import('@/state/walk');
const { QUESTS } = await import('@/world/content');

const REGION = 'us-west-2';
beforeEach(() => {
  localStorage.clear();
  privacy.url = undefined;
  privacy.open.mockClear();
  useCity.setState({ cityRegion: REGION, view: { name: 'city' }, backendKind: 'mock', hosted: false, collectionOpen: false, progress: emptyProgress(), prefs: { chatter: false, stage: 'compact', region: REGION } } as never);
});
afterEach(() => cleanup());

const more = () => screen.getByRole('button', { name: 'More' });
const flush = () => act(async () => {});

/** A side panel whose row button goes away when pressed (a To-do row ticked), and a panel with a heading. */
function Panel() {
  const side = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [done, setDone] = useState(false);
  useKeepFocus(side, () => body.current);
  return (
    <>
      <button>the city</button>
      <aside ref={side}>
        <div ref={body} role="tabpanel" tabIndex={0} aria-label="City">
          <h3>To do</h3>
          {!done && <button onClick={() => setDone(true)}>Start: Your First Bucket</button>}
        </div>
      </aside>
    </>
  );
}

describe('focus is never lost to <body>', () => {
  it('a button that goes away with its row leaves focus on the panel’s heading', async () => {
    render(<Panel />);
    const start = screen.getByRole('button', { name: 'Start: Your First Bucket' });
    start.focus();
    fireEvent.click(start);
    await flush();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'To do' }));
  });

  it('leaves focus alone when the player had moved on (a press outside the panel)', async () => {
    render(<Panel />);
    const start = screen.getByRole('button', { name: 'Start: Your First Bucket' });
    start.focus();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'the city' }));
    act(() => start.blur());
    fireEvent.click(start);
    await flush();
    expect(document.activeElement).toBe(document.body);
  });

  it('closing My City opened from ⋯ puts focus back on ⋯', async () => {
    render(
      <>
        <Hud layout="full" />
        <Collection />
      </>,
    );
    fireEvent.click(more());
    const item = screen.getByRole('menuitem', { name: /My City/ });
    item.focus();
    fireEvent.click(item);
    await flush();
    expect(useCity.getState().collectionOpen).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await flush();
    expect(useCity.getState().collectionOpen).toBe(false);
    expect(document.activeElement).toBe(more());
  });
});

describe('“Walk to” opens the card when Kai gets there', () => {
  const quest = QUESTS.find((q) => q.steps[0]?.kind === 'visit')!;
  const target = (quest.steps[0] as { serviceId: string }).serviceId;
  const startQuest = () => useCity.setState({ progress: { ...emptyProgress(), quests: { [quest.id]: { status: 'active', step: 0 } } } } as never);
  const stepNow = () => useCity.getState().progress.quests?.[quest.id]?.step;

  it('the press’s select waits, and the card’s select comes as the visit counts', () => {
    startQuest();
    const selects: { id: string; waits: boolean }[] = [];
    let arrive = () => {};
    const offs = [
      // The city, as CityScene does: it takes the walk, selects at once, and counts the visit when Kai arrives.
      bus.on('walkTo', ({ id, accept }) => {
        accept();
        bus.emit('select', { id });
        arrive = () => useCity.getState().arrive(id);
      }),
      bus.on('select', ({ id }) => selects.push({ id, waits: cardWaitsForKai(id) })),
    ];
    walkTo(target);
    expect(selects).toEqual([{ id: target, waits: true }]);
    expect(stepNow()).toBe(0);
    arrive();
    expect(stepNow()).toBe(1);
    expect(selects).toEqual([
      { id: target, waits: true },
      { id: target, waits: false },
    ]);
    offs.forEach((off) => off());
  });

  it('a city that can’t walk him counts the visit at once', () => {
    startQuest();
    walkTo(target);
    expect(stepNow()).toBe(1);
    expect(useCity.getState().selected).toBe(target);
  });

  it('a walk with no visit to count opens the card at once, as a tap does', () => {
    const seen: boolean[] = [];
    const offs = [bus.on('walkTo', ({ id, accept }) => (accept(), bus.emit('select', { id }))), bus.on('select', ({ id }) => seen.push(cardWaitsForKai(id)))];
    walkTo(target);
    expect(seen).toEqual([false]);
    offs.forEach((off) => off());
  });
});

describe('⋯ in the demo', () => {
  it('says the demo keeps progress on this device and sends nothing, as an item the arrows reach', () => {
    render(<Hud layout="full" />);
    fireEvent.click(more());
    const note = screen.getByRole('menuitem', { name: DEMO_PRIVACY_LINE });
    expect(note.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('menuitem', { name: /Privacy policy/ })).toBeNull();
  });

  it('links the privacy policy when the build has one', () => {
    privacy.url = 'https://example.org/privacy';
    render(<Hud layout="full" />);
    fireEvent.click(more());
    fireEvent.click(screen.getByRole('menuitem', { name: /Privacy policy/ }));
    expect(privacy.open).toHaveBeenCalledOnce();
  });

  it('a build with a server shows no demo line', () => {
    useCity.setState({ backendKind: 'aws' } as never);
    render(<Hud layout="full" />);
    fireEvent.click(more());
    expect(screen.queryByRole('menuitem', { name: DEMO_PRIVACY_LINE })).toBeNull();
  });
});

describe('⋯ → I already build on AWS', () => {
  it('turns Everything on, as the world intro’s button does; off, it leaves Simple as it is', () => {
    render(<Hud layout="full" />);
    fireEvent.click(more());
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /I already build on AWS/ }));
    expect(useCity.getState().prefs.builder).toBe(true);
    expect(useCity.getState().prefs.simple).toBe(false);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: /I already build on AWS/ }));
    expect(useCity.getState().prefs.builder).toBeUndefined();
    expect(useCity.getState().prefs.simple).toBe(false);
  });
});

describe('Decorate in the HUD', () => {
  it('is named Decorate even where the panel hides the word', () => {
    render(<BuildToggle />);
    expect(screen.getByRole('button', { name: 'Decorate' })).toBeTruthy();
  });
});
