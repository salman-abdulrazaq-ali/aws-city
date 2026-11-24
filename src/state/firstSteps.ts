// The first steps (the beginner path, quest `first-steps`): where a player is on it, whether the city is quiet, and the
// path's words (shared/first-steps.json). Pure: Progress (synced) plus the device's prefs, so every surface agrees and
// nothing new is sent to a server (contract unchanged).

import copyJson from '../../shared/first-steps.json' with { type: 'json' };
import type { Progress } from '@/backend/contract';
import { questById, type QuestStep } from '@/world/content';

/**
 * prefs.firstSteps: 'beginner' (WorldIntro's Start, or a dot), 'skipped' (Advanced, or Skip), 'replay' (⋯ → Play the
 * first steps: anyone, legacy and hosted players included, runs the path again from step 0).
 */
export type FirstStepsPref = 'beginner' | 'skipped' | 'replay' | undefined;
export const FIRST_STEPS_QUEST = 'first-steps';
/** The path's six steps. */
export const FIRST_STEPS_OF = 6;

/**
 * A replay's place on the path (prefs.firstStepsReplay, this device only). A replay can't reuse the synced quest:
 * Progress merges keep a finished quest finished and the higher step (src/state/progress.ts mergeProgress), so a reset
 * there would be undone by the next merge with the server's copy.
 */
export interface ReplayState {
  step: number;
  /** Cards answered on a cards step. */
  count?: number;
}

/** The prefs the path reads (a slice of the store's Prefs, so this file stays free of the store). */
export interface FirstStepsPrefs {
  firstSteps?: FirstStepsPref;
  firstStepsReplay?: ReplayState;
  builder?: boolean;
}

export interface FirstSteps {
  /** On the path now: the city is quiet (src/state/simple.ts) and the guide card leads. */
  active: boolean;
  /** The step on screen, 0..5. */
  step: number;
  of: typeof FIRST_STEPS_OF;
  /** Cards answered on the cards step (0 elsewhere). */
  count: number;
  /** Past the path: first steps done, skipped, or (a legacy save) a quest finished. Never while `active`. */
  graduated: boolean;
  skipped: boolean;
  /** A replay from ⋯ (prefs), not the synced quest. */
  replay: boolean;
  /** A save from before the path (another quest started or done, or "I already build on AWS"): never put in it. */
  legacy: boolean;
}

/** Another quest under way or finished (or "I already build on AWS"), and no first steps: never put in the path. */
export function isLegacy(p: Progress, prefs?: FirstStepsPrefs): boolean {
  if (p.quests?.[FIRST_STEPS_QUEST]) return false;
  // Only real quests count (a save's markers, like quest 2's re-cut, aren't quests).
  return !!prefs?.builder || Object.keys(p.quests ?? {}).some((id) => id !== FIRST_STEPS_QUEST && !!questById(id));
}

/** Quests finished (src/state/ladder.ts questsDone, here so the ladder can import this file). */
const questsDone = (p: Progress) => Object.values(p.quests ?? {}).filter((q) => q.status === 'done').length;

const clampStep = (n: number) => Math.min(FIRST_STEPS_OF - 1, Math.max(0, Math.floor(n) || 0));

/** Where the player is on the first steps. */
export function firstSteps(p: Progress, prefs?: FirstStepsPrefs): FirstSteps {
  const q = p.quests?.[FIRST_STEPS_QUEST];
  const legacy = isLegacy(p, prefs);
  if (prefs?.firstSteps === 'replay') {
    const r = prefs.firstStepsReplay;
    return { active: true, step: clampStep(r?.step ?? 0), of: FIRST_STEPS_OF, count: r?.count ?? 0, graduated: false, skipped: false, replay: true, legacy };
  }
  const skipped = prefs?.firstSteps === 'skipped';
  const active = !skipped && !legacy && q?.status === 'active';
  const graduated = !active && (q?.status === 'done' || skipped || questsDone(p) >= 1);
  return {
    active,
    step: clampStep(q?.status === 'done' ? FIRST_STEPS_OF - 1 : (q?.step ?? 0)),
    of: FIRST_STEPS_OF,
    count: active ? (q?.count ?? 0) : 0,
    graduated,
    skipped,
    replay: false,
    legacy,
  };
}

/** The quiet city: on the path, info toasts are dropped and the extras wait (src/state/simple.ts `quiet`). */
export const quietCity = (p: Progress, prefs?: FirstStepsPrefs) => firstSteps(p, prefs).active;

/** Whether arriving in a city should start the path: the player chose it, isn't a legacy save, and hasn't started it. */
export const startsFirstSteps = (p: Progress, prefs?: FirstStepsPrefs) =>
  prefs?.firstSteps === 'beginner' && !isLegacy(p, prefs) && !p.quests?.[FIRST_STEPS_QUEST];

/** The quest step on screen (undefined off the path). */
export function firstStep(p: Progress, prefs?: FirstStepsPrefs): QuestStep | undefined {
  const fs = firstSteps(p, prefs);
  return fs.active ? questById(FIRST_STEPS_QUEST)?.steps[fs.step] : undefined;
}

/**
 * What `shows()` needs to know about the path (src/state/simple.ts SimpleContext): `quiet`, and the step's kind so
 * Deploy shows on the deploy step. Empty off the path, so it can be spread over any other context.
 */
export function quietContext(p: Progress, prefs?: FirstStepsPrefs): { quiet?: boolean; steps?: string[] } {
  const step = firstStep(p, prefs);
  return step ? { quiet: true, steps: [step.kind] } : {};
}

// ── The path's words (shared/first-steps.json, DESIGN §7) ──────────────────────────

export interface FirstStepCopy {
  title: string;
  body: string;
  button: string;
  running?: string;
  sally?: string;
  done?: string;
  end?: string;
  grew?: string;
  gained?: string;
  notyet?: string;
  strip?: string;
  terms?: string;
  back?: string;
  citizen?: string;
  right?: string;
  wrong?: string;
  note?: string;
  practice?: string;
  approved?: string;
  rejected?: string;
}

export interface FirstStepsCopy {
  quest: string;
  /** The tutorial deck: the cards step counts only these, the citizen asks one of them. */
  deck: string[];
  map: { connie: string; start: string; note: string; advanced: string; tab: string; storm: string };
  guide: { label: string };
  steps: FirstStepCopy[];
  /** Sally's practice task (AgentBackend.practiceTask): plain words, played locally, never sent. */
  task: { id: string; agentId: string; prompt: string; steps: string[]; result: string };
  grad: { title: string; connie: string; learned: string[]; region: string; open: { jobs: string; decorate: string; ask: string }; next: string; later: string };
  coins: { note: string };
  /** `go`/`body` end a replay; a first run's skip goes to the quick tour (`tour`/`tourBody`, DESIGN-tutorial §6.4). */
  skip: { link: string; title: string; body: string; keep: string; go: string; tour: string; tourBody: string };
  resume: string;
  menu: { play: string; replay: string; tour: string };
  hud: { steps: string };
  /**
   * The quick tour (src/ui/Tour.tsx, DESIGN-tutorial §5): six stops; a stop's `hosted`/`local`/`tab`/`safari` replace its
   * body there, `demoTab` the demo's tab (stop 5: the practice console, `consoleTry` starts its Copilot on `consoleGoal`)
   * and `linked` its body once an account is linked.
   */
  tour: {
    label: string;
    next: string;
    back: string;
    end: string;
    try: string;
    tried: string;
    consoleTry: string;
    consoleGoal: string;
    consoleTried: string;
    done: string;
    stops: { id: string; title: string; body: string; hosted?: string; local?: string; tab?: string; demoTab?: string; safari?: string; linked?: string }[];
  };
  q2: { title: string; intro: string };
}

export const FIRST_STEPS: FirstStepsCopy = copyJson as FirstStepsCopy;

/** Fills `{n}`, `{k}`, `{step}`, `{answer}`, `{level}`, `{quest}` in a line: fill(FIRST_STEPS.hud.steps, { n: 2 }) → "First steps 2/6". */
export const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** The tutorial deck's card ids (s3-01, s3-04, s3-05). */
export const TUTORIAL_DECK: readonly string[] = FIRST_STEPS.deck;
