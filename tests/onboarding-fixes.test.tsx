// @vitest-environment jsdom
// Persona fixes (onboarding): the first screen says what AWS is, the chosen certification shows as a progress bar,
// "First Brick" needs a building actually put up, and the news ticker doesn't rotate under reduced motion.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '@/backend/contract';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { WorldIntro } = await import('@/ui/WorldIntro');
const { setDiver } = await import('@/game/worldUi');
const { CertGoal } = await import('@/ui/Home');
const { NewsTicker } = await import('@/ui/NewsTicker');
const { demoHealth, demoNews } = await import('@/backend/mockAccount');
const { earnedBadges } = await import('@/state/badges');

const empty = { version: 2, landmarks: {}, cities: {}, updatedAt: '' } as Progress;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('first screen', () => {
  it('says what AWS is before asking for a Region', () => {
    useCity.setState({ view: { name: 'world' }, prefs: {} } as never);
    const offMap = setDiver(() => true); // the world map is drawn (the card waits for it)
    render(<WorldIntro />);
    const text = screen.getByRole('region', { name: 'Where to start' }).textContent ?? '';
    expect(text).toMatch(/AWS is Amazon’s cloud/);
    expect(text.indexOf('AWS is')).toBeLessThan(text.indexOf('Pick one'));
    offMap();
  });
});

describe('certification goal', () => {
  it('is a labelled progress bar on the shift', () => {
    useCity.setState({ progress: empty, prefs: { certGoal: 'cloud-practitioner' } } as never);
    render(<CertGoal />);
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(Number(bar.getAttribute('aria-valuemax'))).toBeGreaterThan(0);
    expect(bar.getAttribute('aria-valuetext')).toMatch(/^Cloud Practitioner: 0 of \d+ areas ready$/);
  });
  it('shows nothing without a goal', () => {
    useCity.setState({ progress: empty, prefs: {} } as never);
    expect(render(<CertGoal />).container.innerHTML).toBe('');
  });
});

describe('First Brick badge', () => {
  it('needs a building put up', () => {
    expect(earnedBadges(empty)).not.toContain('first-building');
    expect(earnedBadges({ ...empty, cities: { 'us-west-2': { landmarks: { s3: { discovered: false, xp: 0 } } } } } as Progress)).not.toContain('first-building');
    expect(earnedBadges({ ...empty, cities: { 'us-west-2': { landmarks: { s3: { discovered: true, xp: 0 } } } } } as Progress)).toContain('first-building');
  });
});

describe('news ticker and reduced motion', () => {
  beforeEach(() => {
    useCity.setState({ health: demoHealth(new Date('2026-10-11T12:00:00Z')), news: demoNews(), cityRegion: 'me-central-1' });
  });
  const counter = () => screen.getByRole('button', { name: /Next AWS update/ }).textContent;
  it('rotates on its own normally', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    render(<NewsTicker />);
    const before = counter();
    act(() => void vi.advanceTimersByTime(8100));
    expect(counter()).not.toBe(before);
  });
  it('stays on one item under reduced motion', () => {
    vi.useFakeTimers();
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(<NewsTicker />);
    const before = counter();
    act(() => void vi.advanceTimersByTime(30_000));
    expect(counter()).toBe(before);
  });
});
