import { useRef, useState } from 'react';
import { useCity } from '@/state/store';
import { accountMap, itemLine, type MapNode } from '@/world/accountMap';
import { AwsIcon } from './AwsIcon';
import { BillLine } from './BillLine';
import { FlowLine } from './FlowLine';
import { accountLabel } from './DeployPanel';
import { Plain } from './Term';
import { useDialog } from './useDialog';

const ITEMS_SHOWN = 12;

const money = (n: number, currency: string) => `${currency === 'USD' ? '$' : `${currency} `}${n.toFixed(2)}`;

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

/**
 * "My AWS, live": the linked account as one map (src/world/accountMap.ts): what runs where, real data links, live
 * traffic and the month's cost, from what the server already reads. Opened from Deploy's account card and ⋯.
 */
export function AccountMap() {
  const open = useCity((s) => s.accountMapOpen);
  const inventory = useCity((s) => s.inventory);
  const bill = useCity((s) => s.bill);
  const flow = useCity((s) => s.flow);
  const region = useCity((s) => s.cityRegion);
  const account = useCity((s) => s.account);
  const close = () => useCity.getState().openAccountMap(false);
  const box = useRef<HTMLElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
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
          {map.total && (
            <p className="map-total">
              💲 <b>{money(map.total.amount, map.total.currency)}</b> so far in {map.total.month} (all Regions, estimated)
            </p>
          )}
        </div>

        {!inventory ? (
          <p className="muted">Reading your account… (it’s read when you link it, then every few minutes).</p>
        ) : map.empty ? (
          <p>
            <Plain text={`Nothing in ${region} yet. Ask an agent to build something (try “Create a bucket called photos-1”), then look again.`} />
          </p>
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
                    {t.id === 'other' && map.unmapped > 0 && <li className="muted small">{map.unmapped} more the city has no building for yet</li>}
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

        <p className="map-note muted small">
          This map shows what AWS lists in your account. Which resource talks to which comes next: it needs a small, read-only update to your AWS City role.
          {map.partial ? ' Turn on AWS Resource Explorer to see untagged resources too.' : ''}
        </p>
      </section>
    </div>
  );
}
