import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  canDeleteAccount,
  canDownloadData,
  canSetUpMfa,
  confirmMfaSetup,
  decideDeploy,
  downloadMyData,
  isSafeAwsUrl,
  linkAccount,
  mfaStatus,
  openPrivacyPolicy,
  openUrl,
  planDeploy,
  privacyPolicyUrl,
  removeResource,
  signIn,
  signOut,
  startMfaSetup,
  teardownDeploy,
  unlinkAccount,
  verifyAccount,
} from '@/app/runtime';
import { connectsPlayer, defaultLinkRegion, gameBuilds, isLinkRegion, LINK_REGIONS, linkChecklist, regionName, removeTarget, roleUpdate } from '@/state/account';
import { useCity, type DeployView } from '@/state/store';
import { GUARDED_BLUEPRINTS, isPracticeDeploy } from '@/backend/ServerBackend';
import { TEMPLATES } from '@/world/content';
import { serviceById } from '@/world/taxonomy';
import { TemplateView } from './TemplateView';
import { offered, perUnit, pricesFor } from '@/world/regions';
import { DeleteConfirm, FixesOn, RoleUpdate, StackLink } from './Account';
import { useCopy } from './feedback';
import { costLine, offlineReason } from './logic';
import { usePending } from './usePending';
import { ForLearners } from './Term';
import { Plain } from './Term';

/**
 * What a build preview costs: in the practice account, plainly free (the real estimate folds away for learners);
 * against a real account, AWS's estimate.
 */
export function CostNote({ note, className = 'muted' }: { note: string; className?: string }) {
  const kind = useCity((s) => s.backendKind);
  const line = costLine(note, kind);
  return (
    <div className={className}>
      💰 {line}
      {line !== note && (
        <ForLearners>
          <span className="muted small">In a real account: {note}</span>
        </ForLearners>
      )}
    </div>
  );
}

const STATUS_TEXT: Record<DeployView['status'], string> = {
  preview: 'waiting for your OK',
  creating: 'building…',
  complete: 'live',
  failed: 'failed',
  rejected: 'rejected',
  deleting: 'tearing down…',
  deleted: 'deleted',
};

/** A button that shows a spinner + busy label while its request is in flight. */
function PendingButton({ pending, busyLabel, children, className = 'btn', disabled, onClick, title, buttonRef }: {
  buttonRef?: (el: HTMLButtonElement | null) => void;
  pending: boolean;
  busyLabel: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button ref={buttonRef} className={className} disabled={disabled || pending} aria-busy={pending} onClick={onClick} title={title}>
      {pending ? (
        <>
          <span className="spinner" aria-hidden="true" /> {busyLabel}
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** A numbered step: done (✓), current (lit) or still to come. `after`: what a done step still offers ("Change the Region"). */
function Step({ n, state, title, children, after }: { n: number; state: 'done' | 'now' | 'todo'; title: string; children?: ReactNode; after?: ReactNode }) {
  return (
    <li className={`link-step ${state}`}>
      <span className="step-n" aria-hidden="true">
        {state === 'done' ? '✓' : n}
      </span>
      <div className="step-body">
        <b>{title}</b>
        {state === 'now' && children}
        {state === 'done' && after}
      </div>
    </li>
  );
}

/**
 * Step-up MFA: an authenticator app protects the AWS account agents can change (server/src/accounts/mfa.ts). `replace`:
 * the player already has one and sets up a new one (same steps). Either way every session ends after: sign in again.
 */
function MfaSetup({ replace = false }: { replace?: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, copy] = useCopy();
  const confirm = () => confirmMfaSetup(code);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mfa">
      <b>{replace ? '🔐 Replace your authenticator' : '🔐 Protect your account first'}</b>
      <p className="muted">
        {replace
          ? 'Add AWS City to your new app (or phone) with a new key. The old one stops working.'
          : 'Agents can change your AWS account, so linking it, approving a change and applying a fix need an authenticator app (Google Authenticator, 1Password, Authy…).'}{' '}
        Then you sign in again with its code.
      </p>
      {!setup ? (
        <PendingButton className="btn primary" pending={busy} busyLabel="Starting…" onClick={() => void run(async () => setSetup(await startMfaSetup()))}>
          {replace ? 'Get a new key' : 'Set up an authenticator'}
        </PendingButton>
      ) : (
        <>
          <label className="field-hint" htmlFor="mfa-key">
            1. In your app, add an account with this key (time-based)
          </label>
          <input id="mfa-key" readOnly value={setup.secret.replace(/(.{4})/g, '$1 ').trim()} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
          <button className="btn" onClick={() => copy(setup.secret)}>
            {copied ? 'Copied ✓' : 'Copy key'}
          </button>
          <label className="field-hint" htmlFor="mfa-code">
            2. Type the 6-digit code it shows
          </label>
          <div className="row">
            <input
              id="mfa-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && void run(confirm)}
            />
            <PendingButton className="btn primary" pending={busy} busyLabel="Checking…" disabled={code.length !== 6} onClick={() => void run(confirm)}>
              Turn on
            </PendingButton>
          </div>
        </>
      )}
    </div>
  );
}

/** Your data's "Authenticator: on · Replace" row (hosted email players; Google keeps its own second step). */
function AuthenticatorRow() {
  const [state, setState] = useState<'on' | 'off' | 'external'>();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    void mfaStatus().then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, []);
  if (!canSetUpMfa() || !state || state === 'external') return null;
  return (
    <>
      <p className="row">
        <span>
          Authenticator: <b>{state}</b> ·{' '}
        </span>
        <button className="btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {state === 'on' ? 'Replace' : 'Set up'}
        </button>
      </p>
      {open && <MfaSetup replace={state === 'on'} />}
    </>
  );
}

/**
 * Real deploys to the player's own AWS account: link via a CloudFormation quick-create role (ExternalId) in the Region
 * the player picks, preview a change set, approve it, tear it down; check the link, update the role, disconnect.
 * Curated templates only.
 */
export function DeployPanel() {
  const account = useCity((s) => s.account);
  const cityRegion = useCity((s) => s.cityRegion);
  const deployMap = useCity((s) => s.deploys);
  const deploys = Object.values(deployMap);
  const status = useCity((s) => s.backendStatus);
  const kind = useCity((s) => s.backendKind);
  const hosted = useCity((s) => s.hosted);
  const inventory = useCity((s) => s.inventory);
  const offline = offlineReason(kind, status);
  const [role, setRole] = useState('');
  const findings = useCity((s) => s.findings);
  // Fixes are approved in their finding's card; here they're only a history, never next to Tear down.
  const stacks = deploys.filter((d) => !d.findingId);
  const fixes = deploys.filter((d) => d.findingId && d.status !== 'preview' && d.status !== 'rejected');
  // What the city built in the account, from its inventory: it survives a reload (a session's stacks don't).
  const builds = useMemo(() => (account.linked ? gameBuilds(inventory) : []), [account.linked, inventory]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  /** The linking steps stay folded until the player asks for them (this whole tab is optional). */
  const wantsLink = !!account.wantsLink;
  /** The Region picked in step 1 (until then: the one asked for last, the linked one, else this city's). */
  const [picked, setPicked] = useState<string>();
  const region = picked ?? defaultLinkRegion(account, cityRegion);
  /** The Region the setup link out now was made for (step 2's checklist names it). */
  const linkRegion = account.linkRegion ?? region;
  // Disconnect and "another Region" are for an account the player linked (the local server reads the developer's own).
  const canUnlink = hosted || kind === 'mock';
  const mode = useCity((s) => s.deployMode);
  const blueprints = mode === 'guarded' ? GUARDED_BLUEPRINTS : TEMPLATES;
  const signingIn = useCity((s) => s.signingIn);
  const pending = usePending();
  const { clear } = pending;

  // Clear each pending button when the event it was waiting for lands.
  useEffect(() => clear('link'), [account.linkUrl, clear]);
  useEffect(() => {
    clear('verify');
    clear('unlink');
  }, [account.seq, clear]);
  useEffect(() => {
    clear('link');
    clear('verify');
  }, [account.mfaRequired, clear]);
  // The Disconnect confirm closes once the account's answer lands (linked or not).
  useEffect(() => setConfirmUnlink(false), [account.linked, account.broken]);
  const deployCount = deploys.length;
  // Only a new stack (count change) resolves a plan request, or a take-down's (its preview is a new deploy).
  const pendingKeys = useRef(pending.keys);
  pendingKeys.current = pending.keys;
  useEffect(() => {
    for (const k of pendingKeys.current) if (k.startsWith('plan:') || k.startsWith('remove:')) clear(k);
  }, [deployCount, clear]);
  useEffect(() => {
    for (const d of Object.values(deployMap)) {
      if (d.status !== 'preview') clear(`decide:${d.deployId}`);
      if (d.status !== 'complete') clear(`teardown:${d.deployId}`);
    }
  }, [deployMap, clear]);

  // A new preview opens below the blueprints, off-screen in the panel: bring it up and put focus on Approve.
  const approveRefs = useRef(new Map<string, HTMLButtonElement>());
  const seenPreviews = useRef<Set<string> | null>(null);
  const previewIds = stacks.filter((d) => d.status === 'preview').map((d) => d.deployId);
  const previewKey = previewIds.join(',');
  useEffect(() => {
    const ids = previewKey ? previewKey.split(',') : [];
    const seen = seenPreviews.current;
    seenPreviews.current = new Set(ids);
    if (!seen) return; // the first render: previews already waiting aren't news
    const fresh = ids.find((id) => !seen.has(id));
    const btn = fresh && approveRefs.current.get(fresh);
    if (btn) {
      btn.closest('.card')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
      btn.focus({ preventScroll: true });
    }
  }, [previewKey]);

  const verify = () => {
    const requestId = verifyAccount(role);
    if (requestId) pending.start('verify', requestId);
  };
  const getLink = (where: string, allowFixes: boolean) => pending.start('link', linkAccount(where, { allowFixes }));
  const restart = () => {
    setPicked(undefined);
    useCity.getState().restartLink();
  };

  /** The three linking steps (folded until the player asks; inside "How real accounts connect" in the demo). */
  const linkSteps =
    !wantsLink && !account.linkUrl && !account.mfaRequired ? (
      <button className="btn" onClick={() => useCity.getState().patchAccount({ wantsLink: true })}>
        Connect an AWS account
      </button>
    ) : (
      <ol className="link-steps">
        <Step
          n={1}
          state={account.linkUrl ? 'done' : 'now'}
          title={account.linkUrl ? `Get your setup link: ${regionName(linkRegion)}` : 'Pick a Region and get your setup link'}
          after={
            account.linkUrl && (
              <button className="btn tiny ghost" onClick={restart}>
                Change the Region
              </button>
            )
          }
        >
          <label className="field-hint" htmlFor="link-region">
            Region
          </label>
          <select id="link-region" className="link-region" value={region} onChange={(e) => setPicked(e.target.value)}>
            {LINK_REGIONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name} · {r.code}
                {r.optIn ? ' (opt-in)' : ''}
              </option>
            ))}
          </select>
          <p className="muted">
            <Plain text={`Your key will be made in ${regionName(region)}; the city reads that Region.`} />
            {LINK_REGIONS.find((r) => r.code === region)?.optIn && <Plain text=" It's an opt-in Region: turn it on in your account first (Account → AWS Regions)." />}
          </p>
          <PendingButton
            className="btn primary"
            pending={pending.is('link')}
            busyLabel="Getting your link…"
            disabled={!!offline}
            title={offline}
            onClick={() => getLink(region, !!account.allowFixes)}
          >
            Get my setup link
          </PendingButton>
        </Step>
        <Step n={2} state={account.linkUrl ? 'now' : 'todo'} title="Make a safe key for AWS City in your account">
          <p className="muted">
            <Plain text="One click sets up an IAM role with CloudFormation. It's a key that only opens what the quests need." />
          </p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!account.allowFixes}
              disabled={pending.is('link') || !!offline}
              // The choice is part of the setup link (AllowFixes): a new link is made for it.
              onChange={(e) => getLink(linkRegion, e.target.checked)}
            />
            <span>Allow small fixes (you still approve each one)</span>
          </label>
          {connectsPlayer(account.linkUrl) && (
            <p className="connects-player">
              The stack page will say <b>ConnectsPlayer: {connectsPlayer(account.linkUrl)}</b>. Don’t create the stack if that isn’t you.
            </p>
          )}
          <b className="checklist-title">What the console will ask</b>
          <ol className="account-steps link-checklist" aria-label="What the console will ask">
            {linkChecklist(linkRegion).map((line) => (
              <li key={line}>
                <Plain text={line} />
              </li>
            ))}
          </ol>
          <PendingButton className="btn primary" pending={pending.is('link')} busyLabel="Making your link…" onClick={() => openUrl(account.linkUrl!)}>
            Open CloudFormation ↗
          </PendingButton>
          <p className="muted small">This link works for a day. After that, get a new one: the key you made keeps working.</p>
          <details className="why">
            <summary>Details</summary>
            <div className="muted">
              ExternalId (a secret only AWS City knows): <code>{account.externalId}</code>
            </div>
          </details>
        </Step>
        <Step n={3} state={account.linkUrl ? 'now' : 'todo'} title="Tell us your account number (12 digits)">
          <form
            className="prompt-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (role.trim()) verify();
            }}
          >
            <input
              id="account-id"
              aria-label="AWS account ID or role ARN"
              placeholder="123456789012"
              value={role}
              onChange={(e) => setRole(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <PendingButton pending={pending.is('verify')} busyLabel="Checking…" disabled={!role.trim() || !!offline} title={offline} onClick={verify}>
              Verify
            </PendingButton>
          </form>
        </Step>
        {account.linked && (
          <li className="link-cancel">
            <button className="btn tiny ghost" onClick={() => useCity.getState().patchAccount({ wantsLink: false })}>
              Keep the account I have
            </button>
          </li>
        )}
      </ol>
    );

  /** "Disconnect": asked first; the server forgets the link, and the AWSCity stack stays until the player deletes it. */
  const unlinkConfirm = confirmUnlink && (account.linked || account.broken) && (
    <div className="confirm" role="alertdialog" aria-labelledby="unlink-title">
      <b id="unlink-title">Disconnect your AWS account?</b>
      <span className="muted">
        <Plain
          text={`AWS City stops reading and building in ${account.accountId ?? 'your account'}. What the city built stays there (take it down first in My builds), and so does the AWSCity stack until you delete it.`}
        />
      </span>
      <div className="row">
        <button className="btn" autoFocus onClick={() => setConfirmUnlink(false)}>
          Keep it linked
        </button>
        <PendingButton
          className="btn warn"
          pending={pending.is('unlink')}
          busyLabel="Disconnecting…"
          disabled={!!offline}
          title={offline}
          onClick={() => {
            const requestId = unlinkAccount();
            if (requestId) pending.start('unlink', requestId);
          }}
        >
          Yes, disconnect
        </PendingButton>
      </div>
    </div>
  );
  const update = roleUpdate(account);

  // Where the player is in building for real: connect, pick a blueprint, approve it.
  const at = !account.linked ? 0 : stacks.some((d) => d.status === 'preview') ? 2 : stacks.length ? 3 : 1;
  return (
    <div className="deploy">
      <ol className="build-path" aria-label="Build for real, step by step">
        {['Connect', 'Pick a blueprint', 'Approve it'].map((label, i) => (
          <li key={label} className={i < at ? 'done' : i === at ? 'now' : ''} aria-current={i === at ? 'step' : undefined}>
            <span aria-hidden="true">{i < at ? '✓' : i + 1}</span> {label}
          </li>
        ))}
      </ol>
      {offline && <p className="composer-note">{offline}</p>}
      {status === 'signed-out' && (
        <div className="card">
          <b>Sign in to your AWS City account</b>
          <p className="muted">Your progress and deploys are tied to your login.</p>
          <PendingButton className="btn primary" pending={signingIn} busyLabel="Waiting for sign-in…" onClick={signIn}>
            Sign in
          </PendingButton>
          {privacyPolicyUrl() && (
            <button className="btn tiny ghost" title="Opens in a new tab" onClick={openPrivacyPolicy}>
              Privacy policy ↗
            </button>
          )}
        </div>
      )}
      <div className="card account">
        <h3>Your AWS account</h3>
        {/* A linked player is asked too (approving a change, applying a fix): the setup shows whenever the server asks. */}
        {account.mfaRequired && canSetUpMfa() && <MfaSetup />}
        {/* This tab's link, verify or Disconnect the server refused (a failed verify, a link over a day old). */}
        {account.error && (
          <div className="field-error account-error" role="alert">
            ⚠️ {account.error}
            {((!account.linked && account.linkUrl) || wantsLink) && (
              <PendingButton className="btn tiny" pending={pending.is('link')} busyLabel="Getting your link…" disabled={!!offline} onClick={() => getLink(linkRegion, !!account.allowFixes)}>
                Get a new setup link
              </PendingButton>
            )}
          </div>
        )}
        {account.linked ? (
          <>
            <p className="linked">
              <span className="linked-badge">✓ Linked</span> <b>{account.accountId}</b>
              {account.region && (
                <span>
                  · {regionName(account.region)} <span className="muted">({account.region})</span>
                </span>
              )}
            </p>
            {account.message && <p className="muted">{account.message}</p>}
            {account.fixes !== undefined && (
              <p className="muted">
                Small fixes: <b>{account.fixes ? 'on' : 'off'}</b>
                {account.fixes ? ' (you approve each one)' : ' (City care explains what it finds, but changes nothing)'}
              </p>
            )}
            {account.fixes === false && account.region && (
              <details className="why">
                <summary>Turn small fixes on</summary>
                <FixesOn region={account.region} />
              </details>
            )}
            {update && account.region && <RoleUpdate region={account.region} {...update} />}
            {canUnlink && !wantsLink && (
              <div className="row account-actions">
                <button className="btn" onClick={restart}>
                  Use another Region or account
                </button>
                <button className="btn warn" onClick={() => setConfirmUnlink(true)}>
                  Disconnect
                </button>
              </div>
            )}
            {unlinkConfirm}
            {wantsLink && linkSteps}
          </>
        ) : account.broken ? (
          <>
            {/* The link is kept but its role stopped working: said here once, never as a toast on each reconnect. */}
            <div className="account-broken" role="status">
              <p className="field-error">
                ⚠️{' '}
                {account.message ??
                  `I can’t use the AWSCity role in ${account.accountId ?? 'your account'}${account.region ? ` (${account.region})` : ''} any more. Link it again, or disconnect.`}
              </p>
              {!wantsLink && (
                <div className="row account-actions">
                  <button
                    className="btn primary"
                    onClick={() => {
                      // A new setup link in the broken link's Region (same ExternalId), steps 2 and 3 to follow.
                      restart();
                      getLink(account.region && isLinkRegion(account.region) ? account.region : region, !!account.allowFixes);
                    }}
                  >
                    Link again
                  </button>
                  <button className="btn warn" onClick={() => setConfirmUnlink(true)}>
                    Disconnect
                  </button>
                </div>
              )}
            </div>
            {unlinkConfirm}
            {wantsLink && linkSteps}
          </>
        ) : (
          <>
            {/* A status's message is a hint (the welcome's "connect"), never an alert: refusals come as account.error. */}
            {account.message && <p className="muted account-hint">{account.message}</p>}
            {account.stackLeft && (
              <div className="account-howto stack-left">
                <p>
                  <Plain
                    text={`Disconnected. To remove AWS City's role too, delete the AWSCity stack in CloudFormation (${regionName(account.stackLeft)}): Stacks, then AWSCity, then Delete.`}
                  />
                </p>
                <StackLink region={account.stackLeft} />
              </div>
            )}
            {kind === 'mock' && !account.mfaRequired ? (
              <>
                <p className="muted">Practise deploying with a pretend account. Nothing real is created and nothing costs money.</p>
                <PendingButton
                  className="btn primary"
                  pending={pending.is('verify')}
                  busyLabel="Linking…"
                  title="Link a pretend account (the demo creates nothing real)"
                  onClick={() => {
                    const requestId = verifyAccount('arn:aws:iam::123456789012:role/aws-city-player');
                    if (requestId) pending.start('verify', requestId);
                  }}
                >
                  Use the practice account (nothing real)
                </PendingButton>
                {/* How a real account links (ExternalId, CloudFormation, MFA), for when they sign in for real. */}
                <details className="why">
                  <summary>How real accounts connect</summary>
                  <p>
                    You create one IAM role in your account with a CloudFormation quick-create link. It trusts AWS City only with a secret ExternalId, can use
                    only the quest services in one Region, and tags everything it makes <code>aws-city</code>. Hosted players turn on an authenticator app (MFA)
                    before linking. Delete the AWSCity stack to remove it at any time.
                  </p>
                  {linkSteps}
                </details>
              </>
            ) : (
              <>
                <p className="muted">
                  Optional. Everything else in AWS City works without this. Link an account when you want the agents to build real things in it. They only use a
                  role you create, and you approve every change.
                  {kind === 'mock' && ' (Demo: nothing real is created.)'}
                </p>
                <details className="why">
                  <summary>Why is this safe?</summary>
                  The role trusts AWS City only with a secret ExternalId. It can use only the quest services, in one Region, and everything it makes is tagged{' '}
                  <code>aws-city</code>. Delete the AWSCity stack to remove it at any time.
                </details>
                {linkSteps}
              </>
            )}
          </>
        )}
      </div>

      <h4>Blueprints</h4>
      {!account.linked && <p className="muted">🔒 Connect an account above (the practice one is fine) to build these.</p>}
      {account.linked && mode === 'guarded' && <p className="muted">Built with guarded tools: only game-owned resources, small limits, your approval.</p>}
      {blueprints.map((t) => (
        <div key={t.id} className="tpl">
          <div>
            <b>{t.title}</b>
            <div className="muted">{t.summary}</div>
            <BlueprintMissing serviceIds={t.serviceIds} region={account.region ?? cityRegion} />
            {/* Prices and free allowances are for whoever wants them; a beginner reads the plain summary first. */}
            <ForLearners>
              <div className="muted small">💰 {t.costNote}</div>
              <BlueprintPrice serviceIds={t.serviceIds} region={account.region ?? cityRegion} />
            </ForLearners>
            <TemplateView templateId={t.id} title={t.title} />
          </div>
          <PendingButton
            pending={pending.is(`plan:${t.id}`)}
            busyLabel={mode === 'guarded' ? 'Asking…' : 'Planning…'}
            disabled={!account.linked || !!offline}
            onClick={() => {
              pending.start(`plan:${t.id}`, planDeploy(t.id));
            }}
            title={offline ?? (account.linked ? 'See exactly what would be created' : 'Link your account first')}
          >
            {mode === 'guarded' ? 'Ask agent' : 'Preview'}
          </PendingButton>
        </div>
      ))}

      {(stacks.length > 0 || builds.length > 0) && <h4>My builds</h4>}
      {builds.length > 0 && (
        <>
          <ul className="my-builds" aria-label="Built by the city in your account">
            {builds.map((b) => {
              const target = removeTarget(b.arn);
              const key = `remove:${b.arn}`;
              return (
                <li key={b.arn}>
                  <span className="my-build-name">
                    <b>{b.name}</b>{' '}
                    <span className="muted">
                      · {(b.serviceId && serviceById(b.serviceId)?.name) ?? b.type} · {b.region ?? inventory?.homeRegion ?? account.region}
                    </span>
                  </span>
                  {target ? (
                    <PendingButton
                      className="btn tiny warn"
                      pending={pending.is(key)}
                      busyLabel="Asking…"
                      disabled={!!offline}
                      title={offline ?? 'Asks for your OK first, like any change'}
                      onClick={() => pending.start(key, removeResource(target.kind, target.id))}
                    >
                      Take it down
                    </PendingButton>
                  ) : (
                    <span className="muted small">Remove it in the AWS console</span>
                  )}
                </li>
              );
            })}
          </ul>
          <p className="muted small">Taking something down asks for your OK first, like any change. Until then it may keep billing.</p>
        </>
      )}
      {stacks.map((d) => {
        const deciding = pending.is(`decide:${d.deployId}`);
        return (
          <div key={d.deployId} className={`card stack ${d.status}`}>
            <b>{d.stackName}</b>{' '}
            <span className="muted">
              · {d.region} · {isPracticeDeploy(d.deployId) && d.status === 'complete' ? 'practice: nothing was created' : (STATUS_TEXT[d.status] ?? d.status)}
            </span>
            {d.status === 'preview' && (
              <BuildPreview
                d={d}
                offline={offline}
                deciding={deciding}
                buttonRef={(el) => {
                  if (el) approveRefs.current.set(d.deployId, el);
                  else approveRefs.current.delete(d.deployId);
                }}
                onDecide={(approve, typed) => {
                  decideDeploy(d.deployId, approve, typed);
                  pending.start(`decide:${d.deployId}`);
                }}
              />
            )}
            {(d.status === 'creating' || d.status === 'deleting') && <div className="busy-bar" aria-hidden="true" />}
            {d.outputs && (
              <ul className="outputs">
                {Object.entries(d.outputs).map(([k, v]) => (
                  <li key={k}>
                    {k}: {/* Outputs come from the stack: only AWS Console pages become links (the same check as openUrl). */}
                    {isSafeAwsUrl(v) ? (
                      <a href={v} target="_blank" rel="noreferrer">
                        {v}
                      </a>
                    ) : (
                      <code>{v}</code>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {/* A practice build made nothing in AWS: there's nothing to tear down. */}
            {d.status === 'complete' && !isPracticeDeploy(d.deployId) && (
              <PendingButton
                className="btn warn"
                pending={pending.is(`teardown:${d.deployId}`)}
                busyLabel="Tearing down…"
                disabled={!!offline}
                title={offline}
                onClick={() => {
                  teardownDeploy(d.deployId);
                  pending.start(`teardown:${d.deployId}`);
                }}
              >
                🧹 Tear down (delete stack)
              </PendingButton>
            )}
            {d.message && <div className="muted stack-msg">{d.message}</div>}
          </div>
        );
      })}
      {fixes.length > 0 && (
        <>
          <h4>Fixes I approved</h4>
          <ul className="fix-history">
            {fixes.map((d) => {
              const f = findings[d.findingId!];
              return (
                <li key={d.deployId}>
                  <b>{f?.fix?.title ?? d.templateId}</b>{' '}
                  <span className="muted">
                    · {d.stackName} · {d.status === 'complete' ? 'done' : (STATUS_TEXT[d.status] ?? d.status)}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {canDeleteAccount() && status !== 'signed-out' && (
        <div className="card">
          <h3>Your data</h3>
          <p className="muted">Progress, your account link and sign-in are stored for you. Screenshots expire after a day.</p>
          <AuthenticatorRow />
          <div className="row account-actions">
            {canDownloadData() && (
              <button className="btn" onClick={() => void downloadMyData()}>
                Download my data
              </button>
            )}
            <button className="btn" onClick={signOut}>
              Sign out
            </button>
            {!confirmDelete && (
              <button className="btn warn" onClick={() => setConfirmDelete(true)}>
                Delete my account
              </button>
            )}
          </div>
          {confirmDelete && (
            <div className="confirm" role="alertdialog" aria-labelledby="delete-here-title">
              <DeleteConfirm titleId="delete-here-title" onCancel={() => setConfirmDelete(false)} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A build's preview, approved here: what's added or removed, the server's own lines in words ("Safety check: …"), what
 * it costs, and the typed name when the server asks for one (the same rule as a fix's Approve in City care).
 */
function BuildPreview({ d, offline, deciding, buttonRef, onDecide }: {
  d: DeployView;
  offline?: string;
  deciding: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onDecide: (approve: boolean, typed?: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const details = d.changes.filter((c) => c.resourceType === 'detail');
  const resources = d.changes.filter((c) => c.resourceType !== 'detail');
  const ok = !d.confirmText || typed.trim() === d.confirmText;
  const removing = resources.length > 0 && resources.every((c) => c.action === 'Remove');
  return (
    <>
      <table className="changes">
        <tbody>
          {resources.map((c) => (
            <tr key={c.logicalId}>
              <td className={`chg ${c.action}`} aria-label={c.action}>
                {c.action === 'Add' ? '+' : c.action === 'Remove' ? '−' : '~'}
              </td>
              <td>{c.logicalId}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 'detail' lines spell out the change in words (why the server's safety check asks for care). */}
      {details.length > 0 && (
        <ul className="preview-changes">
          {details.map((c) => (
            <li key={c.logicalId}>{c.logicalId}</li>
          ))}
        </ul>
      )}
      {/* The CloudFormation resource types, for whoever wants them. */}
      <ForLearners>
        <table className="changes">
          <tbody>
            {resources.map((c) => (
              <tr key={c.logicalId}>
                <td>{c.logicalId}</td>
                <td className="muted">{c.resourceType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ForLearners>
      {d.costNote && <CostNote note={d.costNote} />}
      {d.confirmText && (
        <div className="confirm-type">
          <label className="field-hint" htmlFor={`confirm-${d.deployId}`}>
            To approve, type <code>{d.confirmText}</code>
          </label>
          <input id={`confirm-${d.deployId}`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} placeholder={d.confirmText} />
        </div>
      )}
      <div className="actions">
        <PendingButton
          buttonRef={buttonRef}
          className="btn primary"
          pending={deciding}
          busyLabel="Starting…"
          disabled={!ok || !!offline}
          title={offline ?? (ok ? undefined : `Type ${d.confirmText} first`)}
          onClick={() => onDecide(true, d.confirmText ? typed.trim() : undefined)}
        >
          {removing ? '✅ Approve & take down' : '✅ Approve & deploy'}
        </PendingButton>
        <button className="btn" disabled={deciding || !!offline} title={offline} onClick={() => onDecide(false)}>
          Reject
        </button>
      </div>
    </>
  );
}

/** That a blueprint can't be built in this Region (it uses a service AWS doesn't offer there). Plain, so always shown. */
function BlueprintMissing({ serviceIds, region }: { serviceIds: readonly string[]; region: string }) {
  const missing = serviceIds.filter((id) => !offered(id, region));
  return missing.length ? (
    <div className="muted small">
      ⛔ Not offered in {region}: {missing.join(', ')}
    </div>
  ) : null;
}

/** The list price of a blueprint's main service in the Region it deploys to (nothing when it isn't offered there). */
function BlueprintPrice({ serviceIds, region }: { serviceIds: readonly string[]; region: string }) {
  if (serviceIds.some((id) => !offered(id, region))) return null;
  const p = serviceIds.flatMap((id) => pricesFor(id, region))[0];
  return p ? (
    <div className="muted small">
      💲 In {region}: {p.label}, {perUnit(p)} (list price)
    </div>
  ) : null;
}
