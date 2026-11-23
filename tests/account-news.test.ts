// @vitest-environment jsdom
// Seen 23 Nov 2026: a bucket made in the console got Sally's "New in your account" line only as a bubble over S3 Lake,
// off screen, while the player was in the console tab. Now it's a toast too, and a toast waits while the page is hidden.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useCity } from '@/state/store';

const setVisibility = (state: 'hidden' | 'visible') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};
const shown = () => useCity.getState().toasts.filter((t) => !t.leaving).map((t) => t.text);
const NEWS = 'New in your account: bucket "test-demo-1". Buckets hold objects (files) by key.';

beforeEach(() => {
  useCity.getState().clearToasts();
  useCity.setState({ toasts: [], view: { name: 'city' }, celebration: undefined, workshopDone: undefined, clientDone: undefined });
});
afterEach(() => setVisibility('visible'));

describe('news of a change the player made in AWS', () => {
  it('is a toast from its agent: the first sentence, not the lesson', () => {
    useCity.getState().applyServerEvent({ type: 'agent.message', from: 's3', to: 'user', text: NEWS });
    expect(shown()).toEqual(['Sally the Angler: New in your account: bucket "test-demo-1".']);
  });

  it('waits while the page is hidden, and shows when the player is back', () => {
    setVisibility('hidden');
    useCity.getState().applyServerEvent({ type: 'agent.message', from: 's3', to: 'user', text: NEWS });
    expect(shown()).toEqual([]);
    setVisibility('visible');
    expect(shown()).toEqual(['Sally the Angler: New in your account: bucket "test-demo-1".']);
  });

  it('is never made of agents talking to each other, or an answer', () => {
    useCity.getState().applyServerEvent({ type: 'agent.message', from: 's3', to: 'iam', text: NEWS });
    useCity.getState().applyServerEvent({ type: 'agent.message', from: 's3', to: 'user', text: 'Your bucket is private.' });
    expect(shown()).toEqual([]);
  });
});
