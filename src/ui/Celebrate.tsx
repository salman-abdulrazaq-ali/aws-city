import { useRef, type RefObject } from 'react';
import { startQuest as notifyQuest } from '@/app/runtime';
import { nextUnlock } from '@/state/ladder';
import { useCity } from '@/state/store';
import { questById, QUESTS } from '@/world/content';
import { placeFor } from '@/world/places';
import { FIRST_STEPS, FIRST_STEPS_QUEST, fill } from '@/state/firstSteps';
import { coins } from '@/state/wallet';
import { REGIONS } from '@/world/culture';
import { ExplainBack } from './ExplainBack';
import { feel } from './feedback';
import { Portrait } from './Portrait';
import { Plain } from './Term';
import { useLadderInput } from './useLadder';
import { useDialog, useShieldGame } from './useDialog';
import { WorkshopDone } from './WorkshopDone';

/** The big moments' cards: a finished quest, and a finished workshop (src/ui/WorkshopDone.tsx). */
export function Celebrate({ openTab }: { openTab?: (t: 'home') => void } = {}) {
  return (
    <>
      <QuestDone openTab={openTab} />
      <WorkshopDone />
    </>
  );
}

/**
 * The one big moment a quest gets: Connie cheers, says which buildings grew and how many stars you earned, what opens
 * next, and offers the next quest. It replaces the toast, so finishing a quest makes one celebration, not five.
 */
function QuestDone({ openTab }: { openTab?: (t: 'home') => void }) {
  const id = useCity((s) => s.celebration);
  const close = useCity((s) => s.celebrate);
  const quests = useCity((s) => s.progress.quests);
  const start = useCity((s) => s.startQuest);
  const input = useLadderInput();
  const box = useRef<HTMLElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  const q = id ? questById(id) : undefined;
  const graduation = q?.id === FIRST_STEPS_QUEST;
  // Focus on the next step (graduation's card opens with Connie's words, whose glossary terms come first otherwise).
  useDialog(!!q, box, () => close(undefined), graduation ? primary : undefined);
  useShieldGame(!!q, scrim);
  if (!q) return null;

  const grew = q.serviceIds.map((sid) => placeFor(sid)?.place).filter((p): p is string => !!p);
  const next = QUESTS.find((x) => !quests?.[x.id]);
  const opens = nextUnlock(input);
  const go = () => {
    close(undefined);
    if (!next) return void (graduation && openTab?.('home'));
    feel.questStart();
    start(next.id);
    notifyQuest(next.id);
    // The next quest's first step is on the City tab's list (a quest often ends in Learn or Deploy).
    openTab?.('home');
  };
  if (graduation)
    return (
      <div ref={scrim} className="finding-scrim app-modal celebrate-scrim" role="presentation" onClick={(e) => e.target === e.currentTarget && close(undefined)}>
        <Graduation
          box={box}
          primary={primary}
          next={next && (next.id === 'storage-static-site' ? FIRST_STEPS.grad.next : `Next: ${next.title} →`)}
          onNext={go}
          onLater={() => {
            close(undefined);
            openTab?.('home');
          }}
        />
      </div>
    );

  return (
    <div ref={scrim} className="finding-scrim app-modal celebrate-scrim" role="presentation" onClick={(e) => e.target === e.currentTarget && close(undefined)}>
      <section ref={box} className="finding-card celebrate" role="dialog" aria-modal="true" aria-labelledby="celebrate-title">
        <div className="celebrate-burst" aria-hidden="true">
          🏆
        </div>
        <h3 id="celebrate-title">Quest complete!</h3>
        <p className="celebrate-name">{q.title}</p>
        <p className="celebrate-stars" aria-label={`You earned ${q.rewardXp} stars`}>
          +{q.rewardXp} ⭐
        </p>
        <div className="celebrate-say">
          <Portrait id="concierge" size={32} />
          <p>
            <b>Connie:</b> <Plain text={grew.length ? `Brilliant! ${grew.join(' and ')} grew because of you.` : 'Brilliant work!'} />
            {opens ? ` And something new is opening soon: ${opens.label}.` : ''}
          </p>
        </div>
        <ExplainBack key={q.id} quest={q} />
        <div className="celebrate-actions">
          {next ? (
            <button className="btn primary wide" onClick={go}>
              Next adventure: {next.title} →
            </button>
          ) : null}
          <button className={`btn ${next ? 'ghost' : 'primary'} wide`} onClick={() => close(undefined)}>
            Keep exploring
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * The first steps' graduation (DESIGN-tutorial §4.2): Connie's words, what the player learned, where their city is
 * (the Region's code, said here before quest 2 shows it), what just opened, and the next quest. The one celebration: the
 * city's tier-up plays behind it, and toasts wait until it closes.
 */
function Graduation({ box, primary, next, onNext, onLater }: {
  box: RefObject<HTMLElement | null>;
  primary: RefObject<HTMLButtonElement | null>;
  /** The next quest's button (none: "Look around first" is the one). */
  next?: string;
  onNext: () => void;
  onLater: () => void;
}) {
  const g = FIRST_STEPS.grad;
  const region = useCity((s) => REGIONS.regions.find((r) => r.code === s.cityRegion));
  const wallet = useCity((s) => coins(s.progress));
  // The copy names Oregon; a city in another Region says its own name and code.
  const where = region ? g.region.replace('Oregon', region.city).replace('us-west-2', region.code) : g.region;
  return (
    <section ref={box} className="finding-card celebrate graduate" role="dialog" aria-modal="true" aria-labelledby="celebrate-title">
      <div className="celebrate-burst" aria-hidden="true">
        🎓
      </div>
      <h3 id="celebrate-title">{g.title}</h3>
      <div className="celebrate-say">
        <Portrait id="concierge" size={32} />
        <p>
          <b>Connie:</b> <Plain text={g.connie} />
        </p>
      </div>
      <section className="grad-list" aria-labelledby="grad-learned">
        <h4 id="grad-learned" className="label">
          What you learned
        </h4>
        <ul>
          {g.learned.map((line) => (
            <li key={line}>
              <span aria-hidden="true">✓ </span>
              <Plain text={line} />
            </li>
          ))}
        </ul>
        <p className="grad-region">
          <Plain text={where} />
        </p>
      </section>
      <section className="grad-list" aria-labelledby="grad-open">
        <h4 id="grad-open" className="label">
          Now open
        </h4>
        <ul>
          <li>{g.open.jobs}</li>
          <li>{fill(g.open.decorate, { n: wallet })}</li>
          <li>{g.open.ask}</li>
        </ul>
      </section>
      <div className="celebrate-actions">
        {next && (
          <button ref={primary} className="btn primary wide" onClick={onNext}>
            {next}
          </button>
        )}
        <button ref={next ? undefined : primary} className={`btn ${next ? 'ghost' : 'primary'} wide`} onClick={onLater}>
          {g.later}
        </button>
      </div>
    </section>
  );
}
