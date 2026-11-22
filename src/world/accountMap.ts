import type { CityBillEvent, CityFlowEvent, DataLink, InventoryItem } from '@/backend/contract';
import type { Inventory } from '@/state/store';
import { inCity, PROPS } from './resources';
import { serviceById } from './taxonomy';

/**
 * "My AWS, live": the player's real account as one map, built only from what the server already sends (city.inventory,
 * city.bill, city.flow). Services sit in columns in the order a request usually meets them (front door, compute, data,
 * security and operations); servers and databases also stand in their Availability Zone; the only lines are the data
 * links AWS reports (global table replication, a Multi-AZ standby). Which resource talks to which isn't read yet (it
 * needs more read-only permissions in the player role), and the map says so. Pure.
 */

export type Tier = 'edge' | 'compute' | 'data' | 'ops' | 'other';

export const TIERS: readonly { id: Tier; label: string; hint: string }[] = [
  { id: 'edge', label: 'Network & front door', hint: 'where requests come in' },
  { id: 'compute', label: 'Compute', hint: 'what runs your code, and its messages' },
  { id: 'data', label: 'Data', hint: 'where things are kept' },
  { id: 'ops', label: 'Security & operations', hint: 'who may do what, and who watches' },
  { id: 'other', label: 'Other', hint: 'things the city has no building for yet' },
];

/** Network services that requests meet first, whatever their district. */
const EDGE = new Set(['vpc', 'route53', 'cloudfront', 'apigateway', 'globalaccelerator', 'transitgateway', 'shield']);

export const tierOf = (serviceId: string | null): Tier => {
  if (!serviceId) return 'other';
  if (EDGE.has(serviceId)) return 'edge';
  switch (serviceById(serviceId)?.districtId) {
    case 'compute':
    case 'aiml':
    case 'networking': // queues and event buses carry work between compute
      return 'compute';
    case 'storage':
    case 'database':
      return 'data';
    case 'security':
    case 'management':
      return 'ops';
    default:
      return 'other';
  }
};

export interface MapNode {
  serviceId: string;
  name: string;
  /** Resources of this service in the city's Region (and global ones). */
  count: number;
  /** The ones the listing named (the server sends up to ~300 in all). */
  items: InventoryItem[];
  /** Month-to-date cost, when the bill is on. */
  cost?: number;
  /** Live rates, when traffic is on ("12 requests a minute"). */
  rates: { label: string; perMin: number }[];
}

export interface MapZone {
  name: string;
  /** "Zone A", in the account's AZ order (as the city's islands are lettered). */
  letter: string;
  items: InventoryItem[];
}

export interface AccountMap {
  region: string;
  tiers: { id: Tier; label: string; hint: string; nodes: MapNode[] }[];
  zones: MapZone[];
  /** Data that really moves between Zones or Regions, in plain words. */
  links: { id: string; kind: DataLink['kind']; text: string }[];
  /** Resources the listing saw that the city has no building for. */
  unmapped: number;
  /** Those resources, so the player can see what they are (seen 22 Nov 2026: "No building yet ×15" said nothing). */
  unmappedItems: InventoryItem[];
  /** Other Regions with resources (the world map shows them as cities). */
  elsewhere: { region: string; count: number }[];
  total?: { amount: number; currency: string; month: string };
  /** The listing may miss things (the tagging API sees only tagged resources). */
  partial: boolean;
  empty: boolean;
}

const where = (end: { region: string; az?: string }, letterOf: (az: string) => string | undefined) => (end.az ? (letterOf(end.az) ?? end.az) : end.region);

/** The id at the end of an ARN (a server's i-…). */
const arnId = (arn: string) => arn.split(/[:/]/).pop() ?? '';
/**
 * A resource in words: "server web-1 (i-0abc…)", "bucket aws-city-…" (the props' nouns), else its type. A server named
 * from its Name tag keeps its id beside it, to copy for "Terminate i-…" (seen 22 Nov 2026: only the name showed).
 */
export const itemLine = (it: InventoryItem) => {
  const id = arnId(it.arn);
  const withId = /^i-[0-9a-f]{8,17}$/.test(id) && id !== it.name ? ` (${id})` : '';
  return `${PROPS[it.type]?.noun ?? it.type.replace(/^AWS::/, '').replace(/::/g, ' ')} ${it.name}${withId}`;
};

export function accountMap(inv: Inventory | undefined, opts: { region: string; bill?: CityBillEvent; flow?: CityFlowEvent }): AccountMap {
  const region = opts.region;
  const home = inv?.homeRegion ?? inv?.region;
  const items = (inv?.items ?? []).filter((it) => inCity(it, region, home));
  const bill = opts.bill && opts.bill.unavailable === undefined ? opts.bill : undefined;
  const flow = opts.flow && opts.flow.unavailable === undefined ? opts.flow : undefined;
  const isHome = region === home;

  const byService = new Map<string, InventoryItem[]>();
  const unmappedItems: InventoryItem[] = [];
  for (const it of items) {
    if (!it.serviceId || !serviceById(it.serviceId)) {
      unmappedItems.push(it);
      continue;
    }
    byService.set(it.serviceId, [...(byService.get(it.serviceId) ?? []), it]);
  }
  // The server's counts cover the home Region and global resources beyond the listed ~300: trust them there.
  if (isHome) for (const [id, n] of Object.entries(inv?.counts ?? {})) if (id !== 'other' && serviceById(id) && !byService.has(id) && n > 0) byService.set(id, []);

  const nodes: MapNode[] = [...byService.entries()].map(([serviceId, list]) => ({
    serviceId,
    name: serviceById(serviceId)!.name,
    count: isHome ? Math.max(list.length, inv?.counts?.[serviceId] ?? 0) : list.length,
    items: list,
    ...(bill && bill.byService[serviceId] !== undefined ? { cost: bill.byService[serviceId] } : {}),
    rates: (flow?.rates ?? []).filter((r) => r.serviceId === serviceId).map((r) => ({ label: r.label, perMin: r.perMin })),
  }));

  const azs = (inv?.zones?.[region] ?? []).map((z) => z.name);
  const letterOf = (az: string) => {
    const i = azs.indexOf(az);
    return i >= 0 ? `Zone ${String.fromCharCode(65 + i)}` : undefined;
  };
  const zones: MapZone[] = azs.map((name) => ({ name, letter: letterOf(name)!, items: items.filter((it) => it.az === name) }));

  const links = (inv?.links ?? [])
    .filter((l) => l.from.region === region || l.to.region === region)
    .map((l) => ({
      id: l.id,
      kind: l.kind,
      text: `${l.label}: ${where(l.from, letterOf)} ${l.twoWay ? '↔' : '→'} ${where(l.to, letterOf)} (${l.kind === 'replication' ? 'copies the data' : l.kind === 'standby' ? 'a standby ready to take over' : 'requests'})`,
    }));

  const tiers = TIERS.map((t) => ({ ...t, nodes: nodes.filter((n) => tierOf(n.serviceId) === t.id).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)) })).filter(
    (t) => t.nodes.length || (t.id === 'other' && unmappedItems.length),
  );
  const elsewhere = Object.entries(inv?.regions ?? {})
    .filter(([r, n]) => r !== region && r !== 'global' && n > 0)
    .map(([r, count]) => ({ region: r, count }))
    .sort((a, b) => b.count - a.count);

  return {
    region,
    tiers,
    zones,
    links,
    unmapped: unmappedItems.length,
    unmappedItems,
    elsewhere,
    ...(bill ? { total: { amount: bill.total, currency: bill.currency, month: bill.month } } : {}),
    partial: !!inv && !inv.complete,
    empty: !nodes.length && !unmappedItems.length,
  };
}
