// How the city moves and reads (pure, no Phaser): camera flights scaled by distance, a tier-up played in order, and
// the player's buildings kept legible at night. CityScene and Landmark apply these; tests/city-view.test.ts checks them.

/**
 * Camera flights: about 300 ms plus the distance on screen at 2.5 px a ms, held to 350–1000 ms, decelerating on
 * arrival (a fixed 700 ms ease-in-out smeared a cross-city flight). Further than 1.5 views away, the camera cuts
 * through a short sea-blue fade instead, like the dive from the world map.
 */
export const FLIGHT = { baseMs: 300, pxPerMs: 2.5, minMs: 350, maxMs: 1000, ease: 'Cubic.easeOut', cutViews: 1.5, fadeOutMs: 140, fadeInMs: 220 } as const;

export type Flight = { kind: 'cut'; ms: 0 } | { kind: 'pan'; ms: number } | { kind: 'fade'; ms: number };

/**
 * How the camera gets from where it looks to a point `dx`, `dy` world px away, at `zoom`, on a `viewW`×`viewH` screen:
 * a cut under reduced motion (or when it's already there), a fade for a far jump, else a pan of a length that fits.
 * `ms` is when the camera is there.
 */
export function flightPlan(dx: number, dy: number, zoom: number, viewW: number, viewH: number, still: boolean): Flight {
  const sx = Math.abs(dx) * zoom;
  const sy = Math.abs(dy) * zoom;
  if (still || Math.hypot(sx, sy) < 1) return { kind: 'cut', ms: 0 };
  if (viewW > 0 && viewH > 0 && Math.max(sx / viewW, sy / viewH) > FLIGHT.cutViews) return { kind: 'fade', ms: FLIGHT.fadeOutMs + FLIGHT.fadeInMs };
  const ms = Math.round(FLIGHT.baseMs + Math.hypot(sx, sy) / FLIGHT.pxPerMs);
  return { kind: 'pan', ms: Math.min(FLIGHT.maxMs, Math.max(FLIGHT.minMs, ms)) };
}

/** An upgrade's push-in (src/game/juice.ts pushIn): 450 ms in, held until 1.9 s, 600 ms back. */
export const PUSH_TOTAL_MS = 2_500;
/** The push-in starts this long after the payoff (the burst, the banner and the cheer), once the bounce has begun. */
export const PUSH_AFTER_MS = 250;

/** How long a new crown takes to drop onto its tower (Landmark.crownDrop). */
export const CROWN_DROP_MS = 700;

/** How long a building's rise takes (Landmark.rise): 8 px floors, 30 ms each over 300 ms, at most 1.4 s. */
export const riseMs = (height: number) => (height < 16 ? 0 : Math.min(1400, 300 + Math.ceil(height / 8) * 30));

/**
 * A tier-up as one moment, in order: the camera lands, the tower rises (or a crown drops: `rise` = CROWN_DROP_MS), then
 * one burst with the banner, the fanfare and the agent's cheer (the payoff), then the push-in. Each value is ms after
 * the tier-up. Before, all six started in the same frame and most of the rise played while the camera was still flying.
 * Reduced motion: no flight, rise or push-in, so the payoff comes at once.
 */
export function tierUpTimeline(flightMs: number, rise: number, still: boolean): { rise: number; payoff: number; push?: number; pushEnd: number } {
  if (still) return { rise: 0, payoff: 0, pushEnd: 0 };
  const payoff = flightMs + rise;
  return { rise: flightMs, payoff, push: payoff + PUSH_AFTER_MS, pushEnd: payoff + PUSH_AFTER_MS + PUSH_TOTAL_MS };
}

/**
 * The player's buildings at night: a copy of each one, added over itself, lifts it out of the night's tint by this much
 * (0 by day). Full at zoom 1, where the night flattened the city into one dark field; gone by zoom 3, where buildings
 * are big enough and their lit windows carry them.
 */
export const NIGHT_LIFT = 0.55;
export const nightLift = (night: number, zoom: number) => Math.max(0, Math.min(1, night)) * NIGHT_LIFT * Math.max(0, Math.min(1, (3 - zoom) / 2));
