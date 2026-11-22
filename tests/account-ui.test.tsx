// @vitest-environment jsdom
// Finding the account card (v2.19): ⋯ → Account on the hosted server (connect, download, sign out, delete with a confirm),
// the To-do row and the shift's line for a signed-in player with no working link, and City care saying up front when the
// player's role doesn't allow fixes.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Progress } from '@/backend/contract';

vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));
const rt = vi.hoisted(() => ({ signOut: vi.fn(), signIn: vi.fn(), downloadMyData: vi.fn(async () => {}), deleteAccount: vi.fn(async () => {}), fixFinding: vi.fn(), openPrivacyPolicy: vi.fn(), reconnect: vi.fn() }));
const privacy = vi.hoisted(() => ({ url: undefined as string | undefined }));
vi.mock('@/app/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/runtime')>()),
  ...rt,
  canSignIn: () => true,
  canDownloadData: () => true,
  canDeleteAccount: () => true,
  canReconnect: () => true,
  privacyPolicyUrl: () => privacy.url,
}));

const { useCity } = await import('@/state/store');
const { Hud, SyncNote } = await import('@/ui/Hud');
const { NOT_SAVED_LINE, SERVER_UPDATING_LINE, UPDATE_EXTENSION_LINE } = await import('@/ui/logic');
const { Home } = await import('@/ui/Home');
const { FindingCard } = await import('@/ui/FindingCard');
const { bus } = await import('@/state/bus');
const { cardsFor } = await import('@/world/content');
const { demoFindings } = await import('@/backend/mockAccount');

const REGION = 'us-west-2';
const player = (): Progress => ({
  version: 2,
  landmarks: {},
  updatedAt: '',
  cards: Object.fromEntries(cardsFor('s3').slice(0, 2).map((c) => [c.id, { interval: 3, ease: 2.5, due: Date.now() + 3 * 86_400_000, reps: 1 }])),
  cities: { [REGION]: { landmarks: { s3: { discovered: true, xp: 40 } } } },
});

beforeEach(() => {
  localStorage.clear();
  privacy.url = undefined;
  for (const f of Object.values(rt)) f.mockClear();
  useCity.setState({
    cityRegion: REGION,
    view: { name: 'city' },
    backendKind: 'server',
    backendStatus: 'connected',
    saveRefused: false,
    hosted: true,
    progress: player(),
    today: undefined,
    tasks: {},
    taskOrder: [],
    toasts: [],
    deploys: {},
    inventory: undefined,
    account: { linked: false },
    collectionOpen: false,
    careReleased: false,
    findings: {},
    findingOpen: undefined,
    prefs: { chatter: false, stage: 'compact', region: REGION },
  } as never);
});
afterEach(() => cleanup());

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'More' }));

describe('⋯ → Account (the hosted server)', () => {
  it('has the AWS account, Download my data, Sign out and Delete my account; the account item opens Deploy with the steps unfolded', () => {
    const shown: string[] = [];
    const off = bus.on('showTab', ({ tab }) => shown.push(tab));
    render(<Hud layout="panel" />);
    openMenu();
    const menu = screen.getByRole('menu');
    expect(within(menu).getByText('Account')).toBeTruthy();
    for (const name of ['Download my data', 'Sign out', 'Delete my account…']) expect(within(menu).getByRole('menuitem', { name })).toBeTruthy();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Connect your AWS account/ }));
    expect(shown).toEqual(['deploy']);
    expect(useCity.getState().account.wantsLink).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Download my data' }));
    expect(rt.downloadMyData).toHaveBeenCalledOnce();
    off();
  });

  it('a linked player reads "Your AWS account"; signed out, the section is just Sign in', () => {
    useCity.setState({ account: { linked: true, accountId: '111122223333', region: 'eu-west-1' } });
    const { unmount } = render(<Hud layout="panel" />);
    openMenu();
    expect(screen.getByRole('menuitem', { name: /Your AWS account/ })).toBeTruthy();
    unmount();
    useCity.setState({ backendStatus: 'signed-out', account: { linked: false } });
    render(<Hud layout="panel" />);
    openMenu();
    const menu = screen.getByRole('menu');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Sign in' }));
    expect(rt.signIn).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();
  });

  it('Delete my account… asks first in a dialog, and warns while the city’s builds still bill', () => {
    useCity.setState({
      account: { linked: true, accountId: '111122223333', region: 'eu-west-1' },
      inventory: {
        takenAt: '',
        region: 'eu-west-1',
        source: 'tagging',
        complete: true,
        counts: {},
        truncated: false,
        items: [{ arn: 'arn:aws:s3:::aws-city-site', type: 's3', name: 'aws-city-site', serviceId: 's3', districtId: 'storage', managedByGame: true }],
      },
    });
    render(<Hud layout="panel" />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete my account…' }));
    const ask = screen.getByRole('alertdialog', { name: /Delete your account and saved progress/ });
    expect(ask.textContent).toMatch(/still in your AWS account, and they keep billing/);
    expect(document.activeElement?.textContent).toBe('Keep it');
    fireEvent.click(within(ask).getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(rt.deleteAccount).not.toHaveBeenCalled();
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete my account…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(rt.deleteAccount).toHaveBeenCalledOnce();
  });

  it('the demo and the local server have no Account section', () => {
    useCity.setState({ hosted: false });
    render(<Hud layout="panel" />);
    openMenu();
    expect(within(screen.getByRole('menu')).queryByText('Account')).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Connect your AWS account/ })).toBeNull();
  });
});

describe('⋯ → Account: the privacy policy (WXT_PRIVACY_URL)', () => {
  it('is listed signed in and signed out when the build has its address, and opens it; absent without one', () => {
    privacy.url = 'https://city.example.com/privacy';
    const { unmount } = render(<Hud layout="panel" />);
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Privacy policy ↗' }));
    expect(rt.openPrivacyPolicy).toHaveBeenCalledOnce();
    act(() => useCity.setState({ backendStatus: 'signed-out' }));
    openMenu();
    expect(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Privacy policy ↗' })).toBeTruthy();
    unmount();
    privacy.url = undefined;
    render(<Hud layout="panel" />);
    openMenu();
    expect(screen.queryByRole('menuitem', { name: /Privacy policy/ })).toBeNull();
  });

  it('the address is used only when it is a plain https one', async () => {
    const { privacyPolicyUrl } = await vi.importActual<typeof import('@/app/runtime')>('@/app/runtime');
    expect(privacyPolicyUrl('https://city.example.com/privacy')).toBe('https://city.example.com/privacy');
    for (const bad of [undefined, '', 'http://city.example.com/p', 'javascript:alert(1)', 'https://u:p@city.example.com/p', 'city.example.com/p'])
      expect(privacyPolicyUrl(bad), String(bad)).toBeUndefined();
  });
});

describe('saving, said calmly (the version handshake and refused saves)', () => {
  const both = () => render(<><Hud layout="full" /><SyncNote /></>);

  it('a server being updated: the pill says so in amber words, one calm line, no Retry, never Offline', () => {
    useCity.setState({ backendStatus: 'updating' });
    both();
    expect(screen.getByText(SERVER_UPDATING_LINE)).toBeTruthy();
    expect(screen.getByText('Server updating').closest('.dot')?.className).toMatch(/(^| )updating( |$)/);
    expect(screen.queryByText('Offline')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('an extension too old for its server: “update the extension”', () => {
    useCity.setState({ backendStatus: 'outdated' });
    both();
    expect(screen.getByText(UPDATE_EXTENSION_LINE)).toBeTruthy();
    expect(screen.getByText('Update needed')).toBeTruthy();
  });

  it('a refused save: “Not saved to your account”, while still Connected, until a save goes through', () => {
    useCity.setState({ saveRefused: true });
    both();
    expect(screen.getByText(NOT_SAVED_LINE)).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    act(() => useCity.getState().setSaveRefused(false));
    expect(screen.queryByText(NOT_SAVED_LINE)).toBeNull();
  });

  it('nothing to say: no line (and none on the demo)', () => {
    const { container, unmount } = render(<SyncNote />);
    expect(container.textContent).toBe('');
    unmount();
    useCity.setState({ backendKind: 'mock', backendStatus: 'updating', saveRefused: true });
    expect(render(<SyncNote />).container.textContent).toBe('');
  });
});

describe('the To-do list and the shift offer the account', () => {
  it('Simple: one quiet row (not the primary button) that opens Deploy with the steps unfolded', () => {
    const opened: string[] = [];
    render(<Home openTab={(t) => opened.push(t)} />);
    const row = screen.getByRole('button', { name: /Connect your AWS account/ });
    expect(row.className).not.toMatch(/primary/);
    expect(row.textContent).toMatch(/\(opens Deploy\)/);
    expect(screen.getAllByRole('button').filter((b) => b.className.includes('primary'))).toHaveLength(1);
    fireEvent.click(row);
    expect(opened).toEqual(['deploy']);
    expect(useCity.getState().account.wantsLink).toBe(true);
  });

  it('a broken link: "Link it again"; linked, the demo or signed out: no row', () => {
    useCity.setState({ account: { linked: false, broken: true } });
    const { unmount } = render(<Home openTab={() => {}} />);
    expect(screen.getByRole('button', { name: /Link it again/ })).toBeTruthy();
    unmount();
    for (const s of [{ account: { linked: true } }, { hosted: false }, { backendStatus: 'signed-out' as const }]) {
      useCity.setState({ account: { linked: false }, hosted: true, backendStatus: 'connected', ...s });
      const { unmount: u } = render(<Home openTab={() => {}} />);
      expect(screen.queryByRole('button', { name: /Connect your AWS account|Link it again/ })).toBeNull();
      u();
    }
  });

  it('Everything: the shift has a small line beside its one primary button', () => {
    useCity.setState({ prefs: { chatter: false, stage: 'compact', region: REGION, simple: false } });
    const opened: string[] = [];
    render(<Home openTab={(t) => opened.push(t)} />);
    const line = screen.getByRole('region', { name: 'Your AWS account' });
    const btn = within(line).getByRole('button', { name: /Connect your AWS account/ });
    expect(btn.className).not.toMatch(/primary/);
    fireEvent.click(btn);
    expect(opened).toEqual(['deploy']);
  });
});

describe('City care when the role doesn’t allow fixes', () => {
  it('says so up front, with how to turn them on, instead of a Fix button that would walk through approve and MFA', () => {
    const f = demoFindings().find((x) => !!x.fix)!;
    // A citizen at the level the fix needs, so only the role stands in the way.
    useCity.setState({
      account: { linked: true, accountId: '111122223333', region: 'eu-west-1', fixes: false },
      progress: { ...player(), citizens: { [f.citizenId]: { xp: 10_000 } } } as Progress,
      findings: { [f.id]: { ...f, seenAt: 1 } },
      findingOpen: f.id,
    });
    render(<FindingCard openTab={() => {}} />);
    const note = screen.getByRole('note');
    expect(note.textContent).toMatch(/Fixes are off for your AWS City role/);
    expect(within(note).getByRole('list', { name: 'Turn small fixes on' }).textContent).toMatch(/AllowFixes to true/);
    expect(within(note).getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Fix/ })).toBeNull();
    act(() => useCity.setState({ account: { linked: true, accountId: '111122223333', region: 'eu-west-1', fixes: true } }));
    expect(screen.queryByRole('note')).toBeNull();
    expect(screen.getByRole('button', { name: /^Fix/ })).toBeTruthy();
  });

  it('on the local server it says how to restart with fixes on, never CloudFormation or Check again', () => {
    const f = demoFindings().find((x) => !!x.fix)!;
    useCity.setState({
      hosted: false,
      account: { linked: true, accountId: '111122223333', region: 'eu-west-1', fixes: false },
      progress: { ...player(), citizens: { [f.citizenId]: { xp: 10_000 } } } as Progress,
      findings: { [f.id]: { ...f, seenAt: 1 } },
      findingOpen: f.id,
    });
    render(<FindingCard openTab={() => {}} />);
    const note = screen.getByRole('note');
    expect(note.textContent).not.toMatch(/CloudFormation/);
    expect(within(note).getByText('npm run live -- --allow-fixes')).toBeTruthy();
    expect(within(note).queryByRole('button', { name: 'Check again' })).toBeNull();
    expect(within(note).queryByRole('list')).toBeNull();
  });
});
