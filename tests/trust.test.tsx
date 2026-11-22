// @vitest-environment jsdom
// Trust fixes (the Marcus, Dana and Hiroshi playtests, 22 Nov 2026): an approval can't happen by accident, every AI box
// warns against personal details, the linking copy says what the role really does (and links its exact template), and
// the demo's practice link rehearses the real one without ever pointing at the real console.
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@/backend/contract';

const rt = vi.hoisted(() => ({
  linkAccount: vi.fn((..._a: unknown[]) => 'r-link'),
  verifyAccount: vi.fn((..._a: unknown[]) => 'r-verify'),
  decideDeploy: vi.fn(),
  openUrl: vi.fn(),
  askDistrict: vi.fn((..._a: unknown[]) => 'q1'),
  submitPrompt: vi.fn(),
  startConsoleCopilot: vi.fn(async () => 't1'),
}));
vi.mock('@/app/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/runtime')>()),
  ...rt,
  canSetUpMfa: () => false,
  canDeleteAccount: () => false,
  canDownloadData: () => false,
}));
vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span />, agentColor: () => '#fff' }));

const { useCity } = await import('@/state/store');
const { DeployPanel } = await import('@/ui/DeployPanel');
const { PromptBar } = await import('@/ui/PromptBar');
const { ChatPanel } = await import('@/ui/ChatPanel');
const { ExplainBack } = await import('@/ui/ExplainBack');
const { AI_NOTE } = await import('@/ui/AiNote');
const { QUESTS } = await import('@/world/content');
const { MockBackend, PRACTICE_LINK } = await import('@/backend/MockBackend');
const { connectsPlayer, FIX_GRANTS, templateLink } = await import('@/state/account');
const { redact } = await import('@/console/risk');
const { isSafeAwsUrl } = await import('@/app/runtime');

const linked = { linked: true, accountId: '111122223333', region: 'eu-west-1' };
const TEMPLATE = 'https://aws-city-templates.s3.eu-west-2.amazonaws.com/player-role-v5.yaml';
const quickCreate = (templateURL: string) =>
  `https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/quickcreate?templateURL=${encodeURIComponent(templateURL)}&stackName=AWSCity&param_ConnectsPlayer=Brave%20Otter`;

// jsdom has neither (the chat's chip row watches its width; its log scrolls to the newest line).
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;

beforeEach(() => {
  for (const f of Object.values(rt)) f.mockClear();
  useCity.setState({ backendKind: 'server', backendStatus: 'connected', hosted: true, deploys: {}, deployFocus: undefined, inventory: undefined, cityRegion: 'eu-west-2', account: { linked: false }, toasts: [] });
});
afterEach(() => cleanup());

describe('an approval can’t happen by accident', () => {
  it('a new removal preview takes focus on its heading, never Approve, and Approve waits for the typed name', () => {
    useCity.setState({ account: { ...linked } });
    const { container } = render(<DeployPanel />);
    act(() =>
      useCity.getState().applyServerEvent({
        type: 'deploy.preview',
        deployId: 'a-1',
        templateId: 'delete_table',
        stackName: 'Delete table city-orders',
        region: 'eu-west-1',
        changes: [{ action: 'Remove', logicalId: 'city-orders', resourceType: 'AWS::DynamoDB::Table' }],
        confirmText: 'city-orders',
      }),
    );
    const approve = screen.getByRole('button', { name: '✅ Approve & take down' }) as HTMLButtonElement;
    const focused = document.activeElement as HTMLElement;
    expect(focused).not.toBe(approve);
    expect(focused.tagName).not.toBe('BUTTON');
    expect(focused).toBe(container.querySelector('.card.stack.preview .stack-title'));
    // A stray Enter or Space where the focus landed approves nothing.
    fireEvent.keyDown(focused, { key: 'Enter' });
    fireEvent.keyDown(focused, { key: ' ' });
    expect(rt.decideDeploy).not.toHaveBeenCalled();
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/To approve, type/), { target: { value: 'city-orders' } });
    fireEvent.click(approve);
    expect(rt.decideDeploy).toHaveBeenCalledWith('a-1', true, 'city-orders');
  });
});

describe('every AI text box says where the words go', () => {
  const describedBy = (el: HTMLElement) => document.getElementById(el.getAttribute('aria-describedby') ?? '')?.textContent;

  it('the prompt bar and the Console Copilot box', () => {
    render(<PromptBar layout="panel" />);
    const box = screen.getByRole('textbox', { name: 'Ask the city' });
    expect(describedBy(box)).toBe(AI_NOTE);
    fireEvent.click(screen.getByRole('switch', { name: /Do it in my console/ }));
    expect(describedBy(screen.getByRole('textbox', { name: /What should the agent do in your console/ }))).toBe(AI_NOTE);
    expect(AI_NOTE).toMatch(/city’s AI.*personal details.*passwords, keys, your address/);
  });

  it('the HQ chat and Explain it back', () => {
    const { unmount } = render(<ChatPanel districtId="storage" />);
    expect(describedBy(screen.getByRole('textbox', { name: 'Question' }))).toBe(AI_NOTE);
    unmount();
    render(<ExplainBack quest={QUESTS[0]!} />);
    fireEvent.click(screen.getByRole('button', { name: /Explain it back/ }));
    expect(describedBy(screen.getByRole('textbox'))).toBe(AI_NOTE);
  });

  it('one shared line, also on a job’s Explain and a workshop’s pasted error', () => {
    for (const f of ['src/ui/PromptBar.tsx', 'src/ui/ChatPanel.tsx', 'src/ui/ExplainBack.tsx', 'src/ui/clients/ClientTask.tsx', 'src/ui/Workshop.tsx']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/<AiNote id=\{noteId\} \/>/);
      expect(src, f).toMatch(/aria-describedby=\{noteId\}/);
    }
  });
});

describe('the linking copy says what the role really does', () => {
  it('step 1: what the role can do, the account-wide reads, and the exact template once a link names it', () => {
    useCity.setState({ account: { linked: false, wantsLink: true } });
    const { container, unmount } = render(<DeployPanel />);
    const can = container.querySelector('details.role-can')!;
    expect(within(can as HTMLElement).getByText('What the role can do')).toBeTruthy();
    expect(can.textContent).toMatch(/account-wide: the list of all your buckets, the Availability Zones of every Region/);
    expect(can.textContent).toMatch(/allows that read at any time, but AWS City’s server reads it only after you turn the bill on/);
    expect(can.textContent).toMatch(/Never: IAM, billing settings or passing roles/);
    // No link yet: nothing to open.
    expect(screen.queryByRole('link', { name: /See the exact permissions/ })).toBeNull();
    expect(container.textContent).not.toMatch(/only the quest services|a key that only opens|secret only AWS City knows|safe key/);
    unmount();
    // account.status names the template (hosted, once known): linked straight to it.
    useCity.setState({ account: { linked: false, wantsLink: true, templateUrl: TEMPLATE } });
    render(<DeployPanel />);
    expect(screen.getByRole('link', { name: 'See the exact permissions ↗' }).getAttribute('href')).toBe(TEMPLATE);
  });

  it('step 2: what small fixes allow and who holds them to tightening; the ExternalId isn’t called a secret', () => {
    useCity.setState({ account: { linked: false, linkRegion: 'eu-west-1', linkUrl: quickCreate(TEMPLATE), externalId: 'ext-1234567890abcdef' } });
    const { container } = render(<DeployPanel />);
    const fixes = container.querySelector('details.fix-grants')!;
    expect(within(fixes as HTMLElement).getByText('What small fixes allow')).toBeTruthy();
    expect(fixes.querySelectorAll('li')).toHaveLength(FIX_GRANTS.length);
    expect(fixes.textContent).toMatch(/Block Public Access on any bucket.*inbound rule from any security group.*point-in-time recovery on any table.*IMDSv2.*EBS encryption by default/);
    expect(fixes.textContent).toMatch(/AWS City’s server holds those to tightening/);
    // The template the setup link carries.
    expect(screen.getByRole('link', { name: 'See the exact permissions ↗' }).getAttribute('href')).toBe(TEMPLATE);
    expect(container.textContent).toMatch(/ExternalId: ext-1234567890abcdef\. It ties the role to your AWS City sign-in.*isn’t a password: AWS doesn’t treat it as a secret/);
    expect(container.textContent).not.toMatch(/a key that only opens|secret only AWS City knows/);
  });

  it('templateLink: account.status’s address, else the setup link’s, only an https AWS host', () => {
    expect(templateLink({ templateUrl: TEMPLATE })).toBe(TEMPLATE);
    expect(templateLink({ linkUrl: quickCreate(TEMPLATE) })).toBe(TEMPLATE);
    expect(templateLink({ linkUrl: quickCreate('https://evil.example.com/player-role.yaml') })).toBeUndefined();
    expect(templateLink({ templateUrl: 'http://bucket.s3.amazonaws.com/x.yaml' })).toBeUndefined();
    expect(templateLink({ templateUrl: 'https://user:pw@bucket.s3.amazonaws.com/x.yaml' })).toBeUndefined();
    expect(templateLink({ linkUrl: 'not a url' })).toBeUndefined();
    expect(templateLink({})).toBeUndefined();
  });

  it('the demo’s explanations say it too', () => {
    useCity.setState({ backendKind: 'mock', hosted: false });
    const { container } = render(<DeployPanel />);
    expect(container.textContent).toMatch(/a few reads cover your whole account/);
    expect(container.textContent).not.toMatch(/only the quest services|tags everything it makes|secret ExternalId/);
  });
});

describe('the practice link rehearses the real one', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const mock = () => {
    const m = new MockBackend({ speed: 200 });
    const events: ServerEvent[] = [];
    m.onEvent((e) => events.push(e));
    const last = <T extends ServerEvent['type']>(type: T) => events.filter((e): e is Extract<ServerEvent, { type: T }> => e.type === type).at(-1);
    return { m, events, last };
  };

  it('in the Region picked, AWSCity, ConnectsPlayer, small fixes off unless ticked, and never a console address', async () => {
    const { m, last } = mock();
    m.send({ action: 'account.link', requestId: 'l1', region: 'ap-northeast-1' });
    const url = last('account.linkUrl')!.url;
    expect(url.startsWith(PRACTICE_LINK)).toBe(true);
    expect(isSafeAwsUrl(url)).toBe(false); // openUrl would refuse it, and the Deploy tab doesn't offer it in the demo
    expect(url).not.toMatch(/console\.aws\.amazon\.com|example\.invalid|aws-city-player/);
    expect(url).toMatch(/stackName=AWSCity/);
    expect(url).not.toMatch(/AllowFixes/);
    expect(new URL(url).searchParams.get('region')).toBe('ap-northeast-1');
    expect(connectsPlayer(url)).toBe('Practice Mayor');
    m.send({ action: 'account.verify', requestId: 'v1', roleArn: '123456789012' });
    await sleep(20);
    expect(last('account.status')).toMatchObject({ requestId: 'v1', linked: true, region: 'ap-northeast-1', fixes: false });
    // Ticked: the link says so, and the practice role allows fixes.
    m.send({ action: 'account.link', requestId: 'l2', region: 'ap-northeast-1', allowFixes: true });
    expect(last('account.linkUrl')!.url).toMatch(/param_AllowFixes=true/);
    m.send({ action: 'account.verify', requestId: 'v2', roleArn: '123456789012' });
    await sleep(20);
    expect(last('account.status')).toMatchObject({ requestId: 'v2', region: 'ap-northeast-1', fixes: true });
    // Disconnected, it stays in that Region (so the Region picker doesn't jump back to Oregon).
    m.send({ action: 'account.unlink', requestId: 'u1' });
    await sleep(20);
    expect(last('account.status')).toMatchObject({ requestId: 'u1', linked: false, region: 'ap-northeast-1' });
  });

  it('“Use the practice account” links in this city’s own Region (named like the real role), not always Oregon', async () => {
    useCity.setState({ backendKind: 'mock', hosted: false, cityRegion: 'ap-northeast-1' });
    render(<DeployPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Use the practice account (nothing real)' }));
    const arn = rt.verifyAccount.mock.calls[0]![0] as string;
    expect(arn).toBe('arn:aws:iam::123456789012:role/AWSCityPlayerRole-ap-northeast-1');
    const { m, last } = mock();
    m.send({ action: 'account.verify', requestId: 'v', roleArn: arn });
    await sleep(20);
    // No practice link: the one-press practice account keeps small fixes on (the demo's City care fixes run with it).
    expect(last('account.status')).toMatchObject({ requestId: 'v', linked: true, region: 'ap-northeast-1', fixes: true });
  });

  it('in the demo, step 2 opens nothing; a practice account without fixes says how to get them, never the local server’s restart', () => {
    useCity.setState({ backendKind: 'mock', hosted: false, account: { linked: false, wantsLink: true, linkRegion: 'eu-west-1', linkUrl: `${PRACTICE_LINK}?region=eu-west-1#/stacks/quickcreate?stackName=AWSCity` } });
    const { unmount } = render(<DeployPanel />);
    expect(screen.queryByRole('button', { name: /Open CloudFormation/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy link/ })).toBeNull();
    expect(screen.getByText(/Practice: nothing opens here/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Done: it says CREATE_COMPLETE' })).toBeTruthy();
    unmount();
    useCity.setState({ account: { ...linked, fixes: false } });
    const { container } = render(<DeployPanel />);
    expect(container.textContent).toMatch(/Practice account: press Use another Region or account, tick Allow small fixes, then Verify again/);
    expect(container.textContent).not.toMatch(/local server/);
  });

  it('a take-down in the demo wants the name typed too: a wrong one changes nothing', async () => {
    const { m, events, last } = mock();
    m.send({ action: 'account.verify', requestId: 'v', roleArn: '123456789012' });
    await sleep(20);
    m.send({ action: 'resource.remove', requestId: 'r1', kind: 'table', id: 'city-quest-library' });
    await sleep(20);
    const preview = last('deploy.preview')!;
    expect(preview.confirmText).toBe('city-quest-library');
    m.send({ action: 'deploy.approve', deployId: preview.deployId });
    await sleep(20);
    expect(last('deploy.status')).toMatchObject({ deployId: preview.deployId, status: 'rejected' });
    expect(events.filter((e) => e.type === 'city.inventory').at(-1)!.items.some((i) => i.arn.endsWith('table/city-quest-library'))).toBe(true);
  });
});

describe('redact: access keys however they’re typed', () => {
  it('catches lowercase keys and keys typed in groups of four', () => {
    expect(redact('my key is akiaiosfodnn7example ok')).toBe('my key is [key] ok');
    expect(redact('key AKIA IOSF ODNN 7EXA MPLE here')).toBe('key [key] here');
    expect(redact('key AKIA-IOSF-ODNN-7EXA-MPLE here')).toBe('key [key] here');
    expect(redact('AKIAIOSFODNN7EXAMPLE')).toBe('[key]');
  });

  it('leaves ordinary words alone', () => {
    for (const t of ['Deploy in Asia Pacific (Tokyo)', 'my servers in Asia have some data from Europe', 'Aida asked about Asia', 'ASIA PACIFIC'])
      expect(redact(t), t).toBe(t);
  });

  it('keeps AWS managed policy names (a workshop step’s Copilot goal names one), still hides long tokens', () => {
    const goal = 'an operator role with the AWSLambdaManagedEC2ResourceOperator policy, or AmazonEC2ContainerServiceforEC2Role';
    expect(redact(goal)).toBe(goal);
    expect(redact('secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe('secret [token]');
  });
});
