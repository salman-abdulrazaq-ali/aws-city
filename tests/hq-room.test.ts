// A district HQ seats what fits and stands the rest (src/game/hqRoom.ts): districts have 6 to 11 services and the room
// has 6 desks, and a 7th service found used to throw before the camera was set (23 Nov 2026).
import { describe, expect, it } from 'vitest';
import { DOOR, piecesFor, ROOM_H, ROOM_W, SEATS, staffSpots, tilesOf } from '@/game/hqRoom';
import type { Tile } from '@/world/layout';
import { DISTRICTS, servicesIn, type DistrictId } from '@/world/taxonomy';

const key = (t: Tile) => t.y * ROOM_W + t.x;
const inRoom = (t: Tile) => t.x >= 0 && t.y >= 0 && t.x < ROOM_W && t.y < ROOM_H;

/** The tiles nobody walks on once the room is furnished for `count` staff (furniture, then the desks in use). */
function blockedFor(districtId: string, count: number) {
  const blocked = new Set<number>();
  for (const p of piecesFor(districtId)) for (const t of tilesOf(p)) blocked.add(key(t));
  for (const s of staffSpots(count)) if (s?.desk) blocked.add(key(s.desk));
  return blocked;
}

/** Every tile Kai can reach from the door. */
function reachable(blocked: Set<number>) {
  const seen = new Set([key(DOOR)]);
  const queue = [DOOR];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: t.x + dx, y: t.y + dy };
      if (inRoom(n) && !blocked.has(key(n)) && !seen.has(key(n))) {
        seen.add(key(n));
        queue.push(n);
      }
    }
  }
  return seen;
}

describe('an HQ room staffs a full district', () => {
  it('a district with 11 services found gets 11 work spots: 6 at desks, 5 standing at the racks', () => {
    const spots = staffSpots(11);
    expect(spots).toHaveLength(11);
    expect(spots.every(Boolean)).toBe(true);
    expect(spots.filter((s) => s?.seated)).toHaveLength(SEATS.length);
    expect(spots.slice(SEATS.length).every((s) => s && !s.seated && !s.desk)).toBe(true);
    expect(new Set(spots.map((s) => key(s!.tile))).size).toBe(11);
  });

  it('every district, fully discovered, has a reachable spot for each of its staff and nothing on top of another', () => {
    const ids = DISTRICTS.map((d) => d.id as DistrictId);
    expect(Math.max(...ids.map((d) => servicesIn(d).length))).toBe(11); // security: the largest today
    for (const d of ids) {
      const n = servicesIn(d).length;
      const spots = staffSpots(n);
      expect(spots.every(Boolean), d).toBe(true);
      const furniture = new Set(piecesFor(d).flatMap(tilesOf).map(key));
      const blocked = blockedFor(d, n);
      const open = reachable(blocked);
      for (const s of spots) {
        expect(inRoom(s!.tile), `${d} ${JSON.stringify(s)}`).toBe(true);
        expect(blocked.has(key(s!.tile)), `${d}: a spot under furniture or a desk`).toBe(false);
        expect(open.has(key(s!.tile)), `${d}: a spot Kai can't reach`).toBe(true);
        if (s!.desk) {
          expect(inRoom(s!.desk)).toBe(true);
          expect(furniture.has(key(s!.desk)), `${d}: a desk on furniture`).toBe(false);
        }
      }
      // Kai still walks in from the door to his first tile, and the door is still open to walk out by.
      expect(open.has(key({ x: 2, y: 7 })), d).toBe(true);
      expect(blocked.has(key(DOOR))).toBe(false);
    }
  });

  it('a district bigger than the room still lists everyone (those past the spots only walk), and none is a crash', () => {
    const spots = staffSpots(20);
    expect(spots).toHaveLength(20);
    expect(spots.filter(Boolean)).toHaveLength(11);
    expect(spots.slice(11).every((s) => s === undefined)).toBe(true);
    expect(staffSpots(0)).toEqual([]);
  });

  it('The Spheres seats its three at desks, clear of its garden', () => {
    const spots = staffSpots(3);
    const blocked = blockedFor('spheres', 3);
    const open = reachable(blocked);
    for (const s of spots) {
      expect(s?.seated).toBe(true);
      expect(open.has(key(s!.tile))).toBe(true);
    }
  });

  it('the scene takes its spots from staffSpots, never indexes the desks by hand', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/game/scenes/InteriorScene.ts', 'utf8');
    expect(src).toMatch(/staffSpots\(staff\.length\)/);
    expect(src).not.toMatch(/SEATS\[/);
    // Room text follows ⋯ → Text size, as in the city, and the room's sign is pinned to the top of the view (it stood
    // above the back wall, off-screen at every zoom), with bubbles kept below it.
    expect(src).toMatch(/const text = \(useCity\.getState\(\)\.prefs\.textSize \?\? 100\) \/ 100;\s*const ui = text \/ cam\.zoom;/);
    expect(src).toMatch(/this\.title\.setScale\(ui\)\.setPosition\(cam\.midPoint\.x, cam\.midPoint\.y - cam\.height \/ 2 \/ cam\.zoom/);
    expect(src).toMatch(/setBubbleTopInset\(this, /);
  });
});
