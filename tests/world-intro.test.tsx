// @vitest-environment jsdom
// The first screen's two buttons (src/ui/WorldIntro.tsx): "I already build on AWS" is the whole game (Simple off, so
// Deploy and ⋯ → Account are there: Marcus), and after either one focus lands in the city's panel, never on <body>
// (Lena: the button went with the intro and NVDA was left at the top of the page).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { WorldIntro } = await import('@/ui/WorldIntro');
const { isSimple, shows } = await import('@/state/simple');

function Page() {
  return (
    <>
      <WorldIntro />
      <div id="city-tabpanel" role="tabpanel" tabIndex={0} aria-label="City" />
    </>
  );
}

beforeEach(() => {
  localStorage.clear();
  useCity.setState({ view: { name: 'world' }, prefs: {} } as never);
});
afterEach(cleanup);

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
