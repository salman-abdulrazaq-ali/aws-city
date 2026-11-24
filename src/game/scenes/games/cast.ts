// The city's own sprites on a mini-game's stage (batch B3a): citizens as requesters and attackers, the service's agent
// at work, its landmark as the place, and pack props, all at a whole-number scale so the pixel art stays crisp.
import Phaser from 'phaser';
import { addSprite, citizenIds, crowdSheet, FRAME_H, FRAME_W, hasAnim, hasSprite, PIVOT, type Dir } from '../../assets';
import { reducedMotion } from '../../motion';
import { COLOR } from '../../theme';
import { useCity } from '@/state/store';
import { tierOf } from '@/state/selectors';
import { districtById, serviceById } from '@/world/taxonomy';

/** The biggest whole-number scale (1 to `max`) at which `natural` px fit in `room` px. */
export const fitScale = (room: number, natural: number, max = 3) => Math.max(1, Math.min(max, Math.floor(room / Math.max(1, natural))));

/** A service's district colour (Security Keep's red for IAM, Network Junction's violet for CloudFront), as a number. */
export const districtColor = (serviceId: string) => districtById(serviceById(serviceId)?.districtId ?? '')?.color ?? COLOR.accent;

/** The service's landmark frame at its level in this city (`lm:<id>:<1-4>`), or undefined when the atlas has none. */
export function landmarkFrame(serviceId: string) {
  const s = useCity.getState();
  const tier = Phaser.Math.Clamp(tierOf(s.progress, serviceId, s.cityRegion), 1, 4);
  for (let t = tier; t >= 1; t--) if (hasSprite(`lm:${serviceId}:${t}`)) return `lm:${serviceId}:${t}`;
  return undefined;
}

/** An atlas prop at a whole-number scale, its generator anchor (the footprint's corner) at (x, y). */
export const prop = (scene: Phaser.Scene, name: string, x: number, y: number, scale = 1) => addSprite(scene, name, x, y).setScale(scale);

/** `n` citizens for a round, shuffled, at crowd size (3/4: people stand to scale beside the props). */
export function cast(n: number) {
  const ids = Phaser.Utils.Array.Shuffle(citizenIds());
  return Array.from({ length: n }, (_, i) => crowdSheet(ids[i % ids.length]));
}

/** A person with feet at (x, y). Their loop (walk, idle, work) holds its first frame under reduced motion. */
export function person(scene: Phaser.Scene, sheet: string, x: number, y: number, scale = 1, anim = 'idle', dir: Dir = 'SE') {
  const s = scene.add.sprite(x, y, `char:${sheet}`, 0).setOrigin(PIVOT.x / FRAME_W, PIVOT.y / FRAME_H).setScale(scale);
  return act(s, anim, dir);
}

/** Plays `anim` (idle when the sheet hasn't got it) facing `dir`; paused on its first frame under reduced motion. */
export function act(s: Phaser.GameObjects.Sprite, anim: string, dir: Dir = 'SE') {
  const id = s.texture.key.replace('char:', '');
  s.play(`${id}:${hasAnim(id, anim) ? anim : 'idle'}:${dir}`, true);
  if (reducedMotion()) s.anims.pause();
  return s;
}
