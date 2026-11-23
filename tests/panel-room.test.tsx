// @vitest-environment jsdom
// Room in the 400 px side panel and one thing over its short map at a time (the Impeccable pass, 23 Nov 2026): the
// Copilot switch stands where it's useful, the AI note folds into the composer (still the box's description), the coins
// note and the news ticker step aside for a toast, the ⋯ menu is labelled groups with Decorate as a plain action, the
// HUD's City Lights count is a 24 px target with its words, and Connie's first card docks under the panel's map.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { PromptBar } = await import('@/ui/PromptBar');
const { AI_NOTE } = await import('@/ui/AiNote');
const { Hud, COINS_TIP_MS } = await import('@/ui/Hud');
const { NewsTicker } = await import('@/ui/NewsTicker');
const { WorldIntro } = await import('@/ui/WorldIntro');

const news = { type: 'aws.news', items: [{ id: 'n1', title: 'Amazon S3 adds a thing', url: 'https://aws.amazon.com/about-aws/whats-new/x', date: new Date().toISOString(), serviceIds: ['s3'] }] };
const toast = { id: 1, icon: '🧩', text: 'Combo found', kind: 'info', ms: 4000 };

beforeEach(() => {
  localStorage.clear();
  useCity.setState({ cityRegion: 'us-west-2', view: { name: 'city' }, backendKind: 'mock', hosted: false, toasts: [], focus: undefined, build: undefined, prefs: { chatter: false, stage: 'compact', region: 'us-west-2', simple: false } } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the prompt bar in the side panel', () => {
  const describedBy = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent;

  it('offers the Copilot switch where it’s useful: the City tab, a console page beside it, or while it’s on', () => {
    const { unmount } = render(<PromptBar layout="panel" consoleHere={false} />);
    expect(screen.queryByRole('switch')).toBeNull();
    unmount();
    useCity.setState({ focus: { kind: 'console', url: 'https://us-west-2.console.aws.amazon.com/s3/home' } } as never);
    render(<PromptBar layout="panel" consoleHere={false} />);
    expect(screen.getByRole('switch', { name: /Do it in my console/ })).toBeTruthy();
  });

  it('folds the AI note into the composer: above the box, and still what the box says to a screen reader', () => {
    const { container } = render(<PromptBar layout="panel" consoleHere={false} />);
    const box = screen.getByRole('textbox', { name: 'Ask the city' });
    expect(describedBy(box)).toBe(AI_NOTE);
    const bar = container.querySelector('.prompt-bar')!;
    const note = bar.querySelector('.ai-note')!;
    expect(note.compareDocumentPosition(bar.querySelector('form')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The stylesheet shows it while the box has focus or words in it (visually hidden otherwise, never display: none).
    const css = readFileSync('src/app/styles/08-chat.css', 'utf8');
    expect(css).toMatch(/\.prompt-bar:not\(:focus-within\):not\(:has\(\.composer input:not\(:placeholder-shown\)\)\) \.ai-note \{[^}]*clip-path: inset\(50%\)/);
    expect(css).toMatch(/\.ai-note \{[^}]*font-size: var\(--fs-xs\)/);
  });
});

describe('one thing over the short map at a time', () => {
  it('the coins note steps aside while a toast shows, comes back after, and is read after a while on screen', () => {
    vi.useFakeTimers();
    const p = useCity.getState().progress;
    useCity.setState({ progress: { ...p, wallet: { earned: 20, spent: 0 } } } as never);
    render(<Hud layout="panel" />);
    expect(screen.getByRole('note').textContent).toMatch(/spend them on decorations/);
    act(() => useCity.setState({ toasts: [toast] } as never));
    expect(screen.queryByRole('note')).toBeNull();
    act(() => useCity.setState({ toasts: [] } as never));
    expect(screen.getByRole('note')).toBeTruthy();
    act(() => void vi.advanceTimersByTime(COINS_TIP_MS));
    expect(screen.queryByRole('note')).toBeNull();
    expect(localStorage.getItem('awscity.tip.coins')).toBe('1');
  });

  it('in the panel the news ticker gives a toast its place; in the tab it stays', () => {
    useCity.setState({ news } as never);
    const { container, unmount } = render(<NewsTicker layout="panel" />);
    expect(container.querySelector('.ticker')).toBeTruthy();
    act(() => useCity.setState({ toasts: [toast] } as never));
    expect(container.querySelector('.ticker')).toBeNull();
    unmount();
    const tab = render(<NewsTicker layout="full" />);
    expect(tab.container.querySelector('.ticker')).toBeTruthy();
  });
});

describe('the ⋯ menu', () => {
  it('is labelled groups, and Decorate is a plain action that opens and closes the drawer', () => {
    render(<Hud layout="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    for (const name of ['Sound and view', 'Accessibility', 'How you play', 'Your city']) expect(screen.getByRole('group', { name })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'How you play' }).textContent).toMatch(/Keep it simple.*I already build on AWS/);
    expect(screen.getByRole('group', { name: 'Accessibility' }).textContent).not.toMatch(/I already build on AWS|Keep it simple/);
    const decorate = screen.getByRole('menuitem', { name: '🌳 Decorate' });
    expect(decorate.querySelector('.switch')).toBeNull();
    fireEvent.click(decorate);
    expect(useCity.getState().build).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '🌳 Done decorating' }));
    expect(useCity.getState().build).toBeUndefined();
  });
});

describe('the HUD', () => {
  it('City Lights is a 24 px target that says its count in words where there’s room, and the panel keeps Decorate’s word', () => {
    const { container } = render(<Hud layout="full" />);
    expect(container.querySelector('.hud-lights .hud-lights-word')?.textContent).toMatch(/windows? lit$/);
    const css = readFileSync('src/app/styles/02-hud.css', 'utf8');
    expect(css).toMatch(/\.hud \.progress-readout \.hud-lights \{[^}]*min-height: 24px/);
    expect(css).toMatch(/\.app-panel \.hud \.build-toggle \.build-word \{\s*display: inline;/);
  });
});

describe('the first screen', () => {
  it('docks Connie’s card under the side panel’s map (not over the dots); the tab keeps it on the map', () => {
    useCity.setState({ view: { name: 'world' }, prefs: {} } as never);
    const { container, unmount } = render(<WorldIntro docked />);
    expect(container.querySelector('.world-intro.docked')).toBeTruthy();
    unmount();
    const tab = render(<WorldIntro />);
    expect(tab.container.querySelector('.world-intro:not(.docked)')).toBeTruthy();
    const app = readFileSync('src/app/App.tsx', 'utf8');
    expect(app).toMatch(/layout === 'full' && <WorldIntro \/>/);
    expect(app).toMatch(/layout === 'panel' && <WorldIntro docked \/>/);
  });
});
