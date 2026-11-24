// Batch B7 (motion.md items 7, 8, 9): a keyboard answer's sparks burst where the answer went, the answer beam reads
// over the city with a landing pulse, and a client level-up's confetti reads at zoom 1. None of it under reduced motion.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => ({ default: {} }));
vi.mock('@/game/audio', () => ({ click: () => {} }));
vi.mock('@/game/assets', () => ({ addSprite: () => ({}), hasSprite: () => false }));
vi.mock('@/game/SpeechBubble', () => ({ crisp: <T>(t: T) => t, TEXT_FONT: 'sans-serif' }));

const { answerPop, noteAnswerSpot, sparkSpot, takeAnswerSpot } = await import('@/game/scenes/games/stageFx');
const { BEAM_CORE, BEAM_HALO, BEAM_LAND, BEAM_MS, PULSE_FROM, PULSE_TO, beam, beamAt } = await import('@/game/juice');
const { CONFETTI_MS, CONFETTI_OUTLINE, CONFETTI_PIECES, ClientsLayer, confettiAt, confettiPieces } = await import('@/game/Clients');
const { COLOR } = await import('@/game/theme');

const root = path.resolve(__dirname, '..');
const code = (f: string) =>
  fs
    .readFileSync(path.join(root, f), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*\*[\s\S]*?\*\//g, '');

afterEach(() => vi.unstubAllGlobals());

describe('a right answer’s sparks (motion.md item 9)', () => {
  const W = 800;
  const H = 600;

  it('a click bursts where the pointer pressed; a key press at the answer the game showed, else the middle', () => {
    expect(sparkSpot('pointer', { x: 120, y: 80 }, { x: 500, y: 400 }, W, H)).toEqual({ x: 120, y: 80 });
    // A key press: the pointer is wherever the mouse last stopped, never the answer.
    expect(sparkSpot('key', { x: 120, y: 80 }, { x: 500, y: 400 }, W, H)).toEqual({ x: 500, y: 400 });
    expect(sparkSpot('key', { x: 120, y: 80 }, undefined, W, H)).toEqual({ x: 400, y: 300 });
    // A pointer that never moved (0, 0) still bursts in view.
    expect(sparkSpot('pointer', { x: 0, y: 0 }, undefined, W, H)).toEqual({ x: 400, y: 300 });
  });

  it('answerPop records the spot it framed, read once (a key press reads it, the next one starts clean)', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    const r = { setStrokeStyle: () => r, setDepth: () => r, destroy: () => {} };
    const scene = { add: { rectangle: () => r }, tweens: { add: () => {} }, time: { delayedCall: () => {} } } as never;
    answerPop(scene, 140.4, 220.6, 40, 30, true);
    expect(takeAnswerSpot(scene)).toEqual({ x: 140, y: 221 });
    expect(takeAnswerSpot(scene)).toBeUndefined();
    noteAnswerSpot(scene, 10, 20);
    expect(takeAnswerSpot(scene)).toEqual({ x: 10, y: 20 });
  });

  it('MiniGame bursts after the press’s handler, keys at the answer: answerPop’s, answerAt’s, else the verdict’s', () => {
    const src = code('src/game/scenes/games/MiniGame.ts');
    // Its own listeners go first: a key sets the press's kind and forgets the last press's spots before the game hears it.
    expect(src.indexOf("this.pressedBy = 'key';")).toBeGreaterThan(-1);
    expect(src.indexOf("this.pressedBy = 'key';")).toBeLessThan(src.indexOf('this.setup();'));
    expect(src).toMatch(/this\.input\.on\('pointerdown', \(\) => \(this\.pressedBy = 'pointer'\)\)/);
    expect(src).toMatch(/queueMicrotask\(\(\) => \{\s*this\.sparksQueued = false;/);
    expect(src).toMatch(/takeAnswerSpot\(this\) \?\? this\.saidAt/);
    expect(src).toMatch(/sparkSpot\(by, this\.input\.activePointer, target,/);
    expect(src).toMatch(/protected answerAt\(x: number, y: number\) \{\s*noteAnswerSpot\(this, x, y\);/);
    // The combo's "×2" floats by the score: it never becomes the press's spot.
    expect(src).toMatch(/const said = this\.saidAt;[\s\S]*combo![\s\S]*this\.saidAt = said;/);
    expect(src).not.toMatch(/const p = this\.input\.activePointer;/);
  });
});

describe('the answer beam (motion.md item 8)', () => {
  it('a 3 px core with one 7 px halo step, whole px', () => {
    expect(BEAM_CORE).toBe(3);
    expect(BEAM_HALO).toBe(BEAM_CORE + 4);
  });

  it('travels, decelerating, and lands at BEAM_LAND; the tail follows; then the pulse spreads in whole px and everything fades', () => {
    expect(beamAt(0).head).toBe(0);
    expect(beamAt(BEAM_LAND / 2).head).toBeGreaterThan(0.5); // most of the way in the first half: an ease-out
    expect(beamAt(BEAM_LAND).head).toBe(1);
    expect(beamAt(BEAM_LAND - 0.01).pulse).toBeUndefined();
    let lastR = 0;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const s = beamAt(t);
      expect(s.tail).toBeLessThanOrEqual(s.head);
      expect(s.halo).toBeLessThan(s.core || 1);
      if (!s.pulse) continue;
      expect(Number.isInteger(s.pulse.r)).toBe(true);
      expect(s.pulse.r).toBeGreaterThanOrEqual(lastR);
      lastR = s.pulse.r;
    }
    const end = beamAt(1);
    expect(end.core).toBe(0);
    expect(end.pulse).toEqual({ r: PULSE_TO, alpha: 0 });
    expect(beamAt(BEAM_LAND).pulse?.r).toBe(PULSE_FROM);
  });

  const fakeScene = () => {
    const calls: string[] = [];
    const g = new Proxy({} as Record<string, unknown>, {
      get: (_t, k: string | symbol) => (...args: unknown[]) => (calls.push(`${String(k)}(${args.join(',')})`), g),
    });
    const tweens: { duration: number; onUpdate: () => void; targets: { t: number } }[] = [];
    return { calls, tweens, scene: { add: { graphics: () => g }, tweens: { add: (cfg: (typeof tweens)[number]) => tweens.push(cfg) } } };
  };

  it('draws the core in the gold it’s given with a pale-gold glint, in whole px, and lands a tile-shaped pulse', () => {
    const f = fakeScene();
    beam(f.scene as never, { x: 100.4, y: 500.6 }, { x: 300.2, y: 100.7 }, COLOR.gold, false);
    expect(f.tweens).toHaveLength(1);
    expect(f.tweens[0].duration).toBe(BEAM_MS);
    f.tweens[0].targets.t = 0.2;
    f.tweens[0].onUpdate();
    expect(f.calls).toContain(`lineStyle(${BEAM_CORE},${COLOR.gold},1)`);
    expect(f.calls).toContain(`lineStyle(1,${COLOR.goldHi},1)`);
    expect(f.calls.some((c) => c.startsWith(`lineStyle(${BEAM_HALO},${COLOR.gold},`))).toBe(true);
    for (const c of f.calls.filter((x) => x.startsWith('lineBetween('))) for (const n of c.slice(12, -1).split(',')) expect(Number.isInteger(Number(n))).toBe(true);
    expect(f.calls).not.toContain('setBlendMode(ADD)');
    f.calls.length = 0;
    f.tweens[0].targets.t = 0.7;
    f.tweens[0].onUpdate();
    expect(f.calls).toContain('strokePath()');
    expect(f.calls).toContain('fillPath()');
    expect(f.calls.filter((c) => c.startsWith('moveTo(') || c.startsWith('lineTo(')).every((c) => c.slice(c.indexOf('(') + 1, -1).split(',').every((n) => Number.isInteger(Number(n))))).toBe(true);
  });

  it('nothing under reduced motion', () => {
    const f = fakeScene();
    beam(f.scene as never, { x: 0, y: 0 }, { x: 10, y: 10 }, COLOR.gold, true);
    expect(f.tweens).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
});

describe('a client level-up’s confetti (motion.md item 7)', () => {
  it('fewer, bigger pieces (14–18 of 7–9 px, never square), the same every time, in the theme’s colours', () => {
    const pieces = confettiPieces();
    expect(CONFETTI_PIECES).toBeGreaterThanOrEqual(14);
    expect(CONFETTI_PIECES).toBeLessThanOrEqual(18);
    expect(pieces).toHaveLength(CONFETTI_PIECES);
    expect(confettiPieces()).toEqual(pieces);
    for (const p of pieces) {
      for (const d of [p.w, p.h]) expect(d >= 7 && d <= 9 && Number.isInteger(d)).toBe(true);
      expect(p.w).not.toBe(p.h);
      expect([COLOR.gold, COLOR.info, COLOR.good, COLOR.bad, COLOR.goldHi]).toContain(p.color);
    }
    // Fanned both ways.
    expect(pieces.some((p) => p.dx < -40) && pieces.some((p) => p.dx > 40)).toBe(true);
  });

  it('rises then falls on whole px, turns in whole quarter turns, and fades out as it lands', () => {
    for (const p of confettiPieces()) {
      let top = 0;
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const at = confettiAt(p, t);
        expect(Number.isInteger(at.x) && Number.isInteger(at.y)).toBe(true);
        expect(Math.abs(at.angle) % 90).toBe(0);
        top = Math.min(top, at.y);
      }
      expect(top).toBe(-p.apex);
      const start = confettiAt(p, 0);
      expect([start.x, start.y, start.angle, start.alpha].map(Math.abs)).toEqual([0, 0, 0, 1]);
      const end = confettiAt(p, 1);
      expect(end.y).toBe(p.fall);
      expect(end.alpha).toBe(0);
    }
  });

  const layer = (reduce: boolean) => {
    vi.stubGlobal('matchMedia', () => ({ matches: reduce }));
    const rects: { w: number; h: number; stroke?: [number, number] }[] = [];
    const tweens: Record<string, unknown>[] = [];
    const scene = {
      add: {
        rectangle: (_x: number, _y: number, w: number, h: number) => {
          const r = { w, h, stroke: undefined as [number, number] | undefined, setStrokeStyle: (a: number, b: number) => ((r.stroke = [a, b]), r), setDepth: () => r };
          rects.push(r);
          return r;
        },
      },
      tweens: { add: (cfg: Record<string, unknown>) => tweens.push(cfg) },
    };
    const l = new ClientsLayer(scene as never, { openClient: () => {}, goStation: () => {} });
    (l as unknown as { placed: Map<string, unknown> }).placed.set('bank', { img: { scaleY: 1 }, site: { rect: { x: 10, y: 10, w: 4, h: 4 } } });
    l.grow('bank');
    return { rects, tweens };
  };

  it('the site stands up with a tame overshoot, and each piece is outlined dark', () => {
    const { rects, tweens } = layer(false);
    expect(rects).toHaveLength(CONFETTI_PIECES);
    for (const r of rects) expect(r.stroke).toEqual([CONFETTI_OUTLINE, COLOR.bgDeep]);
    const bump = tweens[0];
    expect(bump.ease).toBe('Back.easeOut');
    expect((bump.easeParams as number[])[0]).toBeLessThanOrEqual(1);
    expect(tweens.slice(1).every((t) => t.duration === CONFETTI_MS)).toBe(true);
  });

  it('none of it under reduced motion', () => {
    const { rects, tweens } = layer(true);
    expect(rects).toHaveLength(0);
    expect(tweens).toHaveLength(0);
  });
});
