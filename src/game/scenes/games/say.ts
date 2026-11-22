import { SHELVES } from './sorting';

/**
 * What a mini-game says to a screen reader (pure: no Phaser, no store). The canvas has no text a screen reader can
 * read, so each game speaks its goal and keys at the start, each thing to answer, every answer with the score, and the
 * end card's result and keys, through the one polite live region (src/state/announce.ts).
 */

/** A game's name without its leading emoji ("📦 DynamoDB Sorting Office" → "DynamoDB Sorting Office"). */
export const plainName = (title: string) => title.split(' — ')[0].replace(/^[^\p{L}\p{N}]+/u, '').trim();

/**
 * Canvas text in words: a ✓ / ✅ is "Right:", a ✗ / ❌ "Wrong:", a lesson's leading ⭐⭐ "2 stars.", a " · " a comma,
 * an ellipsis a full stop. Other emoji stay (the sorting office's 🍎 is the parcel itself, and screen readers name it).
 */
export function spoken(text: string): string {
  return text
    .replace(/^(⭐+)\s*/u, (_, s: string) => `${[...s].length} ${[...s].length === 1 ? 'star' : 'stars'}. `)
    .replace(/[✓✅]\uFE0F?\s*/gu, 'Right: ')
    .replace(/[✗❌]\uFE0F?\s*/gu, 'Wrong: ')
    .replace(/\s+·\s+/g, ', ')
    .replace(/…/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The building a round grew, in words (src/state/growth.ts growthLine, without the slash). */
export const growthSaid = (g: { place: string; xp: number; next?: number; nextName?: string }) =>
  g.next === undefined ? `${g.place} is fully grown.` : `${g.place}: ${g.xp} of ${g.next} to ${g.nextName}.`;

/** The round's first line: the game, how to play (its title's second half), its keys, and the clock. */
export function startLine({ title, keys = '', seconds, untimed }: { title: string; keys?: string; seconds: number; untimed: boolean }): string {
  const how = title.split(' — ')[1] ?? '';
  const clock = untimed ? 'No clock: press Enter when you’re done.' : seconds ? `You have ${seconds} seconds.` : '';
  return [`${plainName(title)}.`, how && `${how.charAt(0).toUpperCase()}${how.slice(1)}.`, keys, clock].filter(Boolean).join(' ');
}

/** A right or wrong answer that came with no words of its own: what it scored, then the score. */
export function scoreLine(moved: number, score: number, said: boolean): string {
  const total = `Score ${score}.`;
  if (said || !moved) return total;
  return `${moved > 0 ? `Right, plus ${moved}` : `Wrong, minus ${-moved}`}. ${total}`;
}

/** The end card's keys (src/game/scenes/games/gameKeys.ts `endCardKey`). */
export const endKeysLine = (expert: boolean) =>
  `Press Enter to play again${expert ? ', X for the Expert round' : ''}, or Escape to go back to the city.`;

/** The end card in words: the result, what it paid, why a round didn't count, the building it grew, the lesson, the keys. */
export function endLine(o: {
  newBest: boolean;
  score: number;
  stars: number;
  coins: number;
  best: string;
  notes: string[];
  growth: string;
  lesson: string;
  expert: boolean;
}): string {
  const pay = `${o.stars} ${o.stars === 1 ? 'star' : 'stars'}${o.coins ? ` and ${o.coins} City Coins` : ''}`;
  return [o.newBest ? 'New best!' : 'Round over.', `Score ${o.score}.`, `You earned ${pay}.`, `${o.best.charAt(0).toUpperCase()}${o.best.slice(1)}.`, ...o.notes, o.growth, o.lesson, endKeysLine(o.expert)]
    .map(spoken)
    .filter(Boolean)
    .join(' ');
}

/** The sorting office's keys and shelves, for its first line: the shelves are only drawn. */
export const sortKeysLine = () =>
  `Press 1 to ${SHELVES.length} to send the parcel at the front to that shelf. ${SHELVES.map((keys, i) => `Shelf ${i + 1} holds ${keys.join(' and ')}`).join('. ')}.`;

/** A fish on the line, its hint, and the buckets to drop it in (S3 Lake, src/game/scenes/FishingScene.ts). */
export const fishLine = (fish: { name: string; hint: string }, buckets: readonly { label: string; note: string }[]) =>
  `You caught ${fish.name}: “${fish.hint}”. Which storage class? ${buckets.map((b, i) => `${i + 1} ${b.label}, ${b.note.replace(/\s*·\s*/g, ', ')}`).join('. ')}.`;
