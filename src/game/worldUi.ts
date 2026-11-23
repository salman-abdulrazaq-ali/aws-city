// The world map's seams with the rest of the app, kept free of Phaser so the UI and tests can import them: its text
// sizes (they follow ⋯ → Text size like the city's labels) and the first run's dive (src/ui/WorldIntro.tsx).
import { textPx } from './theme';

/** The world map's text, px, at the player's text size (1, 1.25 or 1.5): never under 11 (theme.ts textPx). */
export const worldText = (scale = 1) => ({
  /** "Choose a Region". */
  title: textPx(14, scale),
  /** The Region's line at the bottom and the "Facts ›" button. */
  body: textPx(11, scale),
  /** A city's name under its skyline. */
  city: textPx(11, scale),
  /** A data link's arrow (and its name with map details on). */
  link: textPx(11, scale),
});

let diver: ((code: string) => boolean) | undefined;

/**
 * WorldScene.create: dives go to this scene until the returned function runs (its teardown). `dive` answers whether
 * the scene took the Region (it then enters it itself, once its dive has faded to the sea).
 */
export function setDiver(dive: (code: string) => boolean): () => void {
  diver = dive;
  return () => {
    if (diver === dive) diver = undefined;
  };
}

/**
 * Dive into `code`'s city from the world map, the way picking its dot does: the press answers within a frame and the
 * zoom and the fade to the sea cover the city's build. False when no world map is running: the caller enters the Region
 * itself (`enterRegion`).
 */
export function requestDive(code: string): boolean {
  return diver?.(code) ?? false;
}
