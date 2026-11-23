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
  it('“I already build on AWS” turns Simple off: the Deploy tab is there without a deploy step', async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'I already build on AWS' }));
    const prefs = useCity.getState().prefs;
    expect(prefs.builder).toBe(true);
    expect(isSimple(prefs)).toBe(false);
    expect(shows('deployTab', prefs)).toBe(true);
    expect(useCity.getState().view.name).toBe('city');
    await frame();
  });

  it('“Start in …” keeps Simple on', async () => {
    render(<Page />);
    fireEvent.click(screen.getByRole('button', { name: /^Start in / }));
    expect(isSimple(useCity.getState().prefs)).toBe(true);
    await frame();
  });

  for (const name of [/^Start in /, /^I already build on AWS$/]) {
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
