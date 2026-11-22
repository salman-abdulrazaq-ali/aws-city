// @vitest-environment jsdom
// A glossary term's definition (src/ui/Term.tsx) is never clipped by the card around it: it opens in the top layer
// (the popover API), placed under its term and kept inside the view, at 150 % text too.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GLOSSARY } from '@/world/glossary';
import { Term, popPlace } from '@/ui/Term';

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
afterEach(() => {
  cleanup();
  delete proto.showPopover;
});

const entry = GLOSSARY[0];
const view = { width: 400, height: 860 };

describe('where the definition goes', () => {
  it('under its term, nudged inside the view at the right edge', () => {
    expect(popPlace({ left: 20, top: 100, bottom: 120 }, { width: 260, height: 120 }, view)).toEqual({ left: 20, top: 128 });
    expect(popPlace({ left: 330, top: 100, bottom: 120 }, { width: 260, height: 120 }, view)).toEqual({ left: 132, top: 128 });
  });

  it('above its term when it won’t fit below; at the top of the view when it fits neither (150 % text)', () => {
    expect(popPlace({ left: 20, top: 800, bottom: 820 }, { width: 260, height: 200 }, view)).toEqual({ left: 20, top: 592 });
    expect(popPlace({ left: 20, top: 300, bottom: 320 }, { width: 260, height: 900 }, view)).toEqual({ left: 20, top: 8 });
    // Never off the left edge, even wider than the view.
    expect(popPlace({ left: -40, top: 10, bottom: 30 }, { width: 500, height: 50 }, view).left).toBe(8);
  });
});

describe('the definition opens in the top layer', () => {
  it('with the popover API it is a manual popover, shown and placed on screen (not inside the card)', () => {
    const shown = vi.fn();
    proto.showPopover = shown;
    render(
      <div style={{ overflow: 'hidden', height: 20 }}>
        <Term text={`About ${entry.term} today`} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: `${entry.term}: show definition` }));
    // `hidden`: jsdom's own stylesheet hides a popover the stub can't really open (and then it has no name to match).
    const pop = screen.getByRole('dialog', { hidden: true });
    expect(pop.getAttribute('aria-label')).toBe(entry.term);
    expect(pop.getAttribute('popover')).toBe('manual');
    expect(pop.className).toContain('layer');
    expect(shown).toHaveBeenCalledOnce();
    // jsdom has no layout: everything measures 0, so popPlace puts it a gutter in from the top-left.
    expect(pop.style.left).toBe('8px');
    expect(pop.style.top).toBe('8px');
    // Escape still closes it and gives focus back to the term.
    act(() => void fireEvent.keyDown(pop, { key: 'Escape' }));
    expect(screen.queryByRole('dialog', { hidden: true })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: `${entry.term}: show definition` }));
  });

  it('without it, the definition still opens next to its term', () => {
    render(<Term text={`About ${entry.term} today`} />);
    fireEvent.click(screen.getByRole('button', { name: `${entry.term}: show definition` }));
    const pop = screen.getByRole('dialog', { name: entry.term });
    expect(pop.getAttribute('popover')).toBeNull();
    expect(pop.className).not.toContain('layer');
  });
});
