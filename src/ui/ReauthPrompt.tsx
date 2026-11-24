import { useEffect, useRef } from 'react';
import { signIn } from '@/app/runtime';
import { useCity } from '@/state/store';

/**
 * Step-up: linking an AWS account, approving a write and applying a fix need a sign-in from the last 30 minutes (the
 * server's recentSignIn, error code reauth_required). "Sign in again" asks for the password and authenticator code
 * (prompt=login), then the player presses their button again.
 */
export function ReauthPrompt() {
  const needed = useCity((s) => s.account.reauthRequired);
  const signingIn = useCity((s) => s.signingIn);
  const box = useRef<HTMLDivElement>(null);
  // Brought into view when it appears (seen 24 Nov 2026: Turn on asked for a fresh sign-in, but this box sat at the top of
  // the card, out of view, so the player signed out and in from the ⋯ menu instead).
  useEffect(() => {
    if (needed) box.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [needed]);
  if (!needed) return null;
  return (
    <div className="field-error" role="alert" ref={box}>
      <p>🔒 For your safety, sign in again to confirm this. It’s been a while since you entered your password and code.</p>
      <button type="button" className="btn primary" disabled={signingIn} aria-busy={signingIn} onClick={() => signIn({ fresh: true })}>
        {signingIn ? 'Waiting for sign-in…' : 'Sign in again'}
      </button>
    </div>
  );
}
