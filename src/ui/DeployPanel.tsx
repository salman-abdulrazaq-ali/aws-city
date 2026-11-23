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
  openConsole,
  openSwitchRole,
  openPrivacyPolicy,
  openUrl,
  planDeploy,
  privacyPolicyUrl,
  removeResource,
  signIn,
  signOut,
  startMfaSetup,
  submitPrompt,
  teardownDeploy,
  unlinkAccount,
  verifyAccount,
} from '@/app/runtime';
import {
  accountLabel,
  accountTitle,
  DEFAULT_CONSOLE_ROLE,
  connectsPlayer,
  defaultLinkRegion,
  FIX_GRANTS,
  FIX_GRANTS_CAVEAT,
  gameBuilds,
  isLinkRegion,
  LINK_REGIONS,
  regionName,
  removeTarget,
  ROLE_CAN,
  roleUpdate,
  templateLink,
} from '@/state/account';
import { arrangeBuilds, statusWord } from '@/state/builds';
import { useCity, type DeployView } from '@/state/store';
import { ConsoleAccountWarning } from './ConsoleAccountWarning';
import { ReauthPrompt } from './ReauthPrompt';
import { GUARDED_BLUEPRINTS, isPracticeDeploy } from '@/backend/ServerBackend';
import { TEMPLATES } from '@/world/content';
import { serviceById } from '@/world/taxonomy';
import { TemplateView } from './TemplateView';
import { offered, perUnit, pricesFor } from '@/world/regions';
import { CleanupSwitch, DeleteConfirm, FixesOn, RoleUpdate, StackLink } from './Account';
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
  // A note already written for practice (a removal: "Practice: nothing real is removed…") says what it does as it is,
  // never "free, nothing is created" with a second "Practice:" folded under it.
  const line = note.startsWith('Practice:') ? note : costLine(note, kind);
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
export { accountLabel } from '@/state/account';

/**
 * Switch role into the linked account, the console then opening in its Region (seen 23 Nov 2026: the console and
 * CloudShell were still in another account, so nothing made there showed). The role name is remembered (prefs).
 */
function SwitchRoleLine() {
  const role = useCity((s) => s.prefs.consoleRole) ?? DEFAULT_CONSOLE_ROLE;
  return (
    <details className="why switch-role">
      <summary>In an AWS Organization? Switch role into this account</summary>
      <label className="row">
        <span className="label">Role name</span>
        <input value={role} onChange={(e) => useCity.getState().setPref('consoleRole', e.target.value.trim() || undefined)} spellCheck={false} autoCapitalize="off" />
      </label>
      <button type="button" className="btn tiny" onClick={() => openSwitchRole()}>
        Switch role ↗
      </button>
    </details>
  );
}

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
function PendingButton({ pending, busyLabel, children, className = 'btn', disabled, onClick, title }: {
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
    <button type="button" className={className} disabled={disabled || pending} aria-busy={pending} onClick={onClick} title={title}>
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

/** The Region a setup link makes the role in (its console URL's ?region=), with its name: AWS City looks for it there. */
export const linkRegion = (url?: string): { code: string; name: string } | undefined => {
  try {
    const code = url ? new URL(url).searchParams.get('region') : null;
    return code ? { code, name: regionName(code) } : undefined;
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
      <b>{replace ? '🔐 Replace your authenticator' : '🔐 First, protect your account'}</b>
      <p className="muted">
        {replace
          ? 'Add AWS City to your new app (or phone) with a new key. The old one stops working.'
          : 'The city’s agents can change your AWS account, so connecting it, approving a change, applying a fix and taking something down need a code from an authenticator app on your phone. You set this up once.'}{' '}
        Then you sign in again with its code.
      </p>
      {!setup ? (
        <PendingButton className="btn primary" pending={busy} busyLabel="Starting…" onClick={() => void run(async () => setSetup(await startMfaSetup()))}>
          {replace ? 'Get a new key' : 'Set up an authenticator'}
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
 * What the AWSCity role really allows, before the player creates it: what's account-wide, which promises AWS City's
 * server keeps rather than IAM, and the exact template (the address account.status or the setup link names; nothing
 * else is opened).
 */
function RolePermissions() {
  const tpl = useCity((s) => templateLink(s.account));
  return (
    <details className="why role-can">
      <summary>What the role can do</summary>
      <ul>
        {ROLE_CAN.map((line) => (
          <li key={line}>
            <Plain text={line} />
          </li>
        ))}
      </ul>
      {tpl ? (
        <a className="btn tiny" href={tpl} target="_blank" rel="noreferrer">
          See the exact permissions ↗
        </a>
      ) : (
        <p className="muted small">Your setup link names the role template, with the exact permissions.</p>
      )}
    </details>
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
  const connectNow = useCanConnect() && status !== 'signed-out';
  const kind = useCity((s) => s.backendKind);
  const hosted = useCity((s) => s.hosted);
  const inventory = useCity((s) => s.inventory);
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
  const cards = arrangeBuilds(stacks);
  const fixes = deploys.filter((d) => d.findingId && d.status !== 'preview' && d.status !== 'rejected');
  // What the city built in the account, from its inventory: it survives a reload (a session's stacks don't).
  const builds = useMemo(() => (account.linked ? gameBuilds(inventory) : []), [account.linked, inventory]);
  /** Resource ids My builds' list offers Take it down for (an agent's card then shows no second removal button). */
  const listed = new Set(builds.flatMap((b) => removeTarget(b.arn)?.id ?? []));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  /** The linking steps stay folded until the player asks for them (this whole tab is optional). */
  const wantsLink = !!account.wantsLink;
  /** The Region picked in step 1 (until then: the one asked for last, the linked one, else this city's). */
  const [picked, setPicked] = useState<string>();
  const region = picked ?? defaultLinkRegion(account, cityRegion);
  /** The Region the setup link out now was made for (step 2's checklist names it; else its URL's ?region=). */
  const setupRegion = account.linkRegion ?? where?.code ?? region;
  const setupRegionName = regionName(setupRegion);
  /** Who the setup link out now serves (step 2 says it, so a link meant for someone else is caught). */
  const linkFor = connectsPlayer(account.linkUrl);
  // Disconnect and "another Region" are for an account the player linked (the local server reads the developer's own).
  const canUnlink = hosted || kind === 'mock';
  const mode = useCity((s) => s.deployMode);
  const blueprints = mode === 'guarded' ? GUARDED_BLUEPRINTS : TEMPLATES;
  const signingIn = useCity((s) => s.signingIn);
  const pending = usePending();
  const { clear } = pending;
  /** The server asked for an authenticator first: its setup shows, and the linking steps wait until it's done. */
  const mfaFirst = !!account.mfaRequired && canSetUpMfa();
  // A new setup link (another Region, Allow small fixes, Link again) means a new stack: step 3 waits for it again.
  useEffect(() => setStackMade(false), [account.linkUrl]);

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

  // A new approval (or the one "Approve in Deploy" named) is brought into view with focus on its heading, never on
  // Approve, so one stray Enter or Space can't approve it; whether this tab was already open or just opened for it (the
  // store's deployFocus waits for the card to render).
  const headingRefs = useRef(new Map<string, HTMLElement>());
  const focusId = useCity((s) => s.deployFocus);
  const previewKey = stacks
    .filter((d) => d.status === 'preview')
    .map((d) => d.deployId)
    .join(',');
  useEffect(() => {
    const heading = focusId ? headingRefs.current.get(focusId) : undefined;
    if (!focusId || !heading) return;
    heading.closest('.card')?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    heading.focus({ preventScroll: true });
    useCity.getState().clearDeployFocus();
  }, [focusId, previewKey]);

  const verify = () => {
    const requestId = verifyAccount(accountInput(role));
    if (requestId) pending.start('verify', requestId);
  };
  const getLink = (where: string, allowFixes: boolean, allowCleanup = !!account.allowCleanup) =>
    pending.start('link', linkAccount(where, { allowFixes, ...(allowCleanup ? { allowCleanup } : {}) }));
  const restart = () => {
    setPicked(undefined);
    useCity.getState().restartLink();
  };

  /** The three linking steps (folded until the player asks; inside "How real accounts connect" in the demo). */
  const linkSteps =
    !wantsLink && !connectNow && !account.linkUrl && !account.mfaRequired ? (
      <button className="btn" onClick={() => useCity.getState().patchAccount({ wantsLink: true })}>
        Connect an AWS account
      </button>
    ) : (
      <ol className="link-steps">
        <Step
          n={1}
          state={account.linkUrl ? 'done' : 'now'}
          title={account.linkUrl ? `Get your setup link: ${setupRegionName}` : 'Pick a Region and get your setup link'}
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
            <Plain
              text={`AWS City’s role will be made in ${regionName(region)}. The city builds and checks for issues there; a few reads cover your whole account (see “What the role can do”).`}
            />
            {LINK_REGIONS.find((r) => r.code === region)?.optIn && <Plain text=" It's an opt-in Region: turn it on in your account first (Account → AWS Regions)." />}
          </p>
          <RolePermissions />
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
        <Step n={2} state={!account.linkUrl ? 'todo' : stackMade ? 'done' : 'now'} title="Create AWS City’s role in your AWS account">
          <p className="muted">
            <Plain text="A CloudFormation stack makes one IAM role. Only AWS City’s server can use it, with the ExternalId in your setup link. It reads your account and builds only small things the city made, each after you approve it." />
          </p>
          <RolePermissions />
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!account.allowFixes}
              disabled={pending.is('link') || !!offline}
              // The choice is part of the setup link (AllowFixes): a new link is made for it.
              onChange={(e) => getLink(setupRegion, e.target.checked)}
            />
            <span>Allow small fixes (you still approve each one)</span>
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={!!account.allowCleanup}
              disabled={pending.is('link') || !!offline}
              // Part of the setup link too (AllowCleanup): a new link is made for it.
              onChange={(e) => getLink(setupRegion, !!account.allowFixes, e.target.checked)}
            />
            <span>Let the city change things you made: servers and empty buckets (you type the name and approve each removal)</span>
          </label>
          <details className="why fix-grants">
            <summary>What small fixes allow</summary>
            <ul>
              {FIX_GRANTS.map((g) => (
                <li key={g}>
                  <Plain text={g} />
                </li>
              ))}
            </ul>
            <p className="muted">
              <Plain text={FIX_GRANTS_CAVEAT} />
            </p>
          </details>
          {linkFor && (
            <p className="connects-player">
              The stack page will say <b>ConnectsPlayer: {linkFor}</b>. Don’t create the stack if that isn’t you.
            </p>
          )}
          <b className="checklist-title">What the console will ask</b>
          <ol className="how account-steps link-checklist" aria-label="What the console will ask">
            <li>
              Click <b>Open CloudFormation</b> and sign in to <b>your own AWS account</b>, the one you want the city to look after. Check the
              account at the top right before you click <b>Create stack</b>.
            </li>
            <li>
              Keep the Region at the top right on <b>{where?.name ?? setupRegionName}</b> ({where?.code ?? setupRegion}). The role is made there, and that’s
              where AWS City looks for it.
            </li>
            <li>Use a sign-in that may create IAM roles and CloudFormation stacks (workshop accounts can’t).</li>
            <li>
              At the bottom, tick <b>I acknowledge that AWS CloudFormation might create IAM resources with custom names</b>, then click <b>Create stack</b>.
            </li>
            <li>
              Wait about a minute, until the stack says <b>CREATE_COMPLETE</b>. Then press <b>Done</b> here and <b>Verify</b> your account number.
            </li>
          </ol>
          {/* The demo's practice link rehearses these steps but opens nothing: there's no real console behind it. */}
          {kind === 'mock' && <p className="muted practice-link">Practice: nothing opens here. In your own account, Open CloudFormation shows the stack with these settings filled in.</p>}
          <div className="row">
            {kind !== 'mock' && (
              <>
                <PendingButton className="btn primary" pending={pending.is('link')} busyLabel="Making your link…" onClick={() => openUrl(account.linkUrl!)}>
                  Open CloudFormation ↗
                </PendingButton>
                {/* Signed in to AWS in another browser (or a passkey that only works there): open the same link there. */}
                <button className="btn" disabled={pending.is('link')} onClick={() => copyLink(account.linkUrl!)}>
                  {linkCopied ? 'Copied ✓' : 'Copy link'}
                </button>
              </>
            )}
            <button className="btn" onClick={() => setStackMade(true)}>
              Done: it says CREATE_COMPLETE
            </button>
          </div>
          {kind !== 'mock' && <p className="muted">Signed in to AWS in another browser? Copy the link and open it there.</p>}
          <p className="muted small">This link works for a day. After that, get a new one: the role you made keeps working.</p>
          <p className="muted">
            Hosting AWS City yourself? Use a different AWS account from the one it runs in. The city refuses that one, so it can never act inside the account
            that holds everyone’s data.
          </p>
          <details className="why">
            <summary>Details</summary>
            <div className="muted">
              ExternalId: <code>{account.externalId}</code>. It ties the role to your AWS City sign-in, so another player can’t point the city at your account. It
              isn’t a password: AWS doesn’t treat it as a secret.
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
          <PendingButton className="btn primary" pending={signingIn} busyLabel="Waiting for sign-in…" onClick={() => signIn()}>
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
        {mfaFirst && <MfaSetup />}
        {/* A sign-in from the last 30 minutes is needed (reauth_required); a waiting approval's card says it there. */}
        {!stacks.some((d) => d.status === 'preview') && <ReauthPrompt />}
        {/* This tab's link, verify or Disconnect the server refused (a failed verify, a link over a day old). */}
        {account.error && (
          <div className="field-error account-error" role="alert">
            ⚠️ {account.error}
            {((!account.linked && account.linkUrl) || wantsLink) && (
              <PendingButton className="btn tiny" pending={pending.is('link')} busyLabel="Getting your link…" disabled={!!offline} onClick={() => getLink(setupRegion, !!account.allowFixes)}>
                Get a new setup link
              </PendingButton>
            )}
          </div>
        )}
        {account.linked ? (
          <>
            <p className="linked">
              <span className="linked-badge">✓ Linked</span> <b>{account.accountId ? accountTitle(account.accountId) : ''}</b>
              {account.region && (
                <span>
                  · {regionName(account.region)} <span className="muted">({account.region})</span>
                </span>
              )}
            </p>
            {account.message && <p className="muted">{account.message}</p>}
            <div className="row account-actions">
              <button className="btn tiny" onClick={() => useCity.getState().openAccountMap(true)} title="Your account as one map: what runs where, data that moves, live traffic and this month's cost">
                🗺️ My AWS, live
              </button>
              {kind !== 'mock' && (
                <button className="btn tiny" onClick={() => openConsole()} title={`The AWS console in ${account.region ? regionName(account.region) : 'your Region'}, where the city builds`}>
                  🖥️ Open the AWS console
                </button>
              )}
            </div>
            {kind !== 'mock' && account.accountId && (
              // Asked on 23 Nov 2026: "how do I get to my console?" The city opens it in the right Region, but the
              // sign-in is the player's own (it never holds console credentials, and the role trusts only the city).
              <p className="muted small">
                Sign in as account {accountTitle(account.accountId)} with your own AWS sign-in: the city never signs you in. If that account is in an AWS
                Organization, switch role into it first.
              </p>
            )}
            {kind !== 'mock' && account.accountId && <SwitchRoleLine />}
            <ConsoleAccountWarning />
            {account.fixes !== undefined && (
              <p className="muted">
                Small fixes: <b>{account.fixes ? 'on' : 'off'}</b>
                {account.fixes ? ' (you approve each one)' : ' (City care explains what it finds, but changes nothing)'}
              </p>
            )}
            {account.fixes === false &&
              account.region &&
              (kind === 'mock' ? (
                // The practice account has no stack to update: a new practice link with the box ticked.
                <p className="muted">Practice account: press Use another Region or account, tick Allow small fixes, then Verify again.</p>
              ) : (
                <details className="why">
                  <summary>Turn small fixes on</summary>
                  <FixesOn region={account.region} />
                </details>
              ))}
            {account.region && <CleanupSwitch region={account.region} />}
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
            {wantsLink && !mfaFirst && linkSteps}
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
            {wantsLink && !mfaFirst && linkSteps}
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
                    // Named like the real role (AWSCityPlayerRole-<Region>), in this city's own Region.
                    const requestId = verifyAccount(`arn:aws:iam::123456789012:role/AWSCityPlayerRole-${defaultLinkRegion({}, cityRegion)}`);
                    if (requestId) pending.start('verify', requestId);
                  }}
                >
                  Use the practice account (nothing real)
                </PendingButton>
                {/* How a real account links (ExternalId, CloudFormation, MFA), for when they sign in for real. */}
                <details className="why">
                  <summary>How real accounts connect</summary>
                  <p>
                    <Plain text="You create one IAM role in your account with a CloudFormation quick-create link. Only AWS City’s server can use it, with an ExternalId tied to you. It builds only small things the city made, in the Region you pick, after you approve each one; a few reads cover your whole account. Hosted players turn on an authenticator app (MFA) before linking. Delete the AWSCity stack to remove it at any time." />
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
                  <Plain text="Only AWS City’s server can use the role, with an ExternalId tied to you, and you approve every change. It builds only small things the city made, in the Region you pick; a few reads cover your whole account (the linking steps list them). Delete the AWSCity stack to remove it at any time." />
                </details>
                {!mfaFirst && linkSteps}
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
      {cards.map(({ d, group }) => {
        const deciding = pending.is(`decide:${d.deployId}`);
        const history = group?.history.filter((h) => h.status === 'complete') ?? [];
        return (
          <div key={group?.key ?? d.deployId} className={`card stack ${d.status}`}>
            <b
              className="stack-title"
              tabIndex={d.status === 'preview' ? -1 : undefined}
              ref={(el) => {
                if (el && d.status === 'preview') headingRefs.current.set(d.deployId, el);
                else headingRefs.current.delete(d.deployId);
              }}
            >
              {group?.title ?? d.stackName}
            </b>{' '}
            <span className="muted">
              · {d.region} ·{' '}
              {isPracticeDeploy(d.deployId) && d.status === 'complete' ? 'practice: nothing was created' : group ? statusWord(d) : (STATUS_TEXT[d.status] ?? d.status)}
            </span>
            {group && history.length > 1 && <div className="muted small build-history">{history.map((h) => statusWord(h)).join(' → ')}</div>}
            {d.status === 'preview' && (
              <BuildPreview
                d={d}
                grouped={!!group}
                offline={offline}
                deciding={deciding}
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
            {/* An agent's change: Tear down asks for the removal in plain words, so its own card shows in seconds. Not when
                My builds' list above already offers Take it down for the same resource (one removal button each). */}
            {group?.teardown && d.status !== 'preview' && d.status !== 'creating' && !(d.resourceId && listed.has(d.resourceId)) && (
              <button
                className="btn warn"
                disabled={!!offline}
                title={offline ?? `Asks: “${group.teardown}”. You approve it like any change.`}
                onClick={() => submitPrompt(group.teardown!)}
              >
                🧹 Tear down (remove it)
              </button>
            )}
            {/* A practice build made nothing in AWS: there's nothing to tear down. */}
            {!group && d.status === 'complete' && !isPracticeDeploy(d.deployId) && (
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
function BuildPreview({ d, grouped, offline, deciding, onDecide }: {
  d: DeployView;
  /** One resource's card (src/state/builds.ts): the approval's own words say what this change does. */
  grouped: boolean;
  offline?: string;
  deciding: boolean;
  onDecide: (approve: boolean, typed?: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const details = d.changes.filter((c) => c.resourceType === 'detail');
  const resources = d.changes.filter((c) => c.resourceType !== 'detail');
  const ok = !d.confirmText || typed.trim() === d.confirmText;
  const removing = resources.length > 0 && resources.every((c) => c.action === 'Remove');
  return (
    <>
      {/* What this approval changes, in words ("Permanently terminate EC2 instance i-…"). */}
      {grouped && <div className="build-change">{d.stackName}</div>}
      <ChangeTarget d={d} />
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
      <ReauthPrompt />
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
