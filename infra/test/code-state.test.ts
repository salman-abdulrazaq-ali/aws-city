import { describe, expect, it } from 'vitest';
import { codeProblem, codeRow } from '../lib/code-state.js';
import { reviewRows } from '../lib/review.js';

// Seen 21 Nov 2026: setup ran from a checkout 6 commits behind GitHub's main and deployed the city without two merged fixes.
describe('which code setup deploys', () => {
  const main = { branch: 'main', sha: 'd349c21', behind: 0, dirty: false };

  it('main and up to date: fine, and the review says so', () => {
    expect(codeProblem('prod', main)).toBeUndefined();
    expect(codeRow(main)).toBe('main @ d349c21 (up to date with GitHub)');
  });

  it('behind GitHub: names how far, for staging and prod', () => {
    const behind = { ...main, sha: '9f72225', behind: 6 };
    expect(codeProblem('prod', behind)).toBe("Your copy is 6 commits behind GitHub's main, so it would deploy older code.");
    expect(codeProblem('staging', { ...behind, behind: 1 })).toBe("Your copy is 1 commit behind GitHub's main, so it would deploy older code.");
    expect(codeRow({ ...behind, dirty: true })).toBe('main @ 9f72225 (6 behind GitHub), with local changes');
  });

  it("prod from another branch is named; staging from a branch is normal; no git (a zip) says nothing", () => {
    const branch = { branch: 'feat/x', sha: 'abc1234', behind: 3, dirty: false };
    expect(codeProblem('prod', branch)).toBe('You\'re on "feat/x", not main, so prod would run that branch\'s code.');
    expect(codeProblem('staging', branch)).toBeUndefined();
    expect(codeRow(branch)).toBe('feat/x @ abc1234');
    expect(codeProblem('prod', undefined)).toBeUndefined();
  });

  it('the review screen shows the Code line right under the environment', () => {
    const rows = reviewRows({ envName: 'prod', modelChoice: 'nova', region: 'eu-west-2', domainName: '', cognitoDomainPrefix: 'c', googleClientId: '', alarmEmail: '', monthlyBudgetUsd: 100, sesFromEmail: '', storeId: '', allowDev: false, firefox: false, safari: false, githubRepo: '', aiEnabled: true, code: codeRow(main) });
    expect(rows[1]).toEqual(['Code', 'main @ d349c21 (up to date with GitHub)']);
  });
});
