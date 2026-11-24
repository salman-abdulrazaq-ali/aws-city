// @vitest-environment jsdom
// The approval card (Impeccable batch C, finding 3): where it writes first, one plain line per resource with its template
// name second, one "For AWS learners" fold, a plain-text Approve, and waiting approvals above My builds' Take it down rows;
// a demo fix card names the practice account too.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The fix card's citizen portrait draws with Phaser: not under jsdom.
vi.mock('@/ui/Portrait', () => ({ Portrait: () => <span data-testid="portrait" /> }));

const { useCity } = await import('@/state/store');
const { ChangeTarget, DeployPanel, plainType } = await import('@/ui/DeployPanel');

afterEach(cleanup);

describe('plainType', () => {
  it('says a CloudFormation type in words', () => {
    expect(plainType('AWS::S3::Bucket')).toBe('S3 bucket');
    expect(plainType('AWS::S3::BucketPolicy')).toBe('S3 bucket policy');
    expect(plainType('AWS::CloudFront::OriginAccessControl')).toBe('CloudFront origin access control');
    expect(plainType('AWS::ApiGateway::RestApi')).toBe('API Gateway REST API');
    expect(plainType('AWS::Events::Rule')).toBe('EventBridge rule');
    expect(plainType('AWS::RDS::DBInstance')).toBe('RDS DB instance');
    expect(plainType('AWS::Account::Setting')).toBe('Account setting');
  });
  it('leaves anything that isn’t an AWS:: type alone', () => {
    expect(plainType('Custom::Thing')).toBe('Custom::Thing');
    expect(plainType('ec2:instance')).toBe('ec2:instance');
  });
});

describe('ChangeTarget', () => {
  it('names the practice account in the demo when the preview carries no account id', () => {
    render(<ChangeTarget d={{ region: 'us-west-2' }} practice="123456789012" />);
    expect(screen.getByText(/practice account/).textContent).toBe('Changes the practice account 1234-5678-9012 · us-west-2');
  });
  it('a real preview’s own account id wins', () => {
    render(<ChangeTarget d={{ accountId: '047463438585', region: 'eu-west-1' }} practice="123456789012" />);
    expect(screen.getByText(/Changes AWS account/).textContent).toBe('Changes AWS account 0474-6343-8585 · eu-west-1');
  });
});

describe('the approval card in Deploy', () => {
  const preview = {
    deployId: 'd-1',
    templateId: 'static-site',
    stackName: 'aws-city-static-site',
    region: 'us-west-2',
    status: 'preview' as const,
    changes: [
      { action: 'Add' as const, logicalId: 'SiteBucket', resourceType: 'AWS::S3::Bucket' },
      { action: 'Add' as const, logicalId: 'SiteDistribution', resourceType: 'AWS::CloudFront::Distribution' },
    ],
    costNote: 'About $0.50 a month for a small site.',
  };

  it('says where first, each resource in words, one fold, and a plain Approve; above My builds', () => {
    useCity.setState({
      backendKind: 'mock',
      account: { linked: true, accountId: '123456789012', region: 'us-west-2' },
      deploys: { 'd-1': preview, 'd-0': { ...preview, deployId: 'd-0', stackName: 'aws-city-old-site', status: 'complete' } },
    });
    const { container } = render(<DeployPanel />);
    const card = container.querySelector('.card.stack.preview')!;
    expect(card.querySelector('.change-target')!.textContent).toBe('Changes the practice account 1234-5678-9012 · us-west-2');
    const rows = [...card.querySelectorAll('.change-row')].map((r) => r.textContent);
    expect(rows).toEqual(['+Add S3 bucketSiteBucket', '+Add CloudFront distributionSiteDistribution']);
    expect(card.querySelectorAll('.for-learners')).toHaveLength(1);
    expect(card.querySelector('.for-learners')!.textContent).toMatch(/AWS::S3::Bucket.*In a real account: About \$0\.50/);
    expect(screen.getByRole('button', { name: 'Approve & deploy' })).toBeTruthy();
    // The waiting card comes before the My builds heading and its settled cards.
    const headings = [...container.querySelectorAll('h4')].map((h) => h.textContent);
    expect(headings.indexOf('Waiting for your OK')).toBeGreaterThanOrEqual(0);
    expect(headings.indexOf('Waiting for your OK')).toBeLessThan(headings.indexOf('My builds'));
    const settled = container.querySelector('.card.stack.complete')!;
    expect(card.compareDocumentPosition(settled) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('a fix card in City care', () => {
  it('names the practice account in the demo, like a build preview', async () => {
    const { FindingCard } = await import('@/ui/FindingCard');
    const { demoFindings } = await import('@/backend/mockAccount');
    const f = demoFindings().find((x) => !!x.fix)!;
    useCity.setState({
      backendKind: 'mock',
      account: { linked: true, accountId: '123456789012', region: 'us-west-2', fixes: true },
      findings: { [f.id]: { ...f, seenAt: 1 } },
      findingOpen: f.id,
      deploys: {
        'fix-1': {
          deployId: 'fix-1',
          findingId: f.id,
          templateId: 'fix',
          stackName: 'fix',
          region: 'us-west-2',
          status: 'preview',
          changes: [{ action: 'Modify', logicalId: 'Bucket', resourceType: 'AWS::S3::Bucket' }],
        },
      },
    });
    const { container } = render(<FindingCard openTab={() => {}} />);
    expect(container.querySelector('.finding-preview .change-target')!.textContent).toBe('Changes the practice account 1234-5678-9012 · us-west-2');
  });
});
