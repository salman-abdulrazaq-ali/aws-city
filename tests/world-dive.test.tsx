// @vitest-environment jsdom
// Batch B5: the world map's text follows Text size (never under 11 px), its chrome wears the desk's tokens, the first
// run's "Start in <city>" dives like a picked dot (src/game/worldUi.ts), and the minimap's box waits for the city.
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { bus } = await import('@/state/bus');
const { REGIONS } = await import('@/world/culture');
const { requestDive, setDiver, worldText } = await import('@/game/worldUi');
const { WorldIntro } = await import('@/ui/WorldIntro');
const { Minimap } = await import('@/ui/Minimap');

const frame = () => act(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

beforeEach(() => {
  localStorage.clear();
  useCity.setState({ view: { name: 'world' }, prefs: {} } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the world map’s text', () => {
  it('is never under 11 px and grows with Text size', () => {
    for (const scale of [1, 1.25, 1.5]) for (const px of Object.values(worldText(scale))) expect(px).toBeGreaterThanOrEqual(11);
    expect(worldText(1)).toEqual({ title: 14, body: 11, city: 11, link: 11 });
    expect(worldText(1.5)).toEqual({ title: 21, body: 17, city: 17, link: 17 });
  });

  it('WorldScene draws no retired purple chrome and no fixed sub-11 px text', () => {
    const src = readFileSync('src/game/scenes/WorldScene.ts', 'utf8');
    expect(src).not.toMatch(/#140d1f|#0d0816|#241a37|#4a3768|#fffbeb/i);
    expect(src).not.toMatch(/fontSize: '(?:[0-9]|10)px'/);
    expect(src).toMatch(/worldText\(textScale\(\)\)/);
  });
});

describe('the first run’s dive', () => {
  it('requestDive goes to the registered world map, and to nobody once it has gone', () => {
    const asked: string[] = [];
    const off = setDiver((code) => (asked.push(code), true));
    expect(requestDive('eu-west-2')).toBe(true);
    off();
    expect(requestDive('eu-west-2')).toBe(false);
    expect(asked).toEqual(['eu-west-2']);
    // An older scene's teardown doesn't unregister a newer one.
    const offOld = setDiver(() => true);
    const offNew = setDiver(() => true);
    offOld();
    expect(requestDive('us-east-1')).toBe(true);
    offNew();
  });

  it('“Start in …” dives: the card steps aside at once, the Region opens when the dive ends, focus lands in the panel', async () => {
    const asked: string[] = [];
    const off = setDiver((code) => (asked.push(code), true));
    render(
      <>
        <WorldIntro />
        <div id="city-tabpanel" role="tabpanel" tabIndex={0} aria-label="City" />
      </>,
    );
    const button = screen.getByRole('button', { name: /^Start in / });
    button.focus();
    fireEvent.click(button);
    expect(asked).toEqual([REGIONS.cityRegion]);
    // Still on the world map (the dive runs), the card out of sight and out of reach, keeping its place.
    expect(useCity.getState().view.name).toBe('world');
    expect(screen.queryByRole('region', { name: 'Where to start' })).toBeNull();
    const card = document.querySelector('.world-intro') as HTMLElement;
    expect(card.style.visibility).toBe('hidden');
    expect(card.hasAttribute('inert')).toBe(true);
    await frame();
    expect(document.activeElement?.id).toBe('city-tabpanel');
    // The dive ends (WorldScene enters the Region): the card goes, and focus stays in the panel.
    act(() => useCity.getState().enterRegion(REGIONS.cityRegion));
    await frame();
    expect(document.querySelector('.world-intro')).toBeNull();
    expect(document.activeElement?.id).toBe('city-tabpanel');
    off();
  });
});

describe('the minimap', () => {
  it('shows its box only once the city answers (no empty box while a city is built)', () => {
    vi.useFakeTimers();
    useCity.setState({ view: { name: 'city' }, prefs: { minimap: true } } as never);
    render(<Minimap layout="full" />);
    expect(screen.getByRole('button', { name: /minimap/ })).toBeTruthy();
    expect(document.querySelector('.minimap')).toBeNull();
    const off = bus.on('minimapState', ({ reply }) => reply({ plan: { city: 'Portland' }, view: { x: 0, y: 0, w: 1, h: 1 } } as never));
    act(() => void vi.advanceTimersByTime(250));
    expect(document.querySelector('.minimap canvas')).not.toBeNull();
    off();
  });
});
