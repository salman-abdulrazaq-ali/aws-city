import { useEffect, useRef, useState, type ReactNode } from 'react';
import { canDeleteAccount, canSetUpMfa, confirmMfaSetup, decideDeploy, deleteAccount, isSafeAwsUrl, linkAccount, openUrl, planDeploy, signIn, signOut, startMfaSetup, submitPrompt, teardownDeploy, verifyAccount } from '@/app/runtime';
import { arrangeBuilds, statusWord } from '@/state/builds';
import { useCity, type DeployView } from '@/state/store';
import { ReauthPrompt } from './ReauthPrompt';
import { GUARDED_BLUEPRINTS } from '@/backend/ServerBackend';
import { TEMPLATES } from '@/world/content';
import { TemplateView } from './TemplateView';
import { offered, perUnit, pricesFor, regionInfo } from '@/world/regions';
import { useCopy } from './feedback';
import { costLine, offlineReason } from './logic';
import { usePending } from './usePending';
import { useCanConnect } from './useLadder';
import { QrCode } from './QrCode';
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

/** An account id as the AWS console shows it: 0474-6343-8585. */
export const accountLabel = (id: string) => id.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3');

/** v2.18: exactly where an approval writes, so a player linked to two accounts can tell which one before approving. */
export function ChangeTarget({ d }: { d: Pick<DeployView, 'accountId' | 'region'> }) {
  if (!d.accountId) return null;
  return (
    <div className="muted change-target">
      Changes AWS account <b>{accountLabel(d.accountId)}</b> · {d.region}
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
    // type="button": inside the account-number form a default (submit) button ran verify twice per click (onClick and
    // the form's submit). Enter in the form's one text field still submits it.
    <button ref={buttonRef} type="button" className={className} disabled={disabled || pending} aria-busy={pending} onClick={onClick} title={title}>
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

/** A numbered step: done (✓), current (lit) or still to come. */
/** The Region a setup link makes the role in (its console URL's ?region=), with its name: AWS City looks for it there. */
export const linkRegion = (url?: string): { code: string; name: string } | undefined => {
  try {
    const code = url ? new URL(url).searchParams.get('region') : null;
    return code ? { code, name: regionInfo(code)?.name ?? code } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * What the player typed in step 3: the console shows an account id as 1234-5678-9012, and a number copied from a
 * sentence brings its full stop, so dashes, spaces and trailing punctuation go. A role ARN is kept as typed.
 */
export const accountInput = (raw: string) => {
  const t = raw.trim().replace(/[.,;:]+$/, '');
  return /^[\d\s.-]+$/.test(t) ? t.replace(/\D/g, '') : t;
};

function Step({ n, state, title, children }: { n: number; state: 'done' | 'now' | 'todo'; title: string; children?: ReactNode }) {
  return (
    <li className={`link-step ${state}`}>
      <span className="step-n" aria-hidden="true">
        {state === 'done' ? '✓' : n}
      </span>
      <div className="step-body">
        <b>{title}</b>
        {state === 'now' && children}
      </div>
    </li>
  );
}

/** Step-up MFA: an authenticator app protects the AWS account agents can change (server/src/accounts/mfa.ts). */
function MfaSetup() {
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
      <b>🔐 First, protect your account</b>
      <p className="muted">
        The city’s agents can change your AWS account, so connecting it (and approving each change) needs a code from an authenticator app on your phone.
        You set this up once. Then you connect your account in 3 short steps.
      </p>
      {!setup ? (
        <PendingButton className="btn primary" pending={busy} busyLabel="Starting…" onClick={() => void run(async () => setSetup(await startMfaSetup()))}>
          Set up an authenticator
        </PendingButton>
      ) : (
        <ol className="mfa-steps">
          <li>
            <b>Open an authenticator app on your phone</b>
            <span className="muted">Google Authenticator, Microsoft Authenticator, Authy or 1Password. No app yet? Get one free from the App Store or Google Play.</span>
          </li>
          <li>
            <b>Tap + and scan this code</b>
            <QrCode text={setup.uri} label="QR code to add AWS City to your authenticator app" />
            <details className="why">
              <summary>Can’t scan it? Type a key instead</summary>
              <label className="field-hint" htmlFor="mfa-key">
                In the app, choose “Enter a setup key” (time-based) and type this key:
              </label>
              <input id="mfa-key" readOnly value={setup.secret.replace(/(.{4})/g, '$1 ').trim()} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
              <button className="btn" onClick={() => copy(setup.secret)}>
                {copied ? 'Copied ✓' : 'Copy key'}
              </button>
            </details>
          </li>
          <li>
            <label htmlFor="mfa-code">
              <b>Type the 6-digit code your app shows</b>
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
          </li>
        </ol>
      )}
    </div>
  );
}

/**
 * Real deploys to the player's own AWS account: link via a CloudFormation quick-create role (ExternalId),
 * preview a change set, approve it, tear it down. Curated templates only.
 */
export function DeployPanel() {
  const account = useCity((s) => s.account);
  const cityRegion = useCity((s) => s.cityRegion);
  const deployMap = useCity((s) => s.deploys);
  const deploys = Object.values(deployMap);
  const status = useCity((s) => s.backendStatus);
  const connectNow = useCanConnect() && status !== 'signed-out';
  const kind = useCity((s) => s.backendKind);
  const offline = offlineReason(kind, status);
  const [role, setRole] = useState('');
  /** Step 2 done: the player says the AWSCity stack is created, so step 3 (the account number) opens. */
  const [stackMade, setStackMade] = useState(false);
  const [linkCopied, copyLink] = useCopy();
  const where = linkRegion(account.linkUrl);
  const findings = useCity((s) => s.findings);
  // Fixes are approved in their finding's card; here they're only a history, never next to Tear down.
  const stacks = deploys.filter((d) => !d.findingId);
  // One card per resource for the agents' changes; waiting approvals first (src/state/builds.ts).
  const builds = arrangeBuilds(stacks);
  const fixes = deploys.filter((d) => d.findingId && d.status !== 'preview' && d.status !== 'rejected');
  const [confirmDelete, setConfirmDelete] = useState(false);
  /** The linking steps stay folded until the player asks for them (this whole tab is optional). */
  const [wantsLink, setWantsLink] = useState(false);
  const mode = useCity((s) => s.deployMode);
  const blueprints = mode === 'guarded' ? GUARDED_BLUEPRINTS : TEMPLATES;
  const signingIn = useCity((s) => s.signingIn);
  const pending = usePending();
  const { clear } = pending;

  // Clear each pending button when the event it was waiting for lands.
  useEffect(() => clear('link'), [account.linkUrl, clear]);
  useEffect(() => clear('verify'), [account.seq, clear]);
  useEffect(() => {
    clear('link');
    clear('verify');
  }, [account.mfaRequired, clear]);
  const deployCount = deploys.length;
  // Only a new stack (count change) resolves a plan request.
  const pendingKeys = useRef(pending.keys);
  pendingKeys.current = pending.keys;
  useEffect(() => {
    for (const k of pendingKeys.current) if (k.startsWith('plan:')) clear(k);
  }, [deployCount, clear]);
  useEffect(() => {
    for (const d of Object.values(deployMap)) {
      if (d.status !== 'preview') clear(`decide:${d.deployId}`);
      if (d.status !== 'complete') clear(`teardown:${d.deployId}`);
    }
  }, [deployMap, clear]);

  // A new approval (or the one "Approve in Deploy" named) is brought into view with focus on Approve, whether this tab
  // was already open or just opened for it (the store's deployFocus waits for the card to render).
  const approveRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusId = useCity((s) => s.deployFocus);
  const previewKey = stacks
    .filter((d) => d.status === 'preview')
    .map((d) => d.deployId)
    .join(',');
  useEffect(() => {
    const btn = focusId ? approveRefs.current.get(focusId) : undefined;
    if (!focusId || !btn) return;
    btn.closest('.card')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    btn.focus({ preventScroll: true });
    useCity.getState().clearDeployFocus();
  }, [focusId, previewKey]);

  const verify = () => {
    const requestId = verifyAccount(accountInput(role));
    if (requestId) pending.start('verify', requestId);
  };

  /** The three linking steps (folded until the player asks; inside "How real accounts connect" in the demo). */
  const linkSteps =
    !wantsLink && !connectNow && !account.linkUrl && !account.mfaRequired ? (
      <button className="btn" onClick={() => setWantsLink(true)}>
        Connect an AWS account
      </button>
    ) : (
      <ol className="link-steps">
        <Step n={1} state={account.linkUrl ? 'done' : 'now'} title="Get your setup link">
          <PendingButton
            className="btn primary"
            pending={pending.is('link')}
            busyLabel="Getting your link…"
            disabled={!!offline}
            title={offline}
            onClick={() => {
              pending.start('link', linkAccount());
            }}
          >
            Get my setup link
          </PendingButton>
        </Step>
        <Step n={2} state={!account.linkUrl ? 'todo' : stackMade ? 'done' : 'now'} title="Create AWS City’s key in your AWS account">
          <p className="muted">
            <Plain text="A CloudFormation stack makes an IAM role: a key that only opens what the quests need." />
          </p>
          <ol className="how">
            <li>
              Click <b>Open CloudFormation</b> and sign in to <b>your own AWS account</b>, the one you want the city to look after. Check the
              account at the top right before you click <b>Create stack</b>.
            </li>
            {where && (
              <li>
                Keep the Region at the top right on <b>{where.name}</b> ({where.code}). The role is made there, and that’s where AWS City looks for it.
              </li>
            )}
            <li>
              At the bottom, tick <b>I acknowledge that AWS CloudFormation might create IAM resources with custom names</b>, then click <b>Create stack</b>.
            </li>
            <li>
              Wait about a minute, until the stack says <b>CREATE_COMPLETE</b>.
            </li>
          </ol>
          <div className="row">
            <button className="btn primary" onClick={() => openUrl(account.linkUrl!)}>
              Open CloudFormation ↗
            </button>
            {/* Signed in to AWS in another browser (or a passkey that only works there): open the same link there. */}
            <button className="btn" onClick={() => copyLink(account.linkUrl!)}>
              {linkCopied ? 'Copied ✓' : 'Copy link'}
            </button>
            <button className="btn" onClick={() => setStackMade(true)}>
              Done: it says CREATE_COMPLETE
            </button>
          </div>
          <p className="muted">Signed in to AWS in another browser? Copy the link and open it there.</p>
          <p className="muted">
            Hosting AWS City yourself? Use a different AWS account from the one it runs in. The city refuses that one, so it can never act inside the account
            that holds everyone’s data.
          </p>
          <details className="why">
            <summary>Details</summary>
            <div className="muted">
              ExternalId (a secret only AWS City knows): <code>{account.externalId}</code>
            </div>
          </details>
        </Step>
        <Step n={3} state={account.linkUrl && stackMade ? 'now' : 'todo'} title="Tell us your account number (12 digits)">
          <p className="muted">In the AWS console, click your name at the top right: it’s the Account ID.</p>
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
              placeholder="1234-5678-9012"
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
      </ol>
    );

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
          <PendingButton className="btn primary" pending={signingIn} busyLabel="Waiting for sign-in…" onClick={() => signIn()}>
            Sign in
          </PendingButton>
        </div>
      )}
      <div className="card">
        <h3>Your AWS account</h3>
        {account.linked ? (
          <>
            <p className="linked">
              <span className="linked-badge">✓ Linked</span> <b>{account.accountId}</b> · {account.region}
              {account.message ? <span className="muted"> · {account.message}</span> : null}
            </p>
            <button className="btn tiny" onClick={() => useCity.getState().openAccountMap(true)} title="Your account as one map: what runs where, data that moves, live traffic and this month's cost">
              🗺️ My AWS, live
            </button>
          </>
        ) : (
          <>
            {account.mfaRequired && canSetUpMfa() && <MfaSetup />}
            <ReauthPrompt />
            {account.message && (
              <p className="field-error" role="alert">
                ⚠️ {account.message}
              </p>
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
                {!(account.mfaRequired && canSetUpMfa()) && linkSteps}
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

      {stacks.length > 0 && <h4>My builds</h4>}
      {builds.map(({ d, group }) => {
        const deciding = pending.is(`decide:${d.deployId}`);
        const history = group?.history.filter((h) => h.status === 'complete') ?? [];
        return (
          <div key={group?.key ?? d.deployId} className={`card stack ${d.status}`}>
            <b>{group?.title ?? d.stackName}</b>{' '}
            <span className="muted">
              · {d.region} · {group ? statusWord(d) : (STATUS_TEXT[d.status] ?? d.status)}
            </span>
            {group && history.length > 1 && <div className="muted small build-history">{history.map((h) => statusWord(h)).join(' → ')}</div>}
            {d.status === 'preview' && (
              <>
                {/* What this approval changes, in words ("Permanently terminate EC2 instance i-…"). */}
                {group && <div className="build-change">{d.stackName}</div>}
                <ChangeTarget d={d} />
                <table className="changes">
                  <tbody>
                    {d.changes.map((c) => (
                      <tr key={c.logicalId}>
                        <td className={`chg ${c.action}`} aria-label={c.action}>
                          {c.action === 'Add' ? '+' : c.action === 'Remove' ? '−' : '~'}
                        </td>
                        <td>{c.logicalId}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* The CloudFormation resource types, for whoever wants them. */}
                <ForLearners>
                  <table className="changes">
                    <tbody>
                      {d.changes.map((c) => (
                        <tr key={c.logicalId}>
                          <td>{c.logicalId}</td>
                          <td className="muted">{c.resourceType}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ForLearners>
                {d.costNote && <CostNote note={d.costNote} />}
                <ReauthPrompt />
                <div className="actions">
                  <PendingButton
                    buttonRef={(el) => {
                      if (el) approveRefs.current.set(d.deployId, el);
                      else approveRefs.current.delete(d.deployId);
                    }}
                    className="btn primary"
                    pending={deciding}
                    busyLabel="Starting…"
                    disabled={!!offline}
                    title={offline}
                    onClick={() => {
                      decideDeploy(d.deployId, true);
                      pending.start(`decide:${d.deployId}`);
                    }}
                  >
                    ✅ Approve & deploy
                  </PendingButton>
                  <button
                    className="btn"
                    disabled={deciding || !!offline}
                    title={offline}
                    onClick={() => {
                      decideDeploy(d.deployId, false);
                      pending.start(`decide:${d.deployId}`);
                    }}
                  >
                    Reject
                  </button>
                </div>
              </>
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
            {/* An agent's change: Tear down asks for the removal in plain words, so its own card shows in seconds. */}
            {group?.teardown && d.status !== 'preview' && d.status !== 'creating' && (
              <button
                className="btn warn"
                disabled={!!offline}
                title={offline ?? `Asks: “${group.teardown}”. You approve it like any change.`}
                onClick={() => submitPrompt(group.teardown!)}
              >
                🧹 Tear down (remove it)
              </button>
            )}
            {!group && d.status === 'complete' && (
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
          <div className="row">
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
            <div className="confirm" role="alertdialog" aria-label="Delete your account?">
              <b>Delete your account and saved progress?</b>
              <span className="muted">This can’t be undone.</span>
              <div className="row">
                <button className="btn" autoFocus onClick={() => setConfirmDelete(false)}>
                  Keep it
                </button>
                <button
                  className="btn warn"
                  onClick={() => {
                    setConfirmDelete(false);
                    void deleteAccount();
                  }}
                >
                  Yes, delete
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
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
