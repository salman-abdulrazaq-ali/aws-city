import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Progress } from '@/backend/contract';
import { FIRST_STEPS, FIRST_STEPS_OF, FIRST_STEPS_QUEST, firstStep, TUTORIAL_DECK } from '@/state/firstSteps';
import { cardsFor, questById } from '@/world/content';
import type { Tile } from '@/world/layout';
import { endKeysLine } from '@/game/scenes/games/say';
import { fishingKey } from '@/game/scenes/games/gameKeys';
import {
  cityShows,
  fishingEnd,
  followsKai,
  pathEndKey,
  PLANT_FAR,
  PLANT_NEAR,
  plantedFor,
  plantedRequest,
  plantTile,
  stormLine,
  stormLook,
  streetQuestions,
  verdictLine,
} from '@/game/firstStepsGame';

const root = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const p = (over: Partial<Progress> = {}): Progress => ({ version: 1, landmarks: {}, updatedAt: '2026-01-01T00:00:00.000Z', ...over });
const on = (step: number) => p({ quests: { [FIRST_STEPS_QUEST]: { status: 'active', step, count: 0 } } });
const done = p({ quests: { [FIRST_STEPS_QUEST]: { status: 'done', step: FIRST_STEPS_OF } } });
const legacy = p({ quests: { 'storage-static-site': { status: 'active', step: 1 } } });
const dist = (a: Tile, b: Tile) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** A street grid: every tile in rows y = 5 and y = 9 and columns x = 4 and x = 12, inside 0..20. */
const streets: Tile[] = [];
for (let x = 0; x <= 20; x++) for (let y = 0; y <= 20; y++) if (y === 5 || y === 9 || x === 4 || x === 12) streets.push({ x, y });

describe('the quiet city on the canvas: tokens and random questions wait', () => {
  it('neither shows on the first steps, on any step, nor on a replay', () => {
    for (let step = 0; step < FIRST_STEPS_OF; step++) {
      expect(cityShows('tokens', on(step), { firstSteps: 'beginner' })).toBe(false);
      expect(cityShows('citizenRequests', on(step), { firstSteps: 'beginner' })).toBe(false);
    }
    expect(cityShows('tokens', done, { firstSteps: 'replay', firstStepsReplay: { step: 2 } })).toBe(false);
  });

  it('both come back at graduation, read live (a new Progress, no reload), and never leave a legacy or skipped player', () => {
    const prefs = { firstSteps: 'beginner' as const };
    expect(cityShows('tokens', on(5), prefs)).toBe(false);
    expect(cityShows('tokens', done, prefs)).toBe(true);
    expect(cityShows('citizenRequests', done, prefs)).toBe(true);
    expect(cityShows('tokens', legacy, {})).toBe(true);
    expect(cityShows('citizenRequests', on(2), { firstSteps: 'skipped' })).toBe(true);
    expect(cityShows('tokens', p(), {})).toBe(true);
  });

  it('random questions pause while quiet (none spawns, one already up goes); the planted one never waits', () => {
    expect(streetQuestions(true, 'none')).toEqual({ spawnRandom: false, dropCurrent: false });
    expect(streetQuestions(true, 'random')).toEqual({ spawnRandom: false, dropCurrent: true });
    expect(streetQuestions(true, 'planted')).toEqual({ spawnRandom: false, dropCurrent: false });
    expect(streetQuestions(false, 'none')).toEqual({ spawnRandom: true, dropCurrent: false });
    expect(streetQuestions(false, 'random')).toEqual({ spawnRandom: false, dropCurrent: false });
  });

  it('the path’s request step plants its citizen (S3), and no other step does', () => {
    expect(plantedFor(firstStep(on(3), { firstSteps: 'beginner' }))).toBe('s3');
    for (const step of [0, 1, 2, 4, 5]) expect(plantedFor(firstStep(on(step), { firstSteps: 'beginner' }))).toBeUndefined();
    expect(plantedFor(firstStep(done, { firstSteps: 'beginner' }))).toBeUndefined();
  });
});

describe('the planted citizen (bus requestNow)', () => {
  const lake: Tile = { x: 12, y: 2 };

  it('stands a few tiles from Kai, on a street, on the building’s side', () => {
    const kai = { x: 12, y: 9 };
    const t = plantTile(kai, lake, streets)!;
    expect(streets).toContainEqual(t);
    expect(dist(t, kai)).toBeGreaterThanOrEqual(PLANT_NEAR);
    expect(dist(t, kai)).toBeLessThanOrEqual(PLANT_FAR);
    // Of the tiles in reach, none is nearer the lake.
    const reach = streets.filter((s) => dist(s, kai) >= PLANT_NEAR && dist(s, kai) <= PLANT_FAR);
    expect(Math.min(...reach.map((s) => dist(s, lake)))).toBe(dist(t, lake));
    expect(t).toEqual({ x: 12, y: 5 });
  });

  it('picks the same tile every time, whatever order the streets come in (no random draw)', () => {
    const kai = { x: 4, y: 9 };
    const a = plantTile(kai, lake, streets);
    const shuffled = [...streets].sort((x, y) => ((x.x * 7 + x.y * 13) % 11) - ((y.x * 7 + y.y * 13) % 11));
    expect(plantTile(kai, lake, shuffled)).toEqual(a);
    expect(plantTile(kai, lake, [...streets].reverse())).toEqual(a);
  });

  it('never on Kai: the nearest other street when none is in reach, nothing with no streets', () => {
    const kai = { x: 4, y: 5 };
    expect(plantTile(kai, lake, [kai, { x: 4, y: 6 }])).toEqual({ x: 4, y: 6 });
    expect(plantTile(kai, lake, [kai])).toBeUndefined();
    expect(plantTile(kai, undefined, [])).toBeUndefined();
    // No building known: by Kai.
    const t = plantTile(kai, undefined, streets)!;
    expect(dist(t, kai)).toBeGreaterThanOrEqual(PLANT_NEAR);
  });

  it('asks about a tutorial card, one the player said "Didn’t know" first, its wrong answers the deck’s others', () => {
    const fresh = plantedRequest(p(), 's3')!;
    expect(TUTORIAL_DECK).toContain(fresh.cardId);
    const short = (id: string) => {
      const c = cardsFor('s3').find((x) => x.id === id)!;
      return c.simple ?? c.a;
    };
    expect(new Set(fresh.options)).toEqual(new Set(TUTORIAL_DECK.map(short)));
    expect(fresh.options[fresh.right]).toBe(short(fresh.cardId));
    // Answered "Didn't know" (reps 0) beats the others.
    const missed = TUTORIAL_DECK[1];
    const cards: Progress['cards'] = Object.fromEntries(TUTORIAL_DECK.map((id) => [id, { ease: 2.5, interval: id === missed ? 0 : 1, reps: id === missed ? 0 : 1, due: 0 }]));
    expect(plantedRequest(p({ cards }), 's3')!.cardId).toBe(missed);
    // The card the UI names wins.
    expect(plantedRequest(p({ cards }), 's3', TUTORIAL_DECK[2])!.cardId).toBe(TUTORIAL_DECK[2]);
  });

  it('is the same question each time it opens (no random draw), and its right answer isn’t always first', () => {
    for (const id of TUTORIAL_DECK) expect(plantedRequest(p(), 's3', id)).toEqual(plantedRequest(p(), 's3', id));
    const spots = new Set(TUTORIAL_DECK.map((id) => plantedRequest(p(), 's3', id)!.right));
    expect(spots.size).toBeGreaterThan(1);
  });

  it('a service with no tutorial card still asks one of its own', () => {
    const r = plantedRequest(p(), 'lambda');
    expect(r && cardsFor('lambda').some((c) => c.id === r.cardId)).toBe(true);
  });

  it('says the path’s line', () => {
    expect(FIRST_STEPS.steps[3]?.citizen).toBeTruthy();
  });
});

describe('the walk to S3 Lake: the camera goes with Kai', () => {
  it('only on the path’s visit step, to its building', () => {
    const q = questById(FIRST_STEPS_QUEST)!;
    expect(followsKai(q.steps[0], 's3')).toBe(true);
    expect(followsKai(q.steps[0], 'lambda')).toBe(false);
    expect(followsKai(q.steps[1], 's3')).toBe(false);
    expect(followsKai(undefined, 's3')).toBe(false);
  });
});

describe('the first world map: storms are still and grey, Oregon is the only pulse', () => {
  it('still on a first run, today’s rings later', () => {
    expect(stormLook(true)).toBe('still');
    expect(stormLook(false)).toBe('pulse');
  });

  it('a first run with no account reads the plain line; later visits and linked accounts keep today’s', () => {
    const today = '⛈️ AWS reports a disruption here · updated 2 days ago';
    expect(stormLine(true, false, today)).toBe(FIRST_STEPS.map.storm);
    expect(FIRST_STEPS.map.storm).not.toMatch(/your account/i);
    expect(stormLine(false, false, today)).toBe(today);
    expect(stormLine(true, true, today)).toBe(today);
  });
});

describe('the S3 Fishing end card', () => {
  const primaries = (o: ReturnType<typeof fishingEnd>) => o.buttons.filter((b) => b.primary);

  it('on the first steps: Back to the city leads, Play again is graphite, no Expert, tips or coins', () => {
    for (const expert of [false, true]) {
      const end = fishingEnd(true, expert);
      expect(primaries(end)).toEqual([{ action: 'leave', label: `${FIRST_STEPS.steps[1].end} (Enter)`, primary: true }]);
      expect(end.buttons.map((b) => b.action)).toEqual(['leave', 'again']);
      expect(end).toMatchObject({ tips: false, coins: false });
      expect(end.keysLine).toBe('Press Enter or Escape to go back to the city, or Space to play again.');
    }
  });

  it('on the first steps Enter and Escape go back, Space plays again, X does nothing', () => {
    expect(pathEndKey('Enter')).toBe('leave');
    expect(pathEndKey('Escape')).toBe('leave');
    expect(pathEndKey(' ')).toBe('again');
    expect(pathEndKey('x')).toBeUndefined();
    expect(pathEndKey('1')).toBeUndefined();
  });

  it('otherwise today’s card, unchanged: Play again leads, Expert once it’s open, then ← City', () => {
    expect(fishingEnd(false, false).buttons.map((b) => [b.action, b.primary])).toEqual([
      ['again', true],
      ['leave', false],
    ]);
    expect(fishingEnd(false, true).buttons.map((b) => b.action)).toEqual(['again', 'expert', 'leave']);
    expect(primaries(fishingEnd(false, true))).toHaveLength(1);
    expect(fishingEnd(false, true)).toMatchObject({ tips: true, coins: true });
    // Its keys and their line are the game's own (gameKeys.ts, games/say.ts endKeysLine).
    expect(fishingEnd(false, true).keysLine).toBeUndefined();
    expect(endKeysLine(true)).toMatch(/X for the Expert round/);
    expect(fishingKey('summary', 'Enter', 3)).toEqual({ kind: 'again' });
  });

  it('the last catch’s verdict keeps right or wrong and drops the tip on the path', () => {
    const why = 'Hot data → Standard. Tip: put CloudFront in front of it.';
    expect(verdictLine(true, 'S3 Standard', why, true)).toBe(`✅ Correct! ${why}`);
    expect(verdictLine(false, 'S3 Standard', why, true)).toBe(`❌ Not quite: it’s S3 Standard. ${why}`);
    expect(verdictLine(true, 'S3 Standard', why, false)).toBe('✅ Correct!');
    expect(verdictLine(false, 'S3 Standard', why, false)).not.toMatch(/CloudFront|lifecycle/i);
  });
});

describe('the scenes are wired to the path (static: Phaser scenes don’t run under vitest)', () => {
  it('the city hears say, graduated and walkTo; the requests hear requestNow and walkToRequest', () => {
    const city = read('src/game/scenes/CityScene.ts');
    for (const ev of ['say', 'graduated', 'walkTo']) expect(city).toContain(`bus.on('${ev}'`);
    const req = read('src/game/Requests.ts');
    for (const ev of ['requestNow', 'walkToRequest', 'citizenRequestDone']) expect(req).toContain(`bus.on('${ev}'`);
  });

  it('tokens, requests, the world map and fishing read the path’s rules', () => {
    expect(read('src/game/Tokens.ts')).toContain("cityShows('tokens'");
    expect(read('src/game/Requests.ts')).toContain("cityShows('citizenRequests'");
    expect(read('src/game/scenes/WorldScene.ts')).toMatch(/stormLook\(/);
    expect(read('src/game/scenes/FishingScene.ts')).toMatch(/fishingEnd\(this\.onPath/);
  });

  it('the rules draw nothing at random (determinism, CLAUDE.md)', () => {
    expect(read('src/game/firstStepsGame.ts')).not.toMatch(/Math\.random|\brng\(/);
  });
});
