// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReauthPrompt } from '@/ui/ReauthPrompt';
import { useCity } from '@/state/store';

afterEach(() => {
  cleanup();
  useCity.getState().patchAccount({ reauthRequired: false });
});

// Seen 24 Nov 2026: Turn on asked for a fresh sign-in, but the box sat at the top of the card, out of view, so the player
// signed out and in from the ⋯ menu instead.
describe('ReauthPrompt', () => {
  it('comes into view when a fresh sign-in is needed, with its Sign in again button', () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<ReauthPrompt />);
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => useCity.getState().patchAccount({ reauthRequired: true }));
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy();
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
  });
});
