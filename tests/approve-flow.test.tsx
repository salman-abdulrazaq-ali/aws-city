// @vitest-environment jsdom
// The approval card can't be missed (seen live, 21 Nov 2026: the player waited, not knowing a card was in Deploy):
// the task card says it's waiting and takes them there; from an HQ the city goes back out first; "My builds" folds a
// server's changes into one card whose Tear down asks in plain words.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" />, agentColor: () => '#fff' }));
const sent: string[] = [];
vi.mock('@/app/runtime', async (importOriginal) => ({ ...(await importOriginal<object>()), submitPrompt: (p: string) => void sent.push(p) }));

const { useCity } = await import('@/state/store');
const { TaskCard } = await import('@/ui/ActivityFeed');
const { DeployPanel } = await import('@/ui/DeployPanel');

const ID = 'i-03e06cc3ce2a69cfe';

beforeEach(() => {
  sent.length = 0;
  useCity.setState({ backendKind: 'server', backendStatus: 'connected', account: { linked: true, accountId: '047463438585', region: 'us-west-2' }, deploys: {}, deployFocus: undefined, view: { name: 'city' } });
});
afterEach(cleanup);

describe('Approve in Deploy', () => {
  it('a running task with a card waiting says so, and its button opens Deploy at that card (from an HQ too)', () => {
    useCity.getState().addTask('t1', 'Create a bucket called holiday-123');
    useCity.getState().applyServerEvent({ type: 'task.plan', taskId: 't1', agentId: 's3', targetServiceId: 's3', steps: ['Heading to S3 Lake', 'Create S3 bucket'] });
    useCity.getState().applyServerEvent({ type: 'deploy.preview', deployId: 'a-1', taskId: 't1', templateId: 'create_bucket', stackName: 'Create S3 bucket with suffix "holiday-123"', region: 'us-west-2', accountId: '047463438585', changes: [{ action: 'Add', logicalId: 'aws-city-047463438585-holiday-123', resourceType: 'AWS::S3::Bucket' }] });
    useCity.setState({ view: { name: 'interior', districtId: 'storage' }, deployFocus: undefined });
    const task = useCity.getState().tasks.t1!;
    render(<TaskCard task={task} />);
    expect(screen.getByText('⏳ Waiting for your Approve')).toBeTruthy();
    const seq = useCity.getState().deployOpenSeq;
    fireEvent.click(screen.getByRole('button', { name: 'Approve in Deploy →' }));
    expect(useCity.getState()).toMatchObject({ deployFocus: 'a-1', deployOpenSeq: seq + 1, view: { name: 'city' } });
  });

  it('a toast with an action does it when pressed', async () => {
    const { Toasts } = await import('@/ui/Toasts');
    const action = vi.fn();
    useCity.getState().clearToasts();
    useCity.getState().toast('🛡️', 'Your approval is waiting in Deploy. Tap here to open it.', 'info', undefined, undefined, { action });
    render(<Toasts />);
    fireEvent.click(screen.getByTitle('Open'));
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('My builds: one card per resource', () => {
  it('launch then stop of one server is one card; Tear down sends "Terminate <id>"', () => {
    const s = useCity.getState();
    s.applyServerEvent({ type: 'deploy.preview', deployId: 'a-1', templateId: 'launch_instance', stackName: 'Launch a t4g.micro EC2 instance named "web"', region: 'us-west-2', accountId: '047463438585', changes: [{ action: 'Add', logicalId: 'web', resourceType: 'AWS::EC2::Instance' }] });
    s.applyServerEvent({ type: 'deploy.status', deployId: 'a-1', status: 'complete', message: 'Launching', outputs: { Result: 'Launching', ResourceId: ID } });
    s.applyServerEvent({ type: 'deploy.preview', deployId: 'a-2', templateId: 'stop_instance', stackName: `Stop EC2 instance ${ID}`, region: 'us-west-2', accountId: '047463438585', changes: [{ action: 'Modify', logicalId: ID, resourceType: 'AWS::EC2::Instance' }] });
    s.applyServerEvent({ type: 'deploy.status', deployId: 'a-2', status: 'complete', message: 'Stopping' });
    const { container } = render(<DeployPanel />);
    const cards = container.querySelectorAll('.card.stack');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain(`Server web (${ID})`);
    expect(cards[0]!.textContent).toContain('stopped');
    expect(cards[0]!.textContent).toContain('built → stopped');
    fireEvent.click(screen.getByRole('button', { name: /Tear down \(remove it\)/ }));
    expect(sent).toEqual([`Terminate ${ID}`]);
  });
});
