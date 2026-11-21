// The player's own AWS account, wherever it's reached from: ⋯ → Account and the To-do row open its card in Deploy;
// Deploy's "Your data" and ⋯ share one "Delete my account" confirm; the linked card and City care share the step lists
// (update the role, turn fixes on) and "Check again". The rules are pure in src/state/account.ts.

import { useEffect, useRef, type RefObject } from 'react';
import { deleteAccount, linkAccount, openUrl, recheckAccount } from '@/app/runtime';
import { connectOffer, connectsPlayer, FIXES_ON_STEPS, roleUpdateSteps, stacksUrl, stepsText, stillBuilt } from '@/state/account';
import { connectTask } from '@/state/simple';
import { bus } from '@/state/bus';
import { useCity } from '@/state/store';
import { useCopy } from './feedback';
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
 * "Check again": checks the linked account once more (a fresh setup link, then verify: src/app/runtime.ts
 * recheckAccount), so the server reads the role's version and whether fixes are allowed after an update in
 * CloudFormation. It waits for the account's answer, an error, or 15 s.
 */
export function CheckAgain() {
  const accountId = useCity((s) => s.account.accountId);
  const seq = useCity((s) => s.account.seq);
  const offline = useCity((s) => s.backendKind !== 'mock' && s.backendStatus !== 'connected');
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

/** Fixes are off for the AWSCity role (AllowFixes false): how to turn them on, said before any approve or MFA. */
export function FixesOn({ region }: { region: string }) {
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

/**
 * "Update your AWS City role (v3 → v4)": the steps in CloudFormation, the template's address to paste and the
 * ConnectsPlayer name the newest role asks for (it comes with a setup link: "Get the name to type" asks for a fresh one,
 * same ExternalId), then Check again (a fresh link and verify, so the server reads the new version).
 */
export function RoleUpdate({ region, from, to, templateUrl }: { region: string; from: number; to: number; templateUrl?: string }) {
  const [copied, copy] = useCopy();
  const [copiedName, copyName] = useCopy();
  const label = useCity((s) => connectsPlayer(s.account.linkUrl));
  const linkUrl = useCity((s) => s.account.linkUrl);
  const offline = useCity((s) => s.backendKind !== 'mock' && s.backendStatus !== 'connected');
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
        <CheckAgain />
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
