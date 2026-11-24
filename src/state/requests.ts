// Citizen requests: now and then a passer-by has a quick AWS question. Kai walks over and answers it, and the answer
// is an ordinary flashcard review (src/learning/srs.ts) for a building the city already has, so it grows that building
// like any card would, plus a small thank-you. Pure: the scene picks the citizen, the card shows the question.

import type { Progress } from '@/backend/contract';
import { cardsFor, type Flashcard } from '@/world/content';
import { serviceById } from '@/world/taxonomy';
import { isDiscovered } from './selectors';
import { dueDeck } from './srs';

export interface CitizenRequest {
  cardId: string;
  serviceId: string;
  question: string;
  /** Three answers in simple words, one of them right (`right` is its index). */
  options: string[];
  right: number;
  /** The full answer, shown after. */
  answer: string;
}

/** At most this many a day: a treat in the street, not a quiz wall. */
export const REQUESTS_A_DAY = 5;
/** Stars a thank-you adds on top of the card's own (src/learning/srs.ts xpFor). */
export const THANKS_STARS = 2;
/** How long the city waits between one request and the next (ms). */
export const REQUEST_GAP_MS = 90_000;

export interface RequestLog {
  day: string;
  n: number;
}
export const requestsLeft = (log: RequestLog | undefined, today: string) => Math.max(0, REQUESTS_A_DAY - (log?.day === today ? log.n : 0));
export const countRequest = (log: RequestLog | undefined, today: string): RequestLog => ({ day: today, n: (log?.day === today ? log.n : 0) + 1 });
/** Where the day's count is kept on this device (src/ui/RequestCard.tsx counts a request when it's answered). */
export const REQUEST_LOG_KEY = 'awscity.requests';

const short = (c: Flashcard) => c.simple ?? c.a;

/**
 * A request for the city in `region`: a card that's due (or new) from a building that stands there, with two wrong
 * answers from the same building's other cards (other buildings' when it has too few). `seed` picks which (the same seed, the same request). Undefined when the
 * city has nothing to ask about yet.
 */
export function pickRequest(p: Progress, region: string | undefined, seed: number, now = Date.now()): CitizenRequest | undefined {
  const here = Object.keys(p.cities?.[region ?? '']?.landmarks ?? {})
    .concat(Object.keys(p.landmarks))
    .filter((id, i, all) => all.indexOf(id) === i && serviceById(id) && isDiscovered(p, id, region) && cardsFor(id).length > 0)
    .sort();
  if (!here.length) return undefined;
  const deck = dueDeck(p, here, 3, now);
  if (!deck.length) return undefined;
  const card = deck[Math.abs(seed) % deck.length]!;
  const serviceId = here.find((id) => cardsFor(id).some((c) => c.id === card.id))!;
  return requestOf(card, serviceId, here, seed);
}

/**
 * The first steps' planted citizen (bus requestNow): a question on one card, chosen now. `cardId` when the caller
 * names one; else one of `deck` (the tutorial deck) the player last answered "Didn't know" (it's the one worth
 * remembering now), else the deck's first answered card, else its first. Wrong answers as in pickRequest, from the
 * service's other cards. Undefined when the service has no such card.
 */
export function requestFor(p: Progress, serviceId: string, opts: { cardId?: string; deck?: readonly string[]; seed?: number } = {}): CitizenRequest | undefined {
  const cards = cardsFor(serviceId);
  const inDeck = opts.deck?.length ? cards.filter((c) => opts.deck!.includes(c.id)) : cards;
  const missed = inDeck.find((c) => p.cards?.[c.id] && p.cards[c.id].reps === 0);
  const seen = inDeck.find((c) => p.cards?.[c.id]);
  const card = (opts.cardId ? cards.find((c) => c.id === opts.cardId) : undefined) ?? missed ?? seen ?? inDeck[0];
  if (!card) return undefined;
  // The deck's other cards are the wrong answers: things the player just learned, so the question asks which is which.
  const pool = opts.deck?.length && inDeck.length >= 3 ? inDeck : undefined;
  return requestOf(card, serviceId, [serviceId], opts.seed ?? 0, pool);
}

/** A question on `card` with two wrong answers: the same building's other cards first, then the other buildings'. */
function requestOf(card: Flashcard, serviceId: string, here: string[], seed: number, pool?: Flashcard[]): CitizenRequest | undefined {
  // Wrong answers from the same building's other cards first (they sound alike, so the question needs knowing, not
  // spotting which answer is about the right service), then from other buildings when its deck is too small.
  const right = short(card);
  const same = [...new Set((pool ?? cardsFor(serviceId)).filter((c) => c.id !== card.id).map(short))].filter((t) => t !== right);
  const rest = [...new Set(here.filter((id) => id !== serviceId).flatMap(cardsFor).map(short))].filter((t) => t !== right && !same.includes(t));
  const pick = (from: string[], salt: number) => from[Math.abs(seed * salt + 3) % from.length]!;
  const a = same.length ? pick(same, 7) : rest.length ? pick(rest, 7) : undefined;
  const sameLeft = same.filter((t) => t !== a);
  const restLeft = rest.filter((t) => t !== a);
  const b = sameLeft.length ? pick(sameLeft, 13) : restLeft.length ? pick(restLeft, 13) : undefined;
  if (!a || !b) return undefined;
  const at = Math.abs(seed) % 3;
  const options = [a, b];
  options.splice(at, 0, right);
  return { cardId: card.id, serviceId, question: card.q, options, right: at, answer: card.a };
}
