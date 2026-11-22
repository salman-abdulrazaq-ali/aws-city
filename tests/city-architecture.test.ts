// My AWS → How AWS City runs: the city's own architecture, drawn like the account. Every part has a real icon and every
// line a real end; the only prices are worked out from Fargate's task sizes (infra/test/city-architecture.test.ts checks
// those against the stacks), and the file holds no dollar figure of its own.
import { describe, expect, it } from 'vitest';
import raw from '../shared/city-architecture.json' with { type: 'json' };
import { layoutArch } from '@/world/archDiagram';
import { CITY_ARCH, cityArchitecture, cityCostLine, fargateHourly } from '@/world/cityArchitecture';
import { actorIconPath, iconPath, productIconPath } from '@/world/icons';
import { serviceById } from '@/world/taxonomy';

describe('How AWS City runs', () => {
  it('every part has an icon that exists, and every line joins two parts in two known columns', () => {
    const ids = new Set(CITY_ARCH.components.map((c) => c.id));
    const columns = new Set(CITY_ARCH.columns.map((c) => c.id));
    for (const c of CITY_ARCH.components) {
      expect(columns.has(c.column), c.id).toBe(true);
      if (c.icon.kind === 'service') expect(serviceById(c.icon.id), c.id).toBeTruthy();
      const path = c.icon.kind === 'service' ? iconPath(c.icon.id) : c.icon.kind === 'product' ? productIconPath(c.icon.id) : actorIconPath(c.icon.id);
      expect(path, c.id).toBeTruthy();
    }
    for (const [a, b] of CITY_ARCH.links) {
      expect(ids.has(a), a).toBe(true);
      expect(ids.has(b), b).toBe(true);
    }
  });

  it('prices only Fargate, from its sizes: two servers $1.09 a day, the AI $8.72 a day while on', () => {
    const a = cityArchitecture();
    expect(a.serversHour).toBeCloseTo(2 * (0.5 * 0.03725 + 1 * 0.00409), 9);
    expect(a.aiHour).toBeCloseTo(8 * 0.03725 + 16 * 0.00409, 9);
    const server = a.nodes.find((n) => n.id === 'server')!;
    expect(server.lines).toEqual(['$1.09 a day', '$33.16 a month']);
    expect(a.nodes.find((n) => n.id === 'ai')!.lines).toEqual(['$8.72 a day while on']);
    expect(a.nodes.find((n) => n.id === 'dynamodb')!.lines).toEqual(['pay per use']);
    expect(a.nodes.find((n) => n.id === 'player')!.lines).toBeUndefined();
    expect(fargateHourly({ cpu: 1024, memoryMiB: 2048, tasks: 1 })).toBeCloseTo(0.03725 + 2 * 0.00409, 9);
    expect(cityCostLine(a)).toMatch(/The servers: \$1\.09 a day, \$33\.16 a month; the city's own AI \$8\.72 a day while it's on \(Fargate list price in eu-west-2\)\. The rest is pay per use\. The project's own estimate while idle: about \$60–85 a month\./);
  });

  it('the file holds no dollar figure of its own (only the price list figures and the README’s idle range)', () => {
    const { price: _price, idle: _idle, ...rest } = raw as Record<string, unknown>;
    expect(JSON.stringify(rest)).not.toMatch(/\$\d|usd|"(perDay|perMonth|monthly|daily)"/i);
  });

  it('lays out with every line drawn, in the tab and in the panel', () => {
    const a = cityArchitecture();
    for (const o of ['lr', 'tb'] as const) {
      const out = layoutArch(a.columns, a.nodes, a.links, o);
      expect(out.nodes).toHaveLength(CITY_ARCH.components.length);
      expect(out.links).toHaveLength(CITY_ARCH.links.length);
      expect(out.links.every((l) => l.style === 'design')).toBe(true);
    }
  });
});
