// @vitest-environment jsdom
// Console features you can read: the Copilot is a labelled switch, the Lookout says why it can't snap in the tab and
// shows what it last saw, and a workshop step links only the Copilot task it started (and copies commands honestly).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));
const start = vi.fn<(goal: string, opts?: { serviceId?: string; onStart?: (id: string) => void }) => Promise<string | undefined>>();
vi.mock('@/app/runtime', async (importOriginal) => ({ ...(await importOriginal<object>()), startConsoleCopilot: start }));

const { useCity } = await import('@/state/store');
const { autoSnaps, lookoutUnavailable } = await import('@/app/runtime');
const { PromptBar } = await import('@/ui/PromptBar');
const { LandmarkCard } = await import('@/ui/LandmarkCard');
const { Workshop } = await import('@/ui/Workshop');

beforeEach(() => {
  start.mockReset();
  useCity.setState({ copilotTaskId: undefined, copilotFor: undefined, lastClassified: undefined, snap: 'idle', workshopOpen: undefined, selected: undefined });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the Console Copilot switch', () => {
  it('is a named switch in the panel that the keyboard can flip', () => {
    render(<PromptBar layout="panel" />);
    const sw = screen.getByRole('switch', { name: /Do it in my console/ });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('title')).toMatch(/clicks through your/);
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('textbox', { name: /in your console/ })).toBeTruthy();
  });

  // Seen 24 Nov 2026: pressing the words didn't flip it. The press took the focus into the bar, which unfolds the AI note
  // above the box and lifts the switch from under the pointer before the release. A press keeps the focus where it was.
  it('flips from a press on its words, and the press never moves the focus (nothing unfolds under the pointer)', () => {
    localStorage.clear();
    render(
      <>
        <button>Elsewhere</button>
        <PromptBar layout="panel" />
      </>,
    );
    const words = screen.getByText('Do it in my console');
    const sw = screen.getByRole('switch', { name: /Do it in my console/ });
    const away = screen.getByRole('button', { name: 'Elsewhere' });
    away.focus();
    expect(fireEvent.mouseDown(words)).toBe(false); // default prevented: the button doesn't take the focus
    fireEvent.mouseUp(words);
    fireEvent.click(words);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(away);
    // Turned on: the Copilot's coach tip has nothing left to explain.
    expect(localStorage.getItem('awscity.tip.copilot')).toBe('1');
    fireEvent.click(words);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // The keyboard still flips it from the switch itself.
    sw.focus();
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('is not offered in the full tab (it needs the console beside it)', () => {
    render(<PromptBar layout="full" />);
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('the Lookout card', () => {
  it('in the full tab, says why it can’t snap and how to open the panel or sidebar', () => {
    useCity.setState({ selected: 'lookout' });
    render(<LandmarkCard layout="full" />);
    expect(screen.queryByRole('button', { name: /Show this page/ })).toBeNull();
    expect(screen.getByRole('note').textContent).toMatch(/side panel/);
    expect(lookoutUnavailable('sidebar')).toMatch(/sidebar/);
    expect(lookoutUnavailable('tab')).toMatch(/Safari has no side panel/);
  });

  it('never photographs a page that shows a secret on its own (auto-snap), only AWS pages without one', () => {
    const onConsole = (url: string) => ({ kind: 'console' as const, url });
    expect(autoSnaps(onConsole('https://us-west-2.console.aws.amazon.com/s3/buckets?region=us-west-2'))).toBe(true);
    expect(autoSnaps({ kind: 'docs', url: 'https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html' })).toBe(true);
    for (const url of [
      'https://us-east-1.console.aws.amazon.com/iam/home#/users/details/alice/create-access-key',
      'https://us-west-2.console.aws.amazon.com/secretsmanager/secret?name=prod-db&region=us-west-2',
      'https://us-west-2.console.aws.amazon.com/systems-manager/parameters/db-password/description?region=us-west-2',
      'https://us-west-2.console.aws.amazon.com/kms/home?region=us-west-2#/kms/keys',
      'https://us-west-2.console.aws.amazon.com/cloudshell/home?region=us-west-2',
    ])
      expect(autoSnaps(onConsole(url)), url).toBe(false);
    expect(autoSnaps({ kind: 'other', url: 'https://mail.example.com/' })).toBe(false);
  });

  it('in the panel, shows what it last saw under the button', () => {
    useCity.setState({ selected: 'lookout', lastClassified: { serviceIds: ['s3'], summary: 'You are looking at a bucket list.' } });
    render(<LandmarkCard layout="panel" />);
    expect(screen.getByRole('button', { name: /Show this page/ })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Last look:.*bucket list.*S3/);
  });
});

describe('a workshop step', () => {
  const open = () => act(() => useCity.getState().openWorkshop('rds-first-database'));

  it('links only the Copilot task its own press started, with the step’s service', async () => {
    useCity.setState({ copilotTaskId: 'someone-elses' });
    start.mockImplementation(async (_g, o) => (o?.onStart?.('task-new'), 'task-new'));
    open();
    render(<Workshop />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Do it with the Copilot/ })));
    expect(start.mock.calls[0][1]?.serviceId).toBe('rds');
    expect(useCity.getState().copilotFor).toEqual({ taskId: 'task-new', workshopId: 'rds-first-database', stepId: expect.any(String) });
  });

  it('links nothing when no task started (no console tab), even with another task running', async () => {
    useCity.setState({ copilotTaskId: 'someone-elses' });
    start.mockResolvedValue(undefined);
    open();
    render(<Workshop />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: /Do it with the Copilot/ })));
    expect(useCity.getState().copilotFor).toBeUndefined();
  });

  it('copies the command, says which placeholder to replace, and the button resets', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    open();
    render(<Workshop />);
    expect(screen.getByText(/before running it/).textContent).toMatch(/Replace <db>/);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy' })));
    expect(writeText.mock.calls[0][0]).toMatch(/^aws rds create-db-instance --db-instance-identifier <db>/);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });
});
