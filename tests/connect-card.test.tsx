// @vitest-environment jsdom
// A hosted player who is signed in and hasn't linked an AWS account finds the way to link it on the City tab (not
// behind ⋯ → Show everything). The demo, the local server, a signed-out player and a linked account don't see it.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hosted = { on: true };
vi.mock('@/app/runtime', async (importOriginal) => ({ ...(await importOriginal<object>()), canSetUpMfa: () => hosted.on }));

const { useCity } = await import('@/state/store');
const { ConnectCard } = await import('@/ui/ConnectCard');

beforeEach(() => {
  hosted.on = true;
  useCity.setState({ backendKind: 'server', backendStatus: 'connected', account: { linked: false } });
});
afterEach(cleanup);

describe('ConnectCard', () => {
  it('a signed-in hosted player with no account linked: one button that opens Deploy', () => {
    const openTab = vi.fn();
    render(<ConnectCard openTab={openTab} />);
    expect(screen.getByRole('heading', { name: 'Connect your AWS account' })).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Connect it (opens Deploy)' });
    // The City tab keeps one primary button (the next action).
    expect(button.className).not.toContain('primary');
    fireEvent.click(button);
    expect(openTab).toHaveBeenCalledWith('deploy');
  });

  it('nothing for a linked account, a signed-out player, the demo or the local server', () => {
    const none = () => render(<ConnectCard openTab={() => {}} />).container.innerHTML;
    useCity.setState({ account: { linked: true, accountId: '111122223333' } });
    expect(none()).toBe('');
    cleanup();
    useCity.setState({ account: { linked: false }, backendStatus: 'signed-out' });
    expect(none()).toBe('');
    cleanup();
    useCity.setState({ backendStatus: 'connected', backendKind: 'mock' });
    expect(none()).toBe('');
    cleanup();
    useCity.setState({ backendKind: 'server' });
    hosted.on = false; // the local server: no Cognito, nothing to link
    expect(none()).toBe('');
  });
});
