import { openSwitchRole } from '@/app/runtime';
import { accountLabel, accountTitle, regionName } from '@/state/account';
import { useCity } from '@/state/store';

/**
 * The open AWS console is signed into another account than the one the city is linked to (consoleAccount.ts): what's
 * made there never shows in the city. Seen 23 Nov 2026: a console bucket and a CloudShell one went to the city's own
 * account. Shown where the player works (the prompt bar, Deploy, a workshop for real), with Switch role.
 */
export function ConsoleAccountWarning() {
  const consoleAccount = useCity((s) => s.consoleAccount);
  const account = useCity((s) => s.account);
  const kind = useCity((s) => s.backendKind);
  if (kind === 'mock' || !consoleAccount || !account.linked || !account.accountId || consoleAccount === account.accountId) return null;
  return (
    <div className="field-error console-account" role="alert">
      ⚠️ Your AWS console is signed in to account <b>{accountLabel(consoleAccount)}</b>, but the city is linked to{' '}
      <b>{accountTitle(account.accountId)}</b>
      {account.region ? ` (${regionName(account.region)})` : ''}. What you make there (CloudShell too) won’t show in the city.{' '}
      <button type="button" className="btn tiny" onClick={() => openSwitchRole()}>
        Switch role into {accountTitle(account.accountId)}
      </button>
    </div>
  );
}
