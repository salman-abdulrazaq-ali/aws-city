import { beforeEach, describe, expect, it } from 'vitest';
import { memoryLedger } from '@/learning/dailyLedger';
import { FIRST_PASS_BONUS, firstTryToday, IMPROVE_XP, passHint, PASS_XP, penaltyLine, puzzleReward, rescued, TRY_XP } from '@/learning/puzzleRewards';
import { slotsOf } from '@/learning/diagram';
import { deckFor } from '@/learning/puzzleDraft';
import { scoreDiagram } from '@/learning/scoring';
import { PUZZLE_PASS } from '@/state/ladder';
import { useCity } from '@/state/store';
import { PUZZLES } from '@/world/content';
import { puzzleForJob } from '@/learning/jobPuzzle';
import { ALL_TASKS } from '@/world/clients';

// Drawing an architecture grows the buildings it uses, and a 50 says why it isn't a pass yet.
const p = { required: ['s3', 'lambda', 'cloudfront'] };

describe('puzzle rewards', () => {
  it('a first pass pays every building, most to the first', () => {
    const r = puzzleReward(p, { passed: true, score: 82, missing: [] }, 0, false);
    expect(r.kind).toBe('first');
    expect(r.xp).toEqual({ s3: PASS_XP + FIRST_PASS_BONUS, lambda: PASS_XP, cloudfront: PASS_XP });
  });

  it('a better pass pays a little; the same answer again pays nothing', () => {
    expect(puzzleReward(p, { passed: true, score: 90, missing: [] }, 82, false).xp).toEqual({ s3: IMPROVE_XP, lambda: IMPROVE_XP, cloudfront: IMPROVE_XP });
    expect(puzzleReward(p, { passed: true, score: 82, missing: [] }, 82, false).kind).toBe('none');
  });

  it('a 50 still grows the pieces already right, once a day', () => {
    const r = puzzleReward(p, { passed: false, score: 50, missing: ['cloudfront'] }, 0, false);
    expect(r).toEqual({ kind: 'try', xp: { s3: TRY_XP, lambda: TRY_XP } });
    expect(puzzleReward(p, { passed: false, score: 50, missing: ['cloudfront'] }, 0, true).kind).toBe('none');
    const seen = memoryLedger();
    expect(firstTryToday('x', '2026-10-13', seen)).toBe(true);
    expect(firstTryToday('x', '2026-10-13', seen)).toBe(false);
    expect(firstTryToday('x', '2026-10-14', seen)).toBe(true);
  });

  it('says the pass rule and what is in the way', () => {
    expect(passHint({ passed: false, score: 50, missing: ['cloudfront'] }, (id) => id)).toBe('To pass: 70 or more with nothing missing. You’re at 50: add cloudfront and score 20 more.'.replace('’', "'"));
    expect(passHint({ passed: true, score: 80, missing: [] }, (id) => id)).toBeUndefined();
  });
});

describe('puzzle best is the best pass', () => {
  beforeEach(() => useCity.getState().resetSession());

  it('a failed try is not recorded, so it can never block the stars for a later pass', () => {
    const s = () => useCity.getState();
    s().recordPuzzle('thumbnails', 83, false);
    expect(s().progress.puzzles?.thumbnails).toBeUndefined();
    s().recordPuzzle('thumbnails', 80, true);
    expect(s().progress.puzzles?.thumbnails?.best).toBe(80);
    s().recordPuzzle('thumbnails', 75, true);
    expect(s().progress.puzzles?.thumbnails?.best).toBe(80);
  });
});

describe('mistakes on the way cost points and stars, never the pass', () => {
  // Every architecture puzzle, and every City Clients "Wire it" job (the same board).
  const drawn = [...PUZZLES.filter((z) => z.diagram), ...ALL_TASKS.flatMap(({ task }) => (task.type === 'wire' ? [puzzleForJob(task)] : []))];
  const complete = (z: (typeof drawn)[number]) => Object.fromEntries(slotsOf(z).filter((s) => s.required).map((s) => [s.id, s.service]));

  it('a complete, correct design passes after any number of decoys, wrong spots and hints, for every puzzle and both decks', () => {
    expect(drawn.length).toBeGreaterThan(PUZZLES.length);
    let decoysTried = 0;
    for (const z of drawn) {
      const full = complete(z);
      const clean = scoreDiagram(z, { placements: full, distractorDrops: [], misdrops: 0 });
      expect(clean.passed, z.id).toBe(true);
      expect(clean.penalty, z.id).toBe(0);
      for (const first of [true, false]) {
        // Every decoy the deck deals, tried (each counts once however often it's dropped).
        const decoys = deckFor(z, first).filter((s) => z.distractors.includes(s));
        decoysTried += decoys.length;
        for (const misdrops of [0, 3, 40])
          for (const reveals of [0, 2, 30]) {
            const r = scoreDiagram(z, { placements: full, distractorDrops: [...decoys, ...decoys], misdrops, reveals });
            const what = `${z.id} first=${first} decoys=${decoys.length} misdrops=${misdrops} reveals=${reveals}`;
            expect(r.passed, what).toBe(true);
            expect(r.missing, what).toEqual([]);
            // Best is the best pass: a pass is never recorded below the mark.
            expect(r.score, what).toBeGreaterThanOrEqual(PUZZLE_PASS);
            expect(r.design, what).toBe(clean.design);
            if (decoys.length || misdrops || reveals) {
              expect(r.penalty, what).toBeGreaterThan(0);
              expect(r.score, what).toBeLessThanOrEqual(clean.score);
            } else expect(r.score, what).toBe(clean.score);
          }
      }
    }
    // The decks really deal decoys (the first, gentler deck one each), so the loop above tried them.
    expect(decoysTried).toBeGreaterThan(drawn.length);
  });

  it('a design with a needed piece missing still fails, however clean the way there', () => {
    for (const z of drawn) {
      const full = complete(z);
      const [drop] = Object.keys(full);
      const { [drop]: _gone, ...short } = full;
      expect(scoreDiagram(z, { placements: short, distractorDrops: [], misdrops: 0 }).passed, z.id).toBe(false);
    }
  });

  it('a pass the mistakes would have failed pays every building but not the first-pass bonus, and keeps 70 as its best', () => {
    const z = drawn.find((x) => x.distractors.length >= 2)!;
    const r = scoreDiagram(z, { placements: complete(z), distractorDrops: z.distractors, misdrops: 20, reveals: 10 });
    expect(r.passed).toBe(true);
    expect(rescued(r)).toBe(true);
    expect(r.score).toBe(PUZZLE_PASS);
    const pay = puzzleReward(z, r, 0, false);
    expect(pay.kind).toBe('first');
    expect(pay.xp).toEqual(Object.fromEntries(z.required.map((s) => [s, PASS_XP])));
    // A clean pass later is a better one: it pays the improvement.
    const clean = scoreDiagram(z, { placements: complete(z), distractorDrops: [], misdrops: 0 });
    expect(puzzleReward(z, clean, r.score, false).kind).toBe(clean.score > r.score ? 'better' : 'none');
    expect(penaltyLine(r)).toMatch(/^Mistakes on the way cost \d+ points and the first-pass bonus, never the pass\. Start fresh/);
    expect(penaltyLine(clean)).toBeUndefined();
  });

  it('a pass with a few mistakes still pays the first-pass bonus; the rule speaks of the design on the board', () => {
    const r = { passed: true, score: 80, missing: [], design: 92, penalty: 12 };
    expect(rescued(r)).toBe(false);
    expect(puzzleReward(p, r, 0, false).xp.s3).toBe(PASS_XP + FIRST_PASS_BONUS);
    expect(penaltyLine(r)).toBe('Mistakes on the way cost 12 points, never the pass. Start fresh to clear them.');
    // Failing: the hint counts the design itself, not the points mistakes took.
    expect(passHint({ passed: false, score: 40, missing: ['cloudfront'], design: 60, penalty: 20 }, (id) => id)).toBe("To pass: 70 or more with nothing missing. You're at 60: add cloudfront and score 10 more.");
  });
});
