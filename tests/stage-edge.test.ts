// Edge Cache as a scene (batch B3a; findings 2, 3, 8 and 9): the edge location is the CloudFront landmark with its four
// counters drawn as real rectangles in front of it, the viewers are citizens and the origin a data centre, all at a
// whole-number scale (cast.ts fitScale: 2× in the tab, 1× in the side panel); the slot the number keys picked is ringed
// by a gold rectangle round its counter, never an outline on its letters; and the scene names no colour of its own.
// The scene is checked from the source, as in tests/a11y-games.test.ts (a Phaser scene is not practical to run in a
// test); cast.ts's pure helpers run here with Phaser, the atlas and the store stubbed out.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({ tier: 1, sprites: new Set<string>() }));
vi.mock('phaser', () => ({
  default: {
    Math: { Clamp: (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)) },
    Utils: { Array: { Shuffle: <T>(a: T[]) => a } },
  },
}));
vi.mock('@/game/assets', () => ({
  addSprite: () => ({ setScale: () => ({}) }),
  citizenIds: () => ['a', 'b'],
  crowdSheet: (id: string) => `${id}-crowd`,
  FRAME_W: 48,
  FRAME_H: 72,
  PIVOT: { x: 24, y: 67 },
  hasAnim: () => true,
  hasSprite: (name: string) => stub.sprites.has(name),
}));
vi.mock('@/state/store', () => ({ useCity: { getState: () => ({ progress: {}, cityRegion: 'us-east-1' }) } }));
vi.mock('@/state/selectors', () => ({ tierOf: () => stub.tier }));

const { districtColor, fitScale, landmarkFrame } = await import('@/game/scenes/games/cast');

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), 'utf8');
/** Code without its comments: comments may name old colours. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** The body of a scene's method, from its signature to the next method at the same indent. */
const method = (src: string, sig: string) => {
  const at = src.indexOf(sig);
  expect(at, sig).toBeGreaterThan(-1);
  const rest = src.slice(at + sig.length);
  const end = rest.search(/\n {2}(private|protected|override|public) /);
  return end < 0 ? rest : rest.slice(0, end);
};
/** The file's numeric top-level constants (`const NAME = <expression>;`), worked out in order. */
const constants = (src: string) => {
  const env: Record<string, number> = {};
  for (const [, name, expr] of src.matchAll(/^const ([A-Z][A-Z0-9_]*) = ([^;\r\n]+);\r?$/gm)) {
    const value: unknown = Function(...Object.keys(env), `return (${expr});`)(...Object.values(env));
    if (typeof value === 'number') env[name] = value;
  }
  return env;
};

const SRC = read('src/game/scenes/games/EdgeGame.ts');
const CODE = code(SRC);

describe('cast.ts fitScale: the play group’s whole-number scale', () => {
  it('is 1 when the room is short (or none at all)', () => {
    expect(fitScale(50, 100)).toBe(1);
    expect(fitScale(99, 100)).toBe(1);
    expect(fitScale(0, 100)).toBe(1);
    expect(fitScale(-40, 100)).toBe(1);
  });

  it('is the biggest whole number that fits, up to its max (3 unless given)', () => {
    expect(fitScale(200, 100)).toBe(2);
    expect(fitScale(299, 100)).toBe(2);
    expect(fitScale(300, 100)).toBe(3);
    expect(fitScale(10_000, 100)).toBe(3);
    expect(fitScale(10_000, 100, 2)).toBe(2);
    expect(fitScale(10_000, 100, 1)).toBe(1);
  });

  it('never divides by nothing: a natural size of 0 counts as 1 px', () => {
    expect(fitScale(100, 0)).toBe(3);
    expect(Number.isNaN(fitScale(100, 0, 2))).toBe(false);
  });

  it('is always a whole number from 1 to max, and the scaled size fits the room whenever it’s above 1', () => {
    for (let room = -10; room <= 2000; room += 37.5)
      for (const natural of [1, 36, 54, 100, 296, 310.5])
        for (const max of [1, 2, 3, 4]) {
          const s = fitScale(room, natural, max);
          expect(Number.isInteger(s), `${room}/${natural}`).toBe(true);
          expect(s).toBeGreaterThanOrEqual(1);
          expect(s).toBeLessThanOrEqual(max);
          if (s > 1) expect(s * natural).toBeLessThanOrEqual(room);
        }
  });
});

describe('cast.ts places', () => {
  it('districtColor gives CloudFront Network Junction’s violet, as a number', () => {
    expect(districtColor('cloudfront')).toBe(0x8c4fff);
  });

  it('landmarkFrame draws the landmark at its level, falls back to a lower level the atlas has, and to nothing', () => {
    stub.sprites = new Set(['lm:cloudfront:1', 'lm:cloudfront:2', 'lm:cloudfront:3', 'lm:cloudfront:4']);
    stub.tier = 3;
    expect(landmarkFrame('cloudfront')).toBe('lm:cloudfront:3');
    stub.tier = 7; // Mentor and up still draw the Master building
    expect(landmarkFrame('cloudfront')).toBe('lm:cloudfront:4');
    stub.tier = 0; // not found yet: the first level
    expect(landmarkFrame('cloudfront')).toBe('lm:cloudfront:1');
    stub.sprites = new Set(['lm:cloudfront:2']);
    stub.tier = 4;
    expect(landmarkFrame('cloudfront')).toBe('lm:cloudfront:2');
    stub.sprites = new Set();
    expect(landmarkFrame('cloudfront')).toBeUndefined();
  });
});

describe('Edge Cache is a street scene', () => {
  it('stages the city’s own sprites through cast.ts: the CloudFront landmark, its agent at work, citizens, a data centre', () => {
    const imports = /import \{([^}]*)\} from '\.\/cast';/.exec(SRC)?.[1] ?? '';
    for (const helper of ['act', 'cast', 'districtColor', 'fitScale', 'landmarkFrame', 'person', 'prop']) expect(imports, helper).toMatch(new RegExp(`\\b${helper}\\b`));
    expect(CODE).toMatch(/landmarkFrame\('cloudfront'\)/);
    expect(CODE).toMatch(/person\(this, 'cloudfront', [^)]*'carry'/);
    expect(CODE).toMatch(/cast\(3\)/);
    expect(CODE).toMatch(/'culture:dc:0'/);
    // The violet is the sign's only: never a counter's fill.
    expect(CODE).toMatch(/districtColor\('cloudfront'\)/);
    expect(method(SRC, '  private drawSlot(i: number) {')).not.toMatch(/districtColor/);
  });

  it('is laid out in the play column at a whole-number scale: 1× in the 400 px panel, 2× in the 1400 px tab', () => {
    expect(CODE).toMatch(/this\.column\(/);
    expect(CODE).toMatch(/fitScale\(cw - ROW_MARGINS, ROW_W, MAX_SCALE\)/);
    const c = constants(SRC);
    expect(c.MAX_SCALE).toBe(2);
    const scaleIn = (width: number) => fitScale(Math.min(width, c.MAX_W) - c.ROW_MARGINS, c.ROW_W, c.MAX_SCALE);
    expect(scaleIn(400)).toBe(1);
    expect(scaleIn(1400)).toBe(2);
  });

  it('draws each counter as a rectangle, and rings the picked one with a gold rectangle 2 px clear of it', () => {
    const slot = method(SRC, '  private drawSlot(i: number) {');
    expect(slot).toMatch(/this\.add\s*\.rectangle\(/);
    expect(slot).toMatch(/if \(i === this\.sel\) this\.drawRing\(\)/);
    const ring = method(SRC, '  private drawRing() {');
    expect(ring).toMatch(/lineStyle\(RING_W, COLOR\.gold/);
    expect(ring).toMatch(/strokeRect\(/);
    expect(ring).toMatch(/RING_GAP/);
    const c = constants(SRC);
    expect(c.RING_GAP).toBe(2);
    expect(c.RING_W).toBeGreaterThanOrEqual(2);
    expect(c.RING_W).toBeLessThanOrEqual(3);
    // Never an outline on the slot's letters (finding 9: setStroke on the text outlined the text, not the slot).
    expect(CODE).not.toMatch(/\.setStroke\(/);
  });

  it('names no colour of its own: theme tokens only (black pixel borders through PAL.black)', () => {
    expect(CODE).not.toMatch(/'#[0-9a-f]{3,8}'/i);
    expect(CODE).not.toMatch(/0x[0-9a-f]{6}/i);
    const retired = ['10172a', '4c1d95', '8c4fff', '3b1578', '2e1065', '1e293b', '92400e', '140d1f', '0f172a', 'cbd5e1', 'e2e8f0', '93c5fd', 'fdba74', '5db39e', 'e5676b', 'ffc233', 'ffb84d', '6fe3a3', '7c2d12', '1f2937', '334155', '94a3b8', '3b82f6'];
    for (const hex of retired) expect(CODE.toLowerCase(), hex).not.toContain(hex);
  });

  it('keeps its keys and what it says', () => {
    expect(CODE).toMatch(/edgeKey\(k, EDGE_RULES\.slots\)/);
    for (const [sig, n] of [
      ['  private request() {', 1],
      ['  private addFeed(city: string, name: string) {', 1],
      ['  private store(name: string', 1],
      ['  private change() {', 1],
    ] as const)
      expect(method(SRC, sig).match(/this\.speak\(/g)?.length, sig).toBe(n);
  });
});

describe('the art generator’s props (batch B6: art/tiles/games_art.py)', () => {
  type Anchor = { ax: number; ay: number; w: number; h: number };
  const atlas = (JSON.parse(read('public/assets/city/sprites.json')) as { sprites: Record<string, Anchor> }).sprites;

  it('the atlas has the counter’s 9-slice, a phone and the two envelopes', () => {
    expect(atlas['game:edge:counter']).toMatchObject({ w: 48, h: 48, ax: 0, ay: 0 });
    expect(atlas['game:edge:phone']).toMatchObject({ w: 8, h: 12 });
    expect(atlas['game:edge:file-miss']).toEqual(atlas['game:edge:file-hit']);
    expect(atlas['game:edge:file-miss']).toMatchObject({ w: 8, h: 8, ax: 4, ay: 4 });
  });

  it('the counter frames the desk at the play scale (WebGL only), the viewers hold phones, and a file is an envelope', () => {
    const setup = method(CODE, '  protected setup() {');
    expect(setup).toMatch(/const framed = hasSprite\(COUNTER\.frame\) && this\.game\.renderer\.type === Phaser\.WEBGL/);
    expect(setup).toMatch(/\.nineslice\([^;]*COUNTER\.frame[^;]*\.setScale\(S\)/);
    expect(setup).toMatch(/prop\(this, PHONE, /);
    const packet = method(CODE, '  private packet(miss: boolean) {');
    expect(packet).toMatch(/const file = miss \? FILE\.miss : FILE\.hit/);
    expect(packet).toMatch(/hasSprite\(file\)\s*\? prop\(this, file, v\.x, v\.y, this\.px\)/);
    // Still nothing moves under reduced motion.
    expect(packet).toMatch(/if \(reducedMotion\(\)\) return;/);
  });
});
