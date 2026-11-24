// Practice tasks and practice builds: played here, in the extension, in every build (the demo, the local server and the
// hosted one alike). Nothing is sent to a server, no model is called and nothing is made in AWS: a practice task emits the
// same events a real one would (task.plan, task.step, agent.state, task.done) from a script, so the city and the task
// card show an agent at work. The first steps use them (src/state/firstSteps.ts): "Watch Sally work" and her plan.

import type { ServerEvent } from './contract';
import { uid } from './AgentBackend';
import firstStepsJson from '../../shared/first-steps.json' with { type: 'json' };
import templatesJson from '../../shared/templates.json' with { type: 'json' };

/** A practice task's id starts with this, so the store can tell it from a real one (it never ticks an "ask" step). */
export const PRACTICE_TASK_PREFIX = 'practice-task-';
export const isPracticeTask = (taskId: string) => taskId.startsWith(PRACTICE_TASK_PREFIX);

export interface PracticeScript {
  id: string;
  /** The agent who does it (a landmark's service id). */
  agentId: string;
  /** What the player asked, in their words (the task card's title). */
  prompt: string;
  /** The steps, in plain words; the first is the walk there. */
  steps: string[];
  result: string;
}

/** Scripts by id: Sally's from the first steps (shared/first-steps.json `task`). */
export const PRACTICE_SCRIPTS: Record<string, PracticeScript> = {
  [firstStepsJson.task.id]: firstStepsJson.task,
};

/** Stars a practice task reports (the store pays at most TASK_STARS, by its daily rules). */
const PRACTICE_STARS = 3;
/** How long each beat takes (ms): the walk there, then each step. Tests pass a speed. */
const WALK_MS = 4500;
const STEP_MS = 2200;

/**
 * Plays a practice script: the events go to `emit` (the backend's own listeners) and nowhere else. Returns the task id
 * (a fresh `practice-task-…` unless one is given), or undefined for an unknown script (an error event says so).
 */
export function playPracticeTask(scriptId: string, emit: (e: ServerEvent) => void, opts: { taskId?: string; speed?: number } = {}): string | undefined {
  const script = PRACTICE_SCRIPTS[scriptId];
  const taskId = opts.taskId ?? `${PRACTICE_TASK_PREFIX}${uid().slice(0, 8)}`;
  if (!script) {
    queueMicrotask(() => emit({ type: 'error', taskId, message: 'That practice task isn’t here any more.' }));
    return undefined;
  }
  const speed = opts.speed ?? 1;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms / speed));
  const { agentId, steps } = script;
  void (async () => {
    await Promise.resolve();
    emit({ type: 'task.plan', taskId, agentId, targetServiceId: agentId, steps });
    emit({ type: 'task.step', taskId, index: 0, text: steps[0], status: 'running' });
    await sleep(WALK_MS); // the agent walks over
    emit({ type: 'task.step', taskId, index: 0, text: steps[0], status: 'done' });
    for (let i = 1; i < steps.length; i++) {
      emit({ type: 'task.step', taskId, index: i, text: steps[i], status: 'running' });
      // Plain words, never an API name: the task card lists "real AWS calls" only for those (none here).
      emit({ type: 'agent.state', agentId, state: 'working', service: agentId, detail: steps[i] });
      await sleep(STEP_MS);
      emit({ type: 'agent.state', agentId, state: 'idle' });
      emit({ type: 'task.step', taskId, index: i, text: steps[i], status: 'done' });
    }
    emit({ type: 'task.done', taskId, ok: true, result: script.result, xp: [{ serviceId: agentId, amount: PRACTICE_STARS }] });
  })();
  return taskId;
}

/** Templates that are always a practice build, in every backend (shared/templates.json `practice`: the first steps' photo-bucket). */
export const PRACTICE_TEMPLATES: ReadonlySet<string> = new Set(
  (templatesJson.templates as { id: string; practice?: boolean }[]).filter((t) => t.practice).map((t) => t.id),
);
export const isPracticeTemplate = (templateId: string) => PRACTICE_TEMPLATES.has(templateId);
