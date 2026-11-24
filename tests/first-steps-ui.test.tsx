// @vitest-environment jsdom
// The first steps on screen (src/ui/FirstSteps.tsx, DESIGN-tutorial §4.2 and §6): Connie's guide card shows each step
// with one amber button that does the step's thing, the strip on Learn and Deploy, the quiet city (no coins, Decorate,
// prompt bar or banner), ⋯ → Play the first steps, the trimmed building card, Sally's plan alone in Deploy (a hosted
// player with a linked account too), the tutorial deck with its answers docked in view, the citizen's sheet (keys 1–3,
// the verdict first) and graduation.
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '@/backend/contract';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" />, agentColor: () => undefined }));

const rt = vi.hoisted(() => ({
  planDeploy: vi.fn((..._a: unknown[]) => 'r-plan'),
  decideDeploy: vi.fn(),
  startPracticeTask: vi.fn(() => 'practice-task-1'),
}));
vi.mock('@/app/runtime', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/app/runtime')>()), ...rt }));

const { useCity } = await import('@/state/store');
const { bus } = await import('@/state/bus');
const { shows } = await import('@/state/simple');
const { FIRST_STEPS, quietContext } = await import('@/state/firstSteps');
const { GuideCard, GuideStrip, FirstStepsMoments } = await import('@/ui/FirstSteps');
const { Hud } = await import('@/ui/Hud');
const { Home } = await import('@/ui/Home');
const { DeployPanel } = await import('@/ui/DeployPanel');
const { Flashcards } = await import('@/ui/Flashcards');
const { LandmarkCard } = await import('@/ui/LandmarkCard');
const { RequestCard } = await import('@/ui/RequestCard');
const { Celebrate } = await import('@/ui/Celebrate');
const { ANNOUNCE_GAP_MS } = await import('@/state/announce');

const REGION = 'us-west-2';
/** A player on the first steps at `step` (0..5), S3 Lake put up. */
const onStep = (step: number, extra: Partial<Progress> = {}): Progress => ({
  version: 2,
  landmarks: {},
  updatedAt: '',
  quests: { 'first-steps': { status: 'active', step, count: 0 } },
  cities: { [REGION]: { landmarks: { s3: { discovered: true, xp: 0 } } } },
  ...extra,
});

beforeEach(() => {
  localStorage.clear();
  for (const f of Object.values(rt)) f.mockClear();
  useCity.setState({
    cityRegion: REGION,
    view: { name: 'city' },
    backendKind: 'mock',
    backendStatus: 'connected',
    hosted: false,
    progress: onStep(0),
    tasks: {},
    taskOrder: [],
    deploys: {},
    toasts: [],
    account: { linked: false },
    celebration: undefined,
    selected: undefined,
    build: undefined,
    prefs: { chatter: false, stage: 'compact', region: REGION, firstSteps: 'beginner' },
  } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const STEPS = [
  ['Walk to S3 Lake', 'Walk to S3 Lake'],
  ['Play S3 Fishing', '🎣 Play S3 Fishing'],
  ["Learn 3 of Sally's cards", "Open Sally's cards (Learn tab)"],
  ['Help a citizen', 'Walk to the citizen'],
  ['Watch Sally work', 'Ask Sally: store my photos'],
  ["Say OK to Sally's plan", "See Sally's plan (Deploy tab)"],
] as const;

describe('the guide card', () => {
  it('shows each step with its title, its place in six and one amber button that names the step', () => {
    for (const [i, [title, button]] of STEPS.entries()) {
      useCity.setState({ progress: onStep(i) });
      const { container, unmount } = render(<GuideCard openTab={() => {}} />);
      const card = screen.getByRole('region', { name: `First steps, step ${i + 1} of 6: ${title}` });
      expect(card.textContent).toContain(`First steps · ${i + 1} of 6`);
      expect(screen.getByRole('progressbar', { name: 'First steps done' }).getAttribute('aria-valuenow')).toBe(String(i));
      const primary = container.querySelectorAll('.btn.primary');
      expect(primary).toHaveLength(1);
      expect(primary[0].textContent).toBe(button);
      // The step before says it's done (the fishing step says whether the lake grew, and how far it has to go).
      if (i === 1) expect(card.textContent).toMatch(/Done: you reached S3 Lake\./);
      if (i === 2) expect(card.textContent).toMatch(/S3 Lake needs 10 more ⭐ to grow/);
      unmount();
    }
  });

  it('says the lake grew once the fishing paid enough', () => {
    useCity.setState({ progress: onStep(2, { cities: { [REGION]: { landmarks: { s3: { discovered: true, xp: 12 } } } } }) });
    const { container } = render(<GuideCard openTab={() => {}} />);
    expect(container.querySelector('.guide-done')?.textContent).toMatch(/S3 Lake grew to Novice! Stars ⭐ are what you've learned/);
  });

  it('each button does its step’s thing', () => {
    const opened: string[] = [];
    const heard: string[] = [];
    const offs = [
      bus.on('walkTo', ({ id }) => heard.push(`walkTo:${id}`)),
      bus.on('walkToRequest', () => heard.push('walkToRequest')),
      bus.on('flyTo', ({ id }) => heard.push(`flyTo:${id}`)),
    ];
    const press = (step: number) => {
      useCity.setState({ progress: onStep(step) });
      const { unmount, container } = render(<GuideCard openTab={(t) => opened.push(t)} />);
      fireEvent.click(container.querySelector('.guide-go')!);
      unmount();
    };
    press(0);
    expect(heard).toContain('walkTo:s3');
    press(1);
    expect(useCity.getState().view).toEqual({ name: 'game', game: 'fishing' });
    useCity.setState({ view: { name: 'city' } });
    press(2);
    expect(opened).toEqual(['cards']);
    expect(useCity.getState().selected).toBe('s3');
    press(3);
    expect(heard).toContain('walkToRequest');
    press(4);
    expect(rt.startPracticeTask).toHaveBeenCalledOnce();
    expect(heard).toContain('flyTo:agent:s3');
    press(5);
    expect(rt.planDeploy).toHaveBeenCalledWith('photo-bucket');
    expect(opened).toEqual(['cards', 'deploy']);
    offs.forEach((off) => off());
  });

  it('has no button while the step runs elsewhere: Kai walking, Sally working', () => {
    // The city takes the walk (it calls the visit when Kai arrives).
    const offWalk = bus.on('walkTo', ({ accept }) => accept());
    const { container, rerender } = render(<GuideCard openTab={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Walk to S3 Lake' }));
    expect(screen.getByRole('status').textContent).toMatch(/Kai is walking to S3 Lake…/);
    expect(container.querySelector('.btn.primary')).toBeNull();
    offWalk();
    act(() =>
      useCity.setState({
        progress: onStep(4),
        tasks: { 'practice-task-1': { taskId: 'practice-task-1', prompt: 'Store my holiday photos', agentId: 's3', steps: [{ text: 'Walking to S3 Lake', status: 'running' }], status: 'running' } },
        taskOrder: ['practice-task-1'],
      }),
    );
    rerender(<GuideCard openTab={() => {}} />);
    expect(screen.getByRole('status').textContent).toMatch(/Sally is working…/);
    expect(container.querySelector('.guide .btn.primary')).toBeNull();
    // Her task card sits under the guide, with no follow-ups of its own.
    expect(container.querySelector('.guide-task .task')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Next:|See it in Deploy/ })).toBeNull();
  });

  it('takes focus to the step’s button when it starts (never from somewhere the player is)', () => {
    render(<GuideCard openTab={() => {}} />);
    expect(document.activeElement?.textContent).toBe('Walk to S3 Lake');
    const elsewhere = document.createElement('button');
    document.body.append(elsewhere);
    elsewhere.focus();
    act(() => useCity.setState({ progress: onStep(1) }));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('asks before skipping; Keep going stays, Skip opens the whole city and ends the path', () => {
    render(<GuideCard openTab={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skip the first steps' }));
    const ask = screen.getByRole('alertdialog', { name: 'Skip the first steps?' });
    expect(document.activeElement?.textContent).toBe('Keep going');
    // Two choices and one lamp: the step's own button waits meanwhile.
    expect(document.querySelectorAll('.btn.primary')).toHaveLength(1);
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep going' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(useCity.getState().prefs.firstSteps).toBe('beginner');
    fireEvent.click(screen.getByRole('button', { name: 'Skip the first steps' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Skip the first steps' }));
    const st = useCity.getState();
    expect(st.prefs.firstSteps).toBe('skipped');
    expect(st.prefs.builder).toBe(true);
    expect(st.prefs.simple).toBe(false);
    expect(st.progress.quests?.['first-steps']?.status).toBe('done');
    expect(screen.queryByRole('region', { name: /First steps, step/ })).toBeNull();
  });
});

describe('the path’s moments', () => {
  it('says each step as it starts, Sally’s line on the fishing step, and plants the citizen on the citizen step', async () => {
    // Lines said by earlier tests have gone out (one every ANNOUNCE_GAP_MS), so this one is said at once.
    await new Promise((r) => setTimeout(r, ANNOUNCE_GAP_MS * 4));
    vi.useFakeTimers();
    const lines: string[] = [];
    const said: string[] = [];
    const planted: string[] = [];
    const offs = [
      bus.on('announce', ({ text }) => lines.push(text.trim())),
      bus.on('say', ({ text }) => said.push(text)),
      bus.on('requestNow', ({ serviceId }) => planted.push(serviceId)),
    ];
    render(<FirstStepsMoments />);
    act(() => useCity.setState({ progress: onStep(1) }));
    act(() => void vi.advanceTimersByTime(ANNOUNCE_GAP_MS));
    expect(lines).toContain('Done: you reached S3 Lake. Step 2 of 6: Play S3 Fishing.');
    act(() => void vi.advanceTimersByTime(4000));
    expect(said).toEqual([FIRST_STEPS.steps[1].sally]);
    act(() => useCity.setState({ progress: onStep(3) }));
    expect(planted).toEqual(['s3']);
    offs.forEach((off) => off());
  });
});

describe('the quiet city', () => {
  it('the HUD says “First steps n/6” in To do’s place; coins and Decorate wait', () => {
    useCity.setState({ progress: onStep(1, { wallet: { earned: 20, spent: 0 } }) });
    const { container } = render(<Hud layout="panel" />);
    expect(container.querySelector('.hud-steps')?.textContent).toBe('First steps 2/6');
    expect(container.querySelector('.hud-coins')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Decorate' })).toBeNull();
    expect(container.querySelector('.hud-lights, .rank-chip')).toBeNull();
    // ⋯ has no Decorate and no old tour on the path.
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: /Decorate|Replay the tour|first steps/ })).toBeNull();
  });

  it('the City tab is the guide alone (no To-do, banner or “Coming up next”), and the prompt bar waits', () => {
    const { container } = render(
      <>
        <GuideCard openTab={() => {}} />
        <Home openTab={() => {}} />
      </>,
    );
    expect(container.querySelector('.todo, .event-banner, .coming-next, .connect-card')).toBeNull();
    const { progress, prefs } = useCity.getState();
    for (const f of ['promptBar', 'copilotSwitch', 'eventBanner', 'comingUp', 'coins', 'decorate', 'connect'] as const) expect(shows(f, prefs, quietContext(progress, prefs))).toBe(false);
  });
});

describe('⋯ → How you play', () => {
  it('Play the first steps (Replay once done) runs them from step 0 on the City tab', () => {
    const tabs: string[] = [];
    const off = bus.on('showTab', ({ tab }) => tabs.push(tab));
    useCity.setState({
      view: { name: 'world' },
      prefs: { ...useCity.getState().prefs, firstSteps: undefined },
      progress: { version: 2, landmarks: {}, updatedAt: '', quests: { 'first-steps': { status: 'done', step: 6 } } },
    } as never);
    render(<Hud layout="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: FIRST_STEPS.menu.replay }));
    const st = useCity.getState();
    expect(st.prefs.firstSteps).toBe('replay');
    expect(st.prefs.firstStepsReplay).toEqual({ step: 0 });
    expect(st.view.name).toBe('city');
    expect(tabs).toEqual(['home']);
    off();
  });

  it('says Play for a player who never did them', () => {
    useCity.setState({ prefs: { ...useCity.getState().prefs, firstSteps: undefined }, progress: { version: 2, landmarks: {}, updatedAt: '', quests: { 'storage-static-site': { status: 'active', step: 1, count: 0 } } } } as never);
    render(<Hud layout="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: FIRST_STEPS.menu.play })).toBeTruthy();
  });
});

describe('the strip on Learn and Deploy', () => {
  it('counts the cards on Learn, then offers the way back once that step is done', () => {
    const opened: string[] = [];
    useCity.setState({ progress: onStep(2) });
    const { rerender } = render(<GuideStrip tab="learn" openTab={(t) => opened.push(t)} />);
    expect(screen.getByRole('region', { name: 'First steps' }).textContent).toMatch(/First steps 3 of 6 · Learn 3 cards · 0 of 3/);
    expect(screen.queryByRole('button')).toBeNull();
    act(() => useCity.setState({ progress: onStep(3) }));
    rerender(<GuideStrip tab="learn" openTab={(t) => opened.push(t)} />);
    expect(screen.getByRole('region', { name: 'First steps' }).textContent).toMatch(/✓ Step 3 done · Next: Help a citizen/);
    fireEvent.click(screen.getByRole('button', { name: 'Back to the city' }));
    expect(opened).toEqual(['home']);
  });

  it('names Sally’s plan on Deploy', () => {
    useCity.setState({ progress: onStep(5) });
    render(<GuideStrip tab="deploy" openTab={() => {}} />);
    expect(screen.getByRole('region', { name: 'First steps' }).textContent).toMatch(/First steps 6 of 6 · Say OK to Sally's plan/);
  });
});

describe('Deploy on the path', () => {
  const plan = {
    deployId: 'practice-abc',
    templateId: 'photo-bucket',
    stackName: 'A private bucket for your photos (practice)',
    region: 'practice',
    changes: [{ action: 'Add', logicalId: 'PhotoBucket', resourceType: 'AWS::S3::Bucket' }],
    costNote: 'Practice: nothing real is made, and it costs nothing.',
    status: 'preview',
  };

  it('shows only the waiting practice approval, for a hosted player with a linked account too', () => {
    useCity.setState({
      backendKind: 'server',
      hosted: true,
      account: { linked: true, accountId: '111122223333', region: REGION },
      progress: onStep(5),
      deploys: { [plan.deployId]: plan },
    } as never);
    const { container } = render(<DeployPanel />);
    expect(screen.getByRole('heading', { name: 'Waiting for your OK' })).toBeTruthy();
    expect(container.textContent).toMatch(/Add S3 bucket/);
    expect(container.textContent).toMatch(/Practice: nothing real is made, and it costs nothing\./);
    // No account card, no steps, no blueprints, no account number, no For AWS learners fold.
    expect(screen.queryByRole('heading', { name: 'Your AWS account' })).toBeNull();
    expect(screen.queryByRole('list', { name: 'Build for real, step by step' })).toBeNull();
    expect(container.textContent).not.toMatch(/Blueprints|1111|2222|3333|For AWS learners/);
    const primary = container.querySelectorAll('.btn.primary');
    expect(primary).toHaveLength(1);
    expect(primary[0].textContent).toBe('Approve & deploy');
    // Its title takes focus, never Approve.
    expect(document.activeElement?.textContent).toBe(plan.stackName);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(rt.decideDeploy).toHaveBeenCalledWith('practice-abc', false, undefined);
  });

  it('with no plan yet, offers Sally’s plan right there', () => {
    useCity.setState({ progress: onStep(5) });
    render(<DeployPanel />);
    fireEvent.click(screen.getByRole('button', { name: "See Sally's plan" }));
    expect(rt.planDeploy).toHaveBeenCalledWith('photo-bucket');
  });
});

describe('the tutorial deck', () => {
  it('deals Sally’s three cards in order with a count of three, and its answers stay docked in view', () => {
    useCity.setState({ progress: onStep(2) });
    const { container } = render(<Flashcards />);
    expect(screen.queryByRole('combobox', { name: 'Deck' })).toBeNull();
    expect(container.querySelector('.deck-progress')?.textContent).toMatch(/^0 of 3/);
    expect(container.querySelector('.flash-meta')?.textContent).toMatch(/S3 Lake/);
    fireEvent.keyDown(window, { key: 'f' });
    const grades = screen.getByRole('group', { name: 'How well did you know it?' });
    expect(within(grades).getAllByRole('button')).toHaveLength(3);
    expect(screen.getByText(FIRST_STEPS.steps[2].terms!)).toBeTruthy();
    // The answers dock to the bottom of the tab (styles/32-first-steps.css), so a long answer never pushes them away.
    const css = readFileSync('src/app/styles/32-first-steps.css', 'utf8');
    expect(css).toMatch(/\.cards \.grades \{[^}]*position: sticky;[^}]*bottom: 0;/);
    // Any answer counts toward the three.
    fireEvent.keyDown(window, { key: '1' });
    expect(useCity.getState().progress.quests?.['first-steps']?.count).toBe(1);
    expect(container.querySelector('.deck-progress')?.textContent).toMatch(/^1 of 3/);
  });
});

describe('the building card on the path', () => {
  it('is What is it?, the level bar and a graphite Play Fishing (no extras, no second lamp)', () => {
    useCity.setState({ progress: onStep(1), selected: 's3' });
    const { container } = render(<LandmarkCard openTab={() => {}} />);
    expect(screen.getByRole('region', { name: 'What is it?' })).toBeTruthy();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    const play = screen.getByRole('button', { name: /Play Fishing/ });
    expect(play.className).not.toMatch(/primary/);
    expect(container.querySelector('.btn.primary')).toBeNull();
    expect(screen.queryByText(/For AWS learners|Which one should I pick|Hands-on workshops/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Watch it done|Ask a question|Learn with cards/ })).toBeNull();
  });
});

describe('the citizen’s question', () => {
  const ask = { request: { cardId: 's3-01', serviceId: 's3', question: 'What is an S3 bucket?', options: ['A container for files', 'A server', 'A queue'], right: 0, answer: 'A container for files' }, name: 'Pat' };

  it('answers with keys 1–3, leads with the verdict, and focuses Back to the city', () => {
    useCity.setState({ progress: onStep(3) });
    render(<RequestCard />);
    act(() => bus.emit('citizenRequest', ask));
    expect([...document.querySelectorAll('.request-option .kbd')].map((k) => k.textContent)).toEqual(['1', '2', '3']);
    fireEvent.keyDown(window, { key: '2' });
    const card = screen.getByRole('dialog', { name: 'Pat has a question' });
    const verdict = card.querySelector('.request-verdict')!;
    expect(verdict.textContent).toBe('Not quite: it\'s "A container for files". That card will come back soon.');
    // The verdict comes before the question.
    expect(verdict.compareDocumentPosition(card.querySelector('.request-q')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('Back to the city');
  });

  it('says it the path’s way when it’s right', () => {
    useCity.setState({ progress: onStep(3) });
    render(<RequestCard />);
    act(() => bus.emit('citizenRequest', ask));
    fireEvent.keyDown(window, { key: '1' });
    expect(screen.getByRole('dialog').querySelector('.request-verdict')?.textContent).toBe(FIRST_STEPS.steps[3].right);
  });
});

describe('graduation', () => {
  it('says what was learned, where the city is, what opened, and offers Your First Bucket', () => {
    const opened: string[] = [];
    useCity.setState({
      progress: { version: 2, landmarks: {}, updatedAt: '', quests: { 'first-steps': { status: 'done', step: 6 } }, wallet: { earned: 37, spent: 0 } },
      celebration: 'first-steps',
    } as never);
    render(<Celebrate openTab={(t) => opened.push(t)} />);
    const card = screen.getByRole('dialog', { name: 'First steps done!' });
    for (const line of FIRST_STEPS.grad.learned) expect(card.textContent).toContain(line);
    expect(card.textContent).toContain('Your city is the Oregon Region. AWS writes it us-west-2.');
    expect(card.textContent).toContain('🌳 Decorate: spend your 37 City Coins on your city');
    const next = within(card).getByRole('button', { name: 'Next: Your First Bucket →' });
    expect(next.className).toMatch(/primary/);
    expect(document.activeElement).toBe(next);
    expect(card.querySelectorAll('.btn.primary')).toHaveLength(1);
    fireEvent.click(next);
    expect(useCity.getState().progress.quests?.['storage-static-site']?.status).toBe('active');
    expect(opened).toEqual(['home']);
  });
});
