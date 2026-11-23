// Mini-games reach screen readers: each round says its goal and keys, each thing to answer, every answer with the
// score, and the end card's result and keys (src/game/scenes/games/say.ts, through src/state/announce.ts); the end
// card plays from the keyboard; and a game in the side panel is laid out at the panel's height (games/column.ts).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { endLine, fishLine, growthSaid, plainName, scoreLine, sortKeysLine, spoken, startLine } from '@/game/scenes/games/say';
import { endCardKey, fishingKey } from '@/game/scenes/games/gameKeys';
import { fitParent, playColumn } from '@/game/scenes/games/column';
import { SHELVES } from '@/game/scenes/games/sorting';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const games = fs.readdirSync(path.join(root, 'src/game/scenes/games')).filter((f) => f.endsWith('Game.ts') && f !== 'MiniGame.ts');

describe('what a game says', () => {
  it('starts with the game, how to play, its keys and the clock', () => {
    const line = startLine({ title: '📦 DynamoDB Sorting Office — send each parcel to the shelf with its key', keys: sortKeysLine(), seconds: 50, untimed: false });
    expect(line).toMatch(/^DynamoDB Sorting Office\. Send each parcel to the shelf with its key\. Press 1 to 4/);
    for (const [i, keys] of SHELVES.entries()) expect(line).toContain(`Shelf ${i + 1} holds ${keys.join(' and ')}`);
    expect(line).toMatch(/You have 50 seconds\.$/);
    // Without a clock the round ends on Enter (the Done button is drawn on the canvas).
    expect(startLine({ title: 'Game — play', seconds: 45, untimed: true })).toMatch(/press Enter when you’re done\.$/);
    expect(startLine({ title: 'Game — play', seconds: 0, untimed: false })).toBe('Game. Play.');
  });

  it('says canvas symbols in words', () => {
    expect(spoken('✓ Shelf 2 +6')).toBe('Right: Shelf 2 +6');
    expect(spoken('✗ 🍎 lives on shelf 1')).toBe('Wrong: 🍎 lives on shelf 1');
    expect(spoken('✗ Too busy! Wait…')).toBe('Wrong: Too busy! Wait.');
    expect(spoken('⭐⭐ Nice spreading! S3 Lake · fully grown')).toBe('2 stars. Nice spreading! S3 Lake, fully grown');
    expect(plainName('🛂 Permission Gate — A or ← allows')).toBe('Permission Gate');
  });

  it('a right or wrong answer with no words of its own says what it scored; one with words just adds the score', () => {
    expect(scoreLine(15, 45, false)).toBe('Right, plus 15. Score 45.');
    expect(scoreLine(-5, 40, false)).toBe('Wrong, minus 5. Score 40.');
    expect(scoreLine(6, 24, true)).toBe('Score 24.');
  });

  it('a fish names itself, its hint and the numbered buckets', () => {
    const line = fishLine({ name: 'invoice-2023.pdf', hint: 'Opened about once a month' }, [
      { label: 'S3 Standard', note: 'hot · read often' },
      { label: 'Standard-IA', note: 'warm · monthly' },
      { label: 'S3 Glacier', note: 'cold · archive' },
    ]);
    expect(line).toBe('You caught invoice-2023.pdf: “Opened about once a month”. Which storage class? 1 S3 Standard, hot, read often. 2 Standard-IA, warm, monthly. 3 S3 Glacier, cold, archive.');
  });

  it('the end card says the result, the pay, why a round didn’t count, the building, the lesson and the keys', () => {
    const line = endLine({
      newBest: false,
      score: 40,
      stars: 4,
      coins: 6,
      best: 'best 52',
      notes: ['Too many wrong calls: accuracy 40%, need 60%.'],
      growth: growthSaid({ place: 'Database Row', xp: 30, next: 100, nextName: 'Practitioner' }),
      lesson: '⭐ Perfect sorting! DynamoDB finds things fast by their key.',
      expert: true,
    });
    expect(line).toBe(
      'Round over. Score 40. You earned 4 stars and 6 City Coins. Best 52. Too many wrong calls: accuracy 40%, need 60%. Database Row: 30 of 100 to Practitioner. 1 star. Perfect sorting! DynamoDB finds things fast by their key. Press Enter to play again, X for the Expert round, or Escape to go back to the city.',
    );
    expect(growthSaid({ place: 'S3 Lake', xp: 900 })).toBe('S3 Lake is fully grown.');
  });
});

describe('the end card from the keyboard', () => {
  it('Enter plays again, X the Expert round (only when it’s open), Escape goes back; Space never starts a round', () => {
    expect(endCardKey('Enter', false)).toBe('again');
    expect(endCardKey('x', true)).toBe('expert');
    expect(endCardKey('X', false)).toBeUndefined();
    expect(endCardKey('Escape', false)).toBe('leave');
    expect(endCardKey(' ', true)).toBeUndefined();
  });

  it('fishing’s result card takes X for the Expert round too', () => {
    expect(fishingKey('summary', 'x', 3)).toEqual({ kind: 'expert' });
    expect(fishingKey('quiz', 'x', 3)).toBeUndefined();
  });
});

describe('the scenes speak (a static check: a Phaser scene is not practical to run in a test)', () => {
  it('every game says its goal and keys first, and the end card in words with its keys', () => {
    const mini = read('src/game/scenes/games/MiniGame.ts');
    const create = mini.slice(mini.indexOf('  create() {'), mini.indexOf('  private chrome()'));
    expect(create.indexOf('this.speak(startLine(')).toBeGreaterThan(-1);
    expect(create.indexOf('this.speak(startLine(')).toBeLessThan(create.indexOf('this.setup();'));
    expect(create).toMatch(/endCardKey\(e\.key/);
    expect(mini).toMatch(/announce\(endLine\(/);
    // Verdicts and the player's own score changes are spoken.
    expect(mini.slice(mini.indexOf('  protected verdict('))).toMatch(/this\.speak\(text\)/);
    expect(mini.slice(mini.indexOf('  protected addScore('), mini.indexOf('  protected hit()'))).toMatch(/this\.moved \+=/);
  });

  it('each game’s keys are in its title or its keysHelp', () => {
    for (const f of games) {
      const src = read(`src/game/scenes/games/${f}`);
      const title = /super\('[^']+', '[^']+', '[^']+', '([^']+)'\)/.exec(src)?.[1] ?? '';
      expect(/Space|\(1–4\)|\bA or\b|press|\(or [A-Z]\)/.test(title) || /this\.keysHelp = /.test(src), f).toBe(true);
    }
  });

  it('fishing says each fish, the bite, the verdict and its result card; the sorting office says each parcel', () => {
    const fishing = read('src/game/scenes/FishingScene.ts');
    expect(fishing).toMatch(/announce\(fishLine\(item, CLASSES\)\)/);
    expect(fishing).toMatch(/announce\('Bite! Press Space now!'/);
    expect(fishing).toMatch(/endKeysLine\(/);
    const sort = read('src/game/scenes/games/SortGame.ts');
    expect(sort).toMatch(/this\.speak\(`Parcel \$\{label\(b\.p\)\}\.`, true\)/);
    expect(sort).toMatch(/this\.keysHelp = sortKeysLine\(\)/);
  });

  it('a game names the canvas for itself while it runs, and gives the city its label back', () => {
    for (const f of ['src/game/scenes/games/MiniGame.ts', 'src/game/scenes/FishingScene.ts']) {
      const src = read(f);
      expect(src, f).toMatch(/setAttribute\('aria-label', .*mini-game/);
      expect(src, f).toMatch(/onSceneEnd\(this, \(\) => cityLabel && canvas\?\.setAttribute\('aria-label', cityLabel\)\)/);
    }
  });
});

describe('a game in the side panel uses the panel’s height', () => {
  it('a scene lays out at the size its parent has now (the stage grew for the game), not the size Phaser last saw', () => {
    const scale = { getParentBounds: vi.fn(() => true), refresh: vi.fn() };
    fitParent(scale);
    expect(scale.refresh).toHaveBeenCalledOnce();
    const same = { getParentBounds: vi.fn(() => false), refresh: vi.fn() };
    fitParent(same);
    expect(same.refresh).not.toHaveBeenCalled();
    // …before anything is laid out: the first thing create() does after the clock.
    const mini = read('src/game/scenes/games/MiniGame.ts');
    const fishing = read('src/game/scenes/FishingScene.ts');
    expect(mini.indexOf('fitParent(this.scale)')).toBeLessThan(mini.indexOf('this.setup();'));
    expect(mini.indexOf('fitParent(this.scale)')).toBeGreaterThan(mini.indexOf('  create() {'));
    expect(fishing.indexOf('fitParent(this.scale)')).toBeLessThan(fishing.indexOf('    this.build();'));
  });

  it('the play column at the panel’s full height (400×860) reaches far below the old 282 px strip', () => {
    // The stage inside the panel: 382 px wide; 282 px tall in the city's strip, about 808 px for a game.
    const strip = playColumn(382, 282, 58, 494);
    const full = playColumn(382, 808, 58, 494);
    expect(strip.y).toBe(58);
    expect(full.bottom).toBe(808);
    expect(full.y + full.h).toBeGreaterThan(282 + 200);
    // With no content height the column is the whole room under the chrome.
    expect(playColumn(382, 808, 58).h).toBe(750);
    // Centred and capped in the wide tab.
    expect(playColumn(1400, 880, 58, 400)).toMatchObject({ w: 760, x: 320, cx: 700 });
  });
});
