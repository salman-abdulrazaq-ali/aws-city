import { AdminGetUserCommand, type CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Principal } from '../auth.js';

export const MFA_REQUIRED_MESSAGE = 'Turn on an authenticator app first (Deploy tab → Protect your account). It keeps your AWS account safe if your password leaks.';

/**
 * How recent a sign-in must be to link an AWS account, approve a write or apply a fix. "MFA is on" alone isn't enough:
 * a refresh token lasts 30 days and refreshing keeps the original auth_time, so someone holding a stolen token could
 * otherwise approve without ever entering a code. A fresh sign-in asks for the password and the authenticator code.
 */
export const STEP_UP_MAX_AGE_MS = 30 * 60_000;
export const REAUTH_MESSAGE = 'For your safety, sign in again to confirm this. It’s been a while since you entered your password and code.';
/** Signed in within STEP_UP_MAX_AGE_MS. No auth_time (an unexpected token) counts as not recent. */
export const recentSignIn = (p: Principal, now = Date.now()) => p.authTime !== undefined && now - p.authTime <= STEP_UP_MAX_AGE_MS && p.authTime <= now + 60_000;

/**
 * Step-up for linking an AWS account and for every write to it (hosted): agents can change that account, so the
 * player must have TOTP MFA on. Once TOTP is enrolled Cognito challenges every sign-in, so "enrolled now" is the
 * check (turning MFA off after linking stops writes within a minute: the cache time). Players who sign in with Google
 * have their MFA at Google (Cognito can't add a factor to a federated user). A "yes" is cached for 60 s by default
 * (one AdminGetUser a minute per active player); a "no" is re-checked every time so turning MFA on works at once.
 */
export const createMfaCheck = (deps: { cognito: Pick<CognitoIdentityProviderClient, 'send'>; userPoolId: string; cacheMs?: number; now?: () => number }) => {
  const now = deps.now ?? Date.now;
  const ok = new Map<string, number>();
  let nextSweep = 0;
  return async (p: Principal): Promise<boolean> => {
    const t = now();
    // Expired entries are dropped (at most once a minute), so the map holds only recent players.
    if (t >= nextSweep) {
      nextSweep = t + 60_000;
      for (const [sub, until] of ok) if (until <= t) ok.delete(sub);
    }
    const until = ok.get(p.sub);
    if (until && until > t) return true;
    const user = await deps.cognito.send(new AdminGetUserCommand({ UserPoolId: deps.userPoolId, Username: p.username ?? p.sub }));
    const ready = user.UserStatus === 'EXTERNAL_PROVIDER' || (user.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA');
    if (ready) ok.set(p.sub, now() + (deps.cacheMs ?? 60_000));
    else ok.delete(p.sub);
    return ready;
  };
};
