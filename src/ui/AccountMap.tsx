import { useRef, useState } from 'react';
import { openDocs, type Layout } from '@/app/runtime';
import type { InventoryItem } from '@/backend/contract';
import { useCity } from '@/state/store';
import { accountDiagram, totalLine } from '@/world/accountDiagram';
import { accountMap, itemLine, type AccountMap as Map, type MapNode } from '@/world/accountMap';
import { layoutArch } from '@/world/archDiagram';
import { CITY_ARCH, cityArchitecture, cityCostLine } from '@/world/cityArchitecture';
import { FLOWS } from '@/world/culture';
import { ArchDiagram } from './ArchDiagram';
import { AwsIcon } from './AwsIcon';
import { BillLine } from './BillLine';
import { FlowLine } from './FlowLine';
import { accountLabel } from './DeployPanel';
import { Plain } from './Term';
import { useDialog } from './useDialog';

const ITEMS_SHOWN = 12;

const money = (n: number, currency: string) => `${currency === 'USD' ? '$' : `${currency} `}${n.toFixed(2)}`;

/** What the listing saw that the city has no building for, by name (the types read like "guardduty:detector"). */
function UnmappedList({ items }: { items: InventoryItem[] }) {
  return (
    <ul className="map-items">
      {items.slice(0, ITEMS_SHOWN).map((it) => (
        <li key={it.arn}>{itemLine(it)}</li>
      ))}
      {items.length > ITEMS_SHOWN && <li className="muted">and {items.length - ITEMS_SHOWN} more</li>}
    </ul>
  );
}

/** One service on the map: its icon, how many, what it cost this month, and its live rate; tap for its resources. */
function Node({ node, currency }: { node: MapNode; currency?: string }) {
  const [open, setOpen] = useState(false);
  const busy = node.rates.some((r) => r.perMin > 0);
  return (
    <li className={`map-node ${busy ? 'busy' : ''}`}>
      <button className="map-node-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} title={open ? 'Hide its resources' : 'Show its resources'}>
        <AwsIcon serviceId={node.serviceId} size={28} />
        <span className="map-node-name">{node.name}</span>
        <span className="map-node-count" aria-label={`${node.count} resources`}>
          ×{node.count}
        </span>
      </button>
      {(node.cost !== undefined || node.rates.length > 0) && (
        <div className="map-node-meta">
          {node.cost !== undefined && currency && <span>💲 {money(node.cost, currency)} this month</span>}
          {node.rates.map((r) => (
            <span key={r.label} className={r.perMin > 0 ? 'live' : ''}>
              {r.perMin > 0 ? '● ' : ''}
              {r.perMin} {r.label.toLowerCase()} a minute
            </span>
          ))}
        </div>
      )}
      {open && (
        <ul className="map-items">
          {node.items.slice(0, ITEMS_SHOWN).map((it) => (
            <li key={it.arn}>
              {itemLine(it)}
              {it.managedByGame && <span className="muted"> · built by the city</span>}
            </li>
          ))}
          {node.items.length > ITEMS_SHOWN && <li className="muted">and {node.items.length - ITEMS_SHOWN} more</li>}
          {node.items.length === 0 && <li className="muted">Counted in your account; not listed one by one.</li>}
        </ul>
      )}
    </li>
  );
}

type View = 'services' | 'diagram' | 'city';
const VIEWS: { id: View; label: string }[] = [
  { id: 'services', label: 'Services' },
  { id: 'diagram', label: 'Diagram' },
  { id: 'city', label: 'How AWS City runs' },
];

/** A line sample for the legend (decorative: the words say what it means). */
const Sample = ({ kind }: { kind: 'real' | 'typical' }) => (
  <svg className={`arch-sample arch-link ${kind}`} width="28" height="8" aria-hidden="true">
    <path d="M1 4 L27 4" fill="none" strokeDasharray={kind === 'typical' ? '5 4' : undefined} />
  </svg>
);

/**
 * My AWS → Diagram (src/world/accountDiagram.ts): the services as a drawing, the dots moving along the links, each
 * service's cost a day and a month (est., from the real bill), and a legend that says which lines are real.
 */
function DiagramView({ map, layout }: { map: Map; layout: Layout }) {
  const inventory = useCity((s) => s.inventory);
  const bill = useCity((s) => s.bill);
  const flow = useCity((s) => s.flow);
  const [picked, setPicked] = useState<string>();
  const d = accountDiagram(map, inventory, { flows: FLOWS, bill, flow });
  const drawn = layoutArch(d.columns, d.nodes, d.links, layout === 'panel' ? 'tb' : 'lr');
  const node = map.tiers.flatMap((t) => t.nodes).find((n) => n.serviceId === picked);
  const unmappedPicked = picked === 'unmapped' && map.unmappedItems.length > 0;
  const pickedLinks = d.links.filter((l) => l.title && (l.from === picked || l.to === picked));
  return (
    <div className="arch-view">
      {d.total && (
        <p className="map-total">
          💲 <Plain text={totalLine(d.total)} />
        </p>
      )}
      <ArchDiagram layout={drawn} label={`Diagram of your AWS services in ${map.region}`} selected={picked} onSelect={(id) => setPicked((p) => (p === id ? undefined : id))} />
      <ul className="arch-legend small">
        <li>
          <Sample kind="real" /> Solid line: data AWS reports moving (copies to another Region, a standby in another Zone).
        </li>
        <li>
          <Sample kind="typical" /> Dashed line: how these services usually connect (AWS examples), not read from your account.
        </li>
        <li>● Dots move along the path; quicker where your account reports live traffic.</li>
        <li>{d.costed ? 'est.: worked out from AWS’s figure for this month so far (a day = so far ÷ days so far).' : 'Turn on Show my bill above to see what each service costs a day and a month.'}</li>
      </ul>
      {node && (
        <section className="arch-picked" aria-label={node.name}>
          <h4>
            <AwsIcon serviceId={node.serviceId} size={20} /> {node.name} <span className="muted small">×{node.count}</span>
          </h4>
          {node.cost !== undefined && d.total && (
            <p className="small">
              {money(node.cost, d.total.currency)} so far this month (AWS’s estimate, all Regions).
            </p>
          )}
          {node.rates.map((r) => (
            <p key={r.label} className="small">
              {r.perMin} {r.label.toLowerCase()} a minute
            </p>
          ))}
          <ul className="map-items">
            {node.items.slice(0, ITEMS_SHOWN).map((it) => (
              <li key={it.arn}>{itemLine(it)}</li>
            ))}
            {node.items.length > ITEMS_SHOWN && <li className="muted">and {node.items.length - ITEMS_SHOWN} more</li>}
            {node.items.length === 0 && <li className="muted">Counted in your account; not listed one by one.</li>}
          </ul>
          {pickedLinks.length > 0 && (
            <ul className="small">
              {pickedLinks.map((l) => (
                <li key={l.id}>
                  {l.style === 'real' ? 'Real: ' : 'Usually: '}
                  <Plain text={l.title!} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {unmappedPicked && (
        <section className="arch-picked" aria-label="No building yet">
          <h4>
            No building yet <span className="muted small">×{map.unmapped}</span>
          </h4>
          <p className="small">In your account, but not one of the city’s buildings yet:</p>
          <UnmappedList items={map.unmappedItems} />
        </section>
      )}
      {d.legs.length > 0 && (
        <details className="arch-legs">
          <summary>How these usually connect ({d.legs.length})</summary>
          <ul>
            {d.legs.map((leg) => (
              <li key={`${leg.from}>${leg.to}`}>
                <b>
                  <Plain text={leg.title} />
                </b>
                <br />
                <Plain text={leg.text} />{' '}
                <button className="btn tiny ghost" onClick={() => openDocs(leg.source)}>
                  AWS source ↗
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * My AWS → How AWS City runs (src/world/cityArchitecture.ts): the city's own hosted architecture, drawn the same way,
 * with the only prices it can stand behind (Fargate's) and the README's own idle estimate.
 */
function CityView({ layout }: { layout: Layout }) {
  const [picked, setPicked] = useState<string>();
  const a = cityArchitecture();
  const drawn = layoutArch(a.columns, a.nodes, a.links, layout === 'panel' ? 'tb' : 'lr');
  const part = CITY_ARCH.components.find((c) => c.id === picked);
  return (
    <div className="arch-view">
      <p className="muted small">How this city reaches you, and your account, when it’s hosted on AWS (from its infrastructure code).</p>
      <ArchDiagram layout={drawn} label="Diagram of how AWS City runs on AWS" selected={picked} onSelect={(id) => setPicked((p) => (p === id ? undefined : id))} />
      <p className="map-total">
        💲 <Plain text={cityCostLine(a)} />
      </p>
      <ul className="arch-legend small">
        <li>● Dots follow a request: in through the front door, to the server, to the data, the AI and your account.</li>
        <li>Prices are list prices for the servers on Fargate; everything else costs only what the players use.</li>
      </ul>
      {part && (
        <section className="arch-picked" aria-label={part.name}>
          <h4>{part.name}</h4>
          <p className="small">
            <Plain text={part.simple} />
          </p>
          {part.optional && (
            <p className="muted small">
              <Plain text={part.optional} />
            </p>
          )}
        </section>
      )}
    </div>
  );
}

/**
 * "My AWS, live": the linked account as one map (src/world/accountMap.ts): what runs where, real data links, live
 * traffic and the month's cost, from what the server already reads. Opened from Deploy's account card and ⋯.
 */
export function AccountMap({ layout = 'full' }: { layout?: Layout }) {
  const open = useCity((s) => s.accountMapOpen);
  const inventory = useCity((s) => s.inventory);
  const bill = useCity((s) => s.bill);
  const flow = useCity((s) => s.flow);
  const region = useCity((s) => s.cityRegion);
  const account = useCity((s) => s.account);
  const close = () => useCity.getState().openAccountMap(false);
  const box = useRef<HTMLElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<View>('services');
  useDialog(open, box, close, closeBtn);
  if (!open) return null;
  const map = accountMap(inventory, { region, bill, flow });
  return (
    <div className="finding-scrim" role="presentation" onClick={(e) => e.target === e.currentTarget && close()}>
      <section ref={box} className="finding-card account-map" role="dialog" aria-modal="true" aria-labelledby="account-map-title">
        <header className="finding-head">
          <span className="incident-icon" aria-hidden="true">
            🗺️
          </span>
          <div className="finding-who">
            <b id="account-map-title">My AWS, live</b>
            <span className="muted">
              {account.accountId ? `Account ${accountLabel(account.accountId)} · ` : ''}
              {region}
            </span>
          </div>
          <button ref={closeBtn} className="btn ghost tiny" onClick={close} aria-label="Close the map">
            ✕
          </button>
        </header>

        <div className="map-switches">
          <BillLine region={region} />
          <FlowLine />
          {map.total && view === 'services' && (
            <p className="map-total">
              💲 <b>{money(map.total.amount, map.total.currency)}</b> so far in {map.total.month} (all Regions, estimated)
            </p>
          )}
        </div>

        <div className="seg" role="group" aria-label="Views">
          {VIEWS.map((v) => (
            <button key={v.id} aria-pressed={v.id === view} onClick={() => setView(v.id)}>
              {v.label}
            </button>
          ))}
        </div>

        {view === 'city' ? (
          <CityView layout={layout} />
        ) : !inventory ? (
          <p className="muted">Reading your account… (it’s read when you link it, then every few minutes).</p>
        ) : map.empty ? (
          <p>
            <Plain text={`Nothing in ${region} yet. Ask an agent to build something (try “Create a bucket called photos-1”), then look again.`} />
          </p>
        ) : view === 'diagram' ? (
          <DiagramView map={map} layout={layout} />

        ) : (
          <>
            <p className="muted small">Left to right, the way a request usually travels: in through the front door, to your code, to your data.</p>
            <div className="map-tiers">
              {map.tiers.map((t) => (
                <section key={t.id} className={`map-tier tier-${t.id}`} aria-label={t.label}>
                  <h4>
                    {t.label} <span className="muted small">{t.hint}</span>
                  </h4>
                  <ul>
                    {t.nodes.map((n) => (
                      <Node key={n.serviceId} node={n} currency={map.total?.currency} />
                    ))}
                    {t.id === 'other' && map.unmapped > 0 && (
                      <li className="muted small">
                        <details className="map-unmapped">
                          <summary>{map.unmapped} more the city has no building for yet</summary>
                          <UnmappedList items={map.unmappedItems} />
                        </details>
                      </li>
                    )}
                  </ul>
                </section>
              ))}
            </div>

            {map.zones.some((z) => z.items.length) && (
              <section className="map-zones" aria-label="Availability Zones">
                <h4>Availability Zones</h4>
                <div className="map-zone-row">
                  {map.zones.map((z) => (
                    <div key={z.name} className={`map-zone ${z.items.length ? '' : 'empty'}`}>
                      <b>{z.letter}</b> <span className="muted small">{z.name}</span>
                      <ul>
                        {z.items.map((it) => (
                          <li key={it.arn}>{itemLine(it)}</li>
                        ))}
                        {!z.items.length && <li className="muted small">nothing here</li>}
                      </ul>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="map-links" aria-label="Data that moves">
              <h4>Data that moves</h4>
              {map.links.length ? (
                <ul>
                  {map.links.map((l) => (
                    <li key={l.id}>
                      <Plain text={l.text} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No data copied between Zones or Regions yet.</p>
              )}
            </section>

            {map.elsewhere.length > 0 && (
              <p className="muted small">
                Also in your account: {map.elsewhere.map((e) => `${e.count} in ${e.region}`).join(', ')} (each Region is its own city on the world map).
              </p>
            )}
          </>
        )}

{view !== 'city' && (
                  <p className="map-note muted small">
          This map shows what AWS lists in your account. Which resource talks to which comes next: it needs a small, read-only update to your AWS City role.
          {map.partial ? ' Turn on AWS Resource Explorer to see untagged resources too.' : ''}
        </p>
        )}
      </section>
    </div>
  );
}
