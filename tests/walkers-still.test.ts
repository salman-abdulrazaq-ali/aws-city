// Batch B5 (motion.md 6): under reduced motion the city's walkers (citizens, workers, visiting Mayors) stand where
// they are, like Ambient's parked cars, still tappable, and walk again when the setting goes back. Agent is faked: the
// tests watch what each walker group asks of it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('@/game/audio', () => ({ click: () => {} }));
vi.mock('@/game/assets', () => ({ citizenIds: () => ['a', 'b'], crowdSheet: (s: string) => `${s}-crowd`, hasAnim: () => true }));

class FakeAgent {
  static made: FakeAgent[] = [];
  gx: number;
  gy: number;
  pinned = false;
  walkingTo?: { x: number; y: number };
  updates: number[] = [];
  emotes: string[] = [];
  sprite = { disableInteractive: () => {} };
  name: string;
  constructor(_scene: unknown, _world: unknown, cfg: { tile: { x: number; y: number }; name: string }) {
    this.gx = cfg.tile.x + 0.4; // mid-step
    this.gy = cfg.tile.y;
    this.name = cfg.name;
    FakeAgent.made.push(this);
  }
  get tile() {
    return { x: Math.round(this.gx), y: Math.round(this.gy) };
  }
  get isBusy() {
    return this.pinned || !!this.walkingTo;
  }
  goTo(t: { x: number; y: number }, onArrive?: () => void) {
    this.walkingTo = t.x === this.tile.x && t.y === this.tile.y ? undefined : t;
    if (!this.walkingTo) onArrive?.();
  }
  pin(on: boolean) {
    this.pinned = on;
  }
  update(time: number) {
    this.updates.push(time);
  }
  emote(a: string) {
    this.emotes.push(a);
  }
  onClick() {}
  say() {
    return true;
  }
  face() {}
  hold() {}
  release() {}
  setUiScale() {}
  destroy() {}
}
vi.mock('@/game/Agent', () => ({ Agent: FakeAgent }));

const { Citizens } = await import('@/game/Citizens');
const { Workers } = await import('@/game/Workers');
const { Visitors } = await import('@/game/Visitors');
const { STILL_CHECK_MS, STILL_TIME } = await import('@/game/stillness');

let reduce = false;
beforeEach(() => {
  reduce = false;
  FakeAgent.made = [];
  vi.stubGlobal('matchMedia', () => ({ matches: reduce }));
});
afterEach(() => vi.unstubAllGlobals());

const scene = { time: { delayedCall: () => {}, now: 0 } } as never;
const world = { gridW: 40, gridH: 40, walkable: () => true } as never;
const tiles = () => [{ x: 5, y: 5 }];

describe('walkers under reduced motion', () => {
  it('citizens stop where they stand when the setting turns on, never wander while it holds, and walk again after', () => {
    const c = new Citizens(scene, world, tiles, { lakeShore: () => undefined, player: () => undefined });
    c.ensure(2);
    const [a] = FakeAgent.made;
    c.update(10, 16);
    expect(a.updates.at(-1)).toBe(10); // moving normally
    a.goTo({ x: 9, y: 9 }); // mid-walk
    a.pin(true); // on a trip it started (a bench, the lake)
    reduce = true;
    c.update(10 + STILL_CHECK_MS, 16);
    expect(a.walkingTo).toBeUndefined(); // stopped where it stood
    expect(a.updates.at(-1)).toBe(STILL_TIME); // the wander clock held at 0
    c.update(10 + 2 * STILL_CHECK_MS, 16);
    expect(FakeAgent.made.every((x) => x.walkingTo === undefined)).toBe(true);
    reduce = false;
    c.update(10 + 3 * STILL_CHECK_MS, 16);
    expect(a.updates.at(-1)).toBe(10 + 3 * STILL_CHECK_MS);
  });

  it('workers run no errands and don’t jump in while it holds', () => {
    reduce = true;
    const w = new Workers(scene, world, () => {});
    w.sync([{ serviceId: 'lambda', name: 'Lambda team', workSpot: { x: 5, y: 5 }, partners: () => [{ x: 12, y: 12 }] }], 8);
    for (let t = 0; t < 5; t++) w.update(t * 7000, 16);
    expect(FakeAgent.made[0].walkingTo).toBeUndefined();
    expect(w.surge('lambda', 2, 5000, 100)).toBe(2);
    expect(FakeAgent.made.flatMap((x) => x.emotes)).not.toContain('jump');
    // Back to motion: the errands start again.
    reduce = false;
    w.update(60_000, 16);
    expect(FakeAgent.made[0].walkingTo).toEqual({ x: 12, y: 12 });
  });

  it('visiting Mayors stop when the setting turns on', () => {
    const v = new Visitors(scene, world, tiles);
    v.sync([{ name: 'Brave Otter', rank: 'Town' }], 4);
    const [m] = FakeAgent.made;
    m.goTo({ x: 20, y: 20 });
    reduce = true;
    v.update(5_000, 16);
    expect(m.walkingTo).toBeUndefined();
    expect(m.updates.at(-1)).toBe(STILL_TIME);
  });
});
