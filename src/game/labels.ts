// Map labels' shared rules (the label budget lives in CityScene.syncLabels): keep a label inside the camera view, and
// find which labels collide. Pure geometry on Phaser objects; no store.
import Phaser from 'phaser';

/** An anchor this close outside the view (world px) is pulled in to the view's edge; one further off stays put. */
const EDGE_REACH = 160;

export interface Pt {
  x: number;
  y: number;
}

/**
 * Where a label anchored at `a` should stand so it stays whole inside `view` (world px): clamped when the anchor is
 * near the view, unchanged when it's far off-screen. Origin-aware (`ox`, `oy` are the label's origin, w/h its display
 * size). `top`: world px at the top of the view the UI covers (the status ticker).
 */
export function inView(a: Pt, w: number, h: number, view: { x: number; y: number; width: number; height: number }, pad: number, top = 0, ox = 0.5, oy = 0.5): Pt {
  if (!view.width) return a;
  const right = view.x + view.width;
  const bottom = view.y + view.height;
  const near = a.x > view.x - EDGE_REACH && a.x < right + EDGE_REACH && a.y > view.y - EDGE_REACH && a.y < bottom + EDGE_REACH;
  if (!near) return a;
  const x = view.width > w + 2 * pad ? Phaser.Math.Clamp(a.x, view.x + pad + w * ox, right - pad - w * (1 - ox)) : a.x;
  const y = view.height > h + 2 * pad + top ? Phaser.Math.Clamp(a.y, view.y + top + pad + h * oy, bottom - pad - h * (1 - oy)) : a.y;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Moves a visible text to stay in view, from its anchor. */
export function keepTextInView(t: Phaser.GameObjects.Text, a: Pt, view: Phaser.Geom.Rectangle, ui: number, topInset = 0) {
  if (!t.visible) return;
  const p = inView(a, t.displayWidth, t.displayHeight, view, 4 * ui, topInset * ui, t.originX, t.originY);
  if (t.x !== p.x || t.y !== p.y) t.setPosition(p.x, p.y);
}

// ── One overlap pass over every tag on the map (Kai's, the hint, signs, walkers') ──

/** The order the one overlap pass keeps tags in: Kai's tag, the "E · …" hint, signs, working agents, then citizens. */
export const TAG_ORDER = ['kai', 'hint', 'sign', 'working', 'citizen'] as const;
export type TagKind = (typeof TAG_ORDER)[number];

/** An axis-aligned box in world px (a Phaser Rectangle fits). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapTag<T> {
  kind: TagKind;
  /** Picked, hovered or focused: first within its kind, and never counted against the view's cap. */
  must?: boolean;
  /** A building's name sign: counts toward the cap of signs a view holds (signCap). */
  capped?: boolean;
  /** Within a kind, lower first, compared item by item (signs: signRank). */
  rank?: readonly number[];
  /** Where the tag stands if shown (world px); undefined: not wanted now. */
  box: Box | undefined;
  item: T;
}

/** The tab's map at 1400×880 (screen px): a view this big holds the full cap of signs; a smaller one, its share. */
const TAB_MAP_AREA = 982 * 814;

/**
 * How many building signs one view holds (the picked ones don't count): every one at zoom 1 (the budget already shows
 * only the picked ones there), 10 at zoom 2 and 6 from zoom 3 on the tab's map, a share of that on a smaller one (the
 * side panel), never under 3. A grown city at zoom 2–3 drew ~25 signs, and Kai and his hint got lost among them.
 */
export function signCap(zoom: number, screenW: number, screenH: number): number {
  if (zoom < 2) return Infinity;
  const base = zoom >= 3 ? 6 : 10;
  const share = Math.min(1, Math.max(0, (screenW * screenH) / TAB_MAP_AREA));
  return Math.max(3, Math.round(base * share));
}

/** A sign's place among the signs: one standing in view first, then a building ready to upgrade, then nearest Kai. */
export const signRank = (o: { inView: boolean; ready: boolean; toKai: number }): number[] => [o.inView ? 0 : 1, o.ready ? 0 : 1, o.toKai];

const before = (a: readonly number[] = [], b: readonly number[] = []) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

const touches = (a: Box, b: Box) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * The one overlap pass: every wanted tag in TAG_ORDER (picked ones first within a kind, then by rank), each kept only
 * when it covers none kept before it; building signs past `cap` (picked ones aside) give way too. Returns the items
 * kept: the caller shows those and hides the rest. `gap`: extra world px between tags.
 */
export function keepTags<T>(tags: readonly MapTag<T>[], cap = Infinity, gap = 0): Set<T> {
  const order = tags
    .filter((t) => !!t.box)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => TAG_ORDER.indexOf(a.t.kind) - TAG_ORDER.indexOf(b.t.kind) || Number(!!b.t.must) - Number(!!a.t.must) || before(a.t.rank, b.t.rank) || a.i - b.i);
  const kept: Box[] = [];
  const out = new Set<T>();
  let signs = 0;
  for (const { t } of order) {
    const counts = !!t.capped && !t.must;
    if (counts && signs >= cap) continue;
    const b = t.box!;
    const g = { x: b.x - gap, y: b.y - gap, width: b.width + 2 * gap, height: b.height + 2 * gap };
    if (kept.some((k) => touches(g, k))) continue;
    kept.push(g);
    out.add(t.item);
    if (counts) signs++;
  }
  return out;
}

/**
 * Greedy de-overlap: walks `items` in priority order (first wins) and returns the ones that cover none already kept.
 * `gap`: extra world px between labels.
 */
export function nonOverlapping<T>(items: T[], bounds: (t: T) => Phaser.Geom.Rectangle | undefined, gap = 0): Set<T> {
  const kept: Phaser.Geom.Rectangle[] = [];
  const out = new Set<T>();
  for (const it of items) {
    const b = bounds(it);
    if (!b) continue;
    const g = new Phaser.Geom.Rectangle(b.x - gap, b.y - gap, b.width + 2 * gap, b.height + 2 * gap);
    if (kept.some((k) => Phaser.Geom.Intersects.RectangleToRectangle(g, k))) continue;
    kept.push(g);
    out.add(it);
  }
  return out;
}
