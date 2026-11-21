// @vitest-environment jsdom
// Linking an AWS account, step by step, as a hosted player sees it: the authenticator first (a QR code to scan, the
// key as a fallback), and only then the three linking steps, one at a time, each saying what to click.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = { verify: [] as string[], open: [] as string[] };
const URI = 'otpauth://totp/AWS%20City?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=AWS%20City';
vi.mock('@/app/runtime', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  canSetUpMfa: () => true,
  startMfaSetup: async () => ({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', uri: URI }),
  verifyAccount: (arn: string) => (calls.verify.push(arn), 'req-1'),
  openUrl: (url: string) => calls.open.push(url),
  linkAccount: () => 'req-0',
}));

const { useCity } = await import('@/state/store');
const { DeployPanel, accountInput, linkRegion } = await import('@/ui/DeployPanel');
const { QrCode, QR_BORDER } = await import('@/ui/QrCode');

beforeEach(() => {
  calls.verify = [];
  calls.open = [];
  useCity.setState({ backendKind: 'server', backendStatus: 'connected', account: { linked: false }, deploys: {} });
});
afterEach(cleanup);

describe('linking an AWS account, step by step', () => {
  it('the authenticator comes first: a QR code to scan, the key behind “Can’t scan it?”, and no linking steps yet', async () => {
    useCity.setState({ account: { linked: false, mfaRequired: true } });
    render(<DeployPanel />);
    expect(screen.getByText('🔐 First, protect your account')).toBeTruthy();
    expect(screen.queryByText('Get my setup link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set up an authenticator' }));
    const qr = await screen.findByRole('img', { name: 'QR code to add AWS City to your authenticator app' });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
    expect(screen.getByText('Can’t scan it? Type a key instead')).toBeTruthy();
    expect((screen.getByLabelText(/Enter a setup key/) as HTMLInputElement).value).toBe('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP');
    expect(screen.getByLabelText('Type the 6-digit code your app shows')).toBeTruthy();
  });

  it('then one step at a time: the account number opens once the stack is made, and a console-style id is accepted', () => {
    useCity.setState({ account: { linked: false, linkUrl: 'https://us-west-2.console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks/quickcreate?stackName=AWSCity', externalId: 'x' } });
    render(<DeployPanel />);
    expect(screen.getByText(/I acknowledge that AWS CloudFormation might create IAM resources with custom names/)).toBeTruthy();
    expect(screen.queryByLabelText('AWS account ID or role ARN')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open CloudFormation ↗' }));
    expect(calls.open).toEqual(['https://us-west-2.console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks/quickcreate?stackName=AWSCity']);
    // The Region the role must be made in, by name: it's the one AWS City will look in.
    expect(screen.getByText('US West (Oregon)')).toBeTruthy();
    // Signed in to AWS in another browser: the same link can be copied and opened there.
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByText('Signed in to AWS in another browser? Copy the link and open it there.')).toBeTruthy();
    // A host is told up front to use a different account from the one the city runs in.
    expect(screen.getByText(/Hosting AWS City yourself\? Use a different AWS account from the one it runs in/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done: it says CREATE_COMPLETE' }));
    const id = screen.getByLabelText('AWS account ID or role ARN');
    fireEvent.change(id, { target: { value: '0474-6343-8585' } });
    // One click, one check (a submit button inside the form used to send it twice).
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));
    expect(calls.verify).toEqual(['047463438585']);
    // Enter in the field submits the form: one more check.
    fireEvent.submit(id.closest('form')!);
    expect(calls.verify).toEqual(['047463438585', '047463438585']);
  });

  it('the setup link’s Region, by name (none when the link has no ?region=)', () => {
    expect(linkRegion('https://us-west-2.console.aws.amazon.com/cloudformation/home?region=us-west-2#/stacks/quickcreate?x=1')).toEqual({ code: 'us-west-2', name: 'US West (Oregon)' });
    expect(linkRegion('https://console.aws.amazon.com/cloudformation/home')).toBeUndefined();
    expect(linkRegion('not a url')).toBeUndefined();
    expect(linkRegion(undefined)).toBeUndefined();
  });

  it('account numbers lose the console’s dashes and spaces; a role ARN is kept as typed', () => {
    expect(accountInput(' 1234-5678-9012 ')).toBe('123456789012');
    expect(accountInput('1234 5678 9012')).toBe('123456789012');
    // A number copied from a sentence brings its full stop.
    expect(accountInput('047463438585.')).toBe('047463438585');
    expect(accountInput(' arn:aws:iam::123456789012:role/AWSCityPlayerRole-eu-west-2 ')).toBe('arn:aws:iam::123456789012:role/AWSCityPlayerRole-eu-west-2');
  });

  it('the QR code has the spec’s quiet zone and draws dark modules only', () => {
    const { container } = render(<QrCode text={URI} label="qr" />);
    const svg = container.querySelector('svg')!;
    const n = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    // Version 5 is 37 modules wide for this URI, plus the border on both sides.
    expect(n).toBe(37 + 2 * QR_BORDER);
    const d = svg.querySelector('path')!.getAttribute('d')!;
    const xs = [...d.matchAll(/M(\d+) (\d+)/g)].flatMap((m) => [Number(m[1]), Number(m[2])]);
    expect(Math.min(...xs)).toBe(QR_BORDER);
    expect(Math.max(...xs)).toBe(n - QR_BORDER - 1);
  });
});
