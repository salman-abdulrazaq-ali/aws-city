// A district HQ's room (InteriorScene): its size, door, furniture and where each of the staff works. Pure (no Phaser),
// so a test can staff a full district. Districts have 6 to 11 services (security 11) and the room has 6 desks: the
// rest work standing at the wall of racks (seen 23 Nov 2026: a 7th service found threw before the camera was set, and
// the room drew as a thumbnail with nobody in it).
import type { Tile } from '@/world/layout';

export const ROOM_W = 10;
export const ROOM_H = 9;
export const DOOR: Tile = { x: 0, y: 7 };

/** Chairs (the agent sits here facing SE): the pack's desk with computer is one tile SE of each. */
export const SEATS: Tile[] = [
  { x: 2, y: 2 },
  { x: 5, y: 2 },
  { x: 2, y: 5 },
  { x: 5, y: 5 },
  { x: 2, y: 8 },
  { x: 5, y: 8 },
];

/** Where the staff past the desks stand to work, facing SE: on the grate along the wall of racks (x 9). */
export const STANDS: Tile[] = [
  { x: 8, y: 1 },
  { x: 8, y: 2 },
  { x: 8, y: 3 },
  { x: 8, y: 4 },
  { x: 8, y: 6 },
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
}

/**
 * A work spot for each of `count` staff, in order: the desks first, then the stands. Past both (no district has that
 * many) a spot is undefined and that agent only walks the room, so a bigger district still draws everyone.
 */
export function staffSpots(count: number): (WorkSpot | undefined)[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => {
    if (i < SEATS.length) {
      const tile = SEATS[i];
      return { tile, seated: true, desk: { x: tile.x + 1, y: tile.y } };
    }
    const stand = STANDS[i - SEATS.length];
    return stand ? { tile: stand, seated: false } : undefined;
  });
}
