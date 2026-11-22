import { SITES } from '@/world/layout';
import { placeFor } from '@/world/places';
import { districtById, serviceById, type DistrictId } from '@/world/taxonomy';
import { bus } from './bus';

/**
 * Lines for screen readers, spoken through App's one polite live region (bus `announce`). Each line gets its own
 * update, at least `ANNOUNCE_GAP_MS` apart: lines sent in the same moment (a game's prompt and its score) would
 * otherwise be batched into one render, and only the last would be heard. `replace` drops the lines still waiting, so
 * the newest is always spoken (`]` pressed quickly through the buildings). A line equal to the last one still changes
 * the region (a trailing no-break space, every other time), so a repeat is heard too.
 */
export const ANNOUNCE_GAP_MS = 150;
/** Lines waiting at most: past that the oldest waiting one goes, so speech never falls far behind play. */
const MAX_WAITING = 3;

let waiting: string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let flip = false;

function pump() {
  const next = waiting.shift();
  if (next === undefined) {
    timer = undefined;
    return;
  }
  flip = !flip;
  bus.emit('announce', { text: flip ? next : `${next}\u00a0` });
  timer = setTimeout(pump, ANNOUNCE_GAP_MS);
}

export function announce(text: string, opts: { replace?: boolean } = {}) {
  const line = text.replace(/\s+/g, ' ').trim();
  if (!line) return;
  if (opts.replace) waiting = [];
  waiting.push(line);
  if (waiting.length > MAX_WAITING) waiting.splice(0, waiting.length - MAX_WAITING);
  if (!timer) pump();
}

/**
 * What `]` / `[` say about the building they stepped to (CityScene.stepBuilding): its name as its sign shows it (a
 * service's place, a district HQ, the Day 1 Office, the Correction of Error board…), the service's one plain line, and
 * where it is in the order. Never a raw id: `label` is the sign's text, and without one the name is looked up.
 */
export function stepLine(id: string, label: string | undefined, at: number, of: number): string {
  const place = placeFor(id);
  const hq = id.startsWith('hq:') ? districtById(id.slice(3) as DistrictId)?.hq : undefined;
  const name = place?.place ?? (label?.trim() || undefined) ?? hq ?? serviceById(id)?.name ?? SITES.find((s) => s.id === id)?.site?.label ?? 'A building';
  return `${name}. ${place?.simple ?? ''} ${at} of ${of}.`.replace(/\s+/g, ' ').trim();
}
