// Watch it done (src/state/watch.ts): an agent's task as a story, before, during and after; and the demo's task flow
// (src/backend/MockBackend.ts) lists exactly the steps the city shows.
import { describe, expect, it } from 'vitest';
import { MockBackend, scriptFor } from '@/backend/MockBackend';
import type { ServerEvent, TaskPlanEvent } from '@/backend/contract';
import { accountNews, agentOffer, DEMO_SCRIPTED, doneBubble, followsScript, liveStep, nameIn, paidLine, scriptedNote, taskPhase, taskStory } from '@/state/watch';
import { cardPlace } from '@/world/places';
import type { TaskView } from '@/state/store';
import templatesJson from '../shared/templates.json' with { type: 'json' };
import { FEATURED_REQUESTS } from '@/world/taxonomy';

const task = (over: Partial<TaskView> = {}): TaskView => ({ taskId: 't1', prompt: 'Store my holiday photos cheaply', steps: [], status: 'routing', ...over });

describe('the story', () => {
  it('frames the task before the agent works: who, what, where, and a reason to watch', () => {
    const s = taskStory(task());
    expect(s.agentId).toBe('s3');
    expect(s.framing).toBe('Sally will store your holiday photos in S3 Lake.');
    expect(s.watch).toBe('Watch Sally walk there.');
    expect(s.teaches).toMatch(/storage classes/);
    // The planned agent wins over the words.
    expect(taskStory(task({ agentId: 'lambda' })).who).toBe('Lola');
  });

  it('any building has a story (its own first lesson when nothing is hand-written)', () => {
    const s = taskStory(task({ prompt: 'Something about Amazon SQS queues', agentId: 'sqs' }));
    expect(s.framing).toMatch(/will take this on at/);
    expect(s.teaches.length).toBeGreaterThan(10);
    expect(s.templateId).toBeUndefined();
  });

  it('only offers "See it in Deploy" for a real practice template that uses the agent’s service', () => {
    for (const id of ['s3', 'lambda', 'iam', 'route53', 'dynamodb', 'shield', 'bedrock', 'ec2']) {
      const s = taskStory(task({ agentId: id }));
      if (!s.templateId) continue;
      const t = templatesJson.templates.find((x) => x.id === s.templateId);
      expect(t, s.templateId).toBeTruthy();
      expect(t!.serviceIds, s.templateId).toContain(id);
    }
  });

  it('every building offer routes to its own agent (the demo picks the agent from the words, as the story does)', () => {
    // The story and the demo both read the words: a featured request names whoever they point at.
    for (const r of FEATURED_REQUESTS) expect(taskStory(task({ prompt: r.prompt })).agentId).toBeTruthy();
    for (const id of ['s3', 'lambda', 'iam', 'route53', 'dynamodb', 'shield', 'bedrock', 'ec2']) {
      const o = agentOffer(id)!;
      expect(o.story).toMatch(/you can watch every step/);
      expect(taskStory(task({ prompt: o.prompt })).agentId, o.prompt).toBe(id);
    }
    expect(agentOffer('sqs')).toBeUndefined();
  });
});

describe('the phases', () => {
  const steps = (...st: TaskView['steps'][number]['status'][]) => st.map((status, i) => ({ text: `step ${i}`, status }));
  it('framing while routing and walking, live once work starts, then the result', () => {
    expect(taskPhase(task())).toBe('framing');
    expect(taskPhase(task({ status: 'running', steps: steps('running', 'pending') }))).toBe('framing');
    const live = task({ status: 'running', steps: steps('done', 'done', 'running', 'pending') });
    expect(taskPhase(live)).toBe('live');
    expect(liveStep(live)).toEqual({ index: 2, text: 'step 2', of: 4 });
    expect(taskPhase(task({ status: 'done', steps: steps('done', 'done') }))).toBe('result');
    expect(taskPhase(task({ status: 'failed' }))).toBe('failed');
  });

  it('says what a task paid, or the friendly line when the day’s paid tasks there are used up', () => {
    expect(paidLine(task({ paid: [{ serviceId: 's3', stars: 15 }, { serviceId: 'iam', stars: 5 }] }))).toBe('+15 ⭐ S3 Lake, +5 ⭐ IAM Gatehouse');
    expect(paidLine(task({ capped: true }))).toMatch(/full stars again tomorrow/);
    expect(paidLine(task())).toBeUndefined();
  });
});

describe('the demo task mirrors the city', () => {
  it('plans every step it then runs, the helper’s visit included, and finishes them all', async () => {
    const mock = new MockBackend({ speed: 200 });
    const events: ServerEvent[] = [];
    mock.onEvent((e) => events.push(e));
    mock.send({ action: 'task.submit', taskId: 't1', prompt: 'Store my holiday photos cheaply', context: {} });
    await new Promise((r) => setTimeout(r, 700));
    const plan = events.find((e): e is TaskPlanEvent => e.type === 'task.plan')!;
    expect(plan.steps).toContain('Asking Ivy for help');
    // The card names the AWS service and its agent, not the landmark (seen 23 Nov 2026: "S3 Lake" read as another service).
    expect(plan.steps[0]).toBe('Heading to Amazon S3 (Sally the Angler)');
    const steps = events.filter((e) => e.type === 'task.step');
    const last = new Map<number, string>();
    for (const e of steps) if (e.type === 'task.step') last.set(e.index, e.status);
    expect([...last.keys()].sort((a, b) => a - b)).toEqual(plan.steps.map((_, i) => i));
    expect([...last.values()].every((st) => st === 'done' || st === 'skipped')).toBe(true);
    // The helper's step runs while the helper works, between the two of them talking.
    const helper = plan.steps.indexOf('Asking Ivy for help');
    const running = events.findIndex((e) => e.type === 'task.step' && e.index === helper && e.status === 'running');
    const ivy = events.findIndex((e) => e.type === 'agent.state' && e.agentId === 'iam' && e.state === 'working');
    expect(running).toBeGreaterThan(-1);
    expect(ivy).toBeGreaterThan(running);
    expect(events.some((e) => e.type === 'task.done' && e.ok)).toBe(true);
    mock.disconnect();
  });
});

describe('where the card says the agent is going', () => {
  it('names the AWS service and its agent, and leaves an unknown id as it is', () => {
    expect(cardPlace('s3')).toBe('Amazon S3 (Sally the Angler)');
    expect(cardPlace('nope')).toBe('nope');
  });
});

// Seen 23 Nov 2026: a bucket made in the console got Sally's line only as a bubble over S3 Lake, off screen.
describe('news of a change the player made in AWS', () => {
  it('is the first sentence of the server’s line, the lesson after it left out', () => {
    expect(accountNews('New in your account: bucket "test-demo-1.v2". Buckets hold objects (files) by key.')).toBe('New in your account: bucket "test-demo-1.v2".');
    expect(accountNews('"test-demo-1" (bucket) is gone from your account.')).toBe('"test-demo-1" (bucket) is gone from your account.');
  });
  it('is nothing else an agent says', () => {
    expect(accountNews('Sounds like a job for Sally!')).toBeUndefined();
    expect(accountNews('"web-1" went running → stopped.')).toBeUndefined();
  });
});

// Seen 24 Nov 2026 (an experienced player): "expire after 30 days" played holiday.jpg and Glacier after 90 days, "a table
// called orders" made an unnamed one, a Copilot bucket read "Sally will store your holiday photos", and "Done! +20 ⭐"
// while the day's task stars were used up.
describe('the demo is honest about its scripts', () => {
  it('a script is followed only for the words it was written for (its offer, a featured request), case and punctuation aside', () => {
    for (const r of FEATURED_REQUESTS) expect(followsScript(r.agent, r.prompt), r.prompt).toBe(true);
    for (const id of ['s3', 'lambda', 'iam', 'route53', 'dynamodb', 'shield', 'bedrock', 'ec2']) expect(followsScript(id, agentOffer(id)!.prompt)).toBe(true);
    expect(followsScript('s3', '  store my HOLIDAY photos cheaply!')).toBe(true);
    expect(followsScript('s3', 'Store my photos and expire them after 30 days')).toBe(false);
    expect(followsScript('sqs', 'Make a queue')).toBe(false);
    expect(followsScript('s3', '')).toBe(false);
  });

  it('reads the name a request gives ("called", "named"), else none', () => {
    expect(nameIn('Create a table called orders')).toBe('orders');
    expect(nameIn('Make a bucket named “Holiday-Pics”.')).toBe('Holiday-Pics');
    expect(nameIn('a queue called orders.fifo please')).toBe('orders.fifo');
    expect(nameIn('Store my holiday photos cheaply')).toBeUndefined();
  });

  it('plays the hand-written script only for its words; anything else gets the generic one, under the typed name', () => {
    const texts = (serviceId: string, prompt: string) => {
      const s = scriptFor(serviceId, prompt);
      return [...s.steps.map((x) => x.text), s.result].join(' | ');
    };
    expect(texts('s3', 'Store my holiday photos cheaply')).toMatch(/holiday\.jpg[\s\S]*90 days/);
    const expire = texts('s3', 'Store my photos and expire them after 30 days');
    expect(expire).not.toMatch(/holiday|90 days|Glacier/);
    const orders = scriptFor('dynamodb', 'Create a table called orders');
    expect(orders.steps[0]).toEqual({ text: 'Making the table “orders”', aws: 'dynamodb:CreateTable' });
    expect(orders.result).toMatch(/^The table “orders” is ready\./);
    expect(texts('dynamodb', 'Create a table called orders')).not.toMatch(/user#42|userId/);
    // A bucket's name is lowercase; a queue has no hand-written script, so its name goes on the generic one.
    expect(scriptFor('s3', 'Create a bucket called Orders').steps[0]).toEqual({ text: 'Making the bucket “orders”', aws: 's3:CreateBucket' });
    expect(scriptFor('sqs', 'Make a queue named jobs').steps[0].text).toBe('Making the queue “jobs”');
    expect(texts('s3', 'Create a bucket called orders')).not.toMatch(/holiday|photos/i);
    // The name goes only on the kind asked for: S3 picked from the page's context never makes a "table" a bucket.
    expect(texts('s3', 'Make a table called orders')).not.toMatch(/orders|Making the bucket/);
    expect(texts('dynamodb', 'Make a bucket called orders')).not.toMatch(/orders/);
    expect(scriptFor('s3', 'Make one called orders').steps[0].text).toBe('Making the bucket “orders”');
  });

  it('the demo task runs that script: a typed table name, no canned users table', async () => {
    const mock = new MockBackend({ speed: 200 });
    const events: ServerEvent[] = [];
    mock.onEvent((e) => events.push(e));
    mock.send({ action: 'task.submit', taskId: 't2', prompt: 'Create a DynamoDB table called orders', context: {} });
    await new Promise((r) => setTimeout(r, 300));
    const plan = events.find((e): e is TaskPlanEvent => e.type === 'task.plan')!;
    expect(plan.agentId).toBe('dynamodb');
    expect(plan.steps).toContain('Making the table “orders”');
    expect(plan.steps.join(' ')).not.toMatch(/user#42/);
    mock.disconnect();
  });

  it('the card frames only a matching request with the story’s words, and the demo says when its script didn’t follow', () => {
    expect(taskStory(task({ prompt: 'Create a bucket called orders', agentId: 's3' })).framing).toBe('Sally will take this on at S3 Lake.');
    expect(taskStory(task({ prompt: '🖥️ Create a bucket called city-photos', agentId: 's3' })).framing).toBe('Sally will take this on at S3 Lake.');
    expect(scriptedNote(task(), true)).toBeUndefined();
    expect(scriptedNote(task({ prompt: 'Store my photos and expire them after 30 days' }), true)).toBe(DEMO_SCRIPTED);
    expect(DEMO_SCRIPTED).toMatch(/^Demo: .*scripted example.*hosted city does what you type/);
    // Never on a hosted or local build, the first steps' practice task (the tutorial's own script) or a Copilot run.
    expect(scriptedNote(task({ prompt: 'Store my photos and expire them after 30 days' }), false)).toBeUndefined();
    expect(scriptedNote(task({ taskId: 'practice-task-ab12cd34', prompt: 'Keep my holiday photos safe', agentId: 's3' }), true)).toBeUndefined();
    expect(scriptedNote(task({ prompt: '🖥️ Create a bucket called city-photos', agentId: 's3' }), true)).toBeUndefined();
    expect(scriptedNote(task({ prompt: 'Launch a server called big m5.large', agentId: 'ec2', status: 'failed' }), true)).toBeUndefined();
  });

  it('the agent’s “Done!” names the stars really paid, none past the daily cap', () => {
    expect(doneBubble(task({ paid: [{ serviceId: 's3', stars: 3 }, { serviceId: 'iam', stars: 1 }] }))).toBe('Done! +4 ⭐');
    expect(doneBubble(task({ paid: [], capped: true }))).toBe('Done!');
    expect(doneBubble(undefined)).toBe('Done!');
  });
});
