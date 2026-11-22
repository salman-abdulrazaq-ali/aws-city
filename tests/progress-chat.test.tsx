// @vitest-environment jsdom
// Seen live, 21 Nov 2026: "Watch Eddie walk there" stayed up while he worked, a slow model looked like nothing was
// happening, a failed task said only "Something went wrong", and questions asked while an HQ answer was coming were
// refused and never answered. Each fix, rendered for real.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" />, agentColor: () => '#fff' }));
const asked: string[] = [];
const prompts: string[] = [];
vi.mock('@/app/runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  askDistrict: (districtId: string, q: string) => {
    asked.push(q);
    const requestId = `r${asked.length}`;
    useCity.getState().addUserChat(districtId, requestId, q);
    return requestId;
  },
  submitPrompt: (p: string) => void prompts.push(p),
}));

// jsdom has neither: the chat scrolls to its newest line and its chip row measures itself.
Element.prototype.scrollIntoView = () => undefined;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const { useCity } = await import('@/state/store');
const { failedReason, thinkingLine, watchLine } = await import('@/state/watch');
const { TaskCard } = await import('@/ui/ActivityFeed');
const { ChatPanel } = await import('@/ui/ChatPanel');
const send = (e: Parameters<ReturnType<typeof useCity.getState>['applyServerEvent']>[0]) => act(() => useCity.getState().applyServerEvent(e));

beforeEach(() => {
  asked.length = 0;
  prompts.length = 0;
  useCity.setState({ backendKind: 'server', backendStatus: 'connected', tasks: {}, taskOrder: [], chats: {}, chatQueue: {}, agents: {} });
});
afterEach(cleanup);

describe('a task says where it is', () => {
  it('walking, then at work; "thinking" while its model call runs; a failure says why', () => {
    expect(watchLine({ steps: [{ text: 'Heading to EC2 Factory', status: 'running' }] }, 'Eddie')).toBe('Watch Eddie walk there.');
    expect(watchLine({ steps: [{ text: 'Arrived', status: 'done' }, { text: 'Launch', status: 'pending' }] }, 'Eddie')).toBe('Eddie is there and on it.');
    expect(thinkingLine({ state: 'working', service: 'bedrock', detail: 'InvokeModel — thinking' }, 'Eddie')).toMatch(/Eddie is thinking… this can take up to a minute/);
    expect(thinkingLine({ state: 'working', service: 'ec2', detail: 'RunInstances — Launch…' }, 'Eddie')).toBeUndefined();
    expect(failedReason('Task failed: The city’s AI took too long. Try again in a minute.')).toBe('The city’s AI took too long. Try again in a minute.');
  });

  it('a failed task shows the reason, stops its running step, and offers Try again with the same words', () => {
    useCity.getState().addTask('t1', 'Launch a server called web');
    send({ type: 'task.plan', taskId: 't1', agentId: 'ec2', targetServiceId: 'ec2', steps: ['Heading to EC2 Factory', 'Launch'] });
    send({ type: 'task.step', taskId: 't1', index: 0, text: 'Heading to EC2 Factory', status: 'running' });
    send({ type: 'error', taskId: 't1', message: 'Task failed: The city’s AI took too long (it may be busy with another request). Try again in a minute.' });
    const t = useCity.getState().tasks.t1!;
    expect(t).toMatchObject({ status: 'failed', result: expect.stringMatching(/^The city’s AI took too long/) });
    expect(t.steps[0]!.status).toBe('failed');
    render(<TaskCard task={t} />);
    expect(screen.getByText(/took too long/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(prompts).toEqual(['Launch a server called web']);
  });

  it('the hosted server’s AWS calls are listed (service + "Action — what"), its model calls are not', () => {
    useCity.getState().addTask('t2', 'Create a table called scores');
    send({ type: 'task.plan', taskId: 't2', agentId: 'dynamodb', targetServiceId: 'dynamodb', steps: ['Heading', 'Create'] });
    send({ type: 'agent.state', agentId: 'dynamodb', state: 'working', service: 'bedrock', detail: 'InvokeModel — thinking' });
    send({ type: 'agent.state', agentId: 'dynamodb', state: 'working', service: 'dynamodb', detail: 'CreateTable — Create DynamoDB table "city-scores"' });
    expect(useCity.getState().tasks.t2!.calls).toEqual(['dynamodb:CreateTable']);
  });
});

describe('HQ chat answers every question', () => {
  it('the answer bubble shows at once, thinking; a question asked meanwhile waits and goes when the answer is done', () => {
    render(<ChatPanel districtId="storage" />);
    const box = screen.getByRole('textbox', { name: 'Question' });
    fireEvent.change(box, { target: { value: 'What is EFS for?' } });
    fireEvent.submit(box.closest('form')!);
    expect(asked).toEqual(['What is EFS for?']);
    expect(screen.getByText('Thinking… this can take up to a minute.')).toBeTruthy();
    fireEvent.change(box, { target: { value: 'And S3?' } });
    fireEvent.submit(box.closest('form')!);
    expect(asked).toEqual(['What is EFS for?']); // waits its turn
    expect(screen.getByText(/· next/)).toBeTruthy();
    send({ type: 'chat.answer', requestId: 'r1', districtId: 'storage', agentId: 'efs', delta: 'EFS is shared file storage.', done: false });
    send({ type: 'chat.answer', requestId: 'r1', districtId: 'storage', agentId: 'efs', delta: '', done: true });
    expect(asked).toEqual(['What is EFS for?', 'And S3?']);
    // The first answer is one bubble, named for the agent who answered.
    expect(useCity.getState().chats.storage!.filter((m) => m.id === 'a-r1')).toEqual([expect.objectContaining({ agentId: 'efs', text: 'EFS is shared file storage.', pending: false })]);
  });
});
