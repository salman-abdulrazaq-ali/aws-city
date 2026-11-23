// A district HQ seats what fits and stands the rest (src/game/hqRoom.ts): districts have 6 to 11 services and the room
// has 6 desks, and a 7th service found used to throw before the camera was set (23 Nov 2026).
import { describe, expect, it } from 'vitest';
import { DOOR, ENTRY, keptClear, piecesFor, ROOM_H, ROOM_W, SEATS, staffPlaces, staffSpots, tilesOf } from '@/game/hqRoom';
import type { Rect, Tile } from '@/world/layout';
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

  it('the scene takes its places from staffPlaces, never indexes the desks or spawns the staff by hand', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('src/game/scenes/InteriorScene.ts', 'utf8');
    expect(src).toMatch(/staffPlaces\(this\.districtId, staff\.length\)/);
    expect(src).not.toMatch(/SEATS\[/);
    // Each starts at its own place and idles on its own patch (they spawned on three tiles: `3 + (i % 3)`).
    expect(src).toMatch(/const \{ start, area, spot \} = places\[i\];/);
    expect(src).toMatch(/tile: start,\s*home: area,\s*workSpot: spot\?\.tile,/);
    expect(src).not.toMatch(/i % 3/);
    // Room text follows ⋯ → Text size, as in the city, and the room's sign is pinned to the top of the view (it stood
    // above the back wall, off-screen at every zoom), with bubbles kept below it.
    expect(src).toMatch(/const text = \(useCity\.getState\(\)\.prefs\.textSize \?\? 100\) \/ 100;\s*const ui = text \/ cam\.zoom;/);
    expect(src).toMatch(/this\.title\.setScale\(ui\)\.setPosition\(cam\.midPoint\.x, cam\.midPoint\.y - cam\.height \/ 2 \/ cam\.zoom/);
    expect(src).toMatch(/setBubbleTopInset\(this, /);
  });
});

/** Every tile of a patch. */
const tilesIn = (r: Rect): Tile[] => Array.from({ length: r.w * r.h }, (_, i) => ({ x: r.x + (i % r.w), y: r.y + Math.floor(i / r.w) }));

describe('the staff spread out: each starts at its own place and idles on its own patch (23 Nov 2026: one knot)', () => {
  // The Spheres always has its three (concierge, builder, lookout); a district any number, up to past the spots.
  const rooms: [string, number][] = [...DISTRICTS.flatMap((d) => Array.from({ length: 12 }, (_, i): [string, number] => [d.id, i + 1])), ['spheres', 3]];

  it('for 6 to 12 staff, in every district, each start tile is distinct, walkable and reachable, never the door or Kai’s tile', () => {
    for (const [d, n] of rooms.filter(([d, n]) => n >= 6 || d === 'spheres')) {
      const places = staffPlaces(d, n);
      expect(places, `${d} ${n}`).toHaveLength(n);
      const blocked = blockedFor(d, n);
      const open = reachable(blocked);
      expect(new Set(places.map((p) => key(p.start))).size, `${d} ${n}: two staff on one tile`).toBe(n);
      for (const p of places) {
        const at = `${d} ${n} ${JSON.stringify(p.start)}`;
        expect(inRoom(p.start), at).toBe(true);
        expect(blocked.has(key(p.start)), `${at}: on furniture or a desk`).toBe(false);
        expect(open.has(key(p.start)), `${at}: out of Kai’s reach`).toBe(true);
        expect(key(p.start), at).not.toBe(key(DOOR));
        expect(key(p.start), at).not.toBe(key(ENTRY));
      }
    }
  });

  it('each starts at its work spot (six at the desks, the rest at the racks) and idles on a patch round it that no one else’s touches', () => {
    for (const [d, n] of rooms) {
      const spots = staffSpots(n);
      const owner = new Map<number, number>();
      staffPlaces(d, n).forEach((p, i) => {
        const at = `${d} ${n} #${i}`;
        expect(p.spot, at).toEqual(spots[i]);
        if (p.spot) expect(p.start, at).toEqual(p.spot.tile);
        // Its start is on its patch, and the patch is inside the room.
        expect(tilesIn(p.area).some((t) => key(t) === key(p.start)), at).toBe(true);
        for (const t of tilesIn(p.area)) {
          expect(inRoom(t), `${at} ${JSON.stringify(p.area)}`).toBe(true);
          expect(owner.get(key(t)), `${at} shares ${JSON.stringify(t)} with #${owner.get(key(t))}`).toBeUndefined();
          owner.set(key(t), i);
        }
      });
    }
  });

  it('nobody in a real district stands head over head: any two starts are 32 px apart across the screen or 40 px down it', () => {
    // On screen a tile is 32 × 16 (src/game/iso.ts): x − y steps 16 px across, x + y steps 8 px down.
    for (const d of DISTRICTS.map((x) => x.id as DistrictId)) {
      const places = staffPlaces(d, servicesIn(d).length);
      for (let i = 0; i < places.length; i++)
        for (let j = i + 1; j < places.length; j++) {
          const [a, b] = [places[i].start, places[j].start];
          const across = Math.abs(a.x - a.y - (b.x - b.y)) * 16;
          const down = Math.abs(a.x + a.y - (b.x + b.y)) * 8;
          expect(across >= 32 || down >= 40, `${d}: ${JSON.stringify(a)} and ${JSON.stringify(b)}`).toBe(true);
        }
    }
  });

  it('nobody idles in front of the door or on Kai’s first tile: a tap on the door reaches the door', () => {
    // In front of the door on screen: its own column (x − y within a step) and up to two rows nearer the viewer.
    const front = (t: Tile) => Math.abs(t.x - t.y - (DOOR.x - DOOR.y)) <= 1 && t.x + t.y - (DOOR.x + DOOR.y) >= 0 && t.x + t.y - (DOOR.x + DOOR.y) <= 2;
    expect(keptClear(ENTRY.x, ENTRY.y)).toBe(true);
    for (const [d, n] of rooms)
      staffPlaces(d, n).forEach((p, i) => {
        expect(keptClear(p.start.x, p.start.y), `${d} ${n} #${i} starts in Kai’s way`).toBe(false);
        for (const t of tilesIn(p.area)) if (key(t) !== key(DOOR) && front(t)) expect(keptClear(t.x, t.y), `${d} ${n} #${i}: ${JSON.stringify(t)}`).toBe(true);
      });
  });

  it('the scene lets its staff idle anywhere on their patch but the kept-clear tiles', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('src/game/scenes/InteriorScene.ts', 'utf8')).toMatch(/wanderable: \(x, y\) => !keptClear\(x, y\),/);
  });

  it('those at the racks stand on the grate, every other row, and the corner’s stays on its own tile', () => {
    const racks = staffSpots(11).slice(SEATS.length);
    for (const s of racks) expect(s!.tile.x, JSON.stringify(s)).toBeGreaterThanOrEqual(8);
    const rows = racks.map((s) => s!.tile).filter((t) => t.x === 8).map((t) => t.y);
    for (let i = 1; i < rows.length; i++) expect(rows[i] - rows[i - 1]).toBeGreaterThanOrEqual(2);
  });
});
