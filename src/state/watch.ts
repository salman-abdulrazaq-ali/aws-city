// Watch it done: an agent's task told as a short story the player can follow (src/ui/ActivityFeed.tsx TaskCard).
// Before: who will do what, where ("Sally will store your holiday photos in S3 Lake. Watch her walk there.") and a Watch
// button. During: the card mirrors the canvas, step by step. After: what was built, the one thing it teaches, what it
// paid and the next step; in the demo, where the task matches a practice template, "See it in Deploy" plans that stack
// (planDeploy) for the player to approve. Pure, so it's tested without React (tests/watch.test.ts).
import type { TaskView } from './store';
import { isPracticeTask } from '@/backend/practiceTasks';
import { placeFor } from '@/world/places';
import { FEATURED_REQUESTS, matchText, serviceById } from '@/world/taxonomy';

interface StoryDef {
  /** "store your holiday photos": what the agent will do, finishing "… in <place>". */
  will: string;
  /** The one thing to take away, in plain words (true of the service, not just the demo). */
  teaches: string;
  /** A practice template (shared/templates.json) that builds the real thing, offered after the task in the demo. */
  templateId?: string;
  /** The task an agent offers to do (the building card's "Do it for me"). */
  prompt: string;
}

/** The agents with a hand-written story (the demo's scripted tasks, src/backend/MockBackend.ts SCRIPTS). */
const STORIES: Record<string, StoryDef> = {
  s3: {
    will: 'store your holiday photos',
    teaches: 'S3 storage classes: files you rarely open can live somewhere cheaper, and old ones can move to the deep freeze on their own.',
    templateId: 'static-site',
    prompt: 'Store my holiday photos cheaply',
  },
  lambda: {
    will: 'set up code that runs each time a file arrives',
    teaches: 'Lambda runs your code only when something happens, so you pay nothing while it waits.',
    templateId: 'hello-api',
    prompt: 'Run code when a file is uploaded',
  },
  iam: {
    will: 'check who can do what in your account',
    teaches: 'Least privilege: give each person or app only the permissions it needs, and use roles instead of long-lived keys.',
    prompt: 'Who has permission to do what in my account?',
  },
  route53: {
    will: 'send visitors to the nearest copy of your site',
    teaches: 'Route 53 turns names into addresses, and can pick the fastest Region or fail over when one is down.',
    prompt: 'Point my domain name at the closest copy of my site',
  },
  dynamodb: {
    will: 'set up a table for your app’s data',
    teaches: 'A good partition key spreads your data out, so reads by key stay fast as the table grows.',
    templateId: 'dynamo-table',
    prompt: 'Make a DynamoDB table for my app’s users',
  },
  shield: {
    will: 'protect your site from a flood of traffic',
    teaches: 'Shield Standard protects every AWS customer from common network floods at no extra cost.',
    prompt: 'Protect my site from a traffic flood',
  },
  bedrock: {
    will: 'answer your question with a foundation model',
    teaches: 'Bedrock lets an app use foundation models, and ground their answers in your own documents.',
    prompt: 'Ask a foundation model a question',
  },
  ec2: {
    will: 'start a server in a private subnet',
    teaches: 'Keep servers in a private subnet and open only the ports they need.',
    prompt: 'Start a small server for my app',
  },
};

/** "Sally the Angler" → "Sally". */
const firstName = (agentName: string) => agentName.split(' the ')[0];

export interface TaskStory {
  agentId: string;
  who: string;
  place: string;
  /** "Sally will store your holiday photos in S3 Lake." */
  framing: string;
  /** "Watch Sally walk there." */
  watch: string;
  teaches: string;
  templateId?: string;
}

/** The agent a task goes to: the one the plan named, else the one its words point at, else the concierge's default. */
const taskAgent = (task: Pick<TaskView, 'agentId' | 'prompt'>) => task.agentId ?? matchText(task.prompt) ?? 'bedrock';

/** Words compared as words: case, punctuation and spacing don't count. */
const asWords = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Whether a task's words are the ones its agent's story (and the demo's script, src/backend/MockBackend.ts `scriptFor`)
 * was written for: the agent's own offer or a featured request it makes, word for word. Anything else typed gets a
 * neutral framing and, in the demo, a generic script the card calls scripted (seen 24 Nov 2026: "expire after 30 days"
 * played holiday.jpg and Glacier after 90 days, and a Copilot bucket read "Sally will store your holiday photos").
 */
export function followsScript(agentId: string, prompt: string): boolean {
  const p = asWords(prompt);
  const own = [STORIES[agentId]?.prompt, ...FEATURED_REQUESTS.filter((r) => r.agent === agentId).map((r) => r.prompt)];
  return !!p && own.some((k) => !!k && asWords(k) === p);
}

/** The name a request gives what it makes ("a table called orders", "named “orders”"), else undefined. */
export function nameIn(prompt: string): string | undefined {
  return /\b(?:called|named)\s+["“'‘]?([a-z0-9][a-z0-9._-]{1,62})/i.exec(prompt)?.[1].replace(/[._-]+$/, '') || undefined;
}

/** The demo's honest line on a task its script doesn't follow word for word. */
export const DEMO_SCRIPTED = 'Demo: this is a scripted example, not your exact request. The hosted city does what you type.';

/**
 * The demo's line on a task card, or undefined: an Ask whose words its script wasn't written for. Not the first steps'
 * practice task (the tutorial's own script, which says what it plays), a Copilot run (🖥️: its practice-console flow
 * makes the thing asked for, under the name typed) nor a refused one (its reason says what happened).
 */
export function scriptedNote(task: Pick<TaskView, 'taskId' | 'agentId' | 'prompt' | 'status'>, demo: boolean): string | undefined {
  if (!demo || task.status === 'failed' || isPracticeTask(task.taskId) || task.prompt.startsWith('🖥️')) return undefined;
  return followsScript(taskAgent(task), task.prompt) ? undefined : DEMO_SCRIPTED;
}

/** The story of a task (any agent: a hand-written one, else the building's own first lesson). */
export function taskStory(task: Pick<TaskView, 'agentId' | 'prompt'>): TaskStory {
  const agentId = taskAgent(task);
  const p = placeFor(agentId);
  const who = p ? firstName(p.agentName) : 'An agent';
  const place = p?.place ?? serviceById(agentId)?.name ?? 'town';
  const def = STORIES[agentId];
  // Its hand-written words only for the request they were written for: "Create a table called orders" isn't Dina's
  // users table, and a Copilot bucket isn't Sally's holiday photos.
  const framing = def && followsScript(agentId, task.prompt) ? `${who} will ${def.will} in ${place}.` : `${who} will take this on at ${place}.`;
  const teaches = def?.teaches ?? p?.simple ?? p?.teaches[0] ?? '';
  return { agentId, who, place, framing, watch: `Watch ${who} walk there.`, teaches, ...(def?.templateId ? { templateId: def.templateId } : {}) };
}

/** What a building's agent offers to do for you ("Do it for me"), or undefined when it has no task of its own. */
export function agentOffer(serviceId: string): { prompt: string; story: string } | undefined {
  const def = STORIES[serviceId];
  const p = placeFor(serviceId);
  if (!def || !p) return undefined;
  return { prompt: def.prompt, story: `${firstName(p.agentName)} can ${def.will} in ${p.place}, and you can watch every step.` };
}

/**
 * The framing's last words: "Watch Sally walk there." while she walks, then that she's at work once she's arrived (seen
 * 21 Nov 2026: "walk there" stayed up the whole time a slow model thought).
 */
export function watchLine(task: Pick<TaskView, 'steps'>, who: string): string {
  return task.steps[0]?.status === 'done' ? `${who} is there and on it.` : `Watch ${who} walk there.`;
}

/** The agent's model call is running: say so, since a small model can take most of a minute. */
export function thinkingLine(agent: { state: string; service?: string; detail?: string } | undefined, who: string): string | undefined {
  return agent?.state === 'working' && agent.detail?.startsWith('InvokeModel') ? `💭 ${who} is thinking… this can take up to a minute.` : undefined;
}

/** A failed task's reason, without the server's "Task failed: " lead. */
/**
 * The first sentence of the server's line about a change the player made in AWS themselves (server/src/contract/aws-feed.ts:
 * "New in your account: bucket "photos-1"." or ""photos-1" (bucket) is gone from your account."), else undefined. Seen
 * 23 Nov 2026: a bucket made in the console got Sally's line as a bubble over S3 Lake, off screen, so it was missed.
 */
export function accountNews(text: string): string | undefined {
  return /^New in your account: [^"]*"[^"]*"\./.exec(text)?.[0] ?? /^"[^"]*" \([^)]*\) is gone from your account\./.exec(text)?.[0];
}

export const failedReason = (message: string) => message.replace(/^Task failed:\s*/, '').trim();

/**
 * A message as one speech bubble: "(…)" asides dropped, whole sentences while they fit in `max`, and a first sentence
 * that's too long on its own cut with "…". Seen 22 Nov 2026: a refused m5.large read "That didn't work…" in the city
 * (the reason was cut at its aside, then replaced), so the player thought nothing happened.
 */
export function bubbleText(text: string, max = 90): string {
  const plain = failedReason(text).replace(/\s*\([^()]*\)/g, '').replace(/\s+/g, ' ').trim();
  const sentences = plain.split(/(?<=[.!?])\s+/).filter(Boolean);
  const first = sentences[0] ?? '';
  if (first.length > max) return `${first.slice(0, max - 1).trimEnd()}…`;
  let out = first;
  for (const s of sentences.slice(1)) {
    if (out.length + 1 + s.length > max) break;
    out = `${out} ${s}`;
  }
  return out;
}

/** The agent's last bubble on a task that didn't work: why, never only "That didn't work…" when there's a reason. */
export function failedBubble(result?: string): string {
  const why = result ? bubbleText(result) : '';
  return why ? `✗ ${why}` : 'That didn’t work…';
}

/** Where a task is: before it starts (framing), while it runs (live), or finished (result). */
export type TaskPhase = 'framing' | 'live' | 'result' | 'failed';
export function taskPhase(task: Pick<TaskView, 'status' | 'steps'>): TaskPhase {
  if (task.status === 'failed') return 'failed';
  if (task.status === 'done') return 'result';
  // The agent is still on its way (or not picked yet): the story so far is "who will do what".
  const started = task.steps.some((s, i) => i > 0 && s.status !== 'pending');
  return task.status === 'routing' || !started ? 'framing' : 'live';
}

/** The step the agent is on now (the running one, else the last finished), for the live line. */
export function liveStep(task: Pick<TaskView, 'steps'>) {
  const i = task.steps.findIndex((s) => s.status === 'running');
  const at = i >= 0 ? i : task.steps.map((s) => s.status).lastIndexOf('done');
  return at >= 0 ? { index: at, text: task.steps[at].text, of: task.steps.length } : undefined;
}

/** The agent's bubble when a task is done: the stars it really paid (the store pays first: src/app/runtime.ts), none said when it paid none. */
export function doneBubble(task: Pick<TaskView, 'paid'> | undefined): string {
  const n = (task?.paid ?? []).reduce((sum, x) => sum + x.stars, 0);
  return n > 0 ? `Done! +${n} ⭐` : 'Done!';
}

/** "+3 ⭐ S3 Lake, +1 ⭐ IAM Gatehouse", or the friendly daily-cap line when today's paid tasks (here or in all) are used up. */
export function paidLine(task: Pick<TaskView, 'paid' | 'capped'>): string | undefined {
  if (task.capped) return 'Today’s task stars are used up: full stars again tomorrow.';
  if (!task.paid?.length) return undefined;
  return task.paid.map((x) => `+${x.stars} ⭐ ${placeFor(x.serviceId)?.place ?? x.serviceId}`).join(', ');
}
