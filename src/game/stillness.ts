import { reducedMotion } from './motion';

/** How often walkers read the OS's reduced-motion setting again (Ambient reads it as often for the cars). */
export const STILL_CHECK_MS = 1000;

/**
 * The clock an idle walker is updated with under reduced motion: an Agent wanders off once `time > wanderAt` (scene
 * time, never below 0), so at 0 it never does. It still answers taps, speaks, and walks a path it's given.
 */
export const STILL_TIME = 0;

/**
 * Walkers under reduced motion (Citizens, Workers, Visitors), like the cars Ambient parks at the kerb: they stop where
 * they stand and wait there, still tappable, and walk again when the setting goes back. One per walker group; it
 * follows the setting live.
 */
export class Stillness {
  private still = reducedMotion();
  private at = -Infinity;

  /** Whether walkers stand still now (as of the last check). */
  get on() {
    return this.still;
  }

  /** Per frame: whether walkers stand still now. `park` runs once each time the setting turns on. */
  check(time: number, park: () => void): boolean {
    if (time - this.at >= STILL_CHECK_MS) {
      this.at = time;
      const now = reducedMotion();
      if (now && !this.still) park();
      this.still = now;
    }
    return this.still;
  }
}
