// @vitest-environment jsdom
// The ⋯ menu from the keyboard (src/ui/Hud.tsx): focus moves in when it opens, the arrows move through its items and
// never reach the game, Escape closes it and puts focus back on ⋯; its structure passes axe (a menu holds only items,
// groups and separators), and every item's name is what it shows.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { Hud } = await import('@/ui/Hud');

beforeEach(() => {
  localStorage.clear();
  useCity.setState({ cityRegion: 'us-west-2', view: { name: 'city' }, backendKind: 'mock', hosted: false, prefs: { chatter: false, stage: 'compact', region: 'us-west-2' } } as never);
});
afterEach(() => cleanup());

const more = () => screen.getByRole('button', { name: 'More' });
const items = () => [...screen.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]')];

describe('the ⋯ menu from the keyboard', () => {
  it('opening it puts focus on its first item; the arrows, Home and End move through it and wrap', () => {
    render(<Hud layout="full" />);
    fireEvent.click(more());
    const all = items();
    expect(all.length).toBeGreaterThan(5);
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(all[0]);
  });

  it('the arrow keys stop at the menu: the city and the games (listening on the window) never get them', () => {
    const heard = vi.fn();
    window.addEventListener('keydown', heard);
    render(<Hud layout="full" />);
    fireEvent.click(more());
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    window.removeEventListener('keydown', heard);
    expect(heard).not.toHaveBeenCalled();
  });

  it('Escape closes it and focus goes back to ⋯; ArrowDown or ArrowUp on ⋯ opens it at the first or last item', () => {
    render(<Hud layout="full" />);
    fireEvent.click(more());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more());
    fireEvent.keyDown(more(), { key: 'ArrowUp' });
    const all = items();
    expect(document.activeElement).toBe(all[all.length - 1]);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    fireEvent.keyDown(more(), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items()[0]);
  });
});

describe('the ⋯ menu passes axe', () => {
  it('a menu owns only items, groups and separators; an item sits in a menu', async () => {
    render(<Hud layout="full" />);
    fireEvent.click(more());
    const res = await axe.run(screen.getByRole('menu'), { runOnly: { type: 'rule', values: ['aria-required-children', 'aria-required-parent', 'aria-allowed-role', 'nested-interactive'] } });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
  });

  it('the section titles are groups, and the street maps credit is an item that opens the copyright page', () => {
    render(<Hud layout="full" />);
    fireEvent.click(more());
    expect(screen.getByRole('group', { name: 'Accessibility' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /Street maps: © OpenStreetMap contributors/ })).toBeTruthy();
    expect(screen.getByRole('menu').querySelector('a')).toBeNull();
  });

  it('Text size is named by what it shows (label in name), and says what a press does in its title', () => {
    useCity.getState().setPref('textSize', 125);
    render(<Hud layout="full" />);
    fireEvent.click(more());
    const size = screen.getByRole('menuitem', { name: 'Text size 125%' });
    expect(size.getAttribute('aria-label')).toBeNull();
    expect(size.getAttribute('title')).toMatch(/150%/);
  });
});
