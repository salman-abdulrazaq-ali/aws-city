import { useEffect, useRef, useState } from 'react';
import { bus } from '@/state/bus';
import { growthLine, growthOf } from '@/state/growth';
import { dayKey } from '@/state/progress';
import { countRequest, REQUEST_LOG_KEY, THANKS_STARS, type CitizenRequest, type RequestLog } from '@/state/requests';
import { useCity } from '@/state/store';
import { feel } from './feedback';
import { readPref, writePref } from './logic';
import { ForLearners, Plain } from './Term';
import { useDialog, useShieldGame } from './useDialog';
import { FIRST_STEPS, fill, quietCity } from '@/state/firstSteps';
import { announce } from '@/state/announce';

/**
 * A citizen's question (src/state/requests.ts, raised by src/game/Requests.ts when Kai walks up): three answers in
 * simple words. Answering is a flashcard review for that building (right = good, wrong = again), and a right answer
 * adds a small thank-you. The card then says which building grew.
 *
 * A bottom sheet over the side column (App.tsx), never squeezed into the panel's short map: every answer in view, keys
 * 1–3 answer, and once answered the verdict leads ("Right!" / "Not quite: …"), with "Back to the city" focused.
 */
/** Only an answered question uses up one of the day's five (closed unanswered, the citizen keeps their "?"). */
function countAnswer() {
  try {
    const v = JSON.parse(readPref(REQUEST_LOG_KEY) ?? 'null') as RequestLog | null;
    const log = v && typeof v.day === 'string' && typeof v.n === 'number' ? v : undefined;
    writePref(REQUEST_LOG_KEY, JSON.stringify(countRequest(log, dayKey())));
  } catch {
    /* storage unavailable */
  }
}

/** The verdict that leads the sheet once answered (the first steps say it their own way). */
function verdictOf(r: CitizenRequest, picked: number, onPath: boolean): string {
  const c = FIRST_STEPS.steps[3];
  if (picked === r.right) return onPath && c.right ? c.right : `Thanks! +${THANKS_STARS} ⭐`;
  return onPath && c.wrong ? fill(c.wrong, { answer: r.options[r.right] }) : 'Not quite, but now you both know.';
}

export function RequestCard() {
  const [ask, setAsk] = useState<{ request: CitizenRequest; name: string }>();
  const [picked, setPicked] = useState<number>();
  const box = useRef<HTMLElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const choice = useRef<(i: number) => void>(() => undefined);
  // The first steps' citizen: the path's own words for the verdict.
  const onPath = useCity((s) => quietCity(s.progress, s.prefs));
  useEffect(
    () =>
      bus.on('citizenRequest', (r) => {
        feel.tap();
        setPicked(undefined);
        setAsk(r);
      }),
    [],
  );
  // ✕, Esc and "Back to the city" close it; a tap on the scrim doesn't (one stray tap lost the question).
  const answeredRef = useRef(false);
  answeredRef.current = picked !== undefined;
  const close = () => {
    bus.emit('citizenRequestDone', { answered: answeredRef.current });
    setAsk(undefined);
  };
  // Decorate opened over a question (its HUD button sits outside the scrim): the card waits until the drawer closes.
  const building = useCity((s) => !!s.build);
  const shown = !!ask && !building;
  useDialog(shown, box, close);
  // The backdrop is modal for the city too: a tap on it never selects a building, pans or walks Kai away.
  useShieldGame(shown, scrim);
  // 1–3 answer while the question is open (first, so a flashcard behind it on Learn isn't graded by the same key).
  const open = shown && picked === undefined;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      choice.current(Number(e.key) - 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);
  // Answered: the verdict leads (and is said), and "Back to the city" takes focus (Enter goes back).
  const said = ask && picked !== undefined ? verdictOf(ask.request, picked, onPath) : undefined;
  useEffect(() => {
    if (!said) return;
    announce(said);
    back.current?.focus({ preventScroll: true });
  }, [said]);
  if (!ask || building) return null;
  const { request: r, name } = ask;
  const answered = picked !== undefined;
  const right = picked === r.right;
  const choose = (i: number) => {
    if (answered || i < 0 || i >= r.options.length) return;
    setPicked(i);
    countAnswer();
    const s = useCity.getState();
    s.reviewCard(r.cardId, i === r.right ? 'good' : 'again');
    if (i === r.right) {
      s.addXp(r.serviceId, THANKS_STARS);
      feel.good();
    } else feel.bad();
    bus.emit('answer', { serviceId: r.serviceId, ok: i === r.right });
  };
  choice.current = choose;
  const st = useCity.getState();
  return (
    <div ref={scrim} className="finding-scrim" role="presentation">
      <section ref={box} className="finding-card request-card" role="dialog" aria-modal="true" aria-labelledby="request-title">
        <header className="finding-head">
          <span className="incident-icon" aria-hidden="true">
            🙋
          </span>
          <div className="finding-who">
            <b id="request-title">{name} has a question</b>
            <span className="muted">Help out and the city grows</span>
          </div>
          <button className="btn icon ghost" aria-label="Close" onClick={close}>
            ✕
          </button>
        </header>
        {said && (
          <p className={`request-verdict ${right ? 'right' : 'wrong'}`}>
            <b>
              <Plain text={said} still />
            </b>
          </p>
        )}
        <p className="request-q">
          <Plain text={r.question} />
        </p>
        <div className={`request-options ${answered && !right ? 'juice-wobble' : ''}`} role="group" aria-label="Answers">
          {r.options.map((o, i) => (
            <button
              key={i}
              className={`btn request-option ${answered && i === r.right ? 'right' : ''} ${answered && i === picked && !right ? 'wrong' : ''}`}
              disabled={answered && i !== picked && i !== r.right}
              aria-pressed={picked === i}
              onClick={() => choose(i)}
            >
              <span className="kbd" aria-hidden="true">
                {i + 1}
              </span>
              {/* One box for the words: the button is a flex row, so a marked term ("S3") would be a column of its own. */}
              <span className="request-option-text">
                <Plain text={o} still />
              </span>
            </button>
          ))}
        </div>
        {answered && (
          <div className="request-result">
            {!right && !onPath && (
              <p>
                The answer: <Plain text={r.options[r.right]} />
              </p>
            )}
            <p className="muted">🏗️ {growthLine(growthOf(st.progress, r.serviceId, st.cityRegion))}</p>
            {!onPath && (
              <ForLearners>
                <p>
                  <Plain text={r.answer} />
                </p>
              </ForLearners>
            )}
            <button ref={back} className="btn primary" onClick={close}>
              Back to the city
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
