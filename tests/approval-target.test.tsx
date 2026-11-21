// @vitest-environment jsdom
// v2.18: every approval card says exactly where it writes, "Changes AWS account 0474-6343-8585 · us-west-2", so a player
// who linked another account (or Region) sees which one before pressing Approve.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

const { useCity } = await import('@/state/store');
const { ChangeTarget, accountLabel } = await import('@/ui/DeployPanel');

afterEach(cleanup);

describe('the approval card names the account and Region', () => {
  it('deploy.preview carries accountId into the Deploy tab’s card', () => {
    useCity.getState().applyServerEvent({ type: 'deploy.preview', deployId: 'a-1', taskId: 't', templateId: 'create_bucket', stackName: 'Create S3 bucket', region: 'us-west-2', accountId: '047463438585', changes: [] });
    const d = useCity.getState().deploys['a-1']!;
    expect(d).toMatchObject({ accountId: '047463438585', region: 'us-west-2' });
    render(<ChangeTarget d={d} />);
    expect(screen.getByText(/Changes AWS account/).textContent).toBe('Changes AWS account 0474-6343-8585 · us-west-2');
  });

  it('nothing before an account is linked (an older server sends no accountId)', () => {
    expect(render(<ChangeTarget d={{ region: 'us-west-2' }} />).container.innerHTML).toBe('');
  });

  it('accountLabel groups 12 digits the way the AWS console does, and leaves anything else alone', () => {
    expect(accountLabel('047463438585')).toBe('0474-6343-8585');
    expect(accountLabel('not-linked')).toBe('not-linked');
  });
});
