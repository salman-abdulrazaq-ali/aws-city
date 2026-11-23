// Batch B3b (Rush Hour, Food Stall, Dance Hall, Sorting Office, S3 Lake): a whole-number scale for a game's play group,
// and right/wrong feedback drawn where the answer went, so keyboard play sees it too.
import type Phaser from 'phaser';
import { reducedMotion } from '../../motion';
import { COLOR } from '../../theme';

/**
 * The biggest whole-number scale (1 to `max`) at which a play group laid out at `baseW` × `baseH` fits `w` × `h`. Pixel
 * art stays crisp only at whole numbers, so the full tab gets the scene at 2× instead of a 1× scene in a sea of sky.
 */
export const playScale = (w: number, h: number, baseW: number, baseH: number, max = 2) =>
  Math.max(1, Math.min(max, Math.floor(Math.min(w / Math.max(1, baseW), h / Math.max(1, baseH)))));

/** How long an answer's frame shows, ms. */
export const POP_MS = 420;

/** Where each scene last framed an answer (answerPop, MiniGame.answerAt), until MiniGame's sparks read it. */
const answerSpots = new WeakMap<Phaser.Scene, { x: number; y: number }>();

/** Records where an answer went, so the sparks of a key press burst there (MiniGame.sparks). */
export const noteAnswerSpot = (scene: Phaser.Scene, x: number, y: number) => void answerSpots.set(scene, { x: Math.round(x), y: Math.round(y) });

/** Where the scene last framed an answer, read once (a key press clears it first, so it's never an old answer's). */
export function takeAnswerSpot(scene: Phaser.Scene) {
  const at = answerSpots.get(scene);
  answerSpots.delete(scene);
  return at;
}

/**
 * Where a right answer's sparks burst (motion.md item 9). A click or tap: where the pointer pressed. A key press has no
 * pointer (`activePointer` is wherever the mouse last stopped), so: the answer's `target` (the spot the game framed, else
 * where its verdict went up), else the view's centre.
 */
export function sparkSpot(by: 'key' | 'pointer', pointer: { x: number; y: number }, target: { x: number; y: number } | undefined, w: number, h: number) {
  if (by === 'pointer') return { x: pointer.x || w / 2, y: pointer.y || h / 2 };
  return target ?? { x: Math.round(w / 2), y: Math.round(h / 2) };
}

/**
 * Right/wrong feedback on the answer's target (a shelf, a bucket, a button, a server slot), not where the pointer last
 * was: a key press has no pointer, so in keyboard play the base class's sparks land on a stale spot (motion.md item 9).
 * A 3 px frame in the good or bad colour round the target (`x`, `y` its centre); a right one also throws a few pixel
 * sparks off the frame; `ok` null is a plain action (a server added or turned off): an amber frame, no sparks. Under
 * reduced motion the frame shows, still, for the same time, and nothing flies.
 */
export function answerPop(scene: Phaser.Scene, x: number, y: number, w: number, h: number, ok: boolean | null, depth = 94) {
  noteAnswerSpot(scene, x, y);
  const fw = Math.round(w + 8);
  const fh = Math.round(h + 8);
  const color = ok === null ? COLOR.accent : ok ? COLOR.good : COLOR.bad;
  const frame = scene.add.rectangle(Math.round(x), Math.round(y), fw, fh).setStrokeStyle(3, color).setDepth(depth);
  if (reducedMotion()) return void scene.time.delayedCall(POP_MS, () => frame.destroy());
  scene.tweens.add({ targets: frame, scaleX: (fw + 12) / fw, scaleY: (fh + 12) / fh, alpha: 0, duration: POP_MS, ease: 'Quad.easeOut', onComplete: () => frame.destroy() });
  if (!ok) return;
  const colors = [COLOR.gold, COLOR.good, COLOR.accent, COLOR.inkHi];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const sx = x + (Math.cos(a) * fw) / 2;
    const sy = y + (Math.sin(a) * fh) / 2;
    const sq = scene.add.rectangle(sx, sy, 4, 4, colors[i % colors.length]).setDepth(depth + 1);
    scene.tweens.add({ targets: sq, x: sx + Math.cos(a) * 18, y: sy + Math.sin(a) * 18, alpha: 0, duration: POP_MS, ease: 'Quad.easeOut', onComplete: () => sq.destroy() });
  }
}

/**
 * A key press shows on its button: the face sinks like a pointer press (MiniGame.pxButton: shadow, face, label) and
 * comes back up. A state change, not motion, so it shows under reduced motion too.
 */
export function pressLook(scene: Phaser.Scene, btn?: Phaser.GameObjects.Container) {
  if (!btn?.active) return;
  const [, face, label] = btn.list as unknown as Phaser.GameObjects.Components.Transform[];
  if (!face || !label) return;
  face.y = label.y = 3;
  scene.time.delayedCall(120, () => btn.active && (face.y = label.y = 0));
}
