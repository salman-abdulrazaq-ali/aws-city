// Seen 23 Nov 2026: the console and CloudShell were still signed in to the city's own account, so a bucket made there
// never showed in My AWS (which reads the linked account). The city reads which account a console page is in and warns.
import { describe, expect, it } from 'vitest';
import { consoleAccount } from '@/console/consoleAccount';
import { accountName, accountTitle, switchRoleUrl } from '@/state/account';

const userInfo = (arn: string, times = 1) => {
  let v = JSON.stringify({ arn, alias: 'x', username: 'salman-admin', keybase: 'k', issuer: 'https://signin.aws.amazon.com/', signinType: 'PUBLIC' });
  for (let i = 0; i < times; i++) v = encodeURIComponent(v);
  return `noflush_awsc-locale=en; aws-userInfo=${v}; other=1`;
};

describe('which account a console page is signed in to', () => {
  it('a multi-session console names it in its host', () => {
    expect(consoleAccount('047463438585-abcd1234.us-west-2.console.aws.amazon.com', '')).toBe('047463438585');
  });
  it('otherwise the console’s aws-userInfo cookie names it: an IAM user, or a role after Switch role', () => {
    const host = 'us-west-2.console.aws.amazon.com';
    expect(consoleAccount(host, userInfo('arn:aws:iam::422929814205:user/salman-admin'))).toBe('422929814205');
    expect(consoleAccount(host, userInfo('arn:aws:iam::422929814205:user/salman-admin', 2))).toBe('422929814205');
    expect(consoleAccount(host, userInfo('arn:aws:sts::047463438585:assumed-role/OrganizationAccountAccessRole/salman-admin'))).toBe('047463438585');
  });
  it('anything it can’t read is unknown, so the city says nothing rather than guess', () => {
    const host = 'us-west-2.console.aws.amazon.com';
    expect(consoleAccount(host, '')).toBeUndefined();
    expect(consoleAccount(host, 'aws-userInfo=%7Bnot-json')).toBeUndefined();
    expect(consoleAccount(host, userInfo('not an arn'))).toBeUndefined();
  });
});

describe('Switch role into the linked account', () => {
  it('opens AWS’s Switch role page for that account and role, back to the console in its Region', () => {
    const url = new URL(switchRoleUrl('047463438585', 'us-west-2')!);
    expect(url.origin + url.pathname).toBe('https://signin.aws.amazon.com/switchrole');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      account: '047463438585',
      roleName: 'OrganizationAccountAccessRole',
      displayName: 'AWSCity-8585',
      redirect_uri: 'https://us-west-2.console.aws.amazon.com/console/home?region=us-west-2',
    });
    expect(new URL(switchRoleUrl('047463438585', undefined, 'Admin')!).searchParams.get('roleName')).toBe('Admin');
  });
  // Asked on 23 Nov 2026: say the account's name, not just its number; the same name the console shows after Switch role.
  it('names the linked account as the console does after Switch role, with its number', () => {
    expect(accountName('047463438585')).toBe('AWSCity-8585');
    expect(accountTitle('047463438585')).toBe('AWSCity-8585 (0474-6343-8585)');
    expect(new URL(switchRoleUrl('047463438585', 'us-west-2')!).searchParams.get('displayName')).toBe(accountName('047463438585'));
  });
  it('never for anything but a 12-digit account and a valid role name', () => {
    expect(switchRoleUrl('4746', 'us-west-2')).toBeUndefined();
    expect(switchRoleUrl('047463438585', 'us-west-2', 'bad role/x')).toBeUndefined();
  });
});
