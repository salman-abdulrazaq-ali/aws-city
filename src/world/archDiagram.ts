/**
 * An architecture diagram's layout, pure: columns in the order a request travels, nodes in lanes inside them, and links
 * routed as right-angle lines between the boxes (the last segment always straight, for the arrowhead). Used by both of
 * the My AWS dialog's drawings: "Diagram" (the linked account, src/world/accountDiagram.ts) and "How AWS City runs"
 * (src/world/cityArchitecture.ts). The renderer is src/ui/ArchDiagram.tsx. The same input always gives the same output.
 */

/** Full tab: columns left to right. The 400 px side panel: top to bottom, so nothing has to shrink to fit. */
export type Orientation = 'lr' | 'tb';

export interface Pt {
  x: number;
  y: number;
}

export interface ArchColumn {
  id: string;
  label: string;
}

export interface ArchNodeIn {
  id: string;
  column: string;
  label: string;
  /** Which icon set the picture comes from (src/world/icons.ts). */
  icon?: { kind: 'service' | 'product' | 'actor' | 'group'; id: string };
  /** "×3". */
  badge?: string;
  /** Up to two short lines under the label (a cost per day and per month). */
  lines?: string[];
  /** Shown in the box when there's no icon: a Zone's letter, or "?". */
  glyph?: string;
  /** Read aloud for the node's button: its name and every figure on it. */
  aria?: string;
}

/** real: data AWS reports moving · typical: how these services usually connect · design: how AWS City's own parts connect. */
export type LinkStyle = 'real' | 'typical' | 'design';

export interface ArchLinkIn {
  id: string;
  from: string;
  to: string;
  style: LinkStyle;
  twoWay?: boolean;
  /** A live rate where the account reports one (requests a minute): the dots move faster. */
  perMin?: number;
  /** What the link means, in words (for the list under the drawing). */
  title?: string;
}

export interface DotPlan {
  count: 1 | 2 | 3;
  durMs: number;
}

export interface ArchLayout {
  w: number;
  h: number;
  orientation: Orientation;
  box: number;
  columns: (ArchColumn & { x: number; y: number; anchor: 'middle' | 'start' })[];
  nodes: (ArchNodeIn & { x: number; y: number })[];
  links: (ArchLinkIn & { pts: Pt[]; dots: DotPlan })[];
}

export const BOX = 40;
const MARGIN = 20;
/** Room for a column's name above its lane. */
const HEAD = 22;
/** Room under a box for its label and two short lines. */
const TEXT = 44;
/** The arrowhead (src/ui/diagram/geometry.ts arrowHead) reaches 5 units past the line's end. */
const TIP = 6;
/** Nodes in one lane before the column wraps into another lane. */
export const PER_LANE: Record<Orientation, number> = { lr: 5, tb: 3 };
/** Lane-to-lane step along the flow, and node-to-node step across it. */
const STEP: Record<Orientation, { along: number; across: number }> = { lr: { along: 132, across: BOX + TEXT + 16 }, tb: { along: HEAD + BOX + TEXT + 18, across: 112 } };

/** One calm dot with no live rate; more, and quicker, the busier a link is. */
export function dotPlan(perMin?: number): DotPlan {
  if (!perMin || perMin <= 0) return { count: 1, durMs: 4000 };
  if (perMin < 10) return { count: 1, durMs: 2400 };
  if (perMin < 100) return { count: 2, durMs: 2400 };
  return { count: 3, durMs: 2400 };
}

export function layoutArch(columns: readonly ArchColumn[], nodes: readonly ArchNodeIn[], links: readonly ArchLinkIn[], orientation: Orientation): ArchLayout {
  const step = STEP[orientation];
  const perLane = PER_LANE[orientation];
  // Lanes: each column's nodes in order, wrapped every `perLane`. Empty columns take no room.
  const lanes: { column: ArchColumn; nodes: ArchNodeIn[] }[] = [];
  for (const c of columns) {
    const mine = nodes.filter((n) => n.column === c.id);
    for (let i = 0; i < mine.length; i += perLane) lanes.push({ column: c, nodes: mine.slice(i, i + perLane) });
  }
  const deepest = Math.max(1, ...lanes.map((l) => l.nodes.length));
  const acrossCells = orientation === 'tb' ? perLane : deepest;
  // Flow space: p runs along the flow (lane by lane), q across it. lr: x = p, y = q; tb: x = q, y = p.
  const toXY = (p: number, q: number): Pt => (orientation === 'lr' ? { x: p, y: q } : { x: q, y: p });
  const laneP = (lane: number) => (orientation === 'lr' ? MARGIN + lane * step.along + step.along / 2 : MARGIN + lane * step.along + HEAD + BOX / 2);
  const slotQ = (slot: number, count: number) => {
    // A short lane sits in the middle of the across axis, so lines between lanes stay short.
    const offset = (acrossCells - count) / 2;
    return orientation === 'lr' ? MARGIN + HEAD + (slot + offset) * step.across + BOX / 2 : MARGIN + (slot + offset) * step.across + step.across / 2;
  };

  const placed = new Map<string, ArchLayout['nodes'][number] & { lane: number; p: number; q: number }>();
  const outColumns: ArchLayout['columns'] = [];
  lanes.forEach((l, lane) => {
    const p = laneP(lane);
    if (!outColumns.some((c) => c.id === l.column.id)) {
      outColumns.push(orientation === 'lr' ? { ...l.column, x: p, y: MARGIN + 12, anchor: 'middle' } : { ...l.column, x: MARGIN, y: p - BOX / 2 - 8, anchor: 'start' });
    }
    l.nodes.forEach((n, slot) => {
      const q = slotQ(slot, l.nodes.length);
      const { x, y } = toXY(p, q);
      placed.set(n.id, { ...n, x, y, lane, p, q });
    });
  });

  // The box's reach along the flow: in the panel the label sits below the box, which is along the flow there.
  const after = BOX / 2 + (orientation === 'tb' ? TEXT : 0);
  const before = BOX / 2;
  const gap = step.along - after - before;
  const sameLane = new Map<number, number>();
  const outLinks: ArchLayout['links'] = [];
  for (const l of links) {
    const a = placed.get(l.from);
    const b = placed.get(l.to);
    if (!a || !b || a === b) continue;
    let flow: Pt[];
    if (b.lane > a.lane) {
      const start = { x: a.p + after, y: a.q };
      const end = { x: b.p - before - TIP, y: b.q };
      if (b.lane - a.lane === 1) {
        const mid = Math.round(b.p - before - gap / 2);
        flow = a.q === b.q ? [start, end] : [start, { x: mid, y: a.q }, { x: mid, y: b.q }, end];
      } else {
        // Across lanes in between: out, along the channel between rows, then in, so no box is crossed. Left to right the
        // channel runs under the row's label and costs (they sit below each box); top to bottom, between the columns.
        const channel = Math.round(Math.max(a.q, b.q) + (orientation === 'lr' ? BOX / 2 + TEXT + 6 : step.across / 2));
        const out = a.p + after + 8;
        const into = Math.round(b.p - before - gap / 2);
        flow = [start, { x: out, y: a.q }, { x: out, y: channel }, { x: into, y: channel }, { x: into, y: b.q }, end];
      }
    } else if (b.lane < a.lane) {
      const start = { x: a.p - before, y: a.q };
      const end = { x: b.p + after + TIP, y: b.q };
      const mid = Math.round(a.p - before - gap / 2);
      flow = a.q === b.q && a.lane - b.lane === 1 ? [start, end] : [start, { x: mid, y: a.q }, { x: mid, y: b.q }, end];
    } else {
      // The same lane: a bracket on the outside, each one a little further out.
      const k = sameLane.get(a.lane) ?? 0;
      sameLane.set(a.lane, k + 1);
      const out = a.p + after + 10 + k * 5;
      flow = [
        { x: a.p + after, y: a.q },
        { x: out, y: a.q },
        { x: out, y: b.q },
        { x: b.p + after + TIP, y: b.q },
      ];
    }
    const pts = flow.map((f) => toXY(f.x, f.y));
    outLinks.push({ ...l, pts, dots: dotPlan(l.perMin) });
  }

  const laneCount = Math.max(1, lanes.length);
  const alongLen = MARGIN * 2 + laneCount * step.along;
  const acrossLen = orientation === 'lr' ? MARGIN * 2 + HEAD + acrossCells * step.across : MARGIN * 2 + acrossCells * step.across;
  const { x: w, y: h } = toXY(alongLen, acrossLen);
  return {
    w,
    h,
    orientation,
    box: BOX,
    columns: outColumns,
    nodes: [...placed.values()].map(({ lane: _lane, p: _p, q: _q, ...n }) => n),
    links: outLinks,
  };
}
