// @vitest-environment jsdom
// The Deploy tab's account cards: the authenticator setup whenever the server asks, "Your data" for signed-in players,
// and (v2.17) linking in the Region the player picks, the console's checklist, Allow small fixes, the linked card's
// Disconnect / another Region / role update, a broken link, My builds with "Take it down", and typed build approvals.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '@/backend/contract';

const hosted = { on: true };
const rt = vi.hoisted(() => ({
  linkAccount: vi.fn((..._a: unknown[]) => 'r-link'),
  unlinkAccount: vi.fn(() => 'r-unlink'),
  removeResource: vi.fn((..._a: unknown[]) => 'r-remove'),
  decideDeploy: vi.fn(),
  verifyAccount: vi.fn((..._a: unknown[]) => 'r-verify'),
  recheckAccount: vi.fn(() => 'r-check'),
  confirmRoleUpdate: vi.fn(() => 'r-updated'),
  openUrl: vi.fn(),
  deleteAccount: vi.fn(async () => {}),
  openPrivacyPolicy: vi.fn(),
}));
const privacy = vi.hoisted(() => ({ url: undefined as string | undefined }));
vi.mock('@/app/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/runtime')>()),
  ...rt,
  canSetUpMfa: () => true,
  canDeleteAccount: () => hosted.on,
  canDownloadData: () => hosted.on,
  mfaStatus: async () => 'on' as const,
  privacyPolicyUrl: () => privacy.url,
}));

const { useCity } = await import('@/state/store');
const { DeployPanel } = await import('@/ui/DeployPanel');
const { stacksUrl } = await import('@/state/account');

const item = (arn: string, name: string, serviceId: string | null, managedByGame = true): InventoryItem => ({ arn, type: 'x', name, serviceId, districtId: null, managedByGame, region: 'eu-west-1' });
const linked = { linked: true, accountId: '111122223333', region: 'eu-west-1' };

beforeEach(() => {
  hosted.on = true;
  privacy.url = undefined;
  for (const f of Object.values(rt)) f.mockClear();
  useCity.setState({ backendKind: 'server', backendStatus: 'connected', hosted: true, deploys: {}, inventory: undefined, cityRegion: 'eu-west-2', account: { linked: false }, toasts: [] });
});
afterEach(() => cleanup());

describe('the Deploy tab’s account cards', () => {
  it('the sign-in card links the privacy policy when the build has its address (WXT_PRIVACY_URL)', () => {
    useCity.setState({ backendStatus: 'signed-out' });
    const { unmount } = render(<DeployPanel />);
    expect(screen.getByText('Sign in to your AWS City account')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Privacy policy/ })).toBeNull();
    unmount();
    privacy.url = 'https://city.example.com/privacy';
    render(<DeployPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Privacy policy ↗' }));
    expect(rt.openPrivacyPolicy).toHaveBeenCalledOnce();
  });

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
    expect(screen.queryByRole('button', { name: /Download my data/ })).toBeNull();
  });
});

describe('linking (v2.17)', () => {
  it('step 1 picks the Region by name, starting on this city’s, and says where the key is made', () => {
    useCity.setState({ account: { linked: false, wantsLink: true } });
    render(<DeployPanel />);
    const select = screen.getByLabelText('Region') as HTMLSelectElement;
    expect(select.value).toBe('eu-west-2');
    expect(within(select).getByRole('option', { name: /US West \(Oregon\) · us-west-2/ })).toBeTruthy();
    expect(within(select).queryByRole('option', { name: /GovCloud/ })).toBeNull();
    expect(screen.getByText(/Your key will be made in/).textContent).toMatch(/Europe \(London\); the city reads that/);
    fireEvent.change(select, { target: { value: 'ap-southeast-2' } });
    expect(screen.getByText(/Your key will be made in/).textContent).toMatch(/Asia Pacific \(Sydney\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Get my setup link' }));
    expect(rt.linkAccount).toHaveBeenCalledWith('ap-southeast-2', { allowFixes: false });
  });

  it('starts on the Region asked for last (a link that broke: its own Region)', () => {
    useCity.setState({ account: { linked: false, wantsLink: true, linkRegion: 'ap-south-1' } });
    render(<DeployPanel />);
    expect((screen.getByLabelText('Region') as HTMLSelectElement).value).toBe('ap-south-1');
  });

  it('step 2 lists what the console asks and offers Allow small fixes (a new link is made for it)', () => {
    useCity.setState({ account: { linked: false, linkUrl: 'https://eu-west-1.console.aws.amazon.com/cloudformation/home', externalId: 'ext', linkRegion: 'eu-west-1' } });
    render(<DeployPanel />);
    const list = screen.getByRole('list', { name: 'What the console will ask' });
    expect(list.textContent).toMatch(/Europe \(Ireland\).*IAM roles and CloudFormation stacks.*workshop accounts.*IAM resources with custom names.*CREATE_COMPLETE.*Verify/);
    expect(screen.getByText(/Get your setup link: Europe \(Ireland\)/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Allow small fixes (you still approve each one)'));
    expect(rt.linkAccount).toHaveBeenCalledWith('eu-west-1', { allowFixes: true });
    // The new link is on its way: CloudFormation waits for it.
    expect((screen.getByRole('button', { name: /Making your link/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('the welcome’s "connect" hint is a muted line; only a refusal (a failed verify, a stale link) is an alert, with a new link', () => {
    useCity.setState({ account: { linked: false, message: 'Connect your AWS account to let agents build for real.' } });
    const { unmount } = render(<DeployPanel />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/Connect your AWS account to let agents build for real/).className).toMatch(/muted/);
    unmount();
    useCity.setState({
      account: { linked: false, linkUrl: 'https://eu-west-1.console.aws.amazon.com/x', linkRegion: 'eu-west-1', error: 'Your setup link is more than a day old, so I won’t use it.' },
    });
    render(<DeployPanel />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/more than a day old/);
    fireEvent.click(within(alert).getByRole('button', { name: 'Get a new setup link' }));
    expect(rt.linkAccount).toHaveBeenCalledWith('eu-west-1', { allowFixes: false });
  });

  it('step 2 says who the stack serves (ConnectsPlayer) and that the link works for a day', () => {
    useCity.setState({
      account: {
        linked: false,
        linkRegion: 'eu-west-1',
        linkUrl: 'https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/quickcreate?stackName=AWSCity&param_ConnectsPlayer=Brave%20Otter',
      },
    });
    const { container } = render(<DeployPanel />);
    expect(container.querySelector('.connects-player')!.textContent).toBe('The stack page will say ConnectsPlayer: Brave Otter. Don’t create the stack if that isn’t you.');
    expect(screen.getByText(/This link works for a day/)).toBeTruthy();
  });
});

describe('a linked account (v2.17)', () => {
  it('shows its Region by name, and "Use another Region or account" starts again with the Region picker', () => {
    useCity.setState({ account: { ...linked } });
    render(<DeployPanel />);
    expect(screen.getByText('111122223333').closest('p')!.textContent).toMatch(/Europe \(Ireland\).*eu-west-1/);
    expect(screen.queryByLabelText('Region')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Use another Region or account' }));
    expect((screen.getByLabelText('Region') as HTMLSelectElement).value).toBe('eu-west-1');
    fireEvent.click(screen.getByRole('button', { name: 'Keep the account I have' }));
    expect(screen.queryByLabelText('Region')).toBeNull();
  });

  it('Disconnect asks first, then sends account.unlink; afterwards it says how to delete the stack in that Region', () => {
    useCity.setState({ account: { ...linked } });
    const { unmount } = render(<DeployPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const ask = screen.getByRole('alertdialog', { name: 'Disconnect your AWS account?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it linked' }));
    expect(rt.unlinkAccount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    expect(rt.unlinkAccount).toHaveBeenCalledOnce();
    unmount();
    useCity.setState({ account: { linked: false, stackLeft: 'eu-west-1' } });
    const { container } = render(<DeployPanel />);
    // Plain words: glossary terms inside it are their own buttons, so the note is read as a whole.
    expect(container.querySelector('.stack-left')!.textContent).toMatch(/Disconnected\. To remove AWS City's role too, delete the AWSCity stack in CloudFormation \(Europe \(Ireland\)\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Open the AWSCity stack ↗' }));
    expect(rt.openUrl).toHaveBeenCalledWith(stacksUrl('eu-west-1'));
  });

  it('the local server has no Disconnect (it reads the developer’s own account)', () => {
    useCity.setState({ hosted: false, account: { ...linked } });
    render(<DeployPanel />);
    expect(screen.queryByRole('button', { name: 'Disconnect' })).toBeNull();
  });

  it('an older role: "Update your AWS City role (v3 → v4)" with the steps, the template address and the stacks page', () => {
    useCity.setState({ account: { ...linked, roleVersion: 3, latestRoleVersion: 4, templateUrl: 'https://bucket.s3.amazonaws.com/player-role.yaml' } });
    render(<DeployPanel />);
    const box = screen.getByRole('region', { name: 'Update your AWS City role (v3 → v4)' });
    expect(within(box).getByRole('list').textContent).toMatch(/AWSCity stack.*Replace existing template.*ExternalId.*IAM resources.*UPDATE_COMPLETE/);
    expect(within(box).getByText('https://bucket.s3.amazonaws.com/player-role.yaml')).toBeTruthy();
    fireEvent.click(within(box).getByRole('button', { name: 'Open the AWSCity stack ↗' }));
    expect(rt.openUrl).toHaveBeenCalledWith(stacksUrl('eu-west-1'));
    // The newest role asks for ConnectsPlayer: the name comes with a fresh setup link.
    fireEvent.click(within(box).getByRole('button', { name: 'Get the ConnectsPlayer name to type' }));
    expect(rt.linkAccount).toHaveBeenCalledWith('eu-west-1');
    act(() => useCity.getState().patchAccount({ linkUrl: 'https://eu-west-1.console.aws.amazon.com/x#/stacks/quickcreate?param_ConnectsPlayer=Brave%20Otter' }));
    expect(within(box).getByText('Brave Otter').tagName).toBe('CODE');
    // The city can't read the stack's version: the player says the update is done (a fresh link, then a verify as updated).
    expect(within(box).getByText(/can’t read your stack for its version/)).toBeTruthy();
    expect(within(box).queryByRole('button', { name: 'Check again' })).toBeNull();
    fireEvent.click(within(box).getByRole('button', { name: 'I’ve updated the stack' }));
    expect(rt.confirmRoleUpdate).toHaveBeenCalledOnce();
    expect(rt.recheckAccount).not.toHaveBeenCalled();
    expect(within(box).getByRole('button', { name: /Checking/ })).toBeTruthy();
  });

  it('fixes off: the card says so, with how to turn them on (hosted: CloudFormation and Check again, a read-only recheck)', () => {
    useCity.setState({ account: { ...linked, fixes: false } });
    render(<DeployPanel />);
    expect(screen.getByText(/Small fixes:/).textContent).toMatch(/off/);
    expect(screen.getByText('Turn small fixes on')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Turn small fixes on' }).textContent).toMatch(/AllowFixes to true/);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(rt.recheckAccount).toHaveBeenCalledOnce();
    expect(rt.linkAccount).not.toHaveBeenCalled();
  });

  it('fixes off on the local server: the restart hint, never CloudFormation steps or Check again', () => {
    useCity.setState({ hosted: false, account: { ...linked, fixes: false } });
    render(<DeployPanel />);
    expect(screen.getByText('Turn small fixes on')).toBeTruthy();
    expect(screen.getByText('npm run live -- --allow-fixes').tagName).toBe('CODE');
    expect(screen.queryByRole('list', { name: 'Turn small fixes on' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('a broken link: its message with Link again and Disconnect, no alert storm', () => {
    useCity.setState({ account: { linked: false, broken: true, accountId: '111122223333', region: 'eu-west-1', message: 'I can’t use the AWSCity role in 111122223333 (eu-west-1) any more.' } });
    render(<DeployPanel />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/can’t use the AWSCity role/);
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Link again' }));
    // A new setup link in that Region at once (account.link clears the broken mark on the server).
    expect(rt.linkAccount).toHaveBeenCalledWith('eu-west-1', { allowFixes: false });
    expect((screen.getByLabelText('Region') as HTMLSelectElement).value).toBe('eu-west-1');
  });
});

describe('My builds and approvals (v2.17)', () => {
  const inventory = (items: InventoryItem[]) => ({ takenAt: '', region: 'eu-west-1', source: 'tagging' as const, complete: true, counts: {}, items, truncated: false, homeRegion: 'eu-west-1' });

  it('lists what the city built (from the inventory, so it survives a reload), each with Take it down', () => {
    useCity.setState({
      account: { ...linked },
      inventory: inventory([
        item('arn:aws:ec2:eu-west-1:111122223333:instance/i-0f9e8d7c6b5a40312', 'aws-city-quest-house', 'ec2'),
        item('arn:aws:dynamodb:eu-west-1:111122223333:table/city-orders', 'city-orders', 'dynamodb'),
        item('arn:aws:s3:::aws-city-site', 'aws-city-site', 's3'),
        item('arn:aws:lambda:eu-west-1:111122223333:function:hello', 'hello', 'lambda'),
        item('arn:aws:s3:::someone-elses', 'someone-elses', 's3', false),
      ]),
    });
    render(<DeployPanel />);
    const list = screen.getByRole('list', { name: 'Built by the city in your account' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    expect(within(list).getAllByRole('button', { name: 'Take it down' })).toHaveLength(3);
    expect(within(list).getByText(/Remove it in the AWS console/)).toBeTruthy();
    fireEvent.click(within(within(list).getByText('city-orders').closest('li')!).getByRole('button', { name: 'Take it down' }));
    expect(rt.removeResource).toHaveBeenCalledWith('table', 'city-orders');
  });

  it('a build preview shows its safety line in words and wants the name typed before Approve', () => {
    useCity.setState({
      account: { ...linked },
      deploys: {
        'a-1': {
          deployId: 'a-1',
          templateId: 'delete_table',
          stackName: 'Delete table city-orders',
          region: 'eu-west-1',
          status: 'preview',
          changes: [
            { action: 'Remove', logicalId: 'city-orders', resourceType: 'AWS::DynamoDB::Table' },
            { action: 'Modify', logicalId: 'Safety check: it holds data', resourceType: 'detail' },
          ],
          confirmText: 'city-orders',
        },
      },
    });
    render(<DeployPanel />);
    expect(screen.getByText('Safety check: it holds data').tagName).toBe('LI');
    const approve = screen.getByRole('button', { name: '✅ Approve & take down' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/To approve, type/), { target: { value: 'city-order' } });
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/To approve, type/), { target: { value: 'city-orders ' } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(rt.decideDeploy).toHaveBeenCalledWith('a-1', true, 'city-orders');
  });

  it('a practice build says it made nothing, and has no Tear down', () => {
    useCity.setState({
      account: { ...linked },
      deploys: { 'practice-1a2b': { deployId: 'practice-1a2b', templateId: 'hello-api', stackName: 'Hello API (practice)', region: 'practice', status: 'complete', changes: [] } },
    });
    render(<DeployPanel />);
    expect(screen.getByText(/practice: nothing was created/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Tear down/ })).toBeNull();
  });

  it('a preview with nothing to type approves at once', () => {
    useCity.setState({
      account: { ...linked },
      deploys: { 'a-2': { deployId: 'a-2', templateId: 'static-site', stackName: 'Static site', region: 'eu-west-1', status: 'preview', changes: [{ action: 'Add', logicalId: 'Site', resourceType: 'AWS::S3::Bucket' }] } },
    });
    render(<DeployPanel />);
    expect(screen.queryByLabelText(/To approve, type/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '✅ Approve & deploy' }));
    expect(rt.decideDeploy).toHaveBeenCalledWith('a-2', true, undefined);
  });

  it('Delete my account warns when what the city built is still billing', async () => {
    useCity.setState({ account: { ...linked }, inventory: inventory([item('arn:aws:ec2:eu-west-1:111122223333:instance/i-0f9e8d7c6b5a40312', 'aws-city-quest-house', 'ec2')]) });
    render(<DeployPanel />);
    await act(async () => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Delete my account' }));
    const ask = screen.getByRole('alertdialog', { name: /Delete your account and saved progress/ });
    expect(ask.textContent).toMatch(/One thing the city built is still in your AWS account, and they keep billing after this\. Take them down first/);
    fireEvent.click(within(ask).getByRole('button', { name: 'Yes, delete' }));
    expect(rt.deleteAccount).toHaveBeenCalledOnce();
  });
});
