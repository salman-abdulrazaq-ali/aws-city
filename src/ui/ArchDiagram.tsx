import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { reducedMotion } from '@/game/motion';
import type { ArchLayout } from '@/world/archDiagram';
import { actorIconPath, groupIconPath, iconPath, productIconPath } from '@/world/icons';
import { arrowHead, nextSlot, pathD, pointAt, twoLines, type ArrowKey } from './diagram/geometry';
import { serviceColor } from './diagram/DiagramBoard';

const ICON = { service: iconPath, product: productIconPath, actor: actorIconPath, group: groupIconPath } as const;
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/**
 * An architecture drawing (src/world/archDiagram.ts layoutArch): service boxes with their icons, counts and costs, and
 * links with dots moving along them. SVG dots (animateMotion) need no script per frame; they sit still under reduced
 * motion and pause while the page is hidden. Each box is a real button over the drawing, so keyboard, hit-testing and
 * screen readers use the same thing; arrow keys move between them.
 */
export function ArchDiagram({ layout, label, selected, onSelect }: { layout: ArchLayout; label: string; selected?: string; onSelect?: (id: string) => void }) {
  const { w, h, box } = layout;
  const svg = useRef<SVGSVGElement>(null);
  const btns = useRef(new Map<string, HTMLButtonElement>());
  const [still] = useState(reducedMotion);
  const [focusId, setFocusId] = useState(layout.nodes[0]?.id);

  // Dots stop while the page is hidden (the drawing unmounts when the dialog closes or the view changes).
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const sync = () => (document.hidden ? el.pauseAnimations?.() : el.unpauseAnimations?.());
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);

  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const slots = layout.nodes.map((n) => ({ id: n.id, at: { x: n.x, y: n.y } }));
  const onKey = (e: KeyboardEvent, id: string) => {
    if (!ARROWS.has(e.key)) return;
    const next = nextSlot(slots, id, e.key as ArrowKey);
    if (!next) return;
    e.preventDefault();
    setFocusId(next.id);
    btns.current.get(next.id)?.focus();
  };
  const tabId = layout.nodes.some((n) => n.id === focusId) ? focusId : layout.nodes[0]?.id;

  return (
    <div className={`arch-diagram arch-${layout.orientation}`} style={{ aspectRatio: `${w} / ${h}` }}>
      <svg ref={svg} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
        {layout.columns.map((c) => (
          <text key={c.id} className="arch-col" x={c.x} y={c.y} textAnchor={c.anchor}>
            {c.label}
          </text>
        ))}
        {layout.links.map((l) => {
          const d = pathD(l.pts);
          return (
            <g key={l.id} className={`arch-link ${l.style}`}>
              <path d={d} fill="none" strokeDasharray={l.style === 'typical' ? '5 4' : undefined} />
              <polygon points={arrowHead(l.pts)} />
              {l.twoWay && <polygon points={arrowHead([...l.pts].reverse())} />}
              {Array.from({ length: l.dots.count }, (_, i) => {
                if (still) {
                  const p = pointAt(l.pts, (i + 1) / (l.dots.count + 1));
                  return <circle key={i} className="arch-dot" cx={p.x} cy={p.y} r={2.5} />;
                }
                return (
                  <circle key={i} className="arch-dot" r={2.5}>
                    <animateMotion dur={`${l.dots.durMs}ms`} begin={`-${Math.round((i * l.dots.durMs) / l.dots.count)}ms`} repeatCount="indefinite" path={d} />
                  </circle>
                );
              })}
            </g>
          );
        })}
        {layout.nodes.map((n) => {
          const href = n.icon ? ICON[n.icon.kind](n.icon.id) : undefined;
          const x = n.x - box / 2;
          const y = n.y - box / 2;
          const color = n.icon?.kind === 'service' ? serviceColor(n.icon.id) : undefined;
          const lines = twoLines(n.label, 15);
          return (
            <g key={n.id} className={`arch-node ${selected === n.id ? 'selected' : ''}`}>
              <rect className="arch-box" x={x} y={y} width={box} height={box} rx={4} style={color ? { stroke: color } : undefined} />
              {href ? (
                <image href={href} x={x + 4} y={y + 4} width={box - 8} height={box - 8} />
              ) : (
                <text className="arch-glyph" x={n.x} y={n.y + 5} textAnchor="middle">
                  {n.glyph ?? '?'}
                </text>
              )}
              {n.badge && (
                <g className="arch-badge" transform={`translate(${x + box - 6} ${y - 6})`}>
                  <rect x={-2} y={0} width={Math.max(16, n.badge.length * 6 + 4)} height={12} rx={6} />
                  <text x={Math.max(16, n.badge.length * 6 + 4) / 2 - 2} y={9} textAnchor="middle">
                    {n.badge}
                  </text>
                </g>
              )}
              {lines.map((t, i) => (
                <text key={i} className="arch-label" x={n.x} y={y + box + 11 + i * 11} textAnchor="middle">
                  {t}
                </text>
              ))}
              {n.lines?.map((t, i) => (
                <text key={`c${i}`} className="arch-cost" x={n.x} y={y + box + 11 + lines.length * 11 + i * 10} textAnchor="middle">
                  {t}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
      <div className="arch-hit" role="group" aria-label={`${label}. Arrow keys move between services.`}>
        {layout.nodes.map((n) => (
          <button
            key={n.id}
            ref={(el) => {
              if (el) btns.current.set(n.id, el);
              else btns.current.delete(n.id);
            }}
            className={selected === n.id ? 'selected' : ''}
            style={{ left: pct(n.x - box / 2, w), top: pct(n.y - box / 2, h), width: pct(box, w), height: pct(box, h) }}
            tabIndex={n.id === tabId ? 0 : -1}
            aria-label={n.aria ?? n.label}
            aria-pressed={selected === n.id}
            onFocus={() => setFocusId(n.id)}
            onClick={() => onSelect?.(n.id)}
            onKeyDown={(e) => onKey(e, n.id)}
          />
        ))}
      </div>
    </div>
  );
}
