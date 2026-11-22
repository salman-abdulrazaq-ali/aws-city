import archJson from '../../shared/city-architecture.json' with { type: 'json' };
import { dollars } from './accountCost';
import type { ArchColumn, ArchLinkIn, ArchNodeIn } from './archDiagram';

/**
 * My AWS → How AWS City runs: the city's own hosted architecture (shared/city-architecture.json, from infra/lib), drawn
 * the same way as the account. The only prices are Fargate's, worked out from the task sizes and the Price List figure
 * (infra/test/city-architecture.test.ts checks both against the synthesized stacks); the rest is pay per use, and the
 * idle total is the README's own estimate. Pure.
 */

export type CityCost = 'fargate' | 'fargate-while-on' | 'per-use' | 'not-priced' | 'none';
export interface FargateSize {
  cpu: number;
  memoryMiB: number;
  tasks: number;
}
export interface CityComponent {
  id: string;
  column: string;
  name: string;
  icon: { kind: 'service' | 'product' | 'actor'; id: string };
  simple: string;
  optional?: string;
  fargate?: FargateSize;
  cost: CityCost;
  stack?: string;
}
export interface CityArchitectureData {
  source: string;
  asOf: string;
  price: { region: string; vcpuHour: number; gbHour: number; source: string };
  idle: { env: string; low: number; high: number; source: string };
  columns: ArchColumn[];
  components: CityComponent[];
  links: [string, string][];
}

export const CITY_ARCH = archJson as unknown as CityArchitectureData;

/** Hours in a month, as src/world/regions.ts counts them. */
const HOURS_PER_MONTH = 730;

/** What a Fargate service costs an hour on demand: tasks × (vCPU × vCPU-hour + GB × GB-hour). */
export const fargateHourly = (f: FargateSize, price = CITY_ARCH.price) => f.tasks * ((f.cpu / 1024) * price.vcpuHour + (f.memoryMiB / 1024) * price.gbHour);

const costText = (c: CityComponent): string[] => {
  if (c.fargate && (c.cost === 'fargate' || c.cost === 'fargate-while-on')) {
    const hour = fargateHourly(c.fargate);
    return c.cost === 'fargate' ? [`${dollars(hour * 24)} a day`, `${dollars(hour * HOURS_PER_MONTH)} a month`] : [`${dollars(hour * 24)} a day while on`];
  }
  return c.cost === 'per-use' ? ['pay per use'] : [];
};

export function cityArchitecture(data: CityArchitectureData = CITY_ARCH): { columns: ArchColumn[]; nodes: ArchNodeIn[]; links: ArchLinkIn[]; serversHour: number; aiHour: number } {
  const nodes: ArchNodeIn[] = data.components.map((c) => {
    const lines = costText(c);
    return { id: c.id, column: c.column, label: c.name.replace(/^(Amazon|AWS) /, ''), icon: c.icon, ...(lines.length ? { lines } : {}), aria: [c.name, c.simple, ...lines].join('. ') };
  });
  const links: ArchLinkIn[] = data.links.map(([from, to]) => ({ id: `city:${from}>${to}`, from, to, style: 'design' }));
  const sum = (cost: CityCost) => data.components.filter((c) => c.cost === cost && c.fargate).reduce((n, c) => n + fargateHourly(c.fargate!), 0);
  return { columns: data.columns, nodes, links, serversHour: sum('fargate'), aiHour: sum('fargate-while-on') };
}

/** The line under the drawing: what's priced here, what isn't, and the project's own idle estimate. */
export const cityCostLine = (a: { serversHour: number; aiHour: number }, data: CityArchitectureData = CITY_ARCH) =>
  `The servers: ${dollars(a.serversHour * 24)} a day, ${dollars(a.serversHour * HOURS_PER_MONTH)} a month; the city's own AI ${dollars(a.aiHour * 24)} a day while it's on (Fargate list price in ${data.price.region}). The rest is pay per use. The project's own estimate while idle: about $${data.idle.low}–${data.idle.high} a month.`;
