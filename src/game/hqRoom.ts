// A district HQ's room (InteriorScene): its size, door, furniture and where each of the staff works. Pure (no Phaser),
// so a test can staff a full district. Districts have 6 to 11 services (security 11) and the room has 6 desks: the
// rest work standing at the wall of racks (seen 23 Nov 2026: a 7th service found threw before the camera was set, and
// the room drew as a thumbnail with nobody in it). Each of the staff starts at its own spot and idles on its own patch
// of floor (`staffPlaces`): spawned on three tiles, a full district stood in one knot of heads (seen 23 Nov 2026).
import type { Rect, Tile } from '@/world/layout';

export const ROOM_W = 10;
export const ROOM_H = 9;
export const DOOR: Tile = { x: 0, y: 7 };
/** Where Kai stops once he's in. */
export const ENTRY: Tile = { x: 2, y: 7 };
/**
 * Nobody idles here (they may walk through): the two tiles that stand in front of the door on screen, so a tap on the
 * door reaches the door and not an agent, and Kai's first tile.
 */
export const KEEP_CLEAR: Tile[] = [{ x: 1, y: 7 }, { x: 1, y: 8 }, ENTRY];
export const keptClear = (x: number, y: number) => KEEP_CLEAR.some((t) => t.x === x && t.y === y);

/** Chairs (the agent sits here facing SE): the pack's desk with computer is one tile SE of each. */
export const SEATS: Tile[] = [
  { x: 2, y: 2 },
  { x: 5, y: 2 },
  { x: 2, y: 5 },
  { x: 5, y: 5 },
  { x: 2, y: 8 },
  { x: 5, y: 8 },
];

/**
 * Where the staff past the desks stand to work, facing SE: on the grate along the wall of racks (x 9), every other row
 * (on screen a row apart is 16 px: four in a row stood head over head), the fifth in the grate's far corner. Each idles
 * on its `area`: its stand and the step beside it, the corner's only its own (the step beside it is next to (8, 1)).
 */
export const STANDS: { tile: Tile; area: Rect }[] = [
  { tile: { x: 8, y: 1 }, area: { x: 7, y: 1, w: 2, h: 1 } },
  { tile: { x: 8, y: 3 }, area: { x: 7, y: 3, w: 2, h: 1 } },
  { tile: { x: 8, y: 5 }, area: { x: 7, y: 5, w: 2, h: 1 } },
  { tile: { x: 8, y: 7 }, area: { x: 7, y: 7, w: 2, h: 1 } },
  { tile: { x: 9, y: 0 }, area: { x: 9, y: 0, w: 1, h: 1 } },
];

export type Piece = [sprite: string, x: number, y: number];

/** Each district's wall of kit (x 9), then what every HQ has. */
export const FURNITURE: Record<string, Piece[]> = {
  compute: [['pack:server_rack_SW', 9, 1], ['pack:server_rack_SW', 9, 2], ['pack:server_rack_SW', 9, 3], ['pack:server_rack_SW', 9, 4]],
  storage: [['pack:data_box_SW', 9, 1], ['pack:data_box_SW', 9, 2], ['pack:server_rack_SW', 9, 4]],
  database: [['pack:server_rack_SW', 9, 1], ['pack:server_rack_SW', 9, 2], ['pack:data_box_SW', 9, 4]],
  networking: [['pack:server_rack_SW', 9, 1], ['pack:lambda_sign_SW', 9, 3]],
  security: [['pack:server_rack_SW', 9, 1], ['pack:data_box_SW', 9, 3]],
  aiml: [['pack:server_rack_SW', 9, 1], ['pack:server_rack_SW', 9, 2], ['pack:lambda_sign_SW', 9, 4]],
  management: [['pack:data_box_SW', 9, 1], ['pack:server_rack_SW', 9, 2], ['pack:data_box_SW', 9, 3], ['pack:lambda_sign_SW', 9, 4]],
};
export const COMMON: Piece[] = [['pack:coffee_machine_SW', 9, 7], ['plant', 9, 8], ['plant', 1, 0], ['sofa', 7, 8]];
export const SPHERES: Piece[] = [
  ['tree0', 1, 1], ['tree1', 3, 1], ['pine', 8, 1], ['tree0', 9, 3], ['tree1', 9, 6], ['plant', 1, 4], ['plant', 7, 4], ['plant', 4, 7],
  ['flowers', 3, 4], ['flowers', 6, 6], ['benchX', 7, 6], ['benchY', 2, 6], ['pack:coffee_machine_SW', 9, 8], ['awsSign', 5, 1],
];

/** The room's furniture: The Spheres' garden, or the district's kit and the common pieces. */
export const piecesFor = (districtId: string): Piece[] => (districtId === 'spheres' ? SPHERES : [...(FURNITURE[districtId] ?? []), ...COMMON]);

/** The tiles a piece takes (a sofa two, flowers none: they're walked through). */
export const tilesOf = ([key, x, y]: Piece): Tile[] => (key === 'flowers' ? [] : key === 'sofa' ? [{ x, y }, { x: x + 1, y }] : [{ x, y }]);

/** Where one of the staff works: a chair at a desk (sits), or a spot at the racks (stands, at its usual activity). */
export interface WorkSpot {
  tile: Tile;
  seated: boolean;
  /** The desk a seated spot faces (one tile SE); it blocks walking. */
  desk?: Tile;
  /** The patch of floor it idles on, its own: no other spot's patch touches it. */
  area: Rect;
}

/**
 * A work spot for each of `count` staff, in order: the desks first, then the stands. Past both (no district has that
 * many) a spot is undefined and that agent stands on a free tile (`staffPlaces`), so a bigger district still draws everyone.
 */
export function staffSpots(count: number): (WorkSpot | undefined)[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    if (i < SEATS.length) {
      const tile = SEATS[i];
      // A desk's patch: the 3×3 round its chair (the seats are three tiles apart, so no two patches touch).
      const x = Math.max(0, tile.x - 1);
      const y = Math.max(0, tile.y - 1);
      const area = { x, y, w: Math.min(ROOM_W, tile.x + 2) - x, h: Math.min(ROOM_H, tile.y + 2) - y };
      return { tile, seated: true, desk: { x: tile.x + 1, y: tile.y }, area };
    }
    const stand = STANDS[i - SEATS.length];
    return stand ? { tile: stand.tile, seated: false, area: stand.area } : undefined;
  });
}

/** Where one of the staff starts, and the patch it idles on (its work spot's, or past the spots its own tile). */
export interface StaffPlace {
  start: Tile;
  area: Rect;
  spot?: WorkSpot;
}

const key = (t: Tile) => t.y * ROOM_W + t.x;
const inArea = (t: Tile, r: Rect) => t.x >= r.x && t.y >= r.y && t.x < r.x + r.w && t.y < r.y + r.h;

/**
 * Each of `count` staff's place in the district's room, in order: its work spot (a chair, or a stand at the racks),
 * where it starts and idles on its own patch, so nobody starts on another's tile and no two patches share one. Past the
 * spots (no district has that many) an agent gets a free floor tile Kai can reach, outside every patch when one is
 * left (nearest the room's middle first), and stays on it.
 */
export function staffPlaces(districtId: string, count: number): StaffPlace[] {
  const spots = staffSpots(count);
  const blocked = new Set<number>();
  for (const p of piecesFor(districtId)) for (const t of tilesOf(p)) blocked.add(key(t));
  for (const s of spots) if (s?.desk) blocked.add(key(s.desk));
  // The floor Kai can reach from the door (BFS), less the door and what's kept clear.
  const open = new Set([key(DOOR)]);
  const queue = [DOOR];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: t.x + dx, y: t.y + dy };
      if (n.x < 0 || n.y < 0 || n.x >= ROOM_W || n.y >= ROOM_H || blocked.has(key(n)) || open.has(key(n))) continue;
      open.add(key(n));
      queue.push(n);
    }
  }
  const taken = new Set([key(DOOR), ...KEEP_CLEAR.map(key), ...spots.flatMap((s) => (s ? [key(s.tile)] : []))]);
  const areas = spots.flatMap((s) => (s ? [s.area] : []));
  const free = [...open]
    .map((k) => ({ x: k % ROOM_W, y: Math.floor(k / ROOM_W) }))
    .filter((t) => !taken.has(key(t)))
    .sort((a, b) => {
      const outside = Number(areas.some((r) => inArea(a, r))) - Number(areas.some((r) => inArea(b, r)));
      const mid = (t: Tile) => Math.abs(t.x - (ROOM_W - 1) / 2) + Math.abs(t.y - (ROOM_H - 1) / 2);
      return outside || mid(a) - mid(b) || key(a) - key(b);
    });
  let next = 0;
  return spots.map((spot) => {
    if (spot) return { start: spot.tile, area: spot.area, spot };
    // A room with no free floor left (never: 90 tiles) puts the rest by the door rather than drop anyone.
    const start = free[next++] ?? ENTRY;
    return { start, area: { x: start.x, y: start.y, w: 1, h: 1 } };
  });
}
