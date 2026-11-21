// Release safety (scripts/release-check.mjs): a hosted store build can't ship without its backend or its privacy policy's
// https address, and a release's tag, package.json and built manifests agree, with no manifest key.
import { describe, expect, it } from 'vitest';
import { HOSTED_VARS, isHttpsUrl, manifestVersionOf, PRIVACY_VAR, releaseProblems, storeBuildProblems } from '../scripts/release-check.mjs';

const hosted = {
  WXT_STORE_BUILD: 'true',
  WXT_BACKEND: 'hosted',
  ...Object.fromEntries(HOSTED_VARS.map((k) => [k, `value-of-${k}`])),
  [PRIVACY_VAR]: 'https://city.example.com/privacy',
};

describe('store builds', () => {
  it('a hosted store build with every setting passes, and names each one that is missing', () => {
    expect(storeBuildProblems(hosted)).toEqual([]);
    const [problem] = storeBuildProblems({ ...hosted, WXT_COGNITO_DOMAIN: '', WXT_AWS_API_URL: undefined });
    expect(problem).toMatch(/WXT_AWS_API_URL, WXT_COGNITO_DOMAIN/);
    expect(problem).not.toMatch(/WXT_AWS_WS_URL/);
  });

  it('Safari also needs the sign-in relay page', () => {
    expect(storeBuildProblems(hosted, 'safari').join()).toMatch(/WXT_COGNITO_REDIRECT_URL/);
    expect(storeBuildProblems({ ...hosted, WXT_COGNITO_REDIRECT_URL: 'https://relay/' }, 'safari')).toEqual([]);
  });

  it('needs the privacy policy, at a plain https address (the stores require one; the extension opens nothing else)', () => {
    expect(PRIVACY_VAR).toBe('WXT_PRIVACY_URL');
    expect(storeBuildProblems({ ...hosted, WXT_PRIVACY_URL: '' }).join()).toMatch(/needs WXT_PRIVACY_URL: the https address where your privacy policy is published/);
    for (const bad of ['http://city.example.com/privacy', 'javascript:alert(1)', 'https://user:pw@city.example.com/p', 'city.example.com/privacy'])
      expect(storeBuildProblems({ ...hosted, WXT_PRIVACY_URL: bad }).join(), bad).toMatch(/must be a plain https address/);
    expect(isHttpsUrl('https://github.com/me/aws-city/blob/main/PRIVACY.md')).toBe(true);
    // Only hosted store builds need it: a developer's build or the demo has no account to explain.
    expect(storeBuildProblems({ WXT_BACKEND: 'hosted' })).toEqual([]);
  });

  it("developers' builds keep the demo fallback: only a hosted store build is checked", () => {
    expect(storeBuildProblems({ WXT_BACKEND: 'hosted' })).toEqual([]);
    expect(storeBuildProblems({ WXT_BACKEND: 'hosted', WXT_STORE_BUILD: 'false' })).toEqual([]);
    expect(storeBuildProblems({ WXT_STORE_BUILD: 'true' })).toEqual([]);
  });
});

describe('releases', () => {
  const manifest = (over: Record<string, unknown> = {}) => ({ file: 'm.json', manifest: { version: '1.2.3', ...over } });

  it('the tag is v<package.json version>, and every manifest has that version and no key', () => {
    expect(releaseProblems({ tag: 'v1.2.3', version: '1.2.3', manifests: [manifest(), manifest()] })).toEqual([]);
    expect(releaseProblems({ tag: 'v1.2.4', version: '1.2.3' }).join()).toMatch(/v1\.2\.4 isn't v1\.2\.3/);
    expect(releaseProblems({ tag: undefined, version: '1.2.3' }).join()).toMatch(/\(none\)/);
    expect(releaseProblems({ tag: 'v1.2.3', version: '1.2.3', manifests: [manifest({ version: '1.2.2' })] }).join()).toMatch(/version 1\.2\.2, expected 1\.2\.3/);
    expect(releaseProblems({ tag: 'v1.2.3', version: '1.2.3', manifests: [manifest({ key: 'MIIB…' })] }).join()).toMatch(/"key"/);
  });

  it('a pre-release keeps its X.Y.Z in the manifest (WXT moves the rest to version_name)', () => {
    expect(manifestVersionOf('1.2.3-beta.1')).toBe('1.2.3');
    expect(releaseProblems({ tag: 'v1.2.3-beta.1', version: '1.2.3-beta.1', manifests: [manifest()] })).toEqual([]);
  });
});
