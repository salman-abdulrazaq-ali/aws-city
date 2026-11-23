// @vitest-environment jsdom
// AWS North Hall: each attempt deals a talk's options in a new order, so the first option is no free pass.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The portrait draws with Phaser's canvas, which jsdom doesn't have.
vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));
const { NorthHall } = await import('@/ui/NorthHall');
const { TALKS } = await import('@/world/conference');

afterEach(cleanup);

const optionsOf = (q: string) => within(screen.getByLabelText(q)).getAllByRole('button').map((b) => b.textContent);

describe('North Hall quiz', () => {
  it('shuffles each question’s options, and deals them again on the next attempt', () => {
    const talk = TALKS.find((t) => t.id === 'lambda-managed-instances')!;
    render(<NorthHall />);
    fireEvent.click(screen.getByText(talk.title));
    const first = talk.check.map((c) => optionsOf(c.q));
    talk.check.forEach((c, i) => expect([...first[i]].sort()).toEqual([...c.options].sort()));
    // Not simply the data's order everywhere.
    expect(first).not.toEqual(talk.check.map((c) => c.options));
    // Tap the first option shown on every question, check, then try again: a new deal.
    for (const c of talk.check) fireEvent.click(within(screen.getByLabelText(c.q)).getAllByRole('button')[0]);
    fireEvent.click(screen.getByText(/Check my answers|Check again/));
    fireEvent.click(screen.getByText('Try the questions again'));
    expect(talk.check.map((c) => optionsOf(c.q))).not.toEqual(first);
  });

  it('the first option shown is not the right answer for every question', () => {
    let right = 0;
    let all = 0;
    for (const talk of TALKS) {
      render(<NorthHall />);
      fireEvent.click(screen.getByText(talk.title));
      for (const c of talk.check) {
        all++;
        if (optionsOf(c.q)[0] === c.options[c.answer]) right++;
      }
      cleanup();
    }
    expect(right).toBeLessThan(all);
  });
});
