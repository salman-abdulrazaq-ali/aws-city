// The player's own AWS account, wherever it's reached from: ⋯ → Account and the To-do row open its card in Deploy;
// Deploy's "Your data" and ⋯ share one "Delete my account" confirm; the linked card and City care share the step lists
// (update the role, turn fixes on) and "Check again". The rules are pure in src/state/account.ts.

import { useEffect, useRef, useState, type RefObject } from 'react';
import { confirmRoleUpdate, deleteAccount, linkAccount, openUrl, recheckAccount } from '@/app/runtime';
import {
  CLEANUP_OFF,
  CLEANUP_ROLE_VERSION,
  CLEANUP_SWITCH,
  cleanupCommand,
  cleanupOn,
  cleanupSteps,
  connectOffer,
  accountTitle,
  connectsPlayer,
  FIXES_ON_STEPS,
  LOCAL_FIXES_COMMAND,
  regionName,
  roleUpdateSteps,
  stacksUrl,
  stepsText,
  stillBuilt,
} from '@/state/account';
import { connectTask } from '@/state/simple';
import { bus } from '@/state/bus';
import { AWS_PROFILE_NAME, useCity } from '@/state/store';
import { useCopy } from './feedback';
import { isOnline } from './logic';
import type { OpenTab } from './QuestLog';
import { Plain } from './Term';
import { useDialog } from './useDialog';
import { usePending } from './usePending';

/**
 * Opens the account card in Deploy (as a button that names a tab does: shown while the player is there). Without a
 * working link the linking steps unfold at once: the player asked for them.
 */
export function openAccountCard(openTab?: OpenTab) {
  const s = useCity.getState();
  if (!s.account.linked) s.patchAccount({ wantsLink: true });
  if (openTab) openTab('deploy');
  else bus.emit('showTab', { tab: 'deploy' });
}

/** The To-do row's offer for a hosted, signed-in player with no working link (src/state/account.ts connectOffer). */
export const useConnectOffer = () => useCity((s) => connectOffer({ hosted: s.hosted, status: s.backendStatus, account: s.account }));

/**
 * The shift's quiet line (Everything mode) for a hosted, signed-in player with no working link: the To-do row's words,
 * a small button (never the shift's one primary button).
 */
export function ConnectLine({ openTab }: { openTab: OpenTab }) {
  const offer = useConnectOffer();
  if (!offer) return null;
  const t = connectTask(offer);
  return (
    <section className="connect-line" aria-label={t.title}>
      <span className="connect-text">
        <b>{t.title}</b>
        <small className="muted">
          <Plain text={t.why} />
        </small>
      </span>
      <button className="btn small" title={`${t.action} (opens Deploy)`} onClick={() => openAccountCard(openTab)}>
        {t.action}
        <small className="todo-where"> (opens Deploy)</small>
      </button>
    </section>
  );
}

/** Numbered steps in plain words, with one button that copies them all (`copy`: the text copied, when it says more). */
export function StepList({ steps, copy, label }: { steps: readonly string[]; copy?: string; label: string }) {
  const [copied, doCopy] = useCopy();
  return (
    <>
      <ol className="account-steps" aria-label={label}>
        {steps.map((s) => (
          <li key={s}>
            <Plain text={s} />
          </li>
        ))}
      </ol>
      <button className="btn tiny" onClick={() => doCopy(copy ?? stepsText(steps))}>
        {copied ? 'Copied ✓' : 'Copy the steps'}
      </button>
    </>
  );
}

/** "Open the AWSCity stack ↗": CloudFormation's stacks page in the linked Region (an AWS Console page). */
export function StackLink({ region, children = 'Open the AWSCity stack ↗' }: { region: string; children?: string }) {
  return (
    <button className="btn tiny" onClick={() => openUrl(stacksUrl(region))} title={`CloudFormation in ${region}`}>
      {children}
    </button>
  );
}

/**
 * "Check again": asks the linked role once more whether it allows fixes (v2.19 account.recheck, read-only:
 * src/app/runtime.ts recheckAccount), after AllowFixes was turned on in CloudFormation. Hosted only (FixesOn). It waits
 * for the account's answer, an error, or 15 s.
 */
export function CheckAgain() {
  const accountId = useCity((s) => s.account.accountId);
  const seq = useCity((s) => s.account.seq);
  const offline = useCity((s) => !isOnline(s.backendKind, s.backendStatus));
  const pending = usePending();
  const { clear } = pending;
  useEffect(() => clear('check'), [seq, clear]);
  if (!accountId) return null;
  const busy = pending.is('check');
  return (
    <button
      className="btn tiny"
      disabled={busy || offline}
      aria-busy={busy}
      onClick={() => {
        const requestId = recheckAccount();
        if (requestId) pending.start('check', requestId);
      }}
    >
      {busy ? (
        <>
          <span className="spinner" aria-hidden="true" /> Checking…
        </>
      ) : (
        'Check again'
      )}
    </button>
  );
}

/**
 * Fixes are off (AllowFixes false): how to turn them on, said before any approve or MFA. Hosted: the CloudFormation
 * steps and Check again. The local server runs the developer's own profile, so there it's a restart with fixes allowed.
 */
export function FixesOn({ region }: { region: string }) {
  const hosted = useCity((s) => s.hosted);
  const demo = useCity((s) => s.backendKind === 'mock');
  if (demo)
    return (
      <div className="account-howto">
        <p className="muted">Practice account: in Deploy, press Use another Region or account, tick Allow small fixes, then Verify again.</p>
      </div>
    );
  if (!hosted)
    return (
      <div className="account-howto">
        <p className="muted">
          Fixes are off on this local server. Restart it with them on: <code>{LOCAL_FIXES_COMMAND}</code> (you still approve each fix).
        </p>
      </div>
    );
  return (
    <div className="account-howto">
      <StepList steps={FIXES_ON_STEPS} label="Turn small fixes on" />
      <div className="row">
        <StackLink region={region} />
        <CheckAgain />
      </div>
    </div>
  );
}

/** The player's AWS CLI profile for their own terminal (prefs.awsProfile): one box, shared by every one-command step. */
export function AwsProfileInput({ placeholder = 'e.g. city-047 (leave empty in CloudShell)' }: { placeholder?: string }) {
  const profile = useCity((s) => s.prefs.awsProfile);
  return (
    <label className="row aws-profile">
      <span className="label">Your AWS CLI profile</span>
      <input
        value={profile ?? ''}
        placeholder={placeholder}
        onChange={(e) => useCity.getState().setPref('awsProfile', AWS_PROFILE_NAME.test(e.target.value.trim()) ? e.target.value.trim() : undefined)}
        spellCheck={false}
        autoCapitalize="off"
      />
    </label>
  );
}

/**
 * "Let the city change things you made" (asked for on 23 Nov 2026), in the linked account's card: Off by default, which
 * is today's rule (only what the city built). The switch lives in the player's own AWS account (the AWSCity stack's
 * AllowCleanup, player role v6), so the city can't turn it on by itself: Turn on/off shows the stack update and "I've
 * updated the stack" (whose fresh link and verify record it). The demo's practice account plays it with a new link.
 */
export function CleanupSwitch({ region }: { region: string }) {
  const account = useCity((s) => s.account);
  const hosted = useCity((s) => s.hosted);
  const demo = useCity((s) => s.backendKind === 'mock');
  const profile = useCity((s) => s.prefs.awsProfile);
  const [open, setOpen] = useState(false);
  const [copied, copy] = useCopy();
  const [copiedCmd, copyCmd] = useCopy();
  const pending = usePending();
  const { clear } = pending;
  useEffect(() => clear('cmd'), [account.linkUrl, clear]);
  if (!hosted && !demo) return null;
  const on = account.cleanup === true;
  const want = !on;
  // A role older than v6 has no AllowCleanup: the same update brings the newer template.
  const older = account.roleVersion !== undefined && account.roleVersion < CLEANUP_ROLE_VERSION;
  const newTemplate = older ? account.templateUrl : undefined;
  const label = connectsPlayer(account.linkUrl);
  const command = cleanupCommand(account, want, label, profile);
  // No command yet because the role's version is unknown or older than v5 and the stack's ConnectsPlayer name isn't
  // known: a fresh setup link names it (as RoleUpdate's "Get the ConnectsPlayer name" does).
  const needsName = !command && !label && (account.roleVersion ?? 0) < 5 && !!account.templateUrl;
  const verb = want ? 'Turn on' : 'Turn off';
  return (
    <section className="account-howto cleanup-switch" aria-labelledby="cleanup-switch-title">
      <p className="row">
        <b id="cleanup-switch-title">{CLEANUP_SWITCH}:</b>{' '}
        <span className={`switch-state ${on ? 'on' : 'off'}`}>{on ? 'On ✅' : 'Off'}</span>
        <button
          className="btn tiny"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            // What the next "I've updated the stack" records (confirmRoleUpdate's link carries it).
            if (!open) useCity.getState().patchAccount({ allowCleanup: want });
          }}
        >
          {verb}
        </button>
      </p>
      <p className="muted small">
        <Plain text={on ? cleanupOn(regionName(region)) : CLEANUP_OFF} />
      </p>
      {open &&
        (demo ? (
          <p className="muted">
            Practice account: press Use another Region or account, {want ? 'tick' : 'untick'} “{CLEANUP_SWITCH}”, then Verify again.
          </p>
        ) : (
          <>
            {/* Three steps, in the words the chat used (asked for on 24 Nov 2026: "as clear as your chat"). */}
            <ol className="account-steps cleanup-steps" aria-label={`${verb} “${CLEANUP_SWITCH}”`}>
              <li>
                Open Terminal (or CloudShell) signed in to account <b>{account.accountId ? accountTitle(account.accountId) : 'the linked one'}</b>.
                <AwsProfileInput />
              </li>
              <li>
                {command ? (
                  <>
                    Paste this and press Enter. It takes about a minute:
                    <code className="workshop-cmd">{command}</code>
                    <button className="btn tiny" onClick={() => copyCmd(command)}>
                      {copiedCmd ? 'Copied ✓' : 'Copy the command'}
                    </button>
                  </>
                ) : needsName ? (
                  <>
                    Get your command (one press makes it for your account):{' '}
                    <button
                      className="btn tiny"
                      disabled={pending.is('cmd')}
                      aria-busy={pending.is('cmd')}
                      onClick={() => {
                        const requestId = linkAccount(region, { allowCleanup: want });
                        if (requestId) pending.start('cmd', requestId);
                      }}
                    >
                      {pending.is('cmd') ? 'Getting it…' : 'Get the command'}
                    </button>
                  </>
                ) : (
                  'Update the AWSCity stack in the CloudFormation console (the steps below).'
                )}
              </li>
              <li>
                When the prompt comes back with no error, press: <UpdatedStack allowCleanup={want} />
              </li>
            </ol>
            <details className="why" open={!command && !needsName}>
              <summary>Prefer clicking? Use the CloudFormation console instead</summary>
              <StepList steps={cleanupSteps(want, newTemplate)} label={`${verb} in the CloudFormation console`} />
              {newTemplate && (
                <div className="template-url">
                  <code>{newTemplate}</code>
                  <button className="btn tiny" onClick={() => copy(newTemplate)}>
                    {copied ? 'Copied ✓' : 'Copy the template address'}
                  </button>
                  {label && (
                    <span>
                      ConnectsPlayer: <code>{label}</code>
                    </span>
                  )}
                </div>
              )}
              <StackLink region={region} />
            </details>
          </>
        ))}
    </section>
  );
}

/**
 * "I've updated the stack": the city can't read the stack's version, so the player says the update is done (a fresh
 * setup link, then a verify marked `updated`: src/app/runtime.ts confirmRoleUpdate). It waits for the account's answer,
 * an error, or 15 s.
 */
function UpdatedStack({ allowCleanup }: { allowCleanup?: boolean } = {}) {
  const seq = useCity((s) => s.account.seq);
  const offline = useCity((s) => !isOnline(s.backendKind, s.backendStatus));
  const pending = usePending();
  const { clear } = pending;
  useEffect(() => clear('updated'), [seq, clear]);
  const busy = pending.is('updated');
  return (
    <button
      className="btn tiny"
      disabled={busy || offline}
      aria-busy={busy}
      onClick={() => {
        const requestId = confirmRoleUpdate(allowCleanup !== undefined ? { allowCleanup } : {});
        if (requestId) pending.start('updated', requestId);
      }}
    >
      {busy ? (
        <>
          <span className="spinner" aria-hidden="true" /> Checking…
        </>
      ) : (
        'I’ve updated the stack'
      )}
    </button>
  );
}

/**
 * "Update your AWS City role (v3 → v4)": the steps in CloudFormation, the template's address to paste and the
 * ConnectsPlayer name the newest role asks for (it comes with a setup link: "Get the name to type" asks for a fresh one,
 * same ExternalId), then "I've updated the stack" (the version is the one installed from the city's link: the account
 * can't be read for it).
 */
export function RoleUpdate({ region, from, to, templateUrl }: { region: string; from: number; to: number; templateUrl?: string }) {
  const [copied, copy] = useCopy();
  const [copiedName, copyName] = useCopy();
  const linkUrl = useCity((s) => s.account.linkUrl);
  const label = connectsPlayer(linkUrl);
  const offline = useCity((s) => !isOnline(s.backendKind, s.backendStatus));
  const pending = usePending();
  const { clear } = pending;
  useEffect(() => clear('name'), [linkUrl, clear]);
  return (
    <section className="account-howto role-update" aria-labelledby="role-update-title">
      <b id="role-update-title">
        Update your AWS City role (v{from} → v{to})
      </b>
      <p className="muted">
        <Plain text="A newer role is out: it lets the city do what this version of the game asks. Your link and ExternalId stay the same." />
      </p>
      <p className="muted">
        <Plain text="The city can’t read your stack for its version: it goes by the one you installed from its link. So press “I’ve updated the stack” once CloudFormation says UPDATE_COMPLETE." />
      </p>
      <StepList steps={roleUpdateSteps(undefined, label ? 'the name below' : undefined)} copy={stepsText(roleUpdateSteps(templateUrl, label))} label="Update your AWS City role" />
      {templateUrl && (
        <div className="template-url">
          <code>{templateUrl}</code>
          <button className="btn tiny" onClick={() => copy(templateUrl)}>
            {copied ? 'Copied ✓' : 'Copy the template address'}
          </button>
        </div>
      )}
      <div className="template-url">
        {label ? (
          <>
            <span>
              ConnectsPlayer: <code>{label}</code>
            </span>
            <button className="btn tiny" onClick={() => copyName(label)}>
              {copiedName ? 'Copied ✓' : 'Copy the name'}
            </button>
          </>
        ) : (
          <button
            className="btn tiny"
            disabled={pending.is('name') || offline}
            aria-busy={pending.is('name')}
            onClick={() => {
              const requestId = linkAccount(region);
              if (requestId) pending.start('name', requestId);
            }}
          >
            {pending.is('name') ? 'Getting it…' : 'Get the ConnectsPlayer name to type'}
          </button>
        )}
      </div>
      <div className="row">
        <StackLink region={region} />
        <UpdatedStack />
      </div>
    </section>
  );
}

/**
 * The confirm before "Delete my account": it can't be undone, and anything the city built that's still in the AWS
 * account keeps billing after it (take it down first). `showBuilds` opens Deploy's My builds (from ⋯).
 */
export function DeleteConfirm({ onCancel, showBuilds, titleId, keepRef }: {
  onCancel: () => void;
  showBuilds?: () => void;
  titleId?: string;
  keepRef?: RefObject<HTMLButtonElement | null>;
}) {
  const left = useCity((s) => stillBuilt(s.inventory, Object.values(s.deploys)));
  return (
    <>
      <b id={titleId}>Delete your account and saved progress?</b>
      <span className="muted">This can’t be undone.</span>
      {left > 0 && (
        <p className="field-error delete-billing">
          ⚠️ {left === 1 ? 'One thing the city built is' : `${left} things the city built are`} still in your AWS account, and they keep billing after this. Take
          them down first (Deploy → My builds).{' '}
          {showBuilds && (
            <button className="btn tiny" onClick={showBuilds}>
              Show my builds
            </button>
          )}
        </p>
      )}
      <div className="row">
        <button ref={keepRef} className="btn" autoFocus onClick={onCancel}>
          Keep it
        </button>
        <button
          className="btn warn"
          onClick={() => {
            onCancel();
            void deleteAccount();
          }}
        >
          Yes, delete
        </button>
      </div>
    </>
  );
}

/** ⋯ → Account → Delete my account…: the same confirm, as a modal over the whole app. */
export function DeleteAccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const box = useRef<HTMLElement>(null);
  // The safe choice takes focus (not "Show my builds", the first control in the warning).
  const keep = useRef<HTMLButtonElement>(null);
  useDialog(open, box, onClose, keep);
  if (!open) return null;
  return (
    <div className="finding-scrim account-scrim" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section ref={box} className="finding-card account-card confirm" role="alertdialog" aria-modal="true" aria-labelledby="delete-account-title">
        <DeleteConfirm
          keepRef={keep}
          titleId="delete-account-title"
          onCancel={onClose}
          showBuilds={() => {
            onClose();
            bus.emit('showTab', { tab: 'deploy' });
          }}
        />
      </section>
    </div>
  );
}
