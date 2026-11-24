// Batch B7: under reduced motion the city's own agents (one per landmark) and the Well-Architected patrols stand still
// like the citizens (tests/walkers-still.test.ts): an idle one never starts a stroll, a walk it's given (a task, a
// finding, its first walk to work) still happens, and it strolls again when the setting goes back. The real Agent runs
// on a fake scene; CityScene's wiring is read from its source, as tests/city-view.test.ts does.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('@/game/assets', () => ({ FRAME_H: 72, FRAME_W: 48, PIVOT: { x: 24, y: 66 }, frameOf: () => [48, 72], hasAnim: () => true }));
vi.mock('@/game/SpeechBubble', () => ({
  crisp: <T>(t: T) => t,
  TEXT_FONT: 'sans-serif',
  SpeechBubble: class {
    visible = false;
    showing = false;
    destroy() {}
  },
}));
vi.mock('@/state/store', () => ({ useCity: { getState: () => ({ prefs: {} }) } }));

const { Agent } = await import('@/game/Agent');
const { CITY_ISO } = await import('@/game/iso');
const { STILL_TIME } = await import('@/game/stillness');

const piece = () => {
  const o: Record<string, unknown> = {};
  for (const m of ['setOrigin', 'setInteractive', 'setStrokeStyle', 'setVisible', 'setPosition', 'setDepth', 'setText', 'on', 'play', 'destroy']) o[m] = () => o;
  return o;
};
const scene = () =>
  ({
    add: { ellipse: piece, sprite: piece, rectangle: piece, text: piece },
    textures: { exists: () => true },
    time: { now: 0 },
    cameras: { main: { worldView: {}, zoom: 1 } },
  }) as never;
const world = { iso: CITY_ISO, gridW: 20, gridH: 20, walkable: () => true };
// Its home is a few tiles off, so a stroll always goes somewhere.
const agent = () => new Agent(scene(), world, { id: 's3', name: 'Sally the Angler', tile: { x: 1, y: 1 }, home: { x: 3, y: 3, w: 2, h: 2 }, workSpot: { x: 6, y: 1 } });
const frames = (a: InstanceType<typeof Agent>, time: (i: number) => number, n = 200) => {
  for (let i = 0; i < n; i++) a.update(time(i), 50);
};

describe('landmark agents under reduced motion', () => {
  it('an idle agent on the still clock never starts a stroll; on the real clock it does', () => {
    const still = agent();
    frames(still, () => STILL_TIME);
    expect(still.tile).toEqual({ x: 1, y: 1 });
    expect(still.isBusy).toBe(false);
    const moving = agent();
    moving.update(10_000, 50); // past its first stroll's time (1–5 s after it appeared)
    expect(moving.isBusy).toBe(true);
  });

  it('still walks a path it’s given (a task’s walk), and goes to work when the backend says it’s working', () => {
    const a = agent();
    a.goTo({ x: 4, y: 6 });
    frames(a, () => STILL_TIME);
    expect(a.tile).toEqual({ x: 4, y: 6 });
    a.setWorking(true);
    frames(a, () => STILL_TIME);
    expect(a.tile).toEqual({ x: 6, y: 1 });
    expect(a.isWorking).toBe(true);
  });

  it('CityScene gives its agents and the patrols the still clock while the setting holds (src/game/stillness.ts)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/game/scenes/CityScene.ts'), 'utf8');
    expect(src).toMatch(/import \{ Stillness, STILL_TIME \} from '\.\.\/stillness';/);
    expect(src).toMatch(/private stillness = new Stillness\(\);/);
    const update = src.slice(src.indexOf('  override update(time: number, dt: number) {'), src.indexOf('this.patrols?.update('));
    expect(update).toMatch(/const wander = this\.stillness\.check\(time, \(\) => \{\}\) \? STILL_TIME : time;/);
    expect(update).toMatch(/a\.update\(wander, dt\);/);
    expect(src).toMatch(/this\.patrols\?\.update\(wander, dt\);/);
    // Kai walks on the real clock: he never strolls by himself, and arrow keys and taps must always move him.
    expect(update).toMatch(/this\.player\.update\(time, dt\);/);
  });
});
