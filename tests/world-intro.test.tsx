// @vitest-environment jsdom
// The first screen's two buttons (src/ui/WorldIntro.tsx): "I already build on AWS" is the whole game (Simple off, so
// Deploy and ⋯ → Account are there: Marcus), and after either one focus lands in the city's panel, never on <body>
// (Lena: the button went with the intro and NVDA was left at the top of the page). The card waits for the world map
// (B9b: not over the boot bar, where a press had no dots to dive from).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { WorldIntro } = await import('@/ui/WorldIntro');
const { isSimple, shows } = await import('@/state/simple');
const { setDiver } = await import('@/game/worldUi');

function Page() {
  return (
    <>
      <WorldIntro />
      <div id="city-tabpanel" role="tabpanel" tabIndex={0} aria-label="City" />
    </>
  );
}

/** The world map is drawn. Its dive here is a cut, as under reduced motion: the Region opens within the press. */
let offMap: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear();
  useCity.setState({ view: { name: 'world' }, prefs: {} } as never);
  offMap = setDiver((code) => (useCity.getState().enterRegion(code), true));
});
afterEach(() => {
  offMap?.();
  cleanup();
});

const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

describe('WorldIntro', () => {
  it('“I already know AWS” turns Simple off and skips the first steps: the Deploy tab is there without a deploy step', async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'I already know AWS: quick tour' }));
    const prefs = useCity.getState().prefs;
    expect(prefs.builder).toBe(true);
    expect(prefs.firstSteps).toBe('skipped');
    expect(isSimple(prefs)).toBe(false);
    expect(shows('deployTab', prefs)).toBe(true);
    expect(useCity.getState().view.name).toBe('city');
    // The skip is in the synced save too (finished at step 0, unpaid), so news, City care and quest 2 know it on any device.
    expect(useCity.getState().progress.quests?.['first-steps']).toEqual({ status: 'done', step: 0 });
    await frame();
  });

  it('“Start in …” keeps Simple on and starts the first steps on arrival', async () => {
    useCity.setState({ progress: { version: 2, landmarks: {}, updatedAt: '' } } as never);
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: /^Start in / }));
    expect(isSimple(useCity.getState().prefs)).toBe(true);
    expect(useCity.getState().prefs.firstSteps).toBe('beginner');
    expect(useCity.getState().progress.quests?.['first-steps']?.status).toBe('active');
    await frame();
  });

  // DESIGN-tutorial §3: Connie defines a Region (a tappable term) and says it's practice; a dot picked on the map starts
  // the first steps too, so the card's showing chooses them (WorldScene's own press calls enterRegion).
  it('defines a Region, says it’s all practice, and chooses the first steps for a dot picked on the map', () => {
    render(<Page />);
    const card = screen.getByRole('region', { name: 'Where to start' });
    expect(card.textContent).toMatch(/Each glowing dot is a Region/);
    expect(card.querySelector('.term')?.textContent).toBe('Region');
    expect(card.textContent).toMatch(/about 10 minutes\. It's all practice: nothing costs money\./);
    expect(useCity.getState().prefs.firstSteps).toBe('beginner');
  });

  it('keeps an opt-out already set (the smoke’s), even on Start', async () => {
    useCity.setState({ prefs: { firstSteps: 'skipped' } } as never);
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: /^Start in / }));
    expect(useCity.getState().prefs.firstSteps).toBe('skipped');
    await frame();
  });

  // Seen 24 Nov 2026: the quick tour's choice read as a dim link. It's a graphite secondary button; the amber is the start's.
  it('“I already know AWS: quick tour” is a secondary button, never a ghost link; “Start in …” keeps the amber', () => {
    render(<Page />);
    const tour = screen.getByRole('button', { name: 'I already know AWS: quick tour' });
    expect(tour.className.split(' ')).toEqual(['btn']);
    expect(screen.getByRole('button', { name: /^Start in / }).className).toMatch(/\bprimary\b/);
    expect(screen.getByRole('region', { name: 'Where to start' }).querySelectorAll('.btn.primary')).toHaveLength(1);
  });

  for (const name of [/^Start in /, /^I already know AWS: quick tour$/]) {
    it(`focus lands in the city's panel after ${name}`, async () => {
      render(<Page />);
      const button = screen.getByRole('button', { name });
      button.focus();
      fireEvent.click(button);
      // The intro is gone with its button.
      expect(screen.queryByRole('region', { name: 'Where to start' })).toBeNull();
      await frame();
      expect(document.activeElement?.id).toBe('city-tabpanel');
    });
  }

  // Review 23 Nov 2026: the tour says "Walk with the arrow keys"; the canvas the city gave the keys to keeps them.
  it('leaves focus on the city canvas when the city scene took the keys', async () => {
    const canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    document.body.append(canvas);
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: /^Start in / }));
    canvas.focus(); // createGame's focusSoon
    await frame();
    expect(document.activeElement).toBe(canvas);
    canvas.remove();
  });

  it('waits for the world map: the boot bar stands alone, then the card comes without taking focus', () => {
    offMap?.();
    render(<Page />);
    expect(screen.queryByRole('region', { name: 'Where to start' })).toBeNull();
    const panel = document.getElementById('city-tabpanel')!;
    panel.focus();
    // WorldScene's first draw registers its dive.
    act(() => void (offMap = setDiver(() => true)));
    expect(screen.getByRole('region', { name: 'Where to start' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Start in / })).toBeTruthy();
    expect(document.activeElement).toBe(panel);
    // The map goes (the scene shut down) before a press: the card goes with it.
    act(() => offMap?.());
    expect(screen.queryByRole('region', { name: 'Where to start' })).toBeNull();
  });

  it('a press right as the map goes still opens the Region (no map left to dive from)', async () => {
    render(<Page />);
    const button = screen.getByRole('button', { name: /^Start in / });
    offMap?.(); // gone without a render in between
    fireEvent.click(button);
    expect(useCity.getState().view.name).toBe('city');
    await frame();
  });

  it('leaves focus alone when the player already moved it', async () => {
    render(
      <>
        <Page />
        <button>Elsewhere</button>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Start in / }));
    screen.getByRole('button', { name: 'Elsewhere' }).focus();
    await frame();
    expect(document.activeElement?.textContent).toBe('Elsewhere');
  });
});
