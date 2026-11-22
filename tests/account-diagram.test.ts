// My AWS → Diagram: the linked account as an architecture drawing, pure. Asked for on 22 Nov 2026: "an architecture
// drawing … how it links together, animated with data points, and the cost of each service by day or by month". Typical
// links teach (AWS example flows) and are labelled that way; only links AWS reports are real; costs come from the bill.
import { describe, expect, it } from 'vitest';
import type { CityBillEvent, InventoryItem } from '@/backend/contract';
import type { Inventory } from '@/state/store';
import { billDays, costLines, costView, dollars } from '@/world/accountCost';
import { accountDiagram, FAN_IN, totalLine } from '@/world/accountDiagram';
import { accountMap } from '@/world/accountMap';
import { BOX, dotPlan, layoutArch, PER_LANE, type ArchColumn, type ArchNodeIn, type Orientation } from '@/world/archDiagram';
import { FLOWS } from '@/world/culture';

const item = (serviceId: string, name: string, over: Partial<InventoryItem> = {}): InventoryItem => ({ arn: `arn:${serviceId}:${name}`, type: 'x', name, serviceId, districtId: null, managedByGame: false, region: 'us-west-2', ...over });
const inv = (items: InventoryItem[], over: Partial<Inventory> = {}): Inventory => ({
  takenAt: '2026-11-22T10:00:00Z',
  region: 'us-west-2',
  homeRegion: 'us-west-2',
  source: 'resource-explorer',
  complete: true,
  counts: {},
  items,
  truncated: false,
  zones: { 'us-west-2': ['us-west-2a', 'us-west-2b', 'us-west-2c'].map((name, i) => ({ name, id: `usw2-az${i + 1}` })) },
  ...over,
});
const bill = (byService: Record<string, number>, total = Object.values(byService).reduce((a, b) => a + b, 0)): CityBillEvent => ({ type: 'city.bill', month: '2026-11', currency: 'USD', total, byService, byRegion: {}, takenAt: '2026-11-22T10:00:00Z', estimated: true });
const diagramOf = (i: Inventory, b?: CityBillEvent) => accountDiagram(accountMap(i, { region: 'us-west-2', bill: b }), i, { flows: FLOWS, bill: b });

describe('cost a day and a month, from the bill so far', () => {
  it('counts the UTC days the bill covers, and the days in its month', () => {
    expect(billDays({ month: '2026-11', takenAt: '2026-11-22T10:00:00Z' })).toEqual({ elapsed: 22, inMonth: 30 });
    expect(billDays({ month: '2026-11', takenAt: '2026-11-01T00:30:00Z' })).toEqual({ elapsed: 1, inMonth: 30 });
    expect(billDays({ month: '2028-02', takenAt: '2028-02-29T12:00:00Z' })).toEqual({ elapsed: 29, inMonth: 29 });
    // A bill read in a later month covers all of its own month.
    expect(billDays({ month: '2026-10', takenAt: '2026-11-02T00:00:00Z' })).toEqual({ elapsed: 31, inMonth: 31 });
  });

  it('a day is so far ÷ days so far; a month is a day × the month, both marked est.', () => {
    const c = costView(0.44, { elapsed: 22, inMonth: 30 });
    expect(c.perDay).toBeCloseTo(0.02);
    expect(c.perMonth).toBeCloseTo(0.6);
    expect(costLines(c)).toEqual(['$0.02 a day est.', '$0.60 a month est.']);
    expect(dollars(0.001)).toBe('under $0.01');
    expect(dollars(0)).toBe('$0.00');
  });
});

describe('the account as a diagram', () => {
  const serverless = inv([item('apigateway', 'api'), item('lambda', 'fn'), item('dynamodb', 'city-scores'), item('ec2', 'web', { az: 'us-west-2b' })]);

  it('every service is a node with its count; costs only when the bill is on', () => {
    const d = diagramOf(serverless);
    expect(d.nodes.map((n) => [n.id, n.badge])).toEqual(
      expect.arrayContaining([
        ['apigateway', '×1'],
        ['lambda', '×1'],
        ['dynamodb', '×1'],
        ['ec2', '×1'],
      ]),
    );
    expect(d.costed).toBe(false);
    expect(d.total).toBeUndefined();
    expect(d.nodes.every((n) => !n.lines)).toBe(true);

    const costed = diagramOf(serverless, bill({ lambda: 0.44, ec2: 2.2 }));
    expect(costed.costed).toBe(true);
    expect(costed.nodes.find((n) => n.id === 'lambda')!.lines).toEqual(['$0.02 a day est.', '$0.60 a month est.']);
    expect(costed.nodes.find((n) => n.id === 'lambda')!.aria).toMatch(/AWS Lambda, 1 resource, \$0\.02 a day est\., \$0\.60 a month est\./);
    expect(totalLine(costed.total!)).toBe('So far in 2026-11: $2.64 (AWS’s estimate, all Regions) · $0.12 a day est. · $3.60 for the month est.');
  });

  it('typical links are adjacent pairs of an AWS example flow, both ends present, dashed and labelled', () => {
    const d = diagramOf(serverless);
    const typical = d.links.filter((l) => l.style === 'typical').map((l) => `${l.from}>${l.to}`);
    expect(typical).toEqual(expect.arrayContaining(['apigateway>lambda', 'lambda>dynamodb']));
    for (const l of d.links.filter((x) => x.style === 'typical')) {
      expect(FLOWS.some((f) => !FAN_IN.has(f.id) && f.serviceIds.some((id, i) => id === l.from && f.serviceIds[i + 1] === l.to))).toBe(true);
      expect(l.title).toMatch(/→/);
    }
    expect(d.legs.length).toBe(typical.length);
    // One end missing: no line.
    expect(diagramOf(inv([item('apigateway', 'api'), item('dynamodb', 't')])).links.filter((l) => l.style === 'typical')).toEqual([]);
  });

  it('flows where every service reports into the last one draw no lines between them (DynamoDB does not feed EFS)', () => {
    const d = diagramOf(inv([item('dynamodb', 't'), item('efs', 'fs'), item('ebs', 'v')]));
    expect(d.links.filter((l) => l.style === 'typical')).toEqual([]);
  });

  it('real links go to where the data goes: a Region, or a lettered Zone', () => {
    const withLinks = inv([item('dynamodb', 'sessions'), item('rds', 'orders', { az: 'us-west-2a' })], {
      links: [
        { id: 'ddb', serviceId: 'dynamodb', from: { region: 'us-west-2' }, to: { region: 'eu-west-1' }, kind: 'replication', twoWay: true, label: 'Global table sessions' },
        { id: 'rds', serviceId: 'rds', from: { region: 'us-west-2', az: 'us-west-2a' }, to: { region: 'us-west-2', az: 'us-west-2b' }, kind: 'standby', label: 'Multi-AZ standby for orders' },
      ],
    });
    const d = diagramOf(withLinks);
    const real = d.links.filter((l) => l.style === 'real');
    expect(real.map((l) => [l.from, l.to, !!l.twoWay])).toEqual([
      ['dynamodb', 'place:eu-west-1', true],
      ['rds', 'place:Zone B', false],
    ]);
    expect(d.nodes.find((n) => n.id === 'place:eu-west-1')).toMatchObject({ column: 'elsewhere', label: 'eu-west-1', icon: { kind: 'group', id: 'region' } });
    expect(d.nodes.find((n) => n.id === 'place:Zone B')).toMatchObject({ column: 'elsewhere', label: 'Zone B' });
    expect(d.columns.at(-1)).toEqual({ id: 'elsewhere', label: 'Where data goes' });
  });
});

describe('the drawing’s layout', () => {
  const columns: ArchColumn[] = [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
    { id: 'c', label: 'C' },
  ];
  const nodesFor = (counts: number[]): ArchNodeIn[] => counts.flatMap((n, ci) => Array.from({ length: n }, (_, i) => ({ id: `${columns[ci]!.id}${i}`, column: columns[ci]!.id, label: `Node ${i}` })));
  const overlap = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) < BOX && Math.abs(a.y - b.y) < BOX;

  for (const o of ['lr', 'tb'] as Orientation[]) {
    it(`${o}: every box inside the drawing, none overlapping, columns in order, and the same every time`, () => {
      const nodes = nodesFor([2, 7, 1]);
      const links = [
        { id: 'l1', from: 'a0', to: 'b0', style: 'typical' as const },
        { id: 'l2', from: 'a1', to: 'c0', style: 'real' as const },
        { id: 'l3', from: 'b6', to: 'a0', style: 'typical' as const },
        { id: 'l4', from: 'b1', to: 'b2', style: 'design' as const },
      ];
      const out = layoutArch(columns, nodes, links, o);
      expect(out.nodes).toHaveLength(nodes.length);
      for (const n of out.nodes) {
        expect(n.x - BOX / 2).toBeGreaterThanOrEqual(0);
        expect(n.y - BOX / 2).toBeGreaterThanOrEqual(0);
        expect(n.x + BOX / 2).toBeLessThanOrEqual(out.w);
        expect(n.y + BOX / 2).toBeLessThanOrEqual(out.h);
      }
      for (let i = 0; i < out.nodes.length; i++) for (let j = i + 1; j < out.nodes.length; j++) expect(overlap(out.nodes[i]!, out.nodes[j]!)).toBe(false);
      // Along the flow: column a before b before c.
      const along = (id: string) => (o === 'lr' ? out.nodes.find((n) => n.id === id)!.x : out.nodes.find((n) => n.id === id)!.y);
      expect(along('a0')).toBeLessThan(along('b0'));
      expect(along('b0')).toBeLessThan(along('c0'));
      // A column longer than a lane wraps into another lane.
      expect(new Set(out.nodes.filter((n) => n.column === 'b').map((n) => (o === 'lr' ? n.x : n.y))).size).toBe(Math.ceil(7 / PER_LANE[o]));
      // Every link ends on a straight segment (the arrowhead needs it), and all four were routed.
      expect(out.links).toHaveLength(4);
      for (const l of out.links) {
        const [p, q] = l.pts.slice(-2);
        expect(p!.x === q!.x || p!.y === q!.y).toBe(true);
      }
      expect(layoutArch(columns, nodes, links, o)).toEqual(out);
    });
  }

  it('the side panel is narrow: at most three across', () => {
    const out = layoutArch(columns, nodesFor([3, 3, 3]), [], 'tb');
    expect(out.w).toBeLessThanOrEqual(380);
  });

  it('a link to a node that is not drawn is left out', () => {
    expect(layoutArch(columns, nodesFor([1]), [{ id: 'x', from: 'a0', to: 'nope', style: 'typical' }], 'lr').links).toEqual([]);
  });

  it('dots: one calm dot without a live rate, more and quicker the busier it is', () => {
    expect(dotPlan()).toEqual({ count: 1, durMs: 4000 });
    expect(dotPlan(0)).toEqual({ count: 1, durMs: 4000 });
    expect(dotPlan(5)).toEqual({ count: 1, durMs: 2400 });
    expect(dotPlan(40)).toEqual({ count: 2, durMs: 2400 });
    expect(dotPlan(400)).toEqual({ count: 3, durMs: 2400 });
  });
});
