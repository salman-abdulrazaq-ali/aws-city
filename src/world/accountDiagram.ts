import type { CityBillEvent, CityFlowEvent } from '@/backend/contract';
import type { Inventory } from '@/state/store';
import { billDays, costLines, costView, dollars, type CostView } from './accountCost';
import { TIERS, type AccountMap } from './accountMap';
import type { ArchColumn, ArchLinkIn, ArchNodeIn } from './archDiagram';
import { courierLegs, type CourierLeg } from './couriers';
import type { Flow } from './culture';
import { serviceById } from './taxonomy';

/**
 * "My AWS, live" → Diagram: the linked account's services as an architecture drawing, pure. Built from the map
 * (src/world/accountMap.ts) and what the server already sends; nothing is read from AWS for it.
 *
 * - Solid lines are the data links AWS reports (a global table's replica Region, a Multi-AZ standby's Zone, load
 *   balancer traffic between Zones): real.
 * - Dashed lines are how these services usually connect: adjacent pairs of the AWS example flows in shared/flows.json
 *   (courierLegs, the same lessons the city's learning couriers drive), each with its source. They teach; they're never
 *   presented as read from the account (which resource talks to which isn't read yet).
 * - Costs: AWS's own month-so-far figure per service (Cost Explorer, all Regions), as a day and a month, marked est.
 *   There's no list-price estimate: the client doesn't know a server's size or whether it's running.
 */

/** Flows whose neighbours aren't a path: services that each report into the last one (DynamoDB doesn't feed EFS). */
export const FAN_IN = new Set(['central-backup', 'security-findings']);

const short = (id: string) => (serviceById(id)?.name ?? id).replace(/^(Amazon|AWS) /, '');

export interface AccountDiagram {
  columns: ArchColumn[];
  nodes: ArchNodeIn[];
  links: ArchLinkIn[];
  /** The typical links, with their lesson and source, for the list under the drawing. */
  legs: CourierLeg[];
  /** The whole bill as a day and a month (all Regions), when it's on. */
  total?: CostView & { currency: string; month: string };
  /** Whether any node shows a cost (the bill is on and has lines for the services here). */
  costed: boolean;
}

export function accountDiagram(map: AccountMap, inv: Inventory | undefined, opts: { flows: readonly Flow[]; bill?: CityBillEvent; flow?: CityFlowEvent }): AccountDiagram {
  const bill = opts.bill && opts.bill.unavailable === undefined ? opts.bill : undefined;
  const days = bill ? billDays(bill) : undefined;
  const currency = bill?.currency ?? 'USD';
  const region = map.region;

  const nodes: ArchNodeIn[] = [];
  const present = new Set<string>();
  const rateOf = new Map<string, number>();
  for (const t of map.tiers)
    for (const n of t.nodes) {
      present.add(n.serviceId);
      const perMin = n.rates.reduce((m, r) => Math.max(m, r.perMin), 0);
      if (perMin > 0) rateOf.set(n.serviceId, perMin);
      const cost = bill && days && n.cost !== undefined ? costView(n.cost, days) : undefined;
      const lines = cost ? costLines(cost, currency) : undefined;
      nodes.push({
        id: n.serviceId,
        column: t.id,
        label: short(n.serviceId),
        icon: { kind: 'service', id: n.serviceId },
        badge: `×${n.count}`,
        ...(lines ? { lines } : {}),
        aria: [n.name, `${n.count} ${n.count === 1 ? 'resource' : 'resources'}`, ...(lines ?? []), ...(perMin > 0 ? [`${perMin} a minute`] : [])].join(', '),
      });
    }
  if (map.unmapped > 0) nodes.push({ id: 'unmapped', column: 'other', label: 'No building yet', glyph: '?', badge: `×${map.unmapped}`, aria: `No building yet: ${map.unmapped} ${map.unmapped === 1 ? 'resource' : 'resources'} in your account the city has no building for` });

  // Real links: from the service to where its data goes (a Region, or a lettered Zone), as AWS reports them.
  const azs = (inv?.zones?.[region] ?? []).map((z) => z.name);
  const placeOf = (end: { region: string; az?: string }) => {
    const i = end.az ? azs.indexOf(end.az) : -1;
    return end.az ? (i >= 0 ? `Zone ${String.fromCharCode(65 + i)}` : end.az) : end.region;
  };
  const links: ArchLinkIn[] = [];
  const places = new Set<string>();
  for (const l of inv?.links ?? []) {
    if (!present.has(l.serviceId) || (l.from.region !== region && l.to.region !== region)) continue;
    const away = l.from.region === region && !l.from.az ? l.to : l.from.region !== region ? l.from : l.to;
    const place = placeOf(away);
    const id = `place:${place}`;
    if (!places.has(id)) {
      places.add(id);
      // A Region has its group icon; a Zone shows its letter, as the city's islands are lettered.
      nodes.push({ id, column: 'elsewhere', label: place, ...(away.az ? { glyph: place.replace(/^Zone /, '') } : { icon: { kind: 'group' as const, id: 'region' } }), aria: `${place}: where this data goes` });
    }
    links.push({ id: `real:${l.id}`, from: l.serviceId, to: id, style: 'real', twoWay: l.twoWay, title: l.label });
  }

  // Typical links: how these services usually connect (AWS examples), never read from the account.
  const legs = courierLegs(
    opts.flows.filter((f) => !FAN_IN.has(f.id)),
    (id) => present.has(id),
  );
  for (const leg of legs) links.push({ id: `typical:${leg.from}>${leg.to}`, from: leg.from, to: leg.to, style: 'typical', perMin: rateOf.get(leg.to) ?? rateOf.get(leg.from), title: leg.title });

  const columns: ArchColumn[] = [...TIERS.filter((t) => nodes.some((n) => n.column === t.id)).map((t) => ({ id: t.id, label: t.label })), ...(places.size ? [{ id: 'elsewhere', label: 'Where data goes' }] : [])];
  return {
    columns,
    nodes,
    links,
    legs,
    ...(bill && days ? { total: { ...costView(bill.total, days), currency, month: bill.month } } : {}),
    costed: nodes.some((n) => n.lines?.length),
  };
}

/** "So far in 2026-11: $11.55 (AWS's estimate, all Regions) · $0.53 a day est. · $15.75 for the month est." */
export const totalLine = (t: NonNullable<AccountDiagram['total']>) =>
  `So far in ${t.month}: ${dollars(t.soFar, t.currency)} (AWS’s estimate, all Regions) · ${dollars(t.perDay, t.currency)} a day est. · ${dollars(t.perMonth, t.currency)} for the month est.`;
