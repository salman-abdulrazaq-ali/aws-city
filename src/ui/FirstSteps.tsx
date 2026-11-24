import { useEffect, useMemo, useRef, useState } from 'react';
import { planDeploy, startPracticeTask } from '@/app/runtime';
import { isPracticeTask } from '@/backend/practiceTasks';
import { announce } from '@/state/announce';
import { bus } from '@/state/bus';
import { FIRST_STEPS, FIRST_STEPS_OF, fill, firstSteps, quietContext, type FirstSteps as Path } from '@/state/firstSteps';
import { tierOf } from '@/state/selectors';
import { useCity } from '@/state/store';
import { walkTo } from '@/state/walk';
import { TIER_XP } from '@/world/places';
import { landmarkOf } from '@/state/cities';
import type { Progress } from '@/backend/contract';
import { TaskCard } from './ActivityFeed';
import { feel } from './feedback';
import { Portrait } from './Portrait';
import { Plain } from './Term';
import { playAt } from './today';
import { openEverything } from './useLadder';

/**
 * The first steps' guide (DESIGN-tutorial §6.1): Connie's card at the top of the City tab, the one strip on Learn and
 * Deploy, and the path's moments (Sally's line, the planted citizen, the announce lines). Every word comes from
 * shared/first-steps.json (FIRST_STEPS); the path itself is src/state/firstSteps.ts.
 */

/** Where the guide's buttons send the player (App's setTab takes these). */
export type Go = (t: 'home' | 'cards' | 'deploy') => void;

/** The first steps' practice plan (the deploy step's template). */
export const PLAN_TEMPLATE = 'photo-bucket';
const S3 = 's3';
/** Sally's "Sort my fish" waits this long after her greeting, so one bubble is read before the next. */
const SAY_GAP_MS = 3500;
/** A walk that never arrives (another building tapped, the city asleep) gives its button back after this long. */
const WALK_GIVE_UP_MS = 30_000;

/** Where the player is on the path, with this device's prefs (a skip, a replay). */
export function useFirstSteps(): Path {
  const progress = useCity((s) => s.progress);
  const pref = useCity((s) => s.prefs.firstSteps);
  const replay = useCity((s) => s.prefs.firstStepsReplay);
  const builder = useCity((s) => s.prefs.builder);
  return useMemo(() => firstSteps(progress, { firstSteps: pref, firstStepsReplay: replay, builder }), [progress, pref, replay, builder]);
}

/** What `shows()` needs on the path (`{}` off it), to spread over a surface's own context. */
export function useQuiet(): { quiet?: boolean; steps?: string[] } {
  const progress = useCity((s) => s.progress);
  const pref = useCity((s) => s.prefs.firstSteps);
  const replay = useCity((s) => s.prefs.firstStepsReplay);
  const builder = useCity((s) => s.prefs.builder);
  return useMemo(() => quietContext(progress, { firstSteps: pref, firstStepsReplay: replay, builder }), [progress, pref, replay, builder]);
}

/** The step's copy. */
const copyOf = (step: number) => FIRST_STEPS.steps[step] ?? FIRST_STEPS.steps[0];

/** "First steps 2/6" (the HUD chip, the strip). */
export const stepsChip = (step: number) => fill(FIRST_STEPS.hud.steps, { n: step + 1 });

/** Stars S3 Lake still needs to reach Novice in this city (0 once it's there). */
function starsToGrow(p: Progress, region: string) {
  if (tierOf(p, S3, region) >= 1) return 0;
  return Math.max(1, TIER_XP[1] - (landmarkOf(p, S3, region)?.xp ?? 0));
}

/** The line for the step just done, shown above the next title (the fishing step's says whether the lake grew). */
function doneLine(step: number, toGrow: number): string | undefined {
  if (step <= 0) return undefined;
  if (step === 1) return copyOf(0).done ?? `Done: ${copyOf(0).title}.`;
  if (step === 2) return toGrow > 0 ? fill(copyOf(1).notyet ?? '', { n: toGrow }) : copyOf(1).grew;
  return `Done: ${copyOf(step - 1).title}.`;
}

/** The latest practice task (Watch Sally work), if this session has one. */
const usePracticeTaskView = () => useCity((s) => s.taskOrder.map((id) => s.tasks[id]).find((t) => t && isPracticeTask(t.taskId)));

/** The practice plan waiting for the player's OK, if one is. */
const useWaitingPlan = () => useCity((s) => Object.values(s.deploys).find((d) => d.templateId === PLAN_TEMPLATE && d.status === 'preview'));

/**
 * The path's moments, mounted once beside the tabs (it draws nothing): each step said aloud as it starts, Sally's line
 * as the fishing step starts, and the planted citizen as the citizen step starts with the city up.
 */
export function FirstStepsMoments() {
  const fs = useFirstSteps();
  const inCity = useCity((s) => s.view.name === 'city');
  const region = useCity((s) => s.cityRegion);
  const seen = useRef<number | undefined>(undefined);
  // A step done: "Done: Walk to S3 Lake. Step 2 of 6: Play S3 Fishing." (App's one polite live region.)
  useEffect(() => {
    if (!fs.active) return void (seen.current = undefined);
    const before = seen.current;
    seen.current = fs.step;
    if (before === undefined || before === fs.step) return;
    const p = useCity.getState().progress;
    const done = fs.step > before ? doneLine(fs.step, starsToGrow(p, region)) : undefined;
    announce(`${done ? `${done} ` : ''}Step ${fs.step + 1} of ${FIRST_STEPS_OF}: ${copyOf(fs.step).title}.`);
  }, [fs.active, fs.step, region]);
  // The fishing step: Sally asks for her fish sorted, after her greeting has been read.
  useEffect(() => {
    if (!fs.active || fs.step !== 1 || !inCity) return;
    const t = setTimeout(() => bus.emit('say', { agentId: S3, text: copyOf(1).sally ?? '', tone: 'info' }), SAY_GAP_MS);
    return () => clearTimeout(t);
  }, [fs.active, fs.step, inCity]);
  // The citizen step: one citizen with a question by Kai (the city places them; again when the city comes back up).
  useEffect(() => {
    if (fs.active && fs.step === 3 && inCity) bus.emit('requestNow', { serviceId: S3 });
  }, [fs.active, fs.step, inCity]);
  return null;
}

/** "Skip the first steps": the whole city opens (a replay just ends, leaving the city as it was). */
function skip(replay: boolean) {
  const s = useCity.getState();
  if (!replay) {
    s.setPref('builder', true);
    s.setPref('simple', false);
    openEverything();
  }
  s.skipFirstSteps();
}

/**
 * Connie's guide card (DESIGN §6.1): where the player is ("First steps · 2 of 6" and six marks), what the last step did,
 * the step's title and one plain paragraph, and the screen's one amber button, which does the step's thing. While the
 * step runs elsewhere (Kai walking, Sally working) the card says so and has no button. Pinned above whatever the City tab
 * shows, a building's card included, and followed by Sally's task card while she works.
 */
export function GuideCard({ openTab }: { openTab: Go }) {
  const fs = useFirstSteps();
  const toGrow = useCity((s) => starsToGrow(s.progress, s.cityRegion));
  const task = usePracticeTaskView();
  const plan = useWaitingPlan();
  const [walking, setWalking] = useState(false);
  const [asking, setAsking] = useState(false);
  const box = useRef<HTMLElement>(null);
  const go = useRef<HTMLButtonElement>(null);
  const step = fs.step;
  const c = copyOf(step);
  const working = step === 4 && !!task && (task.status === 'routing' || task.status === 'running');
  const running = (step === 0 && walking) || working;

  // A walk ends when the step does (Kai arrived), when another building is tapped, or after a while.
  useEffect(() => setWalking(false), [step]);
  useEffect(() => {
    if (!walking) return;
    const off = bus.on('select', ({ id }) => id !== S3 && setWalking(false));
    const t = setTimeout(() => setWalking(false), WALK_GIVE_UP_MS);
    return () => (off(), clearTimeout(t));
  }, [walking]);

  // The skip question: Escape keeps going (focus then returns to the step's button, below).
  useEffect(() => {
    if (!asking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !box.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      setAsking(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [asking]);

  // A step starts: its button takes focus when focus was nowhere, on the guide, or on the panel itself (never away from
  // a flashcard, a game, the citizen's sheet or the approval card).
  useEffect(() => {
    if (!fs.active || running || asking) return;
    const a = document.activeElement;
    const mine = !a || a === document.body || a.id === 'city-tabpanel' || !!box.current?.contains(a) || !!a.closest?.('.world-intro');
    if (mine) go.current?.focus({ preventScroll: true });
  }, [fs.active, step, running, asking]);

  if (!fs.active) return null;
  const done = doneLine(step, toGrow);

  const run = () => {
    feel.tap();
    switch (step) {
      case 0:
        setWalking(true);
        announce(c.running ?? c.title);
        return walkTo(S3);
      case 1:
        return playAt(S3);
      case 2:
        useCity.getState().select(S3);
        return openTab('cards');
      case 3:
        // The city walks Kai over (src/game/scenes/CityScene.ts); arriving opens the question, as a tap on its "?" does.
        return bus.emit('walkToRequest');
      case 4:
        feel.send();
        bus.emit('flyTo', { id: `agent:${S3}` });
        return void startPracticeTask();
      case 5:
        // Already planned (a second press): its card is waiting in Deploy.
        if (plan) return useCity.getState().openDeployAt(plan.deployId);
        planDeploy(PLAN_TEMPLATE);
        return openTab('deploy');
    }
  };

  return (
    <>
      <section ref={box} className="guide" aria-labelledby="guide-title">
        <div className="guide-head">
          <Portrait id="concierge" size={32} />
          <span className="guide-label" aria-hidden="true">
            {fill(FIRST_STEPS.guide.label, { n: step + 1 })}
          </span>
        </div>
        <div className="guide-segs" role="progressbar" aria-label="First steps done" aria-valuemin={0} aria-valuemax={FIRST_STEPS_OF} aria-valuenow={step}>
          {Array.from({ length: FIRST_STEPS_OF }, (_, i) => (
            <i key={i} className={i < step ? 'done' : i === step ? 'now' : ''} />
          ))}
        </div>
        {/* Keyed by step: each new step enters (the shared `enter`, from 0.6), instantly under reduced motion. */}
        <div key={step} className="guide-body">
          {done && (
            <p className="guide-done">
              <span aria-hidden="true">✓ </span>
              <Plain text={done} />
            </p>
          )}
          <h3 id="guide-title">
            <span className="sr-only">{`First steps, step ${step + 1} of ${FIRST_STEPS_OF}:`}</span> {c.title}
          </h3>
          <p className="guide-text">
            <Plain text={c.body} />
          </p>
          {asking ? (
            <div className="confirm guide-skip" role="alertdialog" aria-labelledby="guide-skip-title" aria-describedby="guide-skip-body">
              <b id="guide-skip-title">{FIRST_STEPS.skip.title}</b>
              <span id="guide-skip-body">{FIRST_STEPS.skip.body}</span>
              <div className="row">
                <button className="btn primary" autoFocus onClick={() => setAsking(false)}>
                  {FIRST_STEPS.skip.keep}
                </button>
                <button className="btn" onClick={() => skip(fs.replay)}>
                  {FIRST_STEPS.skip.go}
                </button>
              </div>
            </div>
          ) : running ? (
            <p className="guide-running" role="status">
              <span className="spinner" aria-hidden="true" /> {c.running}
            </p>
          ) : (
            <button ref={go} className="btn primary wide guide-go" onClick={run}>
              {c.button}
            </button>
          )}
          {c.note && !asking && <p className="guide-note">{c.note}</p>}
        </div>
        {!asking && (
          <button className="btn ghost tiny guide-skip-link" onClick={() => setAsking(true)}>
            {FIRST_STEPS.skip.link}
          </button>
        )}
      </section>
      {/* Watch Sally work: her task card under the guide, its follow-ups hidden (the guide holds the next step). */}
      {task && (step === 4 || step === 5) && (
        <div className="guide-task">
          <TaskCard key={task.taskId} task={task} quiet />
        </div>
      )}
    </>
  );
}

/**
 * The guide's one row on the Learn and Deploy tabs (DESIGN §6.1): where the player is, and a "Back to the city" button
 * only when this tab's step is done and the next one lives on the City tab.
 */
export function GuideStrip({ tab, openTab }: { tab: 'learn' | 'deploy'; openTab: Go }) {
  const fs = useFirstSteps();
  if (!fs.active) return null;
  const step = fs.step;
  const here = (tab === 'learn' && step === 2) || (tab === 'deploy' && step === 5);
  const line = here
    ? tab === 'learn'
      ? fill(copyOf(2).strip ?? '', { k: fs.count })
      : (copyOf(5).strip ?? '')
    : tab === 'learn' && step === 3
      ? (copyOf(2).done ?? '')
      : `${stepsChip(step)} · ${copyOf(step).title}`;
  return (
    <div className="guide-strip" role="region" aria-label="First steps">
      <Portrait id="concierge" size={20} />
      <span className="guide-strip-text">{line}</span>
      {!here && (
        <button
          className="btn tiny primary"
          onClick={() => {
            feel.tap();
            openTab('home');
          }}
        >
          {copyOf(2).back ?? 'Back to the city'}
        </button>
      )}
    </div>
  );
}

/** The ⋯ item's words: Play the first steps, or Replay once they're done (undefined while on them). */
export function playLabel(fs: Pick<Path, 'active' | 'graduated'>): string | undefined {
  if (fs.active) return undefined;
  return fs.graduated ? FIRST_STEPS.menu.replay : FIRST_STEPS.menu.play;
}
