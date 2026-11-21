// @vitest-environment jsdom
// The Deploy tab's account cards: the authenticator setup whenever the server asks, and "Your data" for signed-in players.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hosted = { on: true };
vi.mock('@/app/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/runtime')>()),
  canSetUpMfa: () => true,
  canDeleteAccount: () => hosted.on,
  mfaStatus: async () => 'on' as const,
}));

const { useCity } = await import('@/state/store');
const { DeployPanel } = await import('@/ui/DeployPanel');

beforeEach(() => {
  hosted.on = true;
  useCity.setState({ backendKind: 'server', backendStatus: 'connected', deploys: {}, account: { linked: false } });
});
afterEach(() => cleanup());

describe('the Deploy tab’s account cards', () => {
  it('a linked player asked for MFA (approving a change, a fix) gets the authenticator setup too', () => {
    useCity.setState({ account: { linked: true, accountId: '123456789012', region: 'us-west-2', mfaRequired: true } });
    render(<DeployPanel />);
    expect(screen.getByText(/Protect your account first/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Set up an authenticator' })).toBeTruthy();
  });

  it('"Your data" shows the authenticator with Replace, which opens the same setup', async () => {
    render(<DeployPanel />);
    await act(async () => undefined); // mfaStatus answers
    expect(screen.getByText('Your data')).toBeTruthy();
    expect(screen.getByText(/Authenticator:/).textContent).toMatch(/Authenticator: on/);
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    expect(screen.getByText(/Replace your authenticator/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Get a new key' })).toBeTruthy();
  });

  it('the local server has no "Your data" (no accounts to sign out of or delete)', async () => {
    hosted.on = false;
    render(<DeployPanel />);
    await act(async () => undefined);
    expect(screen.queryByText('Your data')).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete my account/ })).toBeNull();
  });
});
