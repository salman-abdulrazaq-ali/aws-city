import { AdminGetUserCommand, type CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Principal } from '../auth.js';
import type { MfaStore } from '../store/types.js';

export const MFA_REQUIRED_MESSAGE = 'Turn on an authenticator app first (⋯ → Account → Connect your AWS account → Protect your account first). It keeps your AWS account safe if your password leaks.';
export const SIGN_IN_AGAIN_MESSAGE = 'Your authenticator app is on, but this sign-in started before it was. Sign out, then sign in again with your app’s code.';

/** ok = go ahead; enrol = no authenticator yet (mfa_required); reauth = this session signed in before it was turned on. */
export type StepUp = 'ok' | 'enrol' | 'reauth';

/** In-memory `since` times, for a server without a store (tests, or a setup that doesn't pass one). */
export const memoryMfa = (): MfaStore => {
  const times = new Map<string, number>();
  return {
    async since(sub, now) {
      if (!times.has(sub)) times.set(sub, now);
      return times.get(sub)!;
    },
    async get(sub) {
      return times.get(sub);
    },
    async forget(sub) {
      times.delete(sub);
    },
  };
};

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
 * player must have TOTP MFA on, and this session must have signed in after it was turned on. "Enrolled now" alone
 * isn't enough: a session that signed in with only a (perhaps stolen) password before the authenticator existed would
 * pass it. So the server keeps, per player, the first time it saw TOTP on (`since`, in the player store) and compares
 * the access token's auth_time with it. The extension tells the server right after enrolling (POST /me/mfa, a few tries)
 * and then signs every session out, so the sign-in that follows is after `since`; if that call never landed, the first
 * sight is dated when the server first looks, and the player may have to sign in twice (the extension says so; the safe
 * side: nothing from before the authenticator can pass). Seeing TOTP off forgets `since`, so turning
 * it on again starts over. Players who sign in with Google have their MFA at Google (Cognito can't add a factor to a
 * federated user) and pass. A "yes" is cached for 60 s by default (one AdminGetUser a minute per active player); a
 * "no" is re-checked every time so turning MFA on works at once.
 */
export const createMfaCheck = (deps: {
  cognito: Pick<CognitoIdentityProviderClient, 'send'>;
  userPoolId: string;
  /** Where `since` is kept (Stores.mfa). Without one it lives in this process only, so a restart asks again. */
  since?: MfaStore;
  cacheMs?: number;
  now?: () => number;
}) => {
  const now = deps.now ?? Date.now;
  const store = deps.since ?? memoryMfa();
  /** sub → until when the yes is trusted, and since when TOTP has been on (0 = federated, always passes). */
  const ok = new Map<string, { until: number; since: number }>();
  let nextSweep = 0;
  // auth_time has whole seconds: a sign-in in the same second as `since` counts as after it.
  const verdict = (p: Principal, since: number): StepUp => (since === 0 || (p.authTime !== undefined && p.authTime >= Math.floor(since / 1000) * 1000) ? 'ok' : 'reauth');
  return async (p: Principal): Promise<StepUp> => {
    const t = now();
    // Expired entries are dropped (at most once a minute), so the map holds only recent players.
    if (t >= nextSweep) {
      nextSweep = t + 60_000;
      for (const [sub, e] of ok) if (e.until <= t) ok.delete(sub);
    }
    const cached = ok.get(p.sub);
    if (cached && cached.until > t) return verdict(p, cached.since);
    const user = await deps.cognito.send(new AdminGetUserCommand({ UserPoolId: deps.userPoolId, Username: p.username ?? p.sub }));
    let since: number;
    if (user.UserStatus === 'EXTERNAL_PROVIDER') since = 0;
    else if ((user.UserMFASettingList ?? []).includes('SOFTWARE_TOKEN_MFA')) {
      // A first sight with nothing recorded (POST /me/mfa didn't land) is dated now. Not from UserLastModifiedDate: whether
      // turning TOTP on moves it is unconfirmed, and an earlier date could pass a session from before (a stolen password).
      since = await store.since(p.sub, now());
    } else {
      ok.delete(p.sub);
      await store.forget(p.sub);
      return 'enrol';
    }
    ok.set(p.sub, { until: now() + (deps.cacheMs ?? 60_000), since });
    return verdict(p, since);
  };
};
