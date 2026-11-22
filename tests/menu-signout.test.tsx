// @vitest-environment jsdom
// Seen 22 Nov 2026: a player looked for Sign out in the ⋯ menu first (it lived only in Deploy → Your data).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));
const signOut = vi.fn();
vi.mock('@/app/runtime', async (importOriginal) => ({ ...(await importOriginal<object>()), canSignIn: () => true, signOut }));

const { useCity } = await import('@/state/store');
const { Hud } = await import('@/ui/Hud');
afterEach(cleanup);

describe('the ⋯ menu', () => {
  it('a signed-in player can sign out from it', () => {
    useCity.setState({ backendKind: 'server', backendStatus: 'connected' });
    render(<Hud layout="full" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('a signed-out player or the demo has no Sign out there', () => {
    useCity.setState({ backendKind: 'server', backendStatus: 'signed-out' });
    render(<Hud layout="full" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();
    cleanup();
    useCity.setState({ backendKind: 'mock', backendStatus: 'connected' });
    render(<Hud layout="full" />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();
  });
});
