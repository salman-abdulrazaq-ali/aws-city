// @vitest-environment jsdom
// AWS City Live on screen (src/ui/EventBanner.tsx): one line on the City tab, the Events board behind it, and the stage
// preview (?date=). Nothing shows when no event is near.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBanner } from '@/ui/EventBanner';

const visit = (search: string) => window.history.replaceState({}, '', `/city.html${search}`);
afterEach(() => {
  cleanup();
  visit('');
});

describe('the event banner', () => {
  it('counts down to re:Invent and opens the Events board', () => {
    visit('?date=2026-11-25');
    render(<EventBanner />);
    const line = screen.getByRole('button', { name: /AWS re:Invent 2026.*In 5 days · Las Vegas/ });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('Soon')).toBeTruthy();
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    const board = screen.getByRole('list', { name: 'Events board' });
    expect(board.textContent).toMatch(/five keynotes/);
    expect(screen.getByRole('button', { name: /Open the event page/ })).toBeTruthy();
  });

  it('says Live during re:Invent week', () => {
    visit('?date=2026-12-02');
    const { container } = render(<EventBanner />);
    expect(screen.getByRole('button', { name: /Live now · day 3 of 5/ })).toBeTruthy();
    expect(container.querySelector('.event-banner.reinvent.live')).toBeTruthy();
  });

  it('shows nothing when no event is near', () => {
    visit('?date=2027-02-01');
    const { container } = render(<EventBanner />);
    expect(container.innerHTML).toBe('');
  });
});
