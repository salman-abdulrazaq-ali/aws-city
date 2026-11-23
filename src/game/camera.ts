// Camera framing for the city (pure, no Phaser): the starting zoom follows the map's size (a bigger map, bigger pixels),
// on the whole core when it fits at that zoom, else on the Town Square (the 400 px side panel: zoom 1). Zoom stays on
// integers so pixel art stays crisp (CLAUDE.md).
import { GRID } from '@/world/layout';
import { legacyPlan, type CityPlan } from '@/world/plan';
import { CITY_ISO, cornerScreen, toScreen } from './iso';

const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
/** Side margin round the core diamond, world px. */
const MARGIN_X = 8;
/** Room above the north corner for the tallest buildings there, world px. */
const HEADROOM = 48;

/** A size×size core in world pixels: the diamond plus margins and building headroom. */
export const coreFor = (size: number) => {
  const top = cornerScreen(CITY_ISO, 0, 0).y - HEADROOM;
  const bottom = cornerScreen(CITY_ISO, size, size).y;
  const w = 2 * size * CITY_ISO.halfW + 2 * MARGIN_X;
  return { w, h: bottom - top, x: 0, y: (top + bottom) / 2 };
};
/** The legacy core (GRID×GRID tiles) in world pixels. */
export const CORE = coreFor(GRID);

/** Largest integer zoom in [1, 4] at which the whole core fits a viewW×viewH view, or 0 when it doesn't fit at 1. */
export function fitZoom(viewW: number, viewH: number, core = CORE): number {
  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) if (core.w * z <= viewW && core.h * z <= viewH) return z;
  return 0;
}

/**
 * The least world (px at zoom 1) a starting zoom leaves in view: a bit less than a laptop tab's map shows at zoom 1
 * (862×654 at 1280×720). A bigger map starts closer in, so it shows about as much city with bigger pixels instead of
 * more sea: zoom 2 from a 1440×800 map (a 1920×1080 window's is 1502×1014), zoom 1 up to a 1536 px window.
 */
export const START_VIEW = { w: 720, h: 400 } as const;

/** The starting zoom for a viewW×viewH map (CSS px): the largest whole number in [1, 4] that still shows START_VIEW. */
export function viewZoom(viewW: number, viewH: number): number {
  for (let z = MAX_ZOOM; z > MIN_ZOOM; z--) if (viewW / z >= START_VIEW.w && viewH / z >= START_VIEW.h) return z;
  return MIN_ZOOM;
}

export interface Frame {
  zoom: number;
  /** World point to centre on. */
  x: number;
  y: number;
  target: 'core' | 'square';
}

/**
 * Where the camera should start: the map's starting zoom (viewZoom), on the whole core when it fits at that zoom, else
 * on the Town Square. The core is never smaller than START_VIEW, so it never fits a zoom closer in than viewZoom.
 */
export function frameTarget(viewW: number, viewH: number, plan: CityPlan = legacyPlan()): Frame {
  const core = plan.size === GRID ? CORE : coreFor(plan.size);
  const z = viewZoom(viewW, viewH);
  if (fitZoom(viewW, viewH, core) >= z) return { zoom: z, x: core.x, y: core.y, target: 'core' };
  const r = plan.square;
  const c = toScreen(CITY_ISO, r.x + (r.w - 1) / 2, r.y + (r.h - 1) / 2);
  return { zoom: z, x: c.x, y: c.y, target: 'square' };
}

/**
 * The zoom a resized map takes (the tab's window grew or shrank): its starting zoom again, unless the player zoomed
 * (+/−, the wheel) since the city last showed, whose choice stays.
 */
export const zoomOnResize = (viewW: number, viewH: number, plan: CityPlan, zoom: number, playerZoomed: boolean) =>
  playerZoomed ? zoom : frameTarget(viewW, viewH, plan).zoom;

/**
 * The world y to centre on when the camera goes to a building whose ground is at `groundY` and whose top (its roof, or
 * the crown on its knowledge tower) is at `topY`: a short building is framed as before (just above its ground), a tall
 * one by its middle so the tower shows, but never so high that its ground (where its agent works) leaves the view.
 */
export function buildingFocusY(groundY: number, topY: number, viewH: number, zoom: number, margin = 40) {
  const visible = viewH / zoom;
  const mid = (groundY + topY) / 2;
  return Math.max(Math.min(mid, groundY - 30), groundY - visible / 2 + margin);
}
