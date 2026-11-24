// Batch B3b: Rush Hour, the Food Stall, the Dance Hall, the Sorting Office and S3 Lake fill the stage at a whole-number
// scale, wear the desk's tokens, show their keys, and show a keyboard answer where it went.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerPop, playScale, POP_MS, pressLook } from '@/game/scenes/games/stageFx';

const root = path.resolve(__dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');
const code = (f: string) => read(f).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*\*[\s\S]*?\*\//g, '');
const GAMES = 'src/game/scenes/games';
const FILES = [`${GAMES}/RushGame.ts`, `${GAMES}/KitchenGame.ts`, `${GAMES}/DanceGame.ts`, `${GAMES}/SortGame.ts`, 'src/game/scenes/FishingScene.ts'];

describe('the play group is drawn at a whole-number scale', () => {
  it('1× in the side panel, 2× in a big tab, never 0 and never past the cap', () => {
    expect(playScale(400, 740, 380, 300)).toBe(1); // the panel
    expect(playScale(760, 757, 380, 300)).toBe(2); // the tab's play column under the chrome
    expect(playScale(985, 815, 480, 400)).toBe(2); // S3 Lake's whole tab
    expect(playScale(100, 100, 380, 300)).toBe(1);
    expect(playScale(4000, 4000, 380, 300)).toBe(2);
    expect(playScale(4000, 4000, 380, 300, 3)).toBe(3);
    for (let w = 200; w <= 2000; w += 37) for (let h = 200; h <= 1400; h += 53) expect(Number.isInteger(playScale(w, h, 380, 300))).toBe(true);
  });

  it('Rush Hour and S3 Lake lay their scene out at that scale (finding 8: empty sky, play in the left quarter)', () => {
    const rush = code(`${GAMES}/RushGame.ts`);
    expect(rush).toMatch(/const k = playScale\(/);
    expect(rush).toMatch(/this\.column\(stageH\)/);
    expect(rush).toMatch(/setScale\(k \+ 1\)/); // Eddie
    const fishing = code('src/game/scenes/FishingScene.ts');
    expect(fishing).toMatch(/playScale\(w, h, BASE_W, BASE_H\)/);
    expect(fishing).toMatch(/c\.setScale\(dir \* k, k\)/); // the fish
  });

  it('no sprite stands at a half scale (1.5× drops pixels)', () => {
    for (const f of FILES) {
      const src = code(f);
      expect(src, f).not.toMatch(/setScale\(\d+\.\d+\)/);
      expect(src, f).not.toMatch(/\* 2\) \/ 2/);
    }
  });
});

describe('the five games wear the desk’s tokens (finding 3)', () => {
  // The retired purple chrome and slate: the old PAL/PILL, the purple buttons and chips, the old amber and paper.
  const RETIRED = ['140d1f', '241a37', '4a3768', '2d2144', '8c4fff', 'ffb84d', 'fffbeb', '0f172a', '1e293b', '334155', '475569', '64748b', '94a3b8', 'e2e8f0', 'f8fafc', '161622'];
  for (const f of FILES)
    it(`${path.basename(f)} has no retired colour`, () => {
      const src = code(f).toLowerCase();
      for (const hex of RETIRED) expect(src, `${f}: ${hex}`).not.toMatch(new RegExp(`(#|0x)${hex}`));
    });

  it('S3 Lake’s text goes through TXT, so it follows Text size and never drops under 11 px (finding 4)', () => {
    const src = code('src/game/scenes/FishingScene.ts');
    expect(src).not.toMatch(/fontSize:/);
    expect(src).not.toMatch(/UI_FONT/);
    expect(src.match(/TXT\(/g)?.length).toBeGreaterThanOrEqual(10);
    expect(src).toMatch(/GAME_PAL as PAL/);
  });
});

describe('Rush Hour shows its keys on its buttons (finding 11)', () => {
  it('each button names its arrow, and the keys it names work', () => {
    const src = read(`${GAMES}/RushGame.ts`);
    expect(src).toMatch(/RUSH_BUTTONS = \{ remove: '− server \(↓\)', add: '\+ server \(↑\)' \}/);
    expect(src).toMatch(/this\.pxButton\(0, by, RUSH_BUTTONS\.remove,/);
    expect(src).toMatch(/this\.pxButton\(0, by, RUSH_BUTTONS\.add,/);
    expect(src).toMatch(/key === 'ArrowUp'[^}]*this\.add1\(\)/);
    expect(src).toMatch(/key === 'ArrowDown'[^}]*this\.remove\(\)/);
  });
});

describe('a keyboard answer shows where it went (motion.md item 9)', () => {
  it('each game frames its answer’s target, and the keys press their buttons', () => {
    for (const f of FILES) expect(code(f), f).toMatch(/answerPop\(this,/);
    expect(code(`${GAMES}/RushGame.ts`)).toMatch(/pressLook\(this, this\.plusBtn\)/);
    expect(code(`${GAMES}/DanceGame.ts`)).toMatch(/pressLook\(this, this\.optBtns\[i\]\)/);
  });

  const rect = () => {
    const r = { x: 0, y: 0, setStrokeStyle: () => r, setDepth: () => r, destroy: vi.fn() };
    return r;
  };
  const fakeScene = () => {
    const made: ReturnType<typeof rect>[] = [];
    return {
      made,
      add: { rectangle: vi.fn(() => (made.push(rect()), made[made.length - 1])) },
      tweens: { add: vi.fn() },
      time: { delayedCall: vi.fn() },
    };
  };
  afterEach(() => vi.unstubAllGlobals());

  it('a right answer: a frame and sparks that fly; a wrong one: only the frame', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    const right = fakeScene();
    answerPop(right as never, 100, 100, 40, 30, true);
    expect(right.made.length).toBe(9);
    expect(right.tweens.add).toHaveBeenCalledTimes(9);
    const wrong = fakeScene();
    answerPop(wrong as never, 100, 100, 40, 30, false);
    expect(wrong.made.length).toBe(1);
  });

  it('under reduced motion the frame shows still for the same time, and nothing flies', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const s = fakeScene();
    answerPop(s as never, 100, 100, 40, 30, true);
    expect(s.made.length).toBe(1);
    expect(s.tweens.add).not.toHaveBeenCalled();
    expect(s.time.delayedCall).toHaveBeenCalledWith(POP_MS, expect.any(Function));
  });

  it('a key press sinks its button’s face and label, then lifts them', () => {
    const face = { y: 0 };
    const label = { y: 0 };
    const calls: (() => void)[] = [];
    const btn = { active: true, list: [{ y: 3 }, face, label] };
    pressLook({ time: { delayedCall: (_ms: number, fn: () => void) => calls.push(fn) } } as never, btn as never);
    expect([face.y, label.y]).toEqual([3, 3]);
    calls.forEach((fn) => fn());
    expect([face.y, label.y]).toEqual([0, 0]);
  });
});
