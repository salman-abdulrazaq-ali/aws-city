// What an architecture drawing pays the buildings it uses. Drawing is the hardest learning in the city, so it pays the
// most (it used to pay 5 per service on a better pass and nothing below the pass mark, so a 50 grew nothing):
// - a first pass: PASS_XP to every required service, plus FIRST_PASS_BONUS to the puzzle's first one when the score with
//   the mistakes on the way still reaches the pass mark (src/learning/scoring.ts: mistakes cost stars, never the pass);
// - a better pass later: IMPROVE_XP each (re-checking the same answer pays nothing);
// - a try below the pass mark: TRY_XP for each required service already in place, once per puzzle per day.
// `best` only ever records a passing score (src/state/store.ts recordPuzzle), so a failed try can't block a later pass.
import { PUZZLE_PASS } from '@/state/ladder';
import { dayKey } from '@/state/progress';
import { deviceLedger, takeDaily, type LedgerStore } from './dailyLedger';

export const PASS_XP = 12;
export const FIRST_PASS_BONUS = 10;
export const IMPROVE_XP = 4;
export const TRY_XP = 2;

export type RewardKind = 'first' | 'better' | 'try' | 'none';

export interface PuzzleReward {
  kind: RewardKind;
  /** Stars per service id. */
  xp: Record<string, number>;
}

/** A checked design, as the rewards read it (src/learning/scoring.ts PuzzleScore). */
export interface CheckedDesign {
  passed: boolean;
  score: number;
  missing: string[];
  /** The board's own score, before the mistakes on the way (absent: the same as `score`). */
  design?: number;
  /** What the mistakes on the way cost (absent: nothing). */
  penalty?: number;
}

/** A pass that only counts because mistakes on the way no longer fail it: its score with them is under the mark. */
export const rescued = (r: CheckedDesign) => r.passed && (r.design ?? r.score) - (r.penalty ?? 0) < PUZZLE_PASS;

export function puzzleReward(puzzle: { required: string[] }, result: CheckedDesign, prevBest: number, triedToday: boolean): PuzzleReward {
  const xp: Record<string, number> = {};
  if (result.passed && prevBest < PUZZLE_PASS) {
    for (const s of puzzle.required) xp[s] = PASS_XP;
    if (puzzle.required[0] && !rescued(result)) xp[puzzle.required[0]] += FIRST_PASS_BONUS;
    return { kind: 'first', xp };
  }
  if (result.passed) {
    if (result.score <= prevBest) return { kind: 'none', xp };
    for (const s of puzzle.required) xp[s] = IMPROVE_XP;
    return { kind: 'better', xp };
  }
  if (triedToday) return { kind: 'none', xp };
  for (const s of puzzle.required) if (!result.missing.includes(s)) xp[s] = TRY_XP;
  return { kind: Object.keys(xp).length ? 'try' : 'none', xp };
}

/** True once per puzzle per (local) day; marks it. Kept in the daily ledger, so a reload isn't a fresh try. */
export const firstTryToday = (puzzleId: string, day = dayKey(), store: LedgerStore = deviceLedger) => takeDaily(`try:${puzzleId}`, 1, day, store);

/** The pass rule in a sentence, with what's in the way: the design on the board, whatever the mistakes on the way. */
export function passHint(result: CheckedDesign, names: (id: string) => string) {
  if (result.passed) return undefined;
  const design = result.design ?? result.score;
  const needs: string[] = [];
  if (result.missing.length) needs.push(`add ${result.missing.map(names).join(', ')}`);
  if (design < PUZZLE_PASS) needs.push(`score ${PUZZLE_PASS - design} more`);
  return `To pass: ${PUZZLE_PASS} or more with nothing missing. You're at ${design}${needs.length ? `: ${needs.join(' and ')}` : ''}.`;
}

/** What the mistakes on the way cost, in a sentence (undefined when they cost nothing). */
export function penaltyLine(result: CheckedDesign) {
  if (!result.penalty) return undefined;
  const bonus = rescued(result) ? ' and the first-pass bonus' : '';
  return `Mistakes on the way cost ${result.penalty} ${result.penalty === 1 ? 'point' : 'points'}${bonus}, never the pass. Start fresh to clear them.`;
}
