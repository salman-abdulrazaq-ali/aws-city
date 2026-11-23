import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { edgeKey, fishingKey } from '@/game/scenes/games/gameKeys';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

/** A static check: instantiating a Phaser scene in jsdom isn't practical, so read each scene's source. */
describe('every mini-game can be played from the keyboard', () => {
  const ids = [...read('src/world/places.ts').match(/export type GameId =([^;]+);/)![1].matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const sceneKeys = Object.fromEntries([...read('src/game/createGame.ts').match(/GAME_SCENES = \{([^}]+)\}/)![1].matchAll(/(\w+): '([\w:]+)'/g)].map((m) => [m[1], m[2]]));
  const files = ['src/game/scenes/FishingScene.ts', ...fs.readdirSync(path.join(root, 'src/game/scenes/games')).filter((f) => f.endsWith('Game.ts')).map((f) => `src/game/scenes/games/${f}`)];

  it('knows every game id', () => expect(ids.length).toBeGreaterThanOrEqual(10));
  for (const id of ids) {
    it(`${id} registers key input`, () => {
      const key = sceneKeys[id];
      expect(key, `GAME_SCENES has no ${id}`).toBeTruthy();
      const file = files.find((f) => read(f).includes(`super('${key}'`));
      expect(file, `no scene file for ${key}`).toBeTruthy();
      expect(read(file!)).toMatch(/\bonKeys\(|keyboard\??\.on\(/);
    });
  }
});

describe('Fishing keys', () => {
  it('Space or Enter casts when ready and hooks on a bite', () => {
    expect(fishingKey('ready', ' ', 3)).toEqual({ kind: 'cast' });
    expect(fishingKey('ready', 'Enter', 3)).toEqual({ kind: 'cast' });
    expect(fishingKey('bite', ' ', 3)).toEqual({ kind: 'hook' });
    expect(fishingKey('waiting', ' ', 3)).toBeUndefined();
    expect(fishingKey('reeling', 'Enter', 3)).toBeUndefined();
  });
  it('1-3 answer the quiz, nothing else does', () => {
    expect(fishingKey('quiz', '1', 3)).toEqual({ kind: 'bucket', index: 0 });
    expect(fishingKey('quiz', '3', 3)).toEqual({ kind: 'bucket', index: 2 });
    expect(fishingKey('quiz', '4', 3)).toBeUndefined();
    expect(fishingKey('quiz', '0', 3)).toBeUndefined();
    expect(fishingKey('ready', '1', 3)).toBeUndefined();
  });
  it('the result card plays again or leaves', () => {
    expect(fishingKey('summary', ' ', 3)).toEqual({ kind: 'again' });
    expect(fishingKey('summary', 'Escape', 3)).toEqual({ kind: 'leave' });
  });
});

describe('Edge Cache keys', () => {
  it('1-4 pick a slot', () => {
    expect(edgeKey('1', 4)).toEqual({ kind: 'select', slot: 0 });
    expect(edgeKey('4', 4)).toEqual({ kind: 'select', slot: 3 });
    expect(edgeKey('5', 4)).toBeUndefined();
  });
  it('I invalidates, C or Space caches', () => {
    expect(edgeKey('i', 4)).toEqual({ kind: 'invalidate' });
    expect(edgeKey('I', 4)).toEqual({ kind: 'invalidate' });
    expect(edgeKey('c', 4)).toEqual({ kind: 'cache' });
    expect(edgeKey(' ', 4)).toEqual({ kind: 'cache' });
    expect(edgeKey('x', 4)).toBeUndefined();
  });
});
