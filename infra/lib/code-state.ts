/**
 * Which code `npm run setup` is about to deploy, and whether it's what the player thinks it is. Seen live, 21 Nov 2026:
 * a checkout 6 commits behind GitHub's main deployed the city without two merged fixes, and the live test then showed
 * the old behaviour. Pure: infra/setup/setup.mjs reads git and asks.
 */
export interface CodeState {
  /** The checked-out branch ('HEAD' when detached). */
  branch: string;
  /** The short commit id. */
  sha: string;
  /** Commits on GitHub's main this checkout doesn't have (after a fetch). */
  behind: number;
  /** Uncommitted changes to tracked files. */
  dirty: boolean;
}

/** Why deploying this checkout is probably a mistake, in one sentence; undefined when it's fine. */
export const codeProblem = (envName: 'staging' | 'prod', s: CodeState | undefined): string | undefined => {
  if (!s) return undefined; // not a git checkout (a downloaded zip): nothing to compare
  if (envName === 'prod' && s.branch !== 'main') return `You're on "${s.branch}", not main, so prod would run that branch's code.`;
  if (s.branch === 'main' && s.behind > 0) return `Your copy is ${s.behind} commit${s.behind === 1 ? '' : 's'} behind GitHub's main, so it would deploy older code.`;
  return undefined;
};

/** The review screen's "Code" line. */
export const codeRow = (s: CodeState): string =>
  `${s.branch} @ ${s.sha}${s.branch === 'main' ? (s.behind ? ` (${s.behind} behind GitHub)` : ' (up to date with GitHub)') : ''}${s.dirty ? ', with local changes' : ''}`;
