import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '@/backend/contract';
import { FIRST_STEPS, FIRST_STEPS_OF, FIRST_STEPS_QUEST, fill, firstStep, firstSteps, isLegacy, quietCity, quietContext, startsFirstSteps, TUTORIAL_DECK } from '@/state/firstSteps';
import { ladder } from '@/state/ladder';
import { planNext, questOffer } from '@/state/next';
import { shows } from '@/state/simple';
import { bus } from '@/state/bus';
import { isChatter, migrateQuestCut, QUEST_CUT, SETTLE, SETTLE_BEAT_MS, useCity, whenSettled } from '@/state/store';
import { cardsFor, questById, QUESTS } from '@/world/content';

const p = (over: Partial<Progress> = {}): Progress => ({ version: 1, landmarks: {}, updatedAt: '2026-01-01T00:00:00.000Z', ...over });
const on = (step: number, count = 0) => p({ quests: { [FIRST_STEPS_QUEST]: { status: 'active', step, count } } });
const done = p({ quests: { [FIRST_STEPS_QUEST]: { status: 'done', step: FIRST_STEPS_OF } } });
const legacy = p({ quests: { 'storage-static-site': { status: 'active', step: 1 } } });
const s = () => useCity.getState();

describe('the first steps: where a player is', () => {
  it('is the first quest, with its six steps in order', () => {
    const q = questById(FIRST_STEPS_QUEST)!;
    expect(QUESTS[0].id).toBe(FIRST_STEPS_QUEST);
    expect(q.steps.map((st) => st.kind)).toEqual(['visit', 'game', 'cards', 'request', 'watch', 'deploy']);
    expect(q.steps.length).toBe(FIRST_STEPS_OF);
    expect(q.steps[2]).toMatchObject({ kind: 'cards', count: 3, deck: TUTORIAL_DECK });
    expect(q.steps[5]).toMatchObject({ kind: 'deploy', templateId: 'photo-bucket', decide: true });
    for (const id of TUTORIAL_DECK) expect(cardsFor('s3').some((c) => c.id === id), id).toBe(true);
  });

  it('a new player: not on the path until it starts, and not graduated', () => {
    expect(firstSteps(p())).toMatchObject({ active: false, graduated: false, legacy: false, skipped: false });
    expect(startsFirstSteps(p(), { firstSteps: 'beginner' })).toBe(true);
    expect(startsFirstSteps(p(), {})).toBe(false);
  });

  it('on the path: the step from Progress, the city quiet', () => {
    expect(firstSteps(on(3), { firstSteps: 'beginner' })).toMatchObject({ active: true, step: 3, of: 6, graduated: false });
    // Another device (no pref yet) agrees: the synced quest says so.
    expect(firstSteps(on(3))).toMatchObject({ active: true, step: 3 });
    expect(quietCity(on(0))).toBe(true);
    expect(firstStep(on(1))).toMatchObject({ kind: 'game', gameId: 'fishing' });
    expect(quietContext(on(5))).toEqual({ quiet: true, steps: ['deploy'] });
    expect(quietContext(p())).toEqual({});
  });

  it('graduates when the path is done or skipped; a skip is never on the path', () => {
    expect(firstSteps(done)).toMatchObject({ active: false, graduated: true });
    expect(firstSteps(p(), { firstSteps: 'skipped' })).toMatchObject({ active: false, graduated: true, skipped: true });
    expect(firstSteps(on(2), { firstSteps: 'skipped' })).toMatchObject({ active: false, graduated: true });
  });

  it('never puts a legacy save in the path (another quest, or "I already build on AWS")', () => {
    expect(isLegacy(legacy)).toBe(true);
    expect(isLegacy(p(), { builder: true })).toBe(true);
    expect(startsFirstSteps(legacy, { firstSteps: 'beginner' })).toBe(false);
    expect(firstSteps(legacy, { firstSteps: 'beginner' }).active).toBe(false);
    // Its ladder stays as it was: graduated only once a quest is done.
    expect(firstSteps(legacy).graduated).toBe(false);
    expect(firstSteps(p({ quests: { 'storage-static-site': { status: 'done', step: 7 } } })).graduated).toBe(true);
    // A marker (quest 2's re-cut) isn't a quest.
    expect(isLegacy(p({ quests: { [QUEST_CUT.marker]: { status: 'active', step: 0 } } }))).toBe(false);
  });

  it('a replay puts anyone on the path from its own step, legacy and graduates too', () => {
    expect(firstSteps(legacy, { firstSteps: 'replay', firstStepsReplay: { step: 0 } })).toMatchObject({ active: true, step: 0, replay: true, graduated: false });
    expect(firstSteps(done, { firstSteps: 'replay', firstStepsReplay: { step: 4 } })).toMatchObject({ active: true, step: 4, replay: true });
  });

  it('fills the copy deck', () => {
    expect(fill(FIRST_STEPS.hud.steps, { n: 2 })).toBe('First steps 2/6');
    expect(FIRST_STEPS.steps).toHaveLength(6);
    expect(FIRST_STEPS.task.steps.length).toBeGreaterThan(1);
  });
});

describe('the quiet city and what opens after', () => {
  const input = (progress: Progress, fs = firstSteps(progress)) => ({ progress, linked: false, hasDeploys: false, opened: new Set<string>(), firstSteps: fs });

  it('opens only what the path needs, whatever was opened before', () => {
    const l = ladder({ ...input(on(0)), opened: new Set(['learn', 'deploy', 'clients', 'map', 'care']), linked: true });
    expect([...l.tabs]).toEqual(['home']);
    expect(l).toMatchObject({ places: false, care: false, news: false, clients: false });
    expect([...ladder(input(on(2))).tabs]).toEqual(['home', 'learn']);
    expect([...ladder(input(on(5))).tabs]).toEqual(['home', 'learn', 'deploy']);
  });

  it('graduation opens Jobs, City care and news, as a first quest did', () => {
    const l = ladder(input(done));
    expect(l.tabs.has('jobs')).toBe(true);
    expect(l).toMatchObject({ care: true, news: true, clients: true });
    // A skip graduates too.
    expect(ladder(input(p(), firstSteps(p(), { firstSteps: 'skipped' }))).clients).toBe(true);
  });

  it('shows() hides the extras on the path, in either mode, and Deploy only for the plan', () => {
    for (const f of ['coins', 'decorate', 'promptBar', 'copilotSwitch', 'eventBanner', 'comingUp', 'connect', 'tokens', 'todo', 'shift'] as const) {
      expect(shows(f, {}, quietContext(on(1))), f).toBe(false);
      expect(shows(f, { simple: false }, quietContext(on(1))), f).toBe(false);
    }
    expect(shows('deployTab', {}, quietContext(on(4)))).toBe(false);
    expect(shows('deployTab', {}, quietContext(on(5)))).toBe(true);
    // Off the path they're back, in both modes.
    for (const f of ['coins', 'decorate', 'promptBar', 'eventBanner', 'connect'] as const) {
      expect(shows(f, {}), f).toBe(true);
      expect(shows(f, { simple: false }), f).toBe(true);
    }
  });

  it('planNext never offers the first steps, and offers quest 2 after them', () => {
    expect(planNext({ progress: done, cityRegion: 'us-west-2' })).toMatchObject({ kind: 'quest', questId: 'storage-static-site' });
    expect(planNext({ progress: p(), cityRegion: 'us-west-2' })).toMatchObject({ kind: 'quest', questId: 'storage-static-site' });
    expect(planNext({ progress: on(2), cityRegion: 'us-west-2' }).kind).not.toBe('step');
  });
});

describe('the store on the path', () => {
  beforeEach(() => {
    s().resetSession();
    s().setPref('firstSteps', undefined);
    s().setPref('firstStepsReplay', undefined);
    s().clearToasts();
    useCity.setState({ celebration: undefined });
  });
  const step = () => s().progress.quests?.[FIRST_STEPS_QUEST];

  it('starts on arriving in a city when chosen, and every step counts by doing it; Reject counts on the plan', async () => {
    s().setPref('firstSteps', 'beginner');
    s().enterRegion('us-west-2');
    expect(step()).toMatchObject({ status: 'active', step: 0 });
    const said = vi.fn();
    const off = bus.on('say', said);
    s().arrive('s3');
    expect(step()?.step).toBe(1);
    expect(said).toHaveBeenCalledWith(expect.objectContaining({ agentId: 's3' }));
    off();
    s().recordGame('fishing', 0);
    expect(step()?.step).toBe(2);
    // Only the tutorial deck counts.
    s().reviewCard('s3-02', 'good');
    expect(step()).toMatchObject({ step: 2, count: 0 });
    for (const id of TUTORIAL_DECK) s().reviewCard(id, 'again');
    expect(step()?.step).toBe(3);
    bus.emit('citizenRequestDone', { answered: false });
    expect(step()?.step).toBe(3);
    bus.emit('citizenRequestDone', { answered: true });
    expect(step()?.step).toBe(4);
    s().applyServerEvent({ type: 'task.plan', taskId: 'practice-task-x', agentId: 's3', targetServiceId: 's3', steps: ['a'] });
    s().applyServerEvent({ type: 'task.done', taskId: 'practice-task-x', ok: true, result: 'ok', xp: [{ serviceId: 's3', amount: 3 }] });
    expect(step()?.step).toBe(5);
    const graduated = vi.fn();
    const offG = bus.on('graduated', graduated);
    s().applyServerEvent({ type: 'deploy.preview', deployId: 'practice-1', templateId: 'photo-bucket', stackName: 'x', region: 'practice', changes: [] });
    s().applyServerEvent({ type: 'deploy.status', deployId: 'practice-1', status: 'rejected' });
    offG();
    expect(step()?.status).toBe('done');
    expect(graduated).toHaveBeenCalled();
    expect(s().celebration).toBe(FIRST_STEPS_QUEST);
    expect(firstSteps(s().progress, s().prefs).graduated).toBe(true);
  });

  it('drops info toasts on the path (errors still show)', () => {
    useCity.setState({ progress: on(1) });
    s().toast('🚧', 'New landmark discovered');
    expect(s().toasts).toHaveLength(0);
    s().toast('⚠️', 'Something broke', 'error');
    expect(s().toasts).toHaveLength(1);
  });

  it('a legacy save never starts it', () => {
    useCity.setState({ progress: legacy });
    s().setPref('firstSteps', 'beginner');
    s().startFirstSteps();
    expect(step()).toBeUndefined();
  });

  it('skip ends a path under way, finished and unpaid', () => {
    useCity.setState({ progress: on(2) });
    s().skipFirstSteps();
    expect(step()?.status).toBe('done');
    expect(s().prefs.firstSteps).toBe('skipped');
    expect(s().celebration).toBeUndefined();
  });

  it('a replay runs for a legacy player, graduates, and never pays the quest twice', async () => {
    vi.useFakeTimers();
    try {
      useCity.setState({ progress: { ...done, quests: { ...done.quests, 'storage-static-site': { status: 'done', step: 7 } }, landmarks: { s3: { discovered: true, xp: 100 } } } });
      s().playFirstSteps();
      expect(firstSteps(s().progress, s().prefs)).toMatchObject({ active: true, step: 0, replay: true });
      expect(quietCity(s().progress, s().prefs)).toBe(true);
      s().arrive('s3');
      s().recordGame('fishing', 10);
      for (const id of TUTORIAL_DECK) s().reviewCard(id, 'good');
      bus.emit('citizenRequestDone', { answered: true });
      s().applyServerEvent({ type: 'task.plan', taskId: 'practice-task-y', agentId: 's3', targetServiceId: 's3', steps: ['a'] });
      s().applyServerEvent({ type: 'task.done', taskId: 'practice-task-y', ok: true, result: 'ok', xp: [] });
      expect(firstSteps(s().progress, s().prefs).step).toBe(5);
      const xpBefore = s().progress.landmarks.s3?.xp ?? 0;
      s().applyServerEvent({ type: 'deploy.preview', deployId: 'practice-2', templateId: 'photo-bucket', stackName: 'x', region: 'practice', changes: [] });
      s().applyServerEvent({ type: 'deploy.status', deployId: 'practice-2', status: 'complete' });
      vi.runAllTimers();
      // The choice stays made (a cleared pref let the old first-run tour open over graduation's card).
      expect(s().prefs.firstSteps).toBe('beginner');
      expect(firstSteps(s().progress, s().prefs)).toMatchObject({ active: false, graduated: true });
      expect(s().celebration).toBe(FIRST_STEPS_QUEST);
      // No quest stars a second time.
      expect(s().progress.landmarks.s3?.xp ?? 0).toBe(xpBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("quest 2's re-cut (its workshop last)", () => {
  it('keeps its id, with the workshop as the last step', () => {
    const q = questById('storage-static-site')!;
    expect(q.steps.map((st) => st.kind)).toEqual(['visit', 'cards', 'cards', 'cards', 'puzzle', 'deploy', 'workshop']);
  });

  it('moves a save from before to the same step in the new order, once', () => {
    const at = (step: number, count = 0) => p({ quests: { 'storage-static-site': { status: 'active', step, count } } });
    const moved = (step: number, count = 0) => migrateQuestCut(at(step, count)).quests!['storage-static-site'];
    expect(moved(0)).toMatchObject({ step: 0 });
    expect(moved(1, 3)).toMatchObject({ step: 1, count: 3 });
    expect(moved(2)).toMatchObject({ step: 2, count: 0 }); // on the workshop: on to the CloudFront cards
    expect(moved(3, 2)).toMatchObject({ step: 2, count: 2 }); // the CloudFront cards
    expect(moved(4)).toMatchObject({ step: 3 });
    expect(moved(5)).toMatchObject({ step: 4 });
    expect(moved(6)).toMatchObject({ step: 5 });
    // Once: the marker stops a second move.
    const once = migrateQuestCut(at(4));
    expect(migrateQuestCut(once)).toBe(once);
    // A finished quest, or none, is left alone.
    const fin = p({ quests: { 'storage-static-site': { status: 'done', step: 7 } } });
    expect(migrateQuestCut(fin)).toBe(fin);
    expect(migrateQuestCut(p())).toEqual(p());
  });

  it('a quest 2 started now is marked as the new order', () => {
    s().resetSession();
    s().startQuest('storage-static-site');
    expect(s().progress.quests?.[QUEST_CUT.marker]).toBeDefined();
    expect(migrateQuestCut(s().progress)).toBe(s().progress);
  });
});

describe('after the first steps', () => {
  beforeEach(() => {
    s().resetSession();
    s().clearToasts();
    s().setPref('firstSteps', 'beginner');
    useCity.setState({ celebration: undefined, selected: undefined });
  });

  it('quest 2 starts after what the path already did, and never ticks a step with a toast of its own', () => {
    useCity.setState({ progress: done, selected: 's3' });
    expect(questOffer(done.quests)).toMatchObject({ quest: { id: 'storage-static-site', title: 'The City Brochure Site' }, started: false });
    s().startQuest('storage-static-site');
    expect(s().progress.quests?.['storage-static-site']).toMatchObject({ status: 'active', step: 2, count: 0 });
    expect(questById('storage-static-site')!.steps[2]).toMatchObject({ kind: 'cards', serviceId: 'cloudfront' });
    // Standing at S3 Lake ticks nothing (seen 24 Nov 2026: "✓ Step 1 of 7 done: Walk to S3 Lake…" right after graduation).
    expect(s().toasts.map((t) => t.text).join()).not.toMatch(/Step \d+ of \d+ done/);
    // The new order's marker is written, so the re-cut's migration leaves it alone.
    expect(migrateQuestCut(s().progress)).toBe(s().progress);
  });

  it('a player who skipped the path, or never did it, starts quest 2 from its first step', () => {
    s().setPref('firstSteps', 'skipped');
    useCity.setState({ progress: done });
    s().startQuest('storage-static-site');
    expect(s().progress.quests?.['storage-static-site']?.step).toBe(0);
    s().resetSession();
    s().setPref('firstSteps', undefined);
    s().startQuest('storage-static-site');
    expect(s().progress.quests?.['storage-static-site']?.step).toBe(0);
  });

  it('the quest offered is one under way before one not started (what graduation’s Next names)', () => {
    const under = p({ quests: { [FIRST_STEPS_QUEST]: { status: 'done', step: 6 }, 'storage-static-site': { status: 'active', step: 3, count: 0 } } });
    expect(questOffer(under.quests)).toMatchObject({ quest: { id: 'storage-static-site' }, started: true });
    expect(planNext({ progress: under, cityRegion: 'us-west-2' })).toMatchObject({ kind: 'step', questId: 'storage-static-site' });
    expect(questOffer(on(2).quests)).toMatchObject({ quest: { id: 'storage-static-site' }, started: false });
  });

  it('graduation’s after-moments come one at a time: the coins note, Connie, the banner, then toasts one by one', () => {
    vi.useFakeTimers();
    try {
      const said = vi.fn();
      useCity.setState({ progress: done, celebration: FIRST_STEPS_QUEST });
      s().toast('🧯', 'Practice storm: nothing is wrong with your city.');
      expect(s().toasts).toHaveLength(0);
      s().celebrate(undefined);
      expect(s().settle).toBe(SETTLE.note);
      whenSettled(SETTLE.connie, said);
      expect(said).not.toHaveBeenCalled();
      s().toast('🏅', 'A badge');
      expect(s().toasts).toHaveLength(0);
      vi.advanceTimersByTime(SETTLE_BEAT_MS);
      expect(s().settle).toBe(SETTLE.connie);
      expect(said).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(SETTLE_BEAT_MS);
      expect(s().settle).toBe(SETTLE.banner);
      expect(s().toasts).toHaveLength(0);
      vi.advanceTimersByTime(SETTLE_BEAT_MS);
      expect(s().settle).toBe(0);
      // Then the toasts, one at a time.
      expect(s().toasts.map((t) => t.text)).toEqual(['Practice storm: nothing is wrong with your city.']);
      // Another quest's card settles nothing.
      useCity.setState({ celebration: 'storage-static-site' });
      s().celebrate(undefined);
      expect(s().settle).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('agents talking among themselves are chatter unless it’s the player’s task (a practice task too)', () => {
    const running = { 'practice-task-z': { taskId: 'practice-task-z', prompt: 'x', agentId: 's3', steps: [], status: 'running' as const } };
    // Seen 24 Nov 2026: "Connie · to Luke the Lookout" during Sally's practice task, with the chat switched off.
    expect(isChatter({ tasks: running }, 'concierge', 'lookout')).toBe(true);
    expect(isChatter({ tasks: running }, 'concierge', 's3')).toBe(false);
    expect(isChatter({ tasks: running }, 's3', 'concierge')).toBe(false);
    expect(isChatter({ tasks: running }, 'concierge', 'user')).toBe(false);
    expect(isChatter({ tasks: {} }, 'concierge', 'lookout')).toBe(true);
    // Being routed (no agent yet): Connie's lines are the task's.
    expect(isChatter({ tasks: { t: { taskId: 't', prompt: 'x', steps: [], status: 'routing' } } }, 'concierge', 'lambda')).toBe(false);
    useCity.setState({ tasks: running });
    s().applyServerEvent({ type: 'agent.message', from: 'concierge', to: 'lookout', text: 'Luke, anything new?' });
    expect(s().feed.at(-1)).toMatchObject({ kind: 'message', ambient: true });
  });
});
