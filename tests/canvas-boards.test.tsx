// @vitest-environment jsdom
// Impeccable batch D (canvas & boards): bubbles that share the small map, signs that give way, an end card that leads
// with the next try, Decorate's drawer distilled, and a puzzle board with room to read.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('phaser', () => {
  class Rectangle {
    constructor(
      public x = 0,
      public y = 0,
      public width = 0,
      public height = 0,
    ) {}
  }
  const overlap = (a: Rectangle, b: Rectangle) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  return { default: { Geom: { Rectangle, Intersects: { RectangleToRectangle: overlap } }, GameObjects: { Container: class {} }, Math: { Clamp: (v: number, a: number, b: number) => Math.min(b, Math.max(a, v)) } } };
});

const read = (file: string) => readFileSync(path.resolve(__dirname, '..', file), 'utf8');
afterEach(() => cleanup());

describe('speech bubbles share the map', () => {
  it('a bubble never stays up past the cap: 5 s on the side panel’s small map, 8 s in the tab', async () => {
    const { bubbleHold, BUBBLE_HOLD_MAX_MS } = await import('@/game/SpeechBubble');
    expect(BUBBLE_HOLD_MAX_MS.panel).toBeLessThan(BUBBLE_HOLD_MAX_MS.tab);
    expect(bubbleHold(20, undefined, BUBBLE_HOLD_MAX_MS.tab)).toBe(4000); // short lines keep their own time
    expect(bubbleHold(200, undefined, BUBBLE_HOLD_MAX_MS.tab)).toBe(8000);
    expect(bubbleHold(10, 7000, BUBBLE_HOLD_MAX_MS.panel)).toBe(5000); // the drill's 7 s too
  });

  it('the panel keeps one bubble at a time, and an agent-to-agent caption needs no arrow glyph', () => {
    const scene = read('src/game/scenes/CityScene.ts');
    expect(scene).toMatch(/setBubbleRules\(this, \{ solo: surface === 'panel', maxHoldMs: BUBBLE_HOLD_MAX_MS\[surface\] \}\)/);
    expect(scene).toMatch(/this\.bubbleRules\(surfaceFor\(this\.scale\.width\)\)/);
    expect(scene).toMatch(/onSurface: \(s\) => \{[\s\S]{0,80}this\.bubbleRules\(s\)/);
    // Nunito has no →: "Cody · · you" became "Cody · to you".
    expect(scene).toMatch(/caption: `to \$\{to\}`/);
    expect(scene).not.toMatch(/caption: `→/);
    const bubble = read('src/game/SpeechBubble.ts');
    expect(bubble).toMatch(/if \(rules\?\.solo\) for \(const b of BUBBLES\.get\(this\.scene\) \?\? \[\]\) if \(b !== this && b\.showing\) b\.hide\(true\)/);
  });
});

describe('map signs give way', () => {
  it('the first sign in priority order wins and an overlapping one is dropped', async () => {
    const Phaser = (await import('phaser')).default;
    const { nonOverlapping } = await import('@/game/labels');
    const R = (x: number, y: number) => new Phaser.Geom.Rectangle(x, y, 40, 10);
    const picked = { b: R(0, 0) };
    const near = { b: R(30, 5) }; // overlaps the picked one
    const apart = { b: R(100, 0) };
    expect([...nonOverlapping([picked, near, apart], (s) => s.b)]).toEqual([picked, apart]);
  });

  it('signs are placed after sliding into view (picked, then nearest the middle), and none show while decorating', () => {
    const scene = read('src/game/scenes/CityScene.ts');
    const place = scene.slice(scene.indexOf('  private placeSigns('), scene.indexOf('  /** The plot a landmark stands in'));
    expect(place).toMatch(/keepInView\(view, inset\)[\s\S]*nonOverlapping\(signs/);
    expect(place).toMatch(/Number\(b\.must\) - Number\(a\.must\) \|\| d2\(a\.at\) - d2\(b\.at\)/);
    const sync = scene.slice(scene.indexOf('  private syncLabels() {'), scene.indexOf('  private placeSigns('));
    expect(sync).toMatch(/const want = building \? \[\] :/);
    expect(sync).toMatch(/setTagsShown\(all && !building\)/);
    // Decorate going on or off re-runs the budget.
    const onBuild = scene.slice(scene.indexOf('  private onBuildState('), scene.indexOf('  private onBuildState(') + 1400);
    expect(onBuild.match(/this\.syncLabels\(\)/g)?.length).toBe(2);
  });

  it('theme.ts mirrors the UI’s --muted', () => {
    const base = /--muted:\s*(#[0-9a-f]{6})/i.exec(read('src/app/styles/00-base.css'))?.[1];
    expect(read('src/game/theme.ts')).toContain(`muted: '${base}'`);
  });
});

describe('a mini-game’s end card leads with the next try', () => {
  it('says what to do next first, then the floor with its numbers, in a calm colour', () => {
    const mini = read('src/game/scenes/games/MiniGame.ts');
    const finish = mini.slice(mini.indexOf('  protected finish() {'));
    const next = finish.indexOf('nextTryLine(short)');
    const floor = finish.indexOf('gateLine(gate, this.wrongWord, this.accuracyWord)');
    expect(next).toBeGreaterThan(-1);
    expect(floor).toBeGreaterThan(next);
    expect(finish.indexOf('const score = text(')).toBeGreaterThan(floor);
    expect(finish).not.toMatch(/#991b1b/);
    expect(mini).toMatch(/Next try: take your time and make surer calls/);
    expect(mini).toMatch(/Next try: make at least \$\{RELAXED_MIN_CALLS\} calls before Done to score a round/);
  });
});

describe('Decorate’s drawer', () => {
  it('the tool is one segmented switch, the categories one row, the count in the UI’s type', async () => {
    const { useCity } = await import('@/state/store');
    const { BuildDrawer } = await import('@/ui/BuildDrawer');
    useCity.setState({ cityRegion: 'us-west-2', build: undefined, view: { name: 'city' } as never });
    useCity.getState().setBuild(true);
    render(<BuildDrawer />);
    const tool = screen.getByRole('group', { name: 'Tool' });
    expect(tool.className).toBe('seg');
    expect([...tool.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    fireEvent.click(screen.getByRole('button', { name: /Move/ }));
    expect(useCity.getState().build?.tool).toBe('move');
    expect(screen.queryByRole('group', { name: 'Categories' })).toBeNull(); // only while placing
    fireEvent.click(screen.getByRole('button', { name: /Place/ }));
    expect(screen.getByRole('group', { name: 'Categories' }).className).toMatch(/\bchips\b/);
    const css = read('src/app/styles/26-build.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/font-family:\s*var\(--font-mono\)/);
    expect(css).not.toMatch(/font-size:\s*\d+px/);
    useCity.getState().setBuild(false);
  });
});

describe('the puzzle board', () => {
  it('reads its legend in words, puts Check design on its own row, and opens bigger without losing the design', async () => {
    const { useCity } = await import('@/state/store');
    const { ArchitectureBoard } = await import('@/ui/ArchitectureBoard');
    const { PUZZLES } = await import('@/world/content');
    const { slotsOf } = await import('@/learning/diagram');
    const { draftKey } = await import('@/learning/puzzleDraft');
    const p = PUZZLES[0];
    const slot = slotsOf(p).find((s) => s.required)!;
    localStorage.setItem(draftKey(p.id), JSON.stringify({ placements: { [slot.id]: slot.service }, drops: [], misdrops: 0, revealed: [] }));
    useCity.setState({ progress: { ...useCity.getState().progress, puzzles: {} }, focusPuzzle: p.id });
    const { container } = render(<ArchitectureBoard />);
    expect(container.querySelector('.legend')?.textContent).toMatch(/a spot your design needs.*a bonus spot.*the order data moves/);
    expect(screen.getByRole('button', { name: /Check design/ }).parentElement?.className).toBe('foot-actions');
    fireEvent.click(screen.getByRole('button', { name: /Bigger board/ }));
    const dialog = screen.getByRole('dialog', { name: p.title });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close the big board' }));
    // The same board: the placed card is still there, and the brief sits beside it.
    expect(dialog.querySelector('.arch-label .muted')?.textContent).toMatch(/· 1\//);
    expect(dialog.querySelector('.arch-side .reqs')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('.arch-label .muted')?.textContent).toMatch(/· 1\//);
    localStorage.clear();
  });

  it('never draws its spot labels below --fs-xs: 11-unit labels on a drawing no smaller than its natural size', () => {
    const css = read('src/app/styles/17-diagram.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(/\.diagram \{[^}]*min-width:\s*calc\(var\(--dw, \d+\) \/ 11 \* var\(--fs-xs\)\)/.test(css)).toBe(true);
    expect(Number(/\.node-label \{[^}]*font:\s*\d+ (\d+)px/.exec(css)?.[1])).toBeGreaterThanOrEqual(11);
    expect(read('src/ui/diagram/DiagramBoard.tsx')).toMatch(/'--dw': w/);
  });
});
