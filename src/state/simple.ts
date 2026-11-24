// Simple mode (prefs.simple, on by default): the game shows a plain To-do list and hides the extras. Pure: every surface
// asks `shows(feature, prefs)` here, so the panel, the tab, the city and the store agree, and nothing is ever deleted:
// with "Everything" on (⋯ → Show everything) each surface comes back exactly as it was. The To-do list is built here
// too, from the existing next action (src/state/next.ts), today's goals (src/state/progress.ts) and the order board.

import { questById } from '@/world/content';
import { placeFor } from '@/world/places';
import type { NextPlan, OpenJob } from './next';
import type { TodayGoal } from './progress';

/** Simple unless the player turned "Everything" on (an absent pref is Simple: it's the default). */
export const isSimple = (prefs: { simple?: boolean } | undefined) => prefs?.simple !== false;

/** Every surface Simple mode changes. Hidden in Simple unless `shows` says otherwise. */
export type Feature =
  // shown only in Simple
  | 'todo'
  // Home (Everything): today's shift card and its extras
  | 'shift'
  | 'moreToDo'
  | 'supplyDrop'
  | 'overtime'
  | 'returnNote'
  | 'weekly'
  | 'launchDay'
  | 'certGoal'
  | 'agentOffer'
  // the loops and rewards (HUD, My City, toasts)
  | 'cityLights'
  | 'seasonRoad'
  | 'codex'
  | 'comboToast'
  | 'rank'
  | 'badgeToast'
  | 'myCityExtras'
  // the city and the stage
  | 'news'
  | 'courierHint'
  | 'blueprint'
  | 'rushSurge'
  // tabs and panels that Simple shows only when they're needed
  | 'care'
  | 'deployTab'
  | 'drawingBoard'
  // shown in both modes, but they wait in the quiet city (the first steps: src/state/firstSteps.ts quietContext)
  | 'coins'
  | 'decorate'
  | 'promptBar'
  | 'copilotSwitch'
  | 'eventBanner'
  | 'comingUp'
  | 'connect'
  | 'accountCard'
  | 'tokens'
  | 'citizenRequests'
  | 'coachTips';

/** Shown in Simple and Everything alike, except in the quiet city. */
const OUTSIDE_THE_PATH: ReadonlySet<Feature> = new Set([
  'coins',
  'decorate',
  'promptBar',
  'copilotSwitch',
  'eventBanner',
  'comingUp',
  'connect',
  'accountCard',
  'tokens',
  'citizenRequests',
  'coachTips',
]);

/** What a surface knows that can bring a hidden part back in Simple (the part is needed now). */
export interface SimpleContext {
  /** Quests finished (City care shows in Simple from the first one). */
  questsDone?: number;
  /** An AWS account is linked: its findings are real, and the Deploy tab is where its changes are approved. */
  linked?: boolean;
  /** The kinds of the active quests' steps: a deploy step needs the Deploy tab, a design step the Drawing board. */
  steps?: readonly string[];
  /** A change is waiting for the player's approval in Deploy. */
  deployWaiting?: boolean;
  /** A real account is being linked (src/state/account.ts `linking`): its steps are in Deploy. */
  linking?: boolean;
  /** A hosted player with no AWS account linked yet: Deploy is where it connects. */
  canConnect?: boolean;
  /**
   * The quiet city: the player is on the first steps (src/state/firstSteps.ts quietContext, which also puts the step's
   * kind in `steps`). Everything waits but the path itself: Deploy only on its plan's step.
   */
  quiet?: boolean;
}

/** Whether `feature` shows for these prefs (and, in Simple, whether it's needed now). */
export function shows(feature: Feature, prefs: { simple?: boolean } | undefined, ctx: SimpleContext = {}): boolean {
  // The quiet city, in either mode: the guide card leads, and only the Deploy tab comes, for the plan's step.
  if (ctx.quiet) return feature === 'deployTab' && !!ctx.steps?.includes('deploy');
  if (OUTSIDE_THE_PATH.has(feature)) return true;
  if (!isSimple(prefs)) return feature !== 'todo';
  switch (feature) {
    case 'todo':
      return true;
    case 'care':
      return (ctx.questsDone ?? 0) >= 1 || !!ctx.linked;
    case 'deployTab':
      return !!ctx.steps?.includes('deploy') || !!ctx.linked || !!ctx.deployWaiting || !!ctx.linking || !!ctx.canConnect;
    case 'drawingBoard':
      return !!ctx.steps?.includes('design');
    default:
      return false;
  }
}

// ── The To-do list ──────────────────────────────────────────────────────────────

/** The most tasks the list shows at once. */
export const TODO_MAX = 5;
/** Below this many, the order board's other jobs fill the list. */
const TODO_MIN = 3;
/** While a quest step is open, the day reads done only once this many of today's goals are ticked. */
export const DAY_MIN_DONE = 2;

/**
 * What a task's "Do it" button runs: a plan (src/state/next.ts runs it), one of today's goals (the UI opens it), or the
 * account card in Deploy (`connect`: a hosted player's own AWS account, src/state/account.ts connectOffer).
 */
export type TodoRun = { kind: 'plan'; plan: NextPlan } | { kind: 'goal'; goal: TodayGoal['id'] } | { kind: 'connect' };

export interface TodoTask {
  /** One key per thing to do: the list never holds two of the same. */
  key: string;
  /** What the task is ("Today’s cards", the quest's name). */
  title: string;
  /** One line: why it's worth doing. */
  why: string;
  /** The "Do it" button: exactly what happens ("Walk to S3 Lake", "Review 5 cards", "Play Fishing"). */
  action: string;
  done: boolean;
  /** "2/5", for a goal with more than one to do. */
  have?: number;
  goal?: number;
  /** One of today's goals: it counts towards the progress bar and "To do 2/4". */
  counts: boolean;
  /**
   * The quest step on a short day (fewer than DAY_MIN_DONE goals): it keeps the day open, so it counts towards "To do
   * n/m" too, never ticked (the next step takes its place).
   */
  holds?: boolean;
  run: TodoRun;
}

export interface TodoInput {
  /** The one next action (planNext / nextAction). */
  next: NextPlan;
  /** Today's own goals (todayGoals, bonus ones left out). */
  goals: TodayGoal[];
  /** The order board's open jobs (openJobs), the helped business first. */
  jobs: OpenJob[];
  /** The mini-game today's game goal opens ("Fishing"). */
  gameName?: string;
  /** A hosted, signed-in player with no working link (connectOffer): one quiet "Connect your AWS account" row. */
  connect?: 'connect' | 'relink';
}

const place = (id: string) => placeFor(id)?.place ?? id;

/** The thing a plan does, as a key: a plan and a goal that are the same thing share one (so they merge). */
function planKey(p: NextPlan): string | undefined {
  switch (p.kind) {
    case 'step':
      return p.step.kind === 'cards' ? 'cards' : p.step.kind === 'puzzle' ? 'puzzles' : `step:${p.questId}`;
    case 'review':
    case 'upgrade':
    case 'grow':
      return 'cards';
    case 'job':
      return 'jobs';
    case 'workshop':
      return 'labs';
    case 'quest':
      return `quest:${p.questId}`;
    case 'explore':
      return undefined;
    default:
      return p.kind;
  }
}

/** The next action as a task (none for "walk round your city": that's what the list's end says). */
function planTask(p: NextPlan): TodoTask | undefined {
  const key = planKey(p);
  if (!key) return undefined;
  const base = { key, action: p.label, done: false, counts: false, run: { kind: 'plan', plan: p } as TodoRun };
  switch (p.kind) {
    case 'step': {
      const q = questById(p.questId);
      const at = q ? q.steps.indexOf(p.step) : -1;
      return { ...base, title: `${q?.title ?? 'Your quest'}${q && at >= 0 ? ` · step ${at + 1} of ${q.steps.length}` : ''}`, why: p.step.text };
    }
    case 'quest':
      return { ...base, title: 'A new quest', why: `“${questById(p.questId)?.title ?? 'A quest'}” takes about five minutes and shows you how the city works.` };
    case 'review':
      return { ...base, title: 'Cards to review', why: 'They come back right before you’d forget them.' };
    case 'upgrade':
      return { ...base, title: `${place(p.serviceId)} is nearly at its next level`, why: 'A few cards and it grows.' };
    case 'grow':
      return { ...base, title: `Grow ${place(p.serviceId)}`, why: 'Every card you review grows this building a little.' };
    case 'job':
      return { ...base, title: p.label.replace(/^Do a job for /, 'A job for '), why: 'A business in town needs your help.' };
    case 'workshop':
      return { ...base, title: 'A workshop', why: 'Practise real AWS commands, step by step.' };
    case 'build':
      return { ...base, title: 'A new building', why: 'Ask its agent to move in, and your city grows.' };
    case 'tokens':
      return { ...base, title: 'Golden tokens', why: 'They hide on this city’s streets. Walk round and look for a glint.' };
    default:
      return undefined;
  }
}

/** The account row: optional, never ticked, never one of today's goals (so it never holds the day open). */
export const connectTask = (offer: 'connect' | 'relink'): TodoTask => ({
  key: 'connect',
  done: false,
  counts: false,
  run: { kind: 'connect' },
  ...(offer === 'relink'
    ? { title: 'Your AWS account needs you', why: 'AWS City can’t use its role in your account any more.', action: 'Link it again' }
    : { title: 'Your AWS account', why: 'Optional: link it, and agents can build real things there. You approve every change.', action: 'Connect your AWS account' }),
});

/** One of today's goals as a task. */
function goalTask(g: TodayGoal, jobs: OpenJob[], gameName: string | undefined): TodoTask {
  const done = g.have >= g.goal;
  const base = { key: g.id as string, done, counts: true, ...(g.goal > 1 ? { have: g.have, goal: g.goal } : {}), run: { kind: 'goal', goal: g.id } as TodoRun };
  const left = Math.max(1, g.goal - g.have);
  switch (g.id) {
    case 'cards':
      return { ...base, title: 'Today’s cards', why: 'Each card you get right grows its building.', action: done ? 'Review more cards' : `Review ${left} ${left === 1 ? 'card' : 'cards'}` };
    case 'puzzles':
      return { ...base, title: 'Today’s puzzle', why: 'Put the AWS pieces in the right places.', action: 'Solve a puzzle' };
    case 'games':
      return { ...base, title: 'Today’s game', why: 'Quick practice that pays City Coins.', action: `Play ${gameName ?? 'a mini-game'}` };
    case 'labs':
      return { ...base, title: 'A workshop step', why: 'Type one real AWS command, safely.', action: 'Open the Workshop Studio' };
    case 'fixes':
      return { ...base, title: 'Fix something', why: 'A helper found something to make safer.', action: 'Open City care' };
    case 'designs':
      return { ...base, title: 'Draw a design', why: 'Draw anything, and get a friendly review.', action: 'Open the Drawing board' };
    case 'jobs': {
      const j = jobs[0];
      // The job itself when the board has one (Kai walks to its station); else the board.
      if (j) return { ...base, title: `A job for ${j.client}`, why: `“${j.title}”`, action: `Do a job for ${j.client}`, run: { kind: 'plan', plan: { kind: 'job', label: `Do a job for ${j.client}`, taskId: j.taskId, clientId: j.clientId } } };
      return { ...base, title: 'A job', why: 'Businesses in town need your help.', action: 'Open the order board' };
    }
  }
}

/** The To-do list: the rows on it, the goals behind "+N more", and (once the day is done) the next action on offer. */
export interface TodoList {
  /** The rows shown (at most TODO_MAX). */
  tasks: TodoTask[];
  /** The rest of today's goals, behind "+N more" (never dropped: they count, and an open one keeps the day open). */
  more: TodoTask[];
  /** Once every row is ticked: the next action, offered under "Done for today" ("Want more?"), not a row to tick. */
  extra?: TodoTask;
}

/**
 * The To-do list: the next action first, then today's goals, then (while the list is short) the order board's other
 * jobs; one task per key (a plan that is one of today's goals merges into it: its button, the goal's tick). Every task
 * has one button that says what happens, and runs. The list is a day's worth: once today's goals are all ticked, the
 * rows that never tick (the next action, the board's jobs) leave it, and the next action waits as `extra`, so the day
 * can end. Over TODO_MAX rows, the board's jobs go first, never a goal: the goals left over wait behind "+N more"
 * (the ticked ones first), still counted.
 */
export function buildTodo(i: TodoInput): TodoList {
  const out: TodoTask[] = [];
  const at = new Map<string, number>();
  const add = (t: TodoTask) => {
    const k = at.get(t.key);
    if (k === undefined) return (at.set(t.key, out.length), void out.push(t));
    // The same thing twice: the first keeps its place, button and words; a goal brings its tick and count.
    const first = out[k];
    // A goal already met never ticks a quest step that's still to do (seen 24 Nov 2026: after replaying the first steps,
    // "Review 5 cards" was met and struck "The City Brochure Site · step 3 of 7"): the met goal is its own row.
    const stepStillToDo = first.run.kind === 'plan' && first.run.plan.kind === 'step';
    if (t.counts && t.done && stepStillToDo) return (at.set(`${t.key}:met`, out.length), void out.push({ ...t, key: `${t.key}:met` }));
    if (t.counts && !first.counts) out[k] = { ...first, done: t.done, counts: true, have: t.have, goal: t.goal };
  };
  const first = planTask(i.next);
  if (first) add(first);
  for (const g of i.goals) if (!g.bonus) add(goalTask(g, i.jobs, i.gameName));
  // Today's goals all ticked: the day is done. The rows that never tick leave; the next action is offered instead.
  // Unless a quest is under way and the day has fewer than DAY_MIN_DONE goals (a first day has one): then its step
  // stays a row to do (and is counted as one), so one mini-game round never ends the day mid-quest.
  const goals = out.filter((t) => t.counts);
  const questHolds = !!first && i.next.kind === 'step' && !out[at.get(first.key)!].counts && goals.length < DAY_MIN_DONE;
  if (questHolds) out[at.get(first.key)!] = { ...out[at.get(first.key)!], holds: true };
  if (goals.length > 0 && goals.every((t) => t.done) && !questHolds) return { ...split(goals), ...(first ? { extra: first } : {}) };
  // A hosted player's own AWS account: one quiet row after the goals (before the board's filler jobs).
  if (i.connect) add(connectTask(i.connect));
  // A short list: the board's other jobs (one each), never the one a task already does.
  const taken = new Set(out.flatMap((t) => (t.run.kind === 'plan' && t.run.plan.kind === 'job' ? [t.run.plan.taskId] : [])));
  for (const j of i.jobs) {
    if (out.length >= TODO_MIN) break;
    if (taken.has(j.taskId)) continue;
    const label = `Do a job for ${j.client}`;
    add({ key: `job:${j.taskId}`, title: `A job for ${j.client}`, why: `“${j.title}”`, action: label, done: false, counts: false, run: { kind: 'plan', plan: { kind: 'job', label, taskId: j.taskId, clientId: j.clientId } } });
  }
  // Over the cap: the board's extra jobs go first (they're filler), then the account row (⋯ → Account still has it),
  // never a goal or the next action.
  while (out.length > TODO_MAX) {
    const job = out.findLastIndex((t) => t.key.startsWith('job:'));
    const k = job >= 0 ? job : out.findIndex((t) => t.key === 'connect');
    if (k < 0) break;
    out.splice(k, 1);
  }
  return split(out);
}

/** Rows over TODO_MAX wait behind "+N more": the ticked ones first, then the last; the rest keep their order. */
function split(rows: TodoTask[]): TodoList {
  const over = rows.length - TODO_MAX;
  if (over <= 0) return { tasks: rows, more: [] };
  const hide = new Set<TodoTask>();
  for (const t of [...rows].reverse()) if (hide.size < over && t.done) hide.add(t);
  for (const t of [...rows].reverse()) if (hide.size < over && t !== rows[0]) hide.add(t);
  return { tasks: rows.filter((t) => !hide.has(t)), more: rows.filter((t) => hide.has(t)) };
}

/**
 * "To do 2/4" and "2/4 done": only the rows that can tick (today's goals, the ones behind "+N more" too), plus a quest
 * step holding a short day open; never the next action or the board's filler jobs, which leave once the goals are done.
 * `allDone` only when every counted row is ticked: then the list says "Done for today" and the shift pays.
 */
export function todoProgress(list: TodoList) {
  const rows = [...list.tasks, ...list.more].filter((t) => t.counts || t.holds);
  const done = rows.filter((t) => t.done).length;
  return { done, of: rows.length, allDone: rows.length > 0 && done === rows.length };
}

/** The list's end, once today's goals are done: "Done for today. Come back tomorrow: 4 cards ready." */
export const doneLine = (cardsTomorrow: number) =>
  `Done for today. Come back tomorrow: ${cardsTomorrow > 0 ? `${cardsTomorrow} ${cardsTomorrow === 1 ? 'card' : 'cards'} ready.` : 'new tasks will be waiting.'}`;
