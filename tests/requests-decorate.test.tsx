// @vitest-environment jsdom
// A citizen's question never opens over Decorate's drawer (seen in CI, and possible for players): reached while build
// mode is on, the citizen waits, and asks once Decorate closes (src/game/Requests.ts); a card already up when Decorate
// opens is held until it closes (src/ui/RequestCard.tsx).
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '@/backend/contract';

vi.mock('phaser', () => ({ default: { Geom: { Rectangle: class {}, RectangleContains: () => true } } }));
vi.mock('@/game/audio', () => ({ click: () => {} }));
vi.mock('@/game/motion', () => ({ reducedMotion: () => true }));
vi.mock('@/game/SpeechBubble', () => ({ crisp: <T,>(t: T) => t, TEXT_FONT: 'x' }));
vi.mock('@/game/theme', () => ({ CSS: { accentInk: '#000', gold: '#fc0' }, labelStyle: () => ({}) }));

const { Requests } = await import('@/game/Requests');
const { REQUEST_GAP_MS } = await import('@/state/requests');
const { RequestCard } = await import('@/ui/RequestCard');
const { bus } = await import('@/state/bus');
const { useCity } = await import('@/state/store');

const progress = { version: 2, landmarks: {}, cities: { 'us-west-2': { landmarks: { s3: { discovered: true, xp: 10 } } } }, updatedAt: '' } as unknown as Progress;

const text = () => {
  const o: Record<string, unknown> = { width: 10, height: 10 };
  for (const m of ['setOrigin', 'setDepth', 'setInteractive', 'on', 'setPosition', 'setScale']) o[m] = () => o;
  o.destroy = () => {};
  return o;
};
const agent = (name: string) => ({ name, gx: 5, gy: 5, tile: { x: 5, y: 5 }, isBusy: false, screen: { x: 0, y: 0 }, pin: () => {}, face: () => {}, emote: () => {}, goTo: () => {} });

describe('a citizen with a question while Decorate is open', () => {
  beforeEach(() => useCity.setState({ view: { name: 'city' }, cityRegion: 'us-west-2', progress, build: undefined } as never));
  afterEach(cleanup);

  it('waits while build mode is on, and asks once it closes', () => {
    const scene = { time: { now: 0 }, add: { text }, tweens: { add: () => ({ remove: () => {} }) } };
    const kai = agent('Kai');
    const citizen = agent('Pat · walker');
    const asked: string[] = [];
    const off = bus.on('citizenRequest', ({ name }) => asked.push(name));
    const r = new Requests(scene as never, () => [citizen] as never, () => kai as never);
    useCity.setState({ build: { tool: 'place', undo: [] } } as never);
    r.update(REQUEST_GAP_MS, 1); // the "?" appears beside Kai
    r.update(REQUEST_GAP_MS + 100, 1);
    r.update(REQUEST_GAP_MS + 200, 1);
    expect(asked).toEqual([]);
    useCity.setState({ build: undefined } as never);
    r.update(REQUEST_GAP_MS + 300, 1);
    expect(asked).toEqual(['Pat']);
    off();
    r.destroy();
  });

  it('a card already up waits while Decorate is open, then comes back', () => {
    render(<RequestCard />);
    act(() => bus.emit('citizenRequest', { request: { cardId: 's3-01', serviceId: 's3', question: 'What is S3?', options: ['a', 'b', 'c'], right: 0, answer: 'a' }, name: 'Pat' }));
    expect(screen.getByRole('dialog', { name: 'Pat has a question' })).toBeTruthy();
    act(() => useCity.setState({ build: { tool: 'place', undo: [] } } as never));
    expect(screen.queryByRole('dialog')).toBeNull();
    act(() => useCity.setState({ build: undefined } as never));
    expect(screen.getByRole('dialog', { name: 'Pat has a question' })).toBeTruthy();
  });
});
