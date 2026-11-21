// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { choose, findExact, findTarget, typeInto } from '@/console/act';
import { isSecretPage, PLAYER_ONLY_PAGES, playerOnlyPage, redact, redactConsoleUrl, SECRET_PAGES } from '@/console/risk';
import { isConsoleUrl, isRisky, mayAct } from '@/console/safety';
import { takeSnapshot } from '@/console/snapshot';

const S3_PAGE = `
  <h1>Create bucket</h1>
  <form>
    <fieldset><legend>General configuration</legend>
      <label for="name">Bucket name</label><input id="name" type="text" />
      <label for="region">AWS Region</label>
      <select id="region"><option value="us-west-2">US West (Oregon)</option><option value="eu-west-2">Europe (London)</option></select>
    </fieldset>
    <fieldset><legend>Block Public Access settings for this bucket</legend>
      <label><input type="checkbox" id="bpa" checked /> Block all public access</label>
    </fieldset>
    <label for="pw">Password</label><input id="pw" type="password" value="hunter2" />
    <input type="text" name="secretAccessKey" aria-label="Secret key" value="AKIA-SECRET" />
    <button type="submit">Create bucket</button>
    <button type="button">Delete bucket</button>
    <button type="button" hidden>Hidden thing</button>
  </form>`;

beforeEach(() => {
  document.body.innerHTML = S3_PAGE;
});

describe('console snapshot', () => {
  it('lists visible controls by accessible name, with section context', () => {
    const snap = takeSnapshot(document, { requireLayout: false });
    const names = snap.items.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(['Bucket name', 'AWS Region', 'Block all public access', 'Create bucket', 'Delete bucket']));
    expect(names).not.toContain('Hidden thing');
    expect(snap.heading).toBe('Create bucket');
    expect(snap.items.find((i) => i.name === 'Bucket name')?.context).toBe('General configuration');
    expect(snap.items.find((i) => i.name === 'Block all public access')).toMatchObject({ role: 'checkbox', checked: true });
  });

  it('never reads secret values', () => {
    const snap = takeSnapshot(document, { requireLayout: false });
    const json = JSON.stringify(snap);
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('AKIA-SECRET');
    expect(snap.items.find((i) => i.name === 'Password')).toMatchObject({ sensitive: true });
    expect(snap.items.find((i) => i.name === 'Secret key')).toMatchObject({ sensitive: true });
  });
});

describe('safety', () => {
  it('flags destructive, public, IAM-admin, credential and billing controls as risky', () => {
    for (const n of ['Delete bucket', 'Terminate instance', 'Empty', 'Attach policies', 'AdministratorAccess', 'Create access key', 'Billing preferences', 'Sign out'])
      expect(isRisky(n), n).toBe(true);
    for (const n of ['Create bucket', 'Next', 'Bucket name', 'Create table']) expect(isRisky(n), n).toBe(false);
  });

  it('mayAct refuses risky clicks and secret fields, allows safe ones', () => {
    const items = takeSnapshot(document, { requireLayout: false }).items;
    const by = (n: string) => items.find((i) => i.name === n);
    expect(mayAct(by('Delete bucket'), 'click')).toMatchObject({ ok: false, reason: 'risky' });
    expect(mayAct(by('Password'), 'type')).toMatchObject({ ok: false, reason: 'sensitive' });
    expect(mayAct(by('Create bucket'), 'click')).toEqual({ ok: true });
    expect(mayAct(undefined, 'click')).toMatchObject({ ok: false, reason: 'missing' });
  });

  it('only runs on real console pages, never sign-in or other sites', () => {
    expect(isConsoleUrl('https://eu-west-2.console.aws.amazon.com/s3/bucket/create')).toBe(true);
    expect(isConsoleUrl('https://signin.aws.amazon.com/oauth')).toBe(false);
    expect(isConsoleUrl('https://console.aws.amazon.com.evil.com/')).toBe(false);
    expect(isConsoleUrl('http://console.aws.amazon.com/')).toBe(false);
  });
});

describe('acting on the page', () => {
  it('finds targets by id or by name, and types so React forms notice', () => {
    const snap = takeSnapshot(document, { requireLayout: false });
    const nameItem = snap.items.find((i) => i.name === 'Bucket name')!;
    const el = findTarget(document, { id: nameItem.id, name: 'x' })!;
    const events: string[] = [];
    el.addEventListener('input', () => events.push('input'));
    el.addEventListener('change', () => events.push('change'));
    typeInto(el, 'aws-city-demo-123');
    expect((el as HTMLInputElement).value).toBe('aws-city-demo-123');
    expect(events).toEqual(['input', 'change']);
    expect(findTarget(document, { name: 'create bucket' })?.textContent).toBe('Create bucket');
  });

  it('refuses to type into secret fields', () => {
    takeSnapshot(document, { requireLayout: false });
    expect(() => typeInto(document.getElementById('pw')!, 'x')).toThrow(/secret/);
  });
});

describe('security hardening', () => {
  it('never sends typed values, and redacts account IDs, keys, emails and tokens from page text', () => {
    document.body.innerHTML = `<h1>Account 1234-5678-9012 · admin@example.com</h1>
      <label for="d">Description</label><input id="d" type="text" value="my private notes" />
      <button type="button">Use key AKIAIOSFODNN7EXAMPLE</button>`;
    const json = JSON.stringify(takeSnapshot(document, { requireLayout: false }));
    expect(json).not.toContain('my private notes');
    expect(json).toContain('(filled)');
    expect(json).not.toContain('1234-5678-9012');
    expect(json).not.toContain('admin@example.com');
    expect(json).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(redact('token abcdefghijklmnopqrstuvwxyz0123456789ABCD')).toBe('token [token]');
  });

  it('a multi-session console host loses its account id before the URL leaves the page, and still parses the same', () => {
    const raw = 'https://123456789012-abcd1234.us-east-1.console.aws.amazon.com/iam/home?region=us-east-1#/roles/details/x?arn=arn:aws:iam::123456789012:role/x';
    const out = redactConsoleUrl(raw);
    expect(out).toBe('https://us-east-1.console.aws.amazon.com/iam/home?region=us-east-1#/roles/details/x?arn=arn:aws:iam::[account]:role/x');
    expect(out).not.toContain('123456789012');
    // The server's checks read it as before: a console page, and IAM is still the player's alone.
    expect(isConsoleUrl(out)).toBe(true);
    expect(playerOnlyPage(out)?.id).toBe('iam');
    expect(redactConsoleUrl('https://123456789012-abcd1234.console.aws.amazon.com/s3/buckets/aws-city-123456789012-quest')).toBe(
      'https://console.aws.amazon.com/s3/buckets/aws-city-[account]-quest',
    );
    // An ordinary console URL is unchanged; anything else is left alone.
    expect(redactConsoleUrl('https://us-west-2.console.aws.amazon.com/s3/home?region=us-west-2')).toBe('https://us-west-2.console.aws.amazon.com/s3/home?region=us-west-2');
    expect(redactConsoleUrl('chrome-extension://abc/practice.html#/s3')).toBe('chrome-extension://abc/practice.html#/s3');
    expect(redactConsoleUrl('not a url')).toBe('not a url');
  });

  it('refuses a destructive control disguised with an innocent label, and links that leave the console', () => {
    document.body.innerHTML = `<button type="button" aria-label="Next" data-testid="delete-bucket-button">Next</button>
      <button type="button" aria-label="Continue" class="awsui-button-variant-danger">Continue</button>
      <a href="https://evil.example.com/steal">Learn more</a>
      <a href="/s3/buckets">Buckets</a>`;
    const items = takeSnapshot(document, { requireLayout: false }).items;
    const el = (name: string) => findExact(document, { id: items.find((i) => i.name === name)!.id, name })!;
    const item = (name: string) => items.find((i) => i.name === name);
    expect(mayAct(item('Next'), 'click', el('Next'))).toMatchObject({ ok: false, reason: 'risky' });
    expect(mayAct(item('Continue'), 'click', el('Continue'))).toMatchObject({ ok: false, reason: 'risky' });
    expect(mayAct(item('Learn more'), 'click', el('Learn more'))).toMatchObject({ ok: false, reason: 'risky' });
  });

  it('acting uses only the exact snapshot element — no fuzzy redirect to a look-alike', () => {
    document.body.innerHTML = `<button type="button">Create bucket</button>`;
    takeSnapshot(document, { requireLayout: false });
    expect(findExact(document, { name: 'Create bucket' })).toBeUndefined(); // no id → no action
    expect(findExact(document, { id: 'nope', name: 'Create bucket' })).toBeUndefined();
    expect(findTarget(document, { name: 'Create bucket' })).toBeDefined(); // pointing may still find it
  });
});

describe('typing is risk-checked too', () => {
  it('refuses to type into a delete-confirmation field or type a destructive value', () => {
    document.body.innerHTML = `<div role="dialog"><h2>Delete bucket</h2>
      <label for="c">To confirm deletion, enter the bucket name</label><input id="c" type="text" /></div>
      <label for="n">Bucket name</label><input id="n" type="text" />`;
    const items = takeSnapshot(document, { requireLayout: false }).items;
    const it = (n: string) => items.find((i) => i.name.startsWith(n))!;
    const el = (n: string) => findExact(document, { id: it(n).id, name: n })!;
    expect(mayAct(it('To confirm'), 'type', el('To confirm'), 'my-bucket')).toMatchObject({ ok: false, reason: 'risky' });
    expect(mayAct(it('Bucket name'), 'type', el('Bucket name'), 'permanently delete')).toMatchObject({ ok: false, reason: 'risky' });
    expect(mayAct(it('Bucket name'), 'type', el('Bucket name'), 'aws-city-demo-1')).toEqual({ ok: true });
  });
});

describe('select is checked against the option it picks', () => {
  it('refuses an innocent-looking value whose option is risky', () => {
    document.body.innerHTML = `<label for="s">Setting</label><select id="s">
      <option value="1">Keep defaults</option><option value="2">Disable Block Public Access</option></select>`;
    const item = takeSnapshot(document, { requireLayout: false }).items.find((i) => i.name.startsWith('Setting'))!;
    const el = findExact(document, { id: item.id, name: item.name })!;
    expect(mayAct(item, 'select', el, '2')).toMatchObject({ ok: false, reason: 'risky' });
    expect(mayAct(item, 'select', el, '1')).toEqual({ ok: true });
  });
});

describe('choose selects exactly the option that was checked', () => {
  it('is not redirected by a duplicate option value', () => {
    document.body.innerHTML = `<label for="s">Setting</label><select id="s">
      <option value="x">Disable Block Public Access</option><option value="x">Keep defaults</option></select>`;
    const item = takeSnapshot(document, { requireLayout: false }).items.find((i) => i.name.startsWith('Setting'))!;
    const el = findExact(document, { id: item.id, name: item.name }) as HTMLSelectElement;
    el.selectedIndex = -1;
    choose(el, 'Keep defaults');
    expect(el.selectedOptions[0]?.textContent).toBe('Keep defaults');
  });
});

// The security review's gaps: each is a deterministic rule (no model involved), so each has a test here.
describe('Copilot hardening: the risk list', () => {
  it('catches managed policies inside one word, public access, the open internet, other accounts, trust and roles', () => {
    for (const n of [
      'IAMFullAccess', 'AmazonS3FullAccess', 'PowerUserAccess', 'AdministratorAccess-Amplify',
      'Block all public access', 'Block public access to buckets and objects granted through new access control lists (ACLs)',
      'Block public and cross-account access to buckets and objects through any public bucket or access point policies',
      'I acknowledge that the current settings might result in this bucket and the objects within becoming public.',
      'Anywhere-IPv4', 'Anywhere-IPv6', 'Anywhere 0.0.0.0/0', '0.0.0.0/0', '::/0', 'All traffic',
      'Another AWS account', 'Allow entities in other AWS accounts', 'Trusted entity type', 'Custom trust policy', 'Edit trust policy',
      'Trust relationships', 'Create role', 'Create new IAM role',
    ])
      expect(isRisky(n), n).toBe(true);
    // a plain button counts as risky when its section is (S3's Permissions tab: "Edit" under Block public access)
    expect(isRisky('Edit', 'Block public access (bucket settings)')).toBe(true);
  });

  it('keeps the ordinary steps of every practice flow safe', () => {
    for (const n of [
      'Create bucket', 'Next', 'Bucket name', 'Create table', 'Launch instances', 'Launch instance', 'Instance type', 't3.micro',
      'Create function', 'Author from scratch', 'Function name', 'Runtime', 'Node.js 24.x', 'Create database', 'Easy create',
      'PostgreSQL', 'Free tier', 'DB instance identifier', 'Create distribution', 'Origin access control settings (recommended)',
      'Redirect HTTP to HTTPS', 'Create queue', 'Name', 'Service or use case', 'Lambda', 'AWSLambdaBasicExecutionRole',
      'Role name', 'Permissions policies (4)', 'My IP', 'Custom', '10.0.0.0/16', '172.31.0.0/16',
    ])
      expect(isRisky(n), n).toBe(false);
  });

  it('hands back every step of the review’s chain: Create role → Another AWS account → IAMFullAccess → Create role', () => {
    document.body.innerHTML = `
      <button type="button">Create role</button>
      <fieldset><legend>Trusted entity type</legend>
        <label><input type="radio" name="te" checked /> AWS service</label><label><input type="radio" name="te" /> AWS account</label></fieldset>
      <fieldset><legend>An AWS account</legend>
        <label><input type="radio" name="acct" checked /> This account</label><label><input type="radio" name="acct" /> Another AWS account</label>
        <label for="acct-id">Account ID</label><input id="acct-id" type="text" /></fieldset>
      <fieldset><legend>Permissions policies</legend>
        <label><input type="checkbox" /> IAMFullAccess</label><label><input type="checkbox" /> AWSLambdaBasicExecutionRole</label></fieldset>
      <button type="button">Next</button>`;
    const items = takeSnapshot(document, { requireLayout: false }).items;
    const item = (name: string) => items.find((i) => i.name === name)!;
    const el = (name: string) => findExact(document, item(name))!;
    // Anywhere (here not the real console), the risk list alone hands back each step that grants access.
    const local = 'http://localhost/';
    for (const n of ['Create role', 'AWS account', 'Another AWS account', 'IAMFullAccess'])
      expect(mayAct(item(n), 'click', el(n), undefined, local), n).toMatchObject({ ok: false, reason: 'risky' });
    expect(mayAct(item('AWSLambdaBasicExecutionRole'), 'click', el('AWSLambdaBasicExecutionRole'), undefined, local)).toEqual({ ok: true });
    // On the real console it's an IAM page: every click, pick and keystroke is the player's, "Next" and the account id too.
    const iam = 'https://us-east-1.console.aws.amazon.com/iam/home?region=us-east-1#/roles/create';
    for (const n of ['Create role', 'Another AWS account', 'IAMFullAccess', 'AWSLambdaBasicExecutionRole', 'Next'])
      expect(mayAct(item(n), 'click', el(n), undefined, iam), n).toMatchObject({ ok: false, reason: 'player-only' });
    expect(mayAct(item('Account ID'), 'type', el('Account ID'), '111122223333', iam)).toMatchObject({ ok: false, reason: 'player-only' });
  });
});

describe('Copilot hardening: player-only pages', () => {
  const PAGES: Record<string, string[]> = {
    iam: ['https://us-east-1.console.aws.amazon.com/iam/home#/roles', 'https://console.aws.amazon.com/iamv2/home?region=us-east-1#/users', 'https://console.aws.amazon.com/iam/'],
    'identity-center': ['https://us-east-1.console.aws.amazon.com/singlesignon/home?region=us-east-1#!/instances/users'],
    organizations: ['https://us-east-1.console.aws.amazon.com/organizations/v2/home/accounts'],
    kms: ['https://eu-west-2.console.aws.amazon.com/kms/home?region=eu-west-2#/kms/keys'],
    secretsmanager: ['https://us-west-2.console.aws.amazon.com/secretsmanager/secret?name=prod-db&region=us-west-2'],
    'security-group-rules': [
      'https://us-west-2.console.aws.amazon.com/ec2/home?region=us-west-2#ModifyInboundSecurityGroupRules:securityGroupId=sg-0abc',
      'https://us-west-2.console.aws.amazon.com/vpcconsole/home?region=us-west-2#ModifyInboundSecurityGroupRules:securityGroupId=sg-0abc',
      'https://us-west-2.console.aws.amazon.com/ec2/home?region=us-west-2#CreateSecurityGroup:',
    ],
    's3-permissions': [
      'https://us-east-1.console.aws.amazon.com/s3/buckets/my-bucket?region=us-east-1&tab=permissions',
      'https://s3.console.aws.amazon.com/s3/bucket/my-bucket/property/bpa/edit?region=us-east-1',
      'https://s3.console.aws.amazon.com/s3/bucket/my-bucket/property/policy/edit?region=us-east-1',
      'https://us-east-1.console.aws.amazon.com/s3/settings?region=us-east-1',
    ],
  };

  it('is one list, and each entry matches its real-console pages', () => {
    expect(PLAYER_ONLY_PAGES.map((p) => p.id).sort()).toEqual(Object.keys(PAGES).sort());
    for (const [id, urls] of Object.entries(PAGES)) for (const u of urls) expect(playerOnlyPage(u)?.id, u).toBe(id);
  });

  it('leaves ordinary console pages, other sites and the practice console alone', () => {
    for (const u of [
      'https://us-west-2.console.aws.amazon.com/s3/bucket/create?region=us-west-2',
      'https://us-west-2.console.aws.amazon.com/s3/buckets/my-bucket?region=us-west-2&tab=objects',
      'https://us-west-2.console.aws.amazon.com/ec2/home?region=us-west-2#LaunchInstances:',
      'https://us-west-2.console.aws.amazon.com/ec2/home?region=us-west-2#SecurityGroups:',
      'https://us-west-2.console.aws.amazon.com/lambda/home?region=us-west-2#/create/function',
      'https://us-west-2.console.aws.amazon.com/iamfoo/home', // a whole path segment only
      'https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles.html',
      'https://console.aws.amazon.com.evil.example/iam/home',
      'http://console.aws.amazon.com/iam/home',
      'chrome-extension://abcdefghijklmnop/practice.html#/iam',
      'chrome-extension://abcdefghijklmnop/practice.html#/iam/create',
      '',
      undefined,
    ])
      expect(playerOnlyPage(u), u).toBeUndefined();
  });

  it('mayAct refuses every click, pick and keystroke there with a kind “your turn”, and allows them elsewhere', () => {
    const items = takeSnapshot(document, { requireLayout: false }).items;
    const item = (n: string) => items.find((i) => i.name === n)!;
    const el = (n: string) => findExact(document, item(n))!;
    const kms = 'https://eu-west-2.console.aws.amazon.com/kms/home#/kms/keys/create';
    const steps = [['click', 'Create bucket', undefined], ['type', 'Bucket name', 'aws-city-demo'], ['select', 'AWS Region', 'eu-west-2']] as const;
    for (const [action, n, value] of steps) {
      const v = mayAct(item(n), action, el(n), value, kms);
      expect(v, n).toMatchObject({ ok: false, reason: 'player-only' });
      expect(v.ok ? '' : v.message, n).toBe('On AWS KMS pages, changes are yours to make, so this one is your turn. I’ll point and explain.');
      expect(mayAct(item(n), action, el(n), value, 'https://us-west-2.console.aws.amazon.com/s3/bucket/create'), n).toEqual({ ok: true });
      expect(mayAct(item(n), action, el(n), value, 'chrome-extension://abcdefghijklmnop/practice.html#/s3/create'), n).toEqual({ ok: true });
    }
    // with no url given, it is the element's own page (jsdom's localhost here: not the console)
    expect(mayAct(item('Create bucket'), 'click', el('Create bucket'))).toEqual({ ok: true });
  });
});

describe('Copilot hardening: redaction and secret pages', () => {
  it('redacts dashed, dotted, spaced and bare 12-digit account ids, and an ARN’s account part', () => {
    for (const id of ['1111-2222-3333', '1111.2222.3333', '1111 2222 3333', '111122223333']) expect(redact(`Account ${id} here`), id).toBe('Account [account] here');
    expect(redact('arn:aws:iam::123456789012:role/city-lambda-role')).toBe('arn:aws:iam::[account]:role/city-lambda-role');
    expect(redact('https://123456789012-abcd1234.us-east-1.console.aws.amazon.com/s3')).toBe('https://[account]-abcd1234.us-east-1.console.aws.amazon.com/s3');
    // and a page's snapshot never carries one
    document.body.innerHTML = `<h1>Account 1111.2222.3333</h1><button type="button">Use 1111 2222 3333</button>`;
    const json = JSON.stringify(takeSnapshot(document, { requireLayout: false }));
    expect(json).not.toContain('1111.2222.3333');
    expect(json).not.toContain('1111 2222 3333');
  });

  it('keeps ordinary numbers: dates, sizes, CIDRs, versions and longer runs', () => {
    for (const t of ['Number of instances: 1', 'Version 2012-10-17', '10.0.0.0/16', 'Node.js 24.x · 1024 MB', 'Order 12345678901234', '2026 11 20', 'Ports 8080 443'])
      expect(redact(t), t).toBe(t);
  });

  it('secret pages (never auto-snapped) are one list, matched on the real console only', () => {
    const SECRET: Record<string, string[]> = {
      'iam-access-keys': [
        'https://us-east-1.console.aws.amazon.com/iam/home#/security_credentials',
        'https://us-east-1.console.aws.amazon.com/iam/home#/users/details/alice?section=security_credentials',
        'https://us-east-1.console.aws.amazon.com/iam/home#/users/details/alice/create-access-key',
      ],
      secretsmanager: ['https://us-west-2.console.aws.amazon.com/secretsmanager/secret?name=prod-db&region=us-west-2'],
      'parameter-store': ['https://us-west-2.console.aws.amazon.com/systems-manager/parameters/db-password/description?region=us-west-2&tab=Table'],
      kms: ['https://us-west-2.console.aws.amazon.com/kms/home?region=us-west-2#/kms/keys'],
      cloudshell: ['https://us-west-2.console.aws.amazon.com/cloudshell/home?region=us-west-2'],
    };
    expect(SECRET_PAGES.map((p) => p.id).sort()).toEqual(Object.keys(SECRET).sort());
    for (const urls of Object.values(SECRET)) for (const u of urls) expect(isSecretPage(u), u).toBe(true);
    for (const u of [
      'https://us-east-1.console.aws.amazon.com/iam/home#/roles',
      'https://us-west-2.console.aws.amazon.com/s3/buckets?region=us-west-2',
      'https://us-west-2.console.aws.amazon.com/systems-manager/home?region=us-west-2',
      'https://docs.aws.amazon.com/secretsmanager/latest/userguide/intro.html',
      'chrome-extension://abcdefghijklmnop/practice.html#/iam',
      undefined,
    ])
      expect(isSecretPage(u), u).toBe(false);
  });
});
