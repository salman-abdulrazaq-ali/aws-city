// @vitest-environment jsdom
// "My AWS, live": the linked account as one map, from what the server already sends (city.inventory, city.bill,
// city.flow). Only real links are drawn; which resource talks to which is said to come next, never guessed.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CityBillEvent, CityFlowEvent, InventoryItem } from '@/backend/contract';
import type { Inventory } from '@/state/store';
import { accountMap, itemLine, tierOf } from '@/world/accountMap';

const { useCity } = await import('@/state/store');
const { AccountMap } = await import('@/ui/AccountMap');

const item = (over: Partial<InventoryItem>): InventoryItem => ({ arn: `arn:${over.name}`, type: 'AWS::EC2::Instance', name: 'x', serviceId: 'ec2', districtId: 'compute', managedByGame: true, region: 'us-west-2', ...over });
// Your account on 22 Nov: one server (stopped), one bucket, one table, all built by the city; plus one thing with no building.
const inventory: Inventory = {
  takenAt: '2026-11-22T10:00:00Z',
  region: 'us-west-2',
  homeRegion: 'us-west-2',
  source: 'resource-explorer',
  complete: true,
  counts: { ec2: 1, s3: 1, dynamodb: 1, other: 1 },
  items: [
    item({ name: 'i-03e06cc3ce2a69cfe', az: 'us-west-2a' }),
    item({ name: 'aws-city-047463438585-holiday-123', type: 'AWS::S3::Bucket', serviceId: 's3', districtId: 'storage', region: 'global' }),
    item({ name: 'city-scores', type: 'AWS::DynamoDB::Table', serviceId: 'dynamodb', districtId: 'database' }),
    item({ name: 'alerts', type: 'sns:topic', serviceId: null, districtId: null, managedByGame: false }),
  ],
  truncated: false,
  regions: { 'us-west-2': 3, 'eu-west-2': 2 },
  zones: { 'us-west-2': ['us-west-2a', 'us-west-2b', 'us-west-2c', 'us-west-2d'].map((name, i) => ({ name, id: `usw2-az${i + 1}` })) },
  links: [],
};
const bill: CityBillEvent = { type: 'city.bill', month: '2026-11', currency: 'USD', total: 0.42, byService: { ec2: 0.12, s3: 0, dynamodb: 0.01, other: 0.29 }, byRegion: { 'us-west-2': 0.42 }, takenAt: '', estimated: true };
const flow: CityFlowEvent = { type: 'city.flow', region: 'us-west-2', windowMin: 15, rates: [{ id: 'dynamodb', serviceId: 'dynamodb', kind: 'writes', perMin: 3, label: 'Table writes' }], takenAt: '' };

describe('accountMap', () => {
  it('puts each service in its column, counts it, prices it and shows its live rate', () => {
    const m = accountMap(inventory, { region: 'us-west-2', bill, flow });
    expect(m.tiers.map((t) => t.id)).toEqual(['compute', 'data', 'other']);
    expect(m.tiers[0]!.nodes).toEqual([expect.objectContaining({ serviceId: 'ec2', count: 1, cost: 0.12, rates: [] })]);
    expect(m.tiers[1]!.nodes.map((n) => n.serviceId).sort()).toEqual(['dynamodb', 's3']);
    expect(m.tiers[1]!.nodes.find((n) => n.serviceId === 'dynamodb')!.rates).toEqual([{ label: 'Table writes', perMin: 3 }]);
    expect(m.unmapped).toBe(1);
    expect(m.unmappedItems.map((i) => i.name)).toEqual(['alerts']);
    expect(m.total).toEqual({ amount: 0.42, currency: 'USD', month: '2026-11' });
    expect(m.elsewhere).toEqual([{ region: 'eu-west-2', count: 2 }]);
    expect(m.empty).toBe(false);
  });

  it('servers stand in their Zone, lettered like the city’s islands; only real links, in plain words', () => {
    const withLink: Inventory = { ...inventory, links: [{ id: 'l1', serviceId: 'rds', from: { region: 'us-west-2', az: 'us-west-2a' }, to: { region: 'us-west-2', az: 'us-west-2b' }, kind: 'standby', label: 'Database orders' }] };
    const m = accountMap(withLink, { region: 'us-west-2' });
    expect(m.zones.map((z) => [z.letter, z.items.map((i) => i.name)])).toEqual([
      ['Zone A', ['i-03e06cc3ce2a69cfe']],
      ['Zone B', []],
      ['Zone C', []],
      ['Zone D', []],
    ]);
    expect(m.links).toEqual([{ id: 'l1', kind: 'standby', text: 'Database orders: Zone A → Zone B (a standby ready to take over)' }]);
    expect(accountMap(inventory, { region: 'us-west-2' }).links).toEqual([]);
  });

  it('columns follow a request: front door, compute, data, security and operations', () => {
    expect([tierOf('cloudfront'), tierOf('apigateway'), tierOf('lambda'), tierOf('sqs'), tierOf('s3'), tierOf('rds'), tierOf('iam'), tierOf('cloudformation'), tierOf(null)]).toEqual([
      'edge', 'edge', 'compute', 'compute', 'data', 'data', 'ops', 'ops', 'other',
    ]);
    expect(itemLine(inventory.items[0]!)).toBe('server i-03e06cc3ce2a69cfe');
    // A server named from its Name tag keeps its id beside it, to copy for "Terminate i-…".
    expect(itemLine({ ...inventory.items[0]!, arn: 'arn:aws:ec2:us-west-2:047463438585:instance/i-0d3ee009687a7434c', name: 'demo2' })).toBe('server demo2 (i-0d3ee009687a7434c)');
  });

  it('nothing read yet, or nothing there: empty, never invented', () => {
    expect(accountMap(undefined, { region: 'us-west-2' })).toMatchObject({ empty: true, tiers: [], links: [] });
    expect(accountMap({ ...inventory, items: [], counts: {} }, { region: 'us-west-2' }).empty).toBe(true);
  });
});

describe('the map on screen', () => {
  beforeEach(() => useCity.setState({ backendKind: 'server', backendStatus: 'connected', account: { linked: true, accountId: '047463438585', region: 'us-west-2' }, cityRegion: 'us-west-2', inventory, bill, billOn: true, flow, flowOn: true, accountMapOpen: true }));
  afterEach(cleanup);

  it('names the account, lists each service with its cost, opens to its resources, and says what comes next', () => {
    const { container } = render(<AccountMap />);
    expect(screen.getByRole('dialog', { name: 'My AWS, live' })).toBeTruthy();
    expect(screen.getByText(/Account 0474-6343-8585/)).toBeTruthy();
    expect(container.querySelector('.map-total')?.textContent).toMatch(/\$0\.42 so far in November 2026/);
    expect(screen.getByText(/\$0\.12 this month/)).toBeTruthy();
    expect(screen.getByText(/3 table writes a minute/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Amazon S3|S3/ }));
    expect(screen.getByText(/bucket aws-city-047463438585-holiday-123/)).toBeTruthy();
    expect(screen.getByText(/Which resource talks to which comes next/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close the map' }));
    expect(useCity.getState().accountMapOpen).toBe(false);
  });

  // Asked for on 22 Nov 2026: the account as an architecture drawing, with data moving and each service's cost.
  it('Diagram: the services drawn with their cost a day and a month (est.), moving dots and a legend that says which lines are real', () => {
    // A bill read on the 22nd: the per-day figure divides by 22 days.
    useCity.setState({ bill: { ...bill, takenAt: '2026-11-22T10:00:00Z' } });
    const { container } = render(<AccountMap />);
    const views = screen.getByRole('group', { name: 'Views' });
    expect([...views.querySelectorAll('button')].map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Services', 'true'],
      ['Diagram', 'false'],
      ['How AWS City runs', 'false'],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Diagram' }));
    expect(screen.getByRole('img', { name: /Diagram of your AWS services in us-west-2/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Amazon EC2, 1 resource, \$0\.01 a day est\., \$0\.16 a month est\./ })).toBeTruthy();
    expect(screen.getByText(/Dashed line: how these services usually connect/)).toBeTruthy();
    expect(screen.getByText(/Solid line: data AWS reports moving/)).toBeTruthy();
    expect(container.querySelector('.map-total')?.textContent).toMatch(/So far in November 2026: \$0\.42 .* a day est\./);
    // Picking a service shows its resources.
    fireEvent.click(screen.getByRole('button', { name: /^Amazon S3/ }));
    expect(screen.getByRole('region', { name: 'Amazon S3' }).textContent).toMatch(/bucket aws-city-047463438585-holiday-123/);
  });

  // Seen 22 Nov 2026: "No building yet ×15" said nothing about what the 15 were.
  it('what has no building yet is listed: tap it in the Diagram, or open it under Services', () => {
    const { container } = render(<AccountMap />);
    fireEvent.click(screen.getByText('1 more the city has no building for yet'));
    expect(container.querySelector('.map-unmapped')?.textContent).toMatch(/sns:topic alerts/);
    fireEvent.click(screen.getByRole('button', { name: 'Diagram' }));
    fireEvent.click(screen.getByRole('button', { name: /^No building yet: 1 resource in your account/ }));
    expect(screen.getByRole('region', { name: 'No building yet' }).textContent).toMatch(/not one of the city’s buildings yet.*sns:topic alerts/);
  });

  it('How AWS City runs: the city’s own parts and links, the Fargate prices, and the README’s idle estimate', () => {
    useCity.setState({ inventory: undefined });
    const { container } = render(<AccountMap />);
    fireEvent.click(screen.getByRole('button', { name: 'How AWS City runs' }));
    expect(screen.getByRole('img', { name: 'Diagram of how AWS City runs on AWS' })).toBeTruthy();
    expect(container.querySelectorAll('.arch-link.design').length).toBeGreaterThan(10);
    expect(container.querySelector('.map-total')?.textContent).toMatch(/The servers: \$1\.09 a day, \$33\.16 a month.*about \$60–85 a month/);
    fireEvent.click(screen.getByRole('button', { name: /^AWS City server/ }));
    expect(screen.getByRole('region', { name: 'AWS City server' }).textContent).toMatch(/Runs the agents/);
    expect(screen.queryByText(/Which resource talks to which comes next/)).toBeNull();
  });

  it('Diagram → Built by the city: only what the city built, and an empty note when there is nothing', () => {
    render(<AccountMap />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Built by the city' }));
    expect(screen.getByRole('img', { name: /Diagram of what the city built in us-west-2/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^No building yet/ })).toBeNull();
    expect(screen.getByText(/No costs here: AWS bills each service for the whole account/)).toBeTruthy();
    cleanup();
    useCity.setState({ inventory: { ...inventory, items: inventory.items.map((i) => ({ ...i, managedByGame: false })) } });
    render(<AccountMap />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagram' }));
    fireEvent.click(screen.getByRole('button', { name: 'Built by the city' }));
    expect(screen.getByText(/Nothing built by the city yet/)).toBeTruthy();
    expect(screen.queryByRole('img', { name: /Diagram of/ })).toBeNull();
  });

  it('Diagram: dots move along the links, and sit still under reduced motion', () => {
    const typed: Inventory = { ...inventory, items: [...inventory.items, { ...inventory.items[0]!, arn: 'arn:fn', name: 'fn', type: 'AWS::Lambda::Function', serviceId: 'lambda', az: undefined }], counts: { ...inventory.counts, lambda: 1 } };
    useCity.setState({ inventory: typed });
    const moving = render(<AccountMap />);
    fireEvent.click(screen.getByRole('button', { name: 'Diagram' }));
    // Lambda → DynamoDB is an AWS example flow (stream processing, serverless API): one dashed line, one dot moving.
    expect(moving.container.querySelectorAll('.arch-link.typical').length).toBeGreaterThan(0);
    expect(moving.container.querySelectorAll('animateMotion').length).toBeGreaterThan(0);
    cleanup();

    const real = globalThis.matchMedia;
    globalThis.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof matchMedia;
    try {
      const still = render(<AccountMap />);
      fireEvent.click(screen.getByRole('button', { name: 'Diagram' }));
      expect(still.container.querySelectorAll('animateMotion').length).toBe(0);
      expect(still.container.querySelectorAll('.arch-dot').length).toBeGreaterThan(0);
    } finally {
      globalThis.matchMedia = real;
    }
  });
});
