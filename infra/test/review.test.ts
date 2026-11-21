// The setup wizard's review screen (lib/review.ts): every answer on one screen and the AWS changes it will make, before
// anything is written; the us-east-1 note; free-mail senders flagged.
import { describe, expect, it } from 'vitest';
import { cloudFrontNote, isFreeMail, plannedActions, reviewRows, reviewText, type ReviewAnswers } from '../lib/review.js';

const answers: ReviewAnswers = {
  envName: 'staging', modelChoice: 'nova', region: 'eu-west-2', domainName: '', cognitoDomainPrefix: 'cloud-city-staging-814205',
  googleClientId: '360123069445-abc.apps.googleusercontent.com', alarmEmail: 'me@example.com', monthlyBudgetUsd: 50, sesFromEmail: '',
  storeId: '', allowDev: true, firefox: false, safari: false, githubRepo: '', aiEnabled: false,
};

describe('the review screen', () => {
  it('lists every answer, says where CloudFront’s firewall lives, and that the AI starts off', () => {
    const rows = Object.fromEntries(reviewRows(answers));
    expect(rows.Environment).toMatch(/staging/);
    expect(rows['AI models']).toBe('Amazon Nova');
    expect(rows['AI at first']).toMatch(/off until Bedrock/);
    expect(rows.Region).toBe("eu-west-2 (CloudFront's firewall: us-east-1)");
    expect(rows['Sign-in page']).toBe('cloud-city-staging-814205.auth.eu-west-2.amazoncognito.com');
    expect(rows['Alarm email']).toBe('me@example.com');
    expect(rows['Sign-up emails from']).toMatch(/Cognito’s default/);
    expect(rows['Google sign-in']).not.toContain('apps.googleusercontent.com');
    // A custom domain has no CloudFront, so no us-east-1.
    expect(Object.fromEntries(reviewRows({ ...answers, domainName: 'api.example.com' })).Region).toBe('eu-west-2');
  });

  it('names each AWS change in order, with us-east-1 explained, and deploys last', () => {
    const actions = plannedActions(
      { ...answers, sesFromEmail: 'noreply@example.com' },
      { account: '111122223333', storeGoogleSecret: true, verifySes: true, deleteSes: ['old@example.com'], bootstrap: ['eu-west-2', 'us-east-1'] },
    );
    expect(actions).toEqual([
      'Store the Google client secret in Secrets Manager ("aws-city/google-oauth")',
      'Ask Amazon SES to verify noreply@example.com (it sends a verification email)',
      'Remove the SES identity old@example.com (set up by an earlier run, no longer used)',
      'Prepare 111122223333/eu-west-2 for CDK (one time)',
      'Prepare 111122223333/us-east-1 for CDK (one time): for CloudFront’s firewall',
      'Deploy AWS City (staging) in eu-west-2: about 15–25 minutes the first time',
    ]);
    expect(plannedActions(answers, { account: '1', storeGoogleSecret: false, verifySes: false, deleteSes: [], bootstrap: [] })).toEqual(['Deploy AWS City (staging) in eu-west-2: about 15–25 minutes the first time']);
    const text = reviewText(reviewRows(answers), ['Deploy']);
    expect(text).toMatch(/^Environment +staging/);
    expect(text).toContain('In AWS, confirming will:\n  1. Deploy');
  });

  it('says where the AI runs when Bedrock answers only in another Region, and when Nova runs on Lite alone', () => {
    const away = Object.fromEntries(reviewRows({ ...answers, aiEnabled: true, aiRegion: 'us-west-2', novaLiteOnly: true }));
    expect(away['AI runs in']).toBe("us-west-2 (only the agents' questions; data stays in eu-west-2)");
    expect(away['AI models']).toBe('Amazon Nova Lite (no Pro quota yet)');
    // At home: no extra row.
    expect(Object.fromEntries(reviewRows({ ...answers, aiRegion: '' }))['AI runs in']).toBeUndefined();
    expect(Object.fromEntries(reviewRows({ ...answers, aiRegion: 'eu-west-2' }))['AI runs in']).toBeUndefined();
  });

  it('explains us-east-1 in one sentence', () => {
    expect(cloudFrontNote('eu-west-2')).toMatch(/AWS WAF.*us-east-1.*stay in eu-west-2/);
  });

  it('flags free-mail senders for SES', () => {
    for (const e of ['me@outlook.com', 'Me@Gmail.com', 'x@hotmail.co.uk', 'x@icloud.com']) expect(isFreeMail(e), e).toBe(true);
    for (const e of ['noreply@example.com', 'team@aws-city.dev', 'not-an-email']) expect(isFreeMail(e), e).toBe(false);
  });
});
