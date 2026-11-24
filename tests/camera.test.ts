import { describe, expect, it } from 'vitest';
import { buildingFocusY, CORE, fitZoom, frameTarget, START_VIEW, viewZoom, zoomOnResize } from '@/game/camera';
import { CITY_ISO, toScreen } from '@/game/iso';
import { GRID, TOWN_SQUARE } from '@/world/layout';
import { legacyPlan } from '@/world/plan';
import { somePlans } from './support/plans';

describe('camera framing', () => {
  it('the core is the 40-tile diamond (~1280×640 at zoom 1) plus a little room', () => {
    expect(CORE.w).toBeGreaterThanOrEqual(2 * GRID * CITY_ISO.halfW);
    expect(CORE.h).toBeGreaterThanOrEqual(2 * GRID * CITY_ISO.halfH);
    expect(CORE.w).toBeLessThan(1300);
    expect(CORE.h).toBeLessThan(700);
  });

  it('the side panel (400×560) gets zoom 1 on the Town Square', () => {
    const f = frameTarget(400, 560);
    expect(f.zoom).toBe(1);
    expect(f.target).toBe('square');
    const r = TOWN_SQUARE.rect;
    expect({ x: f.x, y: f.y }).toEqual(toScreen(CITY_ISO, r.x + (r.w - 1) / 2, r.y + (r.h - 1) / 2));
  });

  it('a laptop tab (1400×880) shows the whole core at zoom 1', () => {
    expect(frameTarget(1400, 880)).toMatchObject({ zoom: 1, target: 'core' });
  });

  it('a big map (2600×1400) starts at zoom 3 on the Town Square: as much city as a laptop shows, bigger', () => {
    // Before (adapt pass, 23 Nov 2026) it got zoom 2 on the whole core: the starting zoom now follows the map's size.
    expect(frameTarget(2600, 1400)).toMatchObject({ zoom: 3, target: 'square' });
  });

  it('zoom is always a whole number in [1, 4]', () => {
    for (const [w, h] of [[300, 200], [1300, 700], [5200, 2800], [20000, 20000]]) {
      const z = frameTarget(w, h).zoom;
      expect(Number.isInteger(z)).toBe(true);
      expect(z).toBeGreaterThanOrEqual(1);
      expect(z).toBeLessThanOrEqual(4);
    }
    expect(fitZoom(20000, 20000)).toBe(4);
    expect(fitZoom(300, 200)).toBe(0);
  });
});

// The map sizes city.html measured (adapt pass, 23 Nov 2026): the canvas beside the side column, CSS px.
const MAPS: Record<string, readonly [number, number]> = {
  panel: [384, 290],
  w760: [422, 732],
  w1024: [661, 700],
  w1280: [862, 654],
  w1366: [948, 700],
  w1536: [1118, 798],
  fhd: [1502, 1014],
  fhdChrome: [1502, 880],
  qhd: [2062, 1232],
};

describe('the starting zoom follows the map’s size (viewZoom)', () => {
  it('a 1920×1080 window’s map starts at zoom 2, with or without the browser’s bars', () => {
    expect(viewZoom(...MAPS.fhd)).toBe(2);
    expect(viewZoom(...MAPS.fhdChrome)).toBe(2);
  });

  it('up to a 1536 px window, and in the side panel, the city starts at zoom 1', () => {
    for (const k of ['panel', 'w760', 'w1024', 'w1280', 'w1366', 'w1536']) expect(viewZoom(...MAPS[k]), k).toBe(1);
  });

  it('a 2560×1440 window’s map starts at 2, a 4K one at 4 (CSS px)', () => {
    expect(viewZoom(...MAPS.qhd)).toBe(2);
    expect(viewZoom(3342, 2000)).toBe(4);
  });

  it('a short wide map stays at 1: the height counts too', () => {
    expect(viewZoom(1502, 700)).toBe(1);
  });

  it('never leaves less than START_VIEW in view above zoom 1, and a bigger map never starts further out', () => {
    let last = 1;
    for (let w = 300; w <= 4000; w += 50) {
      const z = viewZoom(w, w * 0.6);
      expect(Number.isInteger(z)).toBe(true);
      if (z > 1) expect(w / z >= START_VIEW.w && (w * 0.6) / z >= START_VIEW.h).toBe(true);
      expect(z).toBeGreaterThanOrEqual(last);
      last = z;
    }
  });

  it('a resized map takes its starting zoom again, unless the player zoomed during this visit', () => {
    const p = legacyPlan();
    expect(zoomOnResize(...MAPS.fhd, p, 1, false)).toBe(2);
    expect(zoomOnResize(...MAPS.w1280, p, 2, false)).toBe(1);
    expect(zoomOnResize(...MAPS.fhd, p, 3, true)).toBe(3);
    expect(zoomOnResize(...MAPS.w1280, p, 2, true)).toBe(2);
  });
});

describe('framing a building (buildingFocusY)', () => {
  it('frames a short building just above its ground, as before', () => {
    expect(buildingFocusY(500, 460, 800, 2)).toBe(470);
  });

  it('frames a tall tower by its middle, so the tower and its crown show', () => {
    expect(buildingFocusY(500, 260, 800, 2)).toBe(380);
  });

  it('never so high that the ground leaves the view', () => {
    // 200 world px visible at zoom 4: the ground stays 40 px above the bottom edge
    const y = buildingFocusY(500, 100, 800, 4);
    expect(y).toBe(500 - 100 + 40);
    expect(500 - y).toBeLessThan(800 / 4 / 2);
  });
});

describe.each(somePlans().map((s) => [s.name, s] as const))('framing the real streets of %s', (_n, s) => {
  const p = s.plan;
  it('a 64×64 core doesn’t fit a laptop or the panel: they open on the Town Square at zoom 1', () => {
    for (const [w, h] of [[400, 560], [1400, 880]]) {
      const f = frameTarget(w, h, p);
      expect(f).toMatchObject({ zoom: 1, target: 'square' });
      expect({ x: f.x, y: f.y }).toEqual(toScreen(CITY_ISO, p.square.x + 5.5, p.square.y + 5.5));
    }
  });
  it('a 1920×1080 window opens on the Town Square at zoom 2 (it was 1: tiny, half the view sea)', () => {
    expect(frameTarget(...MAPS.fhd, p)).toMatchObject({ zoom: 2, target: 'square' });
  });
  it('a 4K map (CSS px) opens close in on the Town Square, on a whole-number zoom', () => {
    // Before (adapt pass) it showed the whole 64×64 core at zoom 1: the city small, a third of the view landscape.
    const f = frameTarget(3840, 2160, p);
    expect(f).toMatchObject({ zoom: 4, target: 'square' });
    expect(Number.isInteger(f.zoom)).toBe(true);
  });
});
