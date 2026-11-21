// A real AWS account (contract v2.17): the pure rules in src/state/account.ts and how the store keeps account.status and
// build previews. Only a reply to the player's own request is toasted; a welcome or a broken link updates the card quietly.
import { beforeEach, describe, expect, it } from 'vitest';
import type { InventoryItem } from '@/backend/contract';
import { isSafeAwsUrl } from '@/app/runtime';
import {
  connectOffer,
  connectsPlayer,
  defaultLinkRegion,
  FIXES_ON_STEPS,
  gameBuilds,
  isLinkRegion,
  LINK_REGIONS,
  linkChecklist,
  linking,
  regionName,
  removeTarget,
  roleUpdate,
  roleUpdateSteps,
  stacksUrl,
  stepsText,
  stillBuilt,
} from '@/state/account';
import { useCity } from '@/state/store';

const item = (arn: string, managedByGame = true): InventoryItem => ({ arn, type: 'x', name: arn.split(/[:/]/).at(-1)!, serviceId: null, districtId: null, managedByGame });

describe('the Regions a link can use', () => {
  it('are the commercial partition’s, by name (GovCloud and the sovereign cloud can’t trust the city’s account)', () => {
    const codes = LINK_REGIONS.map((r) => r.code);
    expect(codes).toContain('us-west-2');
    expect(codes).toContain('eu-west-1');
    expect(codes).toContain('af-south-1');
    expect(codes).not.toContain('us-gov-west-1');
    expect(codes).not.toContain('eusc-de-east-1');
    expect(LINK_REGIONS.find((r) => r.code === 'us-west-2')).toEqual({ code: 'us-west-2', name: 'US West (Oregon)', optIn: false });
    expect(LINK_REGIONS.find((r) => r.code === 'af-south-1')?.optIn).toBe(true);
    const names = LINK_REGIONS.map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(regionName('eu-west-2')).toBe('Europe (London)');
  });

  it('a link starts on the Region asked for last, then the linked one, then the city’s (never one it can’t use)', () => {
    expect(defaultLinkRegion({ linkRegion: 'ap-south-1', region: 'eu-west-1' }, 'us-east-2')).toBe('ap-south-1');
    expect(defaultLinkRegion({ region: 'eu-west-1' }, 'us-east-2')).toBe('eu-west-1');
    expect(defaultLinkRegion({}, 'ca-central-1')).toBe('ca-central-1');
    expect(defaultLinkRegion({}, 'us-gov-west-1')).toBe('us-east-1');
    expect(isLinkRegion('us-gov-east-1')).toBe(false);
  });
});

describe('where the account card is', () => {
  it('a link under way keeps Deploy in sight: a setup link out, the server asking for an authenticator, or a broken link', () => {
    expect(linking({ linked: false })).toBe(false);
    expect(linking({ linked: false, linkUrl: 'https://x' })).toBe(true);
    expect(linking({ linked: false, mfaRequired: true })).toBe(true);
    expect(linking({ linked: false, broken: true })).toBe(true);
    // A linked account opens Deploy for good on its own (the ladder's `linked`).
    expect(linking({ linked: true, linkUrl: 'https://x' })).toBe(false);
  });

  it('the To-do row is for hosted, signed-in players with no working link only', () => {
    const base = { hosted: true, status: 'connected' as const, account: { linked: false } };
    expect(connectOffer(base)).toBe('connect');
    expect(connectOffer({ ...base, account: { linked: false, broken: true } })).toBe('relink');
    expect(connectOffer({ ...base, account: { linked: true } })).toBeUndefined();
    expect(connectOffer({ ...base, status: 'signed-out' })).toBeUndefined();
    // The demo and the local server (it reads the developer's own account) never offer it.
    expect(connectOffer({ ...base, hosted: false })).toBeUndefined();
  });
});

describe('the role and its steps', () => {
  it('"Update your AWS City role" only when both versions are known and the installed one is older', () => {
    expect(roleUpdate({ linked: true, roleVersion: 3, latestRoleVersion: 4, templateUrl: 'https://t' })).toEqual({ from: 3, to: 4, templateUrl: 'https://t' });
    expect(roleUpdate({ linked: true, roleVersion: 4, latestRoleVersion: 4 })).toBeUndefined();
    expect(roleUpdate({ linked: true, latestRoleVersion: 4 })).toBeUndefined();
    expect(roleUpdate({ linked: false, roleVersion: 3, latestRoleVersion: 4 })).toBeUndefined();
  });

  it('each step list says what the console asks, in order, and copies as numbered text', () => {
    const update = roleUpdateSteps('https://bucket.s3.amazonaws.com/player-role.yaml');
    expect(update.join(' ')).toMatch(/AWSCity stack.*Update.*Replace existing template.*player-role\.yaml.*ExternalId.*IAM resources.*UPDATE_COMPLETE/);
    expect(FIXES_ON_STEPS.join(' ')).toMatch(/Use existing template.*AllowFixes to true.*ExternalId.*IAM resources/);
    const check = linkChecklist('eu-west-2');
    expect(check[0]).toMatch(/Europe \(London\)/);
    expect(check.join(' ')).toMatch(/IAM roles and CloudFormation stacks.*workshop accounts can’t.*IAM resources with custom names.*CREATE_COMPLETE.*about a minute.*Verify/);
    expect(stepsText(['a', 'b'])).toBe('1. a\n2. b');
  });

  it('a setup link names who its stack serves (ConnectsPlayer), read from the quick-create link’s hash query', () => {
    const url = (q: string) => `https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks/quickcreate?${q}`;
    expect(connectsPlayer(url('templateURL=https%3A%2F%2Ft&stackName=AWSCity&param_ExternalId=x&param_ConnectsPlayer=Brave%20Otter'))).toBe('Brave Otter');
    expect(connectsPlayer(url('stackName=AWSCity&param_ConnectsPlayer=Player+1a2b3c4d'))).toBe('Player 1a2b3c4d');
    expect(connectsPlayer(url('stackName=AWSCity&param_ExternalId=x'))).toBeUndefined();
    expect(connectsPlayer(undefined)).toBeUndefined();
    expect(roleUpdateSteps(undefined, 'Brave Otter').join(' ')).toMatch(/Set ConnectsPlayer to Brave Otter, and keep the ExternalId/);
  });

  it('the stacks page is an AWS Console page in that Region (the only kind openUrl opens)', () => {
    expect(stacksUrl('eu-west-1')).toBe('https://eu-west-1.console.aws.amazon.com/cloudformation/home?region=eu-west-1#/stacks?filteringText=AWSCity');
    expect(isSafeAwsUrl(stacksUrl('ap-southeast-2'))).toBe(true);
  });
});

describe('the city’s own builds', () => {
  it('"Take it down" knows an instance, a table and a bucket by their ARNs; anything else is removed in the console', () => {
    expect(removeTarget('arn:aws:ec2:us-west-2:123456789012:instance/i-0f9e8d7c6b5a40312')).toEqual({ kind: 'instance', id: 'i-0f9e8d7c6b5a40312' });
    expect(removeTarget('arn:aws:dynamodb:us-west-2:123456789012:table/city-orders')).toEqual({ kind: 'table', id: 'city-orders' });
    expect(removeTarget('arn:aws:s3:::aws-city-site-1234')).toEqual({ kind: 'bucket', id: 'aws-city-site-1234' });
    expect(removeTarget('arn:aws:lambda:us-west-2:123456789012:function:hello')).toBeUndefined();
    expect(removeTarget('arn:aws:dynamodb:us-west-2:123456789012:table/city-orders/stream/2026')).toBeUndefined();
    expect(removeTarget('arn:aws:s3:::bucket/key.txt')).toBeUndefined();
  });

  it('My builds are the inventory’s managedByGame items; what’s still built counts them, else this session’s live stacks', () => {
    const inv = { items: [item('arn:aws:s3:::mine'), item('arn:aws:s3:::theirs', false)] };
    expect(gameBuilds(inv).map((i) => i.name)).toEqual(['mine']);
    expect(gameBuilds(undefined)).toEqual([]);
    expect(stillBuilt(inv, [])).toBe(1);
    expect(stillBuilt(undefined, [{ deployId: 'a-1', status: 'complete' }, { deployId: 'a-2', status: 'deleted' }, { deployId: 'f-1', status: 'complete', findingId: 'f1' }])).toBe(1);
    // A practice build made nothing in AWS.
    expect(stillBuilt(undefined, [{ deployId: 'practice-1234', status: 'complete' }])).toBe(0);
    expect(stillBuilt({ items: [] }, [])).toBe(0);
  });
});

describe('the store and account.status (v2.17)', () => {
  const s = () => useCity.getState();
  beforeEach(() => {
    s().resetSession();
    s().clearToasts();
    useCity.setState({ backendKind: 'server', toasts: [] });
  });

  it('a welcome (no requestId) updates the card quietly: no toast, and its hint isn’t an error', () => {
    s().applyServerEvent({ type: 'account.status', linked: false, message: 'Connect your AWS account to let agents build for real.' });
    expect(s().toasts).toEqual([]);
    expect(s().account).toMatchObject({ linked: false, message: expect.stringMatching(/Connect your AWS account/) });
    expect(s().account.error).toBeUndefined();
    s().applyServerEvent({ type: 'account.status', linked: true, accountId: '111122223333', region: 'eu-west-1', fixes: false, roleVersion: 3, latestRoleVersion: 4, templateUrl: 'https://t' });
    expect(s().toasts).toEqual([]);
    expect(s().account).toMatchObject({ linked: true, fixes: false, roleVersion: 3, latestRoleVersion: 4, templateUrl: 'https://t' });
  });

  it('a broken link is kept on the card, never toasted', () => {
    s().applyServerEvent({ type: 'account.status', linked: false, broken: true, accountId: '111122223333', region: 'eu-west-1', message: 'I can’t use the AWSCity role any more.' });
    expect(s().toasts).toEqual([]);
    expect(s().account).toMatchObject({ linked: false, broken: true, accountId: '111122223333', region: 'eu-west-1' });
    expect(linking(s().account)).toBe(true);
  });

  it('a new link took: one toast, and the linking steps fold away', () => {
    s().patchAccount({ wantsLink: true, linkUrl: 'https://eu-west-1.console.aws.amazon.com/x', externalId: 'e' });
    s().applyServerEvent({ type: 'account.status', requestId: 'r1', linked: true, accountId: '111122223333', region: 'eu-west-1' });
    expect(s().toasts.map((t) => t.text)).toEqual([expect.stringMatching(/Your AWS account 111122223333 is linked/)]);
    expect(s().account).toMatchObject({ linked: true, wantsLink: false, linkUrl: undefined });
  });

  it('a verify that didn’t take while linked (the old link stays) keeps the steps open and says why', () => {
    useCity.setState({ account: { linked: true, accountId: '111122223333', region: 'eu-west-1', wantsLink: true, linkUrl: 'https://x' } });
    s().applyServerEvent({ type: 'account.status', requestId: 'r2', linked: true, accountId: '111122223333', region: 'eu-west-1', message: 'I couldn’t use the AWSCity role in 444455556666 (us-east-2).' });
    expect(s().account).toMatchObject({ wantsLink: true, linkUrl: 'https://x' });
    expect(s().toasts.at(-1)?.text).toMatch(/couldn’t use the AWSCity role/);
  });

  it('Disconnect’s answer: no error, the Region whose stack is left, and the steps reset', () => {
    useCity.setState({ account: { linked: true, accountId: '111122223333', region: 'eu-west-1', unlinking: 'u1' } });
    s().applyServerEvent({ type: 'account.status', requestId: 'u1', linked: false, message: 'Disconnected. Delete the AWSCity stack in CloudFormation to remove its role.' });
    expect(s().account).toMatchObject({ linked: false, stackLeft: 'eu-west-1', unlinking: undefined });
    expect(s().toasts.map((t) => [t.kind, t.text])).toEqual([['info', expect.stringMatching(/Disconnected.*Delete the AWSCity stack/)]]);
    // Linking again clears the note.
    s().restartLink();
    expect(s().account).toMatchObject({ wantsLink: true, stackLeft: undefined });
  });

  it('a Disconnect refused with an error stops waiting', () => {
    useCity.setState({ account: { linked: true, unlinking: 'u1' } });
    s().applyServerEvent({ type: 'error', requestId: 'u1', message: 'Not now.' });
    expect(s().account.unlinking).toBeUndefined();
  });

  it('a practice build says so when it’s done: nothing was created in the AWS account', () => {
    s().applyServerEvent({ type: 'deploy.preview', deployId: 'practice-1a2b', templateId: 'hello-api', stackName: 'Hello API (practice)', region: 'practice', changes: [] });
    s().applyServerEvent({ type: 'deploy.status', deployId: 'practice-1a2b', status: 'complete' });
    expect(s().toasts.at(-1)?.text).toBe('Hello API (practice): practice build done. Nothing was created in your AWS account.');
  });

  it('every build preview keeps the name the server asks to be typed (not only a fix’s)', () => {
    s().applyServerEvent({
      type: 'deploy.preview',
      deployId: 'a-1',
      templateId: 'delete_table',
      stackName: 'Delete table city-orders',
      region: 'us-west-2',
      changes: [
        { action: 'Remove', logicalId: 'city-orders', resourceType: 'AWS::DynamoDB::Table' },
        { action: 'Modify', logicalId: 'Safety check: it holds data', resourceType: 'detail' },
      ],
      confirmText: 'city-orders',
    });
    expect(s().deploys['a-1']).toMatchObject({ confirmText: 'city-orders', status: 'preview' });
    expect(s().deploys['a-1'].findingId).toBeUndefined();
  });

  it('the backend says once whether it’s the hosted server; status changes keep it', () => {
    s().setBackend('server', 'connecting', 'templates', true);
    s().setBackend('server', 'connected');
    expect(s().hosted).toBe(true);
    s().setBackend('mock', 'connected', 'templates', false);
    expect(s().hosted).toBe(false);
  });
});
