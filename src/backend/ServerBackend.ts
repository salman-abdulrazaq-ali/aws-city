import { Listeners, uid, type AgentBackend, type ConnectionStatus, type SaveState } from './AgentBackend';
import type { CognitoAuth } from './auth';
import {
  bearerSubprotocols,
  CLOSE_CODES,
  compareContract,
  CONTRACT_HEADER,
  CONTRACT_PARAM,
  CONTRACT_VERSION,
  isServerEvent,
  type ClientCommand,
  type DeployDecision,
  type DeployPlan,
  type PlayerDataExport,
  type Progress,
  type ServerEvent,
} from './contract';
import templatesJson from '../../shared/templates.json' with { type: 'json' };
import { isPracticeTemplate, playPracticeTask } from './practiceTasks';

/**
 * The AWS City server (server/): Claude on Bedrock + real AWS. Two deployments, same protocol:
 *  - local: on loopback with the workshop profile; the build carries the server's token (WXT_AWS_TOKEN), which the
 *    launcher mints fresh each run. An allowed Origin alone never gets in.
 *  - hosted: api.<domain> on ECS; players sign in with Cognito and the access token rides in the
 *    WebSocket subprotocol (REST: Authorization: Bearer). Each player acts in their own linked account.
 * Transport: WebSocket /ws + REST (/progress, /screenshots, /me).
 *
 * Deploys here are the server's guarded actions (EC2 t4g, DynamoDB, S3). Every write the agents want
 * to make arrives as deploy.preview and needs deploy.approve — see server/src/contract/approvals.ts.
 * A curated template with no guarded build (the serverless quests' hello-api, queue-worker) is a practice build
 * here, like the demo's: a preview and a "built" status from this class, nothing sent and nothing created in AWS.
 */
export interface ServerConfig {
  wsUrl: string;
  apiUrl: string;
  /** Hosted: Cognito sign-in. Absent for the local server. */
  auth?: CognitoAuth;
  /** Local server only: its token (WXT_AWS_TOKEN, minted per run by scripts/launcher/live-run.mjs). Every browser needs it. */
  token?: string;
}

const { reauth: CLOSE_REAUTH, deleted: CLOSE_DELETED, tooMany: CLOSE_TOO_MANY, restarting: CLOSE_RESTARTING } = CLOSE_CODES;

/** What the Deploy tab offers on this backend: prompts that ask the right agent to build it. */
export const GUARDED_BLUEPRINTS = [
  { id: 'library', title: 'Build a library (DynamoDB table)', serviceIds: ['dynamodb'], summary: 'An on-demand table named city-…, built by Dyna.', costNote: 'Pay per request; ~$0 idle.', prompt: 'Create an on-demand DynamoDB table named city-quest-library for my quest.' },
  { id: 'warehouse', title: 'Build a warehouse (S3 bucket)', serviceIds: ['s3'], summary: 'An S3 bucket aws-city-<account>-quest, built by Sally.', costNote: 'Empty bucket: $0.', prompt: 'Create an S3 bucket with the suffix quest for my quest.' },
  { id: 'house', title: 'Build a house (EC2 t4g.micro)', serviceIds: ['ec2'], summary: 'A tiny Graviton instance, built by Eddie. Terminate it when done!', costNote: 'Billed per second (1-minute minimum) while running, plus a small hourly charge for its public IPv4 address; its disk still bills when stopped. Terminate it to stop all charges.', prompt: 'Launch a t4g.micro EC2 instance named quest-house.' },
] as const;

/** Commands kept while offline; older ones are dropped first. */
const MAX_QUEUED = 50;
/** A server behind this extension is being updated: ask it again in a minute, plus up to 30 s of jitter. */
const heldRetryMs = () => 60_000 + Math.random() * 30_000;

export class ServerBackend implements AgentBackend {
  readonly kind = 'server' as const;
  readonly deployMode = 'guarded' as const;
  private ws?: WebSocket;
  private events = new Listeners<ServerEvent>();
  private statuses = new Listeners<ConnectionStatus>();
  private queue: ClientCommand[] = [];
  private retry = 0;
  private closedByUser = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** An open() is between start and creating its socket (awaiting a token): don't start a second. */
  private opening = false;
  /** Sockets that closed before ever opening, since the last successful open. */
  private failedOpens = 0;
  /** Why the server refused us, once diagnosed; cleared by the next successful open. */
  private diagnosed = false;
  /** The last progress the server didn't accept (offline, 5xx); re-sent on the next open. */
  private unsaved?: Progress;
  /**
   * The version handshake refused this extension (GET /progress answered 409 and named the server's version): `updating`
   * while the server is older (asked again every minute or so), `outdated` while it no longer serves this version. Saves
   * wait on this device; cleared by the next successful open.
   */
  private held?: 'updating' | 'outdated';
  private saves = new Listeners<SaveState>();
  /** Set while the player is signed out (no token); cleared when a connection attempt starts with one. */
  private signedOut = false;
  /** Hosted (Cognito sign-in) rather than the local server. */
  readonly hosted: boolean;
  /** The `sub` of the last token a connection was opened with (hosted only); kept after the session ends. */
  private player?: string;
  /** deployId → what was built, so teardown can ask the agent to demolish it. */
  private built = new Map<string, string>();
  /** Practice builds waiting for the player's answer: deployId → template id (never sent to the server). */
  private practice = new Map<string, string>();

  /**
   * The signed-in player (hosted only). The local server has no players, so it has no playerId at all: the runtime
   * then keeps this device's progress unowned, as on the mock.
   */
  readonly playerId?: () => string | undefined;

  constructor(private cfg: ServerConfig) {
    this.hosted = !!cfg.auth;
    if (cfg.auth) this.playerId = () => this.player;
    this.onEvent((e) => {
      if (e.type === 'deploy.preview') this.built.set(e.deployId, e.changes.map((c) => `${c.resourceType} ${c.logicalId}`).join(', '));
    });
    // The side panel and the full-city tab each run a backend: follow sign-in/out made in the other one.
    cfg.auth?.onChange((change) => {
      if (change === 'signed-in' && this.signedOut) this.reconnect();
      else if (change === 'signed-out' && !this.signedOut) this.endSession();
    });
  }

  onEvent(cb: (e: ServerEvent) => void) {
    return this.events.add(cb);
  }
  onStatus(cb: (s: ConnectionStatus) => void) {
    return this.statuses.add(cb);
  }
  onSave(cb: (s: SaveState) => void) {
    return this.saves.add(cb);
  }

  connect() {
    this.closedByUser = false;
    void this.open();
  }

  disconnect() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.ws?.close(1000);
  }

  reconnect() {
    clearTimeout(this.reconnectTimer);
    this.retry = 0;
    this.failedOpens = 0;
    this.diagnosed = false;
    this.closedByUser = false;
    if (this.opening || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    void this.open();
  }

  async signIn(opts?: { fresh?: boolean }) {
    if (!this.cfg.auth) return;
    await this.cfg.auth.signIn(opts);
    // Step-up on an open socket: hand it the fresh token (auth.renew) so a pending approval stays; otherwise connect.
    if (opts?.fresh && this.ws?.readyState === WebSocket.OPEN) {
      const token = await this.cfg.auth.token();
      if (token) return this.raw({ action: 'auth.renew', token });
    }
    this.reconnect();
  }

  async signOut() {
    if (!this.cfg.auth) return;
    await this.cfg.auth.signOut();
    this.endSession();
  }

  /** Signed out here or in another surface: drop the socket and everything queued for this player. */
  private endSession() {
    this.closedByUser = true;
    this.signedOut = true;
    this.dropPlayerState();
    clearTimeout(this.reconnectTimer);
    // Detach first: the socket's async onclose would otherwise report 'disconnected' over 'signed-out'.
    const ws = this.ws;
    this.ws = undefined;
    ws?.close(1000);
    this.statuses.emit('signed-out');
  }

  /**
   * The player's account was deleted (in this tab or on another device). Its token still verifies for a while, so
   * reconnecting with it would only be refused: sign out instead, and never reconnect.
   */
  private deleted() {
    void this.cfg.auth?.signOut().catch((err) => console.warn('[server] sign-out after delete', err));
    this.endSession();
  }

  /** Commands and unsaved progress queued for this player must never replay for whoever signs in next. */
  private dropPlayerState() {
    this.queue = [];
    this.unsaved = undefined;
  }

  async startTotp() {
    if (!this.cfg.auth) throw new Error('This server has no sign-in.');
    return this.cfg.auth.startTotp();
  }

  /**
   * Turns the authenticator on, tells the server first (it must see it before the sign-in that follows; a few tries),
   * then every session ends: the player signs in again with the code. A session that died (not a sign-out), so this
   * device keeps the city for the same player. `signInTwice`: the server never heard, so it may ask for one more sign-in.
   */
  async confirmTotp(code: string) {
    if (!this.cfg.auth) throw new Error('This server has no sign-in.');
    const { noted } = await this.cfg.auth.confirmTotp(code, () => this.noteMfa());
    this.endSession();
    return { signInTwice: !noted };
  }

  /** POST /me/mfa: the server looks at the authenticator now. Throws when it didn't land (an older server's 404 counts: it looks later). */
  private async noteMfa() {
    const res = await fetch(this.url('/me/mfa'), { method: 'POST', headers: await this.headers(), signal: AbortSignal.timeout(5_000) });
    if (!res.ok && res.status !== 404) throw new Error(`POST /me/mfa ${res.status}`);
  }

  async mfaStatus() {
    return this.cfg.auth?.mfaStatus();
  }

  private async token(): Promise<string | undefined> {
    return this.cfg.auth ? this.cfg.auth.token() : this.cfg.token;
  }

  private async headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const t = await this.token();
    // A REST call (GET /progress at startup) can beat the socket to the token: tag the player here too.
    if (t && this.cfg.auth) this.player = subOf(t) ?? this.player;
    return t ? { ...extra, authorization: `Bearer ${t}` } : extra;
  }

  private schedule(ms: number) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.open(), ms);
  }

  private backoff() {
    this.schedule(Math.min(30_000, 1000 * 2 ** this.retry++) + Math.random() * 500);
  }

  private async open() {
    if (this.opening) return;
    this.opening = true;
    // Held by the version handshake: the line stays as it is while the server is asked again.
    this.statuses.emit(this.held ?? 'connecting');
    let ws: WebSocket;
    try {
      let protocols: string[] = [];
      if (this.cfg.auth) {
        const token = await this.token();
        // Signed out (or disconnected) while the token was being fetched: say so, or the pill stays on "Connecting…".
        if (this.closedByUser) return this.statuses.emit(this.signedOut ? 'signed-out' : 'disconnected');
        // Signing in needs a click (launchWebAuthFlow), so we wait for the player instead of popping a window.
        if (!token) {
          // The session is gone (expired, revoked, or signed out elsewhere): whoever signs in next starts clean.
          this.signedOut = true;
          this.dropPlayerState();
          return this.statuses.emit('signed-out');
        }
        this.signedOut = false;
        this.player = subOf(token) ?? this.player;
        protocols = bearerSubprotocols(token);
      } else if (this.cfg.token) protocols = bearerSubprotocols(this.cfg.token);
      if (this.closedByUser) return this.statuses.emit(this.signedOut ? 'signed-out' : 'disconnected');
      const wsUrl = new URL(this.cfg.wsUrl);
      wsUrl.searchParams.set(CONTRACT_PARAM, CONTRACT_VERSION);
      ws = new WebSocket(wsUrl.href, protocols);
    } catch (err) {
      // A token refresh that failed or a bad URL: report it and retry like a dropped connection.
      console.warn('[server] connect failed', err);
      this.statuses.emit('error');
      if (!this.closedByUser) this.backoff();
      return;
    } finally {
      this.opening = false;
    }
    const old = this.ws;
    this.ws = ws;
    // A stray socket from an earlier attempt must not hold one of the player's tab slots.
    if (old && old.readyState <= WebSocket.OPEN) old.close(1000);
    let opened = false;
    ws.onopen = () => {
      if (this.ws !== ws) return ws.close(1000);
      opened = true;
      this.retry = 0;
      this.failedOpens = 0;
      this.diagnosed = false;
      this.held = undefined;
      this.statuses.emit('connected');
      for (const cmd of this.queue.splice(0)) ws.send(JSON.stringify(cmd));
      if (this.unsaved) this.putProgress(this.unsaved);
    };
    ws.onmessage = (msg) => {
      if (this.ws !== ws) return;
      try {
        const data: unknown = JSON.parse(String(msg.data));
        for (const e of Array.isArray(data) ? data : [data]) if (isServerEvent(e)) this.events.emit(e);
      } catch (err) {
        console.warn('[server] bad frame', err);
      }
    };
    ws.onerror = () => this.ws === ws && this.statuses.emit('error');
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.statuses.emit(this.held ?? 'disconnected');
      if (this.closedByUser) return;
      if (ev.code === CLOSE_TOO_MANY) {
        this.events.emit({ type: 'error', message: 'AWS City is open in too many tabs. Close one and press Retry.' });
        return;
      }
      // The account was deleted (in this tab or on another device). Its token still verifies for a while, so reconnecting
      // with it would only be refused: sign out here instead.
      if (ev.code === CLOSE_DELETED) return this.deleted();
      // The server asks for a fresh token every few hours; the auth layer refreshes it silently.
      if (ev.code === CLOSE_REAUTH) return this.schedule(200);
      // A deploy is rolling: spread reconnects out so the new tasks aren't stampeded.
      if (ev.code === CLOSE_RESTARTING) return this.schedule(1000 + Math.random() * 4000);
      // Refused for its version (diagnose found out): a server behind is asked again in a minute or so; an extension too
      // old waits for its own update (the browser installs it and reloads the extension).
      if (this.held === 'updating') return this.schedule(heldRetryMs());
      if (this.held === 'outdated') return;
      // A refused handshake reaches the browser only as 1006: after two in a row, ask the REST API why.
      if (!opened && ++this.failedOpens >= 2 && !this.diagnosed) return void this.diagnose();
      this.backoff();
    };
  }

  /**
   * The WebSocket was refused before it opened. The same checks guard GET /progress, so its status says
   * why: 401 = token rejected, 403/421 = this build isn't allowed, 409 = the version handshake (the server can't serve
   * this extension's contract version; its header names the one it speaks), 410 = this account was deleted, 2xx =
   * per-player tab limit (429 on /ws only).
   */
  private async diagnose() {
    this.diagnosed = true;
    let res: Response | undefined;
    try {
      res = await fetch(this.url('/progress'), { headers: await this.headers(), signal: AbortSignal.timeout(10_000) });
    } catch {
      // Unreachable: a plain outage. Keep retrying quietly.
    }
    const status = res?.status;
    if (this.closedByUser) return;
    if (res && status === 409) {
      // A server older than this extension (or one that doesn't say) is being updated; a newer one has stopped serving
      // this version. One calm status either way, never the server's own words.
      this.held = (compareContract(CONTRACT_VERSION, res.headers.get(CONTRACT_HEADER)) ?? 1) > 0 ? 'updating' : 'outdated';
      this.statuses.emit(this.held);
      if (this.held === 'updating') this.schedule(heldRetryMs());
      return;
    }
    if (status === 410) return this.deleted();
    if (status === 401) {
      if (this.cfg.auth) {
        // A revoked or stale access token: refresh it once; if the refresh token is dead too, token() asks for sign-in.
        await this.cfg.auth.forgetAccessToken();
        this.failedOpens = 0;
        this.diagnosed = false;
        return this.schedule(200);
      }
      this.statuses.emit('error');
      this.events.emit({ type: 'error', message: 'The local server rejected this build’s token (WXT_AWS_TOKEN). Restart it with npm run live.' });
      return;
    }
    if (status === 403 || status === 421) {
      this.statuses.emit('error');
      this.events.emit({
        type: 'error',
        message: this.hosted
          ? 'This version of AWS City isn’t allowed by its server. Update the extension, then press Retry.'
          : 'The local server doesn’t allow this extension (EXTENSION_ORIGIN / PUBLIC_HOSTS). Restart it with npm run live.',
      });
      return;
    }
    if (status !== undefined && status < 300) {
      this.events.emit({ type: 'error', message: 'AWS City may be open in too many tabs. Close one and press Retry.' });
    }
    this.backoff();
  }

  private raw(cmd: ClientCommand) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(cmd));
    else if (this.queue.push(cmd) > MAX_QUEUED) this.queue.shift();
  }

  /** A practice task: played here and never sent, even with a real account linked (src/backend/practiceTasks.ts). */
  practiceTask(scriptId: string, taskId?: string) {
    return playPracticeTask(scriptId, (e) => this.events.emit(e), { taskId });
  }

  private task(prompt: string, taskId = uid()) {
    this.raw({ action: 'task.submit', taskId, prompt, context: {} });
  }

  send(cmd: ClientCommand) {
    switch (cmd.action) {
      case 'task.submit': {
        const { questId: _q, ...rest } = cmd; // the server's schema rejects unknown fields
        return this.raw(rest);
      }
      case 'deploy.approve':
      case 'deploy.reject':
        if (this.practice.has(cmd.deployId)) return this.answerPractice(cmd);
        return this.raw(cmd);
      case 'chat.ask':
      case 'page.classify':
      case 'console.start':
      case 'console.observe':
      case 'console.stop':
      // v2.3 city care: forwarded unchanged (the server re-reads the resource and answers with deploy.preview).
      case 'finding.explain':
      case 'finding.fix':
      case 'finding.undo':
      // v2.5: the bill switch (the server reads Cost Explorer at most once a day while it's on).
      case 'bill.enable':
      // v2.8: live traffic (the server reads CloudWatch at most every 5 minutes while it's on).
      case 'flow.enable':
      // v2.19: disconnect the account; ask the role again whether fixes are allowed (read-only); take down one thing the city built (approved like any write).
      case 'account.unlink':
      case 'account.recheck':
      case 'resource.remove':
      // v2.10: a workshop step checked with a read-only look at the account.
      case 'workshop.verify':
      // v2.11: the live city and leaderboards.
      case 'presence.beat':
      case 'score.submit':
      case 'leaderboard.get':
      // v2.17: a fresh sign-in handed to the open socket (step-up), so a pending approval survives.
      case 'auth.renew':
        return this.raw(cmd);
      case 'deploy.plan': {
        // A practice-only template (the first steps' photo-bucket) never reaches the server, linked account or not.
        if (isPracticeTemplate(cmd.templateId)) return this.planPractice(cmd);
        const bp = GUARDED_BLUEPRINTS.find((b) => b.id === cmd.templateId) ?? GUARDED_BLUEPRINTS.find((b) => b.id === GUARDED_EQUIV[cmd.templateId]);
        // No guarded build (serverless): a practice build, so the quest step still counts and nothing bills.
        if (!bp) return this.planPractice(cmd);
        // The plan's requestId doubles as the task's id, so an error for the task settles the button that asked.
        return this.task(bp.prompt, cmd.requestId);
      }
      case 'deploy.teardown': {
        const what = this.built.get(cmd.deployId);
        if (!what) return this.events.emit({ type: 'deploy.status', deployId: cmd.deployId, status: 'failed', message: 'I don’t know what that was any more.' });
        return this.task(`Please demolish what you built for me: ${what}. (Stop/terminate or delete it.)`);
      }
      // v2.19: account.link may carry allowFixes (the setup link asks for AllowFixes=true), account.verify `updated`.
      case 'account.link':
      case 'account.verify':
        return this.raw(cmd);
      case 'progress.get':
      case 'progress.put':
      case 'screenshot.presign':
      case 'quest.start':
        return; // handled via REST below / not needed
      default: {
        // Every command in the contract is handled above: a new one fails to compile here instead of being dropped.
        const unknown: never = cmd;
        console.warn('[server] command not sent', (unknown as { action?: string }).action);
      }
    }
  }

  /**
   * A curated template with no guarded build: the demo's practice build (a preview, then "built" on approve), made here
   * and never sent. Nothing is created in the player's AWS account, and the preview says so. Its deploy.status complete
   * carries the template id, so the quest's deploy step counts (src/state/store.ts matches templateId).
   */
  private planPractice({ requestId, templateId, taskId }: DeployPlan) {
    const t = templatesJson.templates.find((x) => x.id === templateId);
    if (!t) return this.events.emit({ type: 'error', requestId, message: `This backend can't build ${templateId}.` });
    const deployId = `${PRACTICE_PREFIX}${uid().slice(0, 8)}`;
    this.practice.set(deployId, templateId);
    queueMicrotask(() =>
      this.events.emit({
        type: 'deploy.preview',
        requestId,
        deployId,
        ...(taskId ? { taskId } : {}),
        templateId,
        stackName: `${t.title} (practice)`,
        region: 'practice',
        changes: t.resources.map((r) => ({ action: 'Add' as const, logicalId: r.logicalId, resourceType: r.type })),
        costNote: isPracticeTemplate(templateId) ? t.costNote : 'Practice: free, nothing is created in your AWS account. The city can’t build this kind of stack for real yet; it still counts for your quest.',
      }),
    );
  }

  private answerPractice(cmd: DeployDecision) {
    const templateId = this.practice.get(cmd.deployId);
    this.practice.delete(cmd.deployId);
    const deployId = cmd.deployId;
    if (cmd.action === 'deploy.reject') return queueMicrotask(() => this.events.emit({ type: 'deploy.status', deployId, status: 'rejected', message: 'Nothing was created.' }));
    const t = templatesJson.templates.find((x) => x.id === templateId);
    queueMicrotask(() => {
      this.events.emit({ type: 'deploy.status', deployId, status: 'creating' });
      this.events.emit({ type: 'deploy.status', deployId, status: 'complete', message: `${t?.title ?? 'The stack'}: practice build done. Nothing was created in your AWS account.` });
    });
  }

  /** A REST address on the server, naming this extension's contract version (the v2.19 handshake). */
  private url(path: string) {
    const u = new URL(path, this.cfg.apiUrl);
    u.searchParams.set(CONTRACT_PARAM, CONTRACT_VERSION);
    return u;
  }

  async uploadScreenshot(dataUrl: string) {
    const res = await fetch(this.url('/screenshots'), { method: 'POST', headers: await this.headers({ 'content-type': 'application/json' }), body: JSON.stringify({ contentType: 'image/jpeg' }) });
    if (!res.ok) throw new Error(`POST /screenshots → ${res.status}`);
    const target = (await res.json()) as { uploadUrl: string; screenshotKey: string; method?: 'PUT' | 'POST'; fields?: Record<string, string> };
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    let up: Response;
    if (target.method === 'POST') {
      // S3 presigned POST: the policy fields first, the file last.
      const form = new FormData();
      for (const [k, v] of Object.entries(target.fields ?? {})) form.append(k, v);
      form.append('file', blob);
      up = await fetch(target.uploadUrl, { method: 'POST', body: form });
    } else {
      up = await fetch(new URL(target.uploadUrl, this.cfg.apiUrl), { method: 'PUT', body: blob, headers: { 'content-type': 'image/jpeg' } });
    }
    if (!up.ok) throw new Error(`screenshot upload failed: ${up.status}`);
    return target.screenshotKey;
  }

  async getProgress(): Promise<Progress | null> {
    const res = await fetch(this.url('/progress'), { headers: await this.headers(), signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return null;
    // 401 is "unknown", not "none": treating it as empty would let local progress overwrite the server's.
    if (res.status === 401) throw new Error('GET /progress → 401 (not signed in yet)');
    if (!res.ok) throw new Error(`GET /progress → ${res.status}`);
    return (await res.json()) as Progress;
  }

  putProgress(p: Progress) {
    this.unsaved = p;
    // Held by the version handshake: kept here and sent on the next open, once the server serves this version again.
    if (this.held) return;
    void this.headers({ 'content-type': 'application/json' })
      .then((headers) => fetch(this.url('/progress'), { method: 'PUT', headers, body: JSON.stringify(p) }))
      .then((res) => {
        if (res.ok) {
          if (this.unsaved === p) this.unsaved = undefined;
          return this.saves.emit('saved');
        }
        // Kept for the next open: the server's own trouble (5xx), a stale token (401: re-sent after a fresh one) or the
        // version handshake (409: re-sent once the server serves this version).
        if (res.status >= 500 || res.status === 401 || res.status === 409) throw new Error(`PUT /progress → ${res.status}`);
        // Refused (400: the server's schema refused this copy; 413: too big…): the same copy would be refused again, so
        // it isn't re-sent. The player is told, and the next change tries afresh (each save sends the whole progress).
        if (this.unsaved === p) this.unsaved = undefined;
        console.warn('[server] putProgress refused', res.status);
        this.saves.emit('refused');
      })
      .catch((e) => console.warn('[server] putProgress (will retry on reconnect)', e));
  }

  /** v2.19: GET /me/export, everything the server keeps about the player (the account link as metadata only). */
  async exportMe(): Promise<PlayerDataExport> {
    const res = await fetch(this.url('/me/export'), { headers: await this.headers(), signal: AbortSignal.timeout(15_000) });
    // v2.19: once a minute per player; `tooSoon` lets the UI say so instead of blaming the connection.
    if (!res.ok) throw Object.assign(new Error(`GET /me/export → ${res.status}`), res.status === 429 ? { tooSoon: true } : {});
    return (await res.json()) as PlayerDataExport;
  }

  /** Deletes the player's data on the server (progress, account link, screenshots, sign-in). */
  async deleteAccount() {
    const res = await fetch(this.url('/me'), { method: 'DELETE', headers: await this.headers() });
    if (!res.ok) throw new Error(`DELETE /me → ${res.status}`);
    await this.signOut();
  }
}

/**
 * The `sub` claim of a Cognito access token, read without verifying it: the server verifies every token, and this is
 * only a local tag (which player a parked copy of progress belongs to), not a security check.
 */
export function subOf(token: string): string | undefined {
  try {
    const payload = token.split('.')[1];
    if (!payload) return undefined;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '='));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && sub ? sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Quest deploy steps name curated templates; on this backend the closest guarded build counts. Only where it's the same
 * kind of thing: a serverless template (hello-api, queue-worker) never becomes an EC2 house or a table. It's a practice
 * build instead (planPractice), which counts by its own template id.
 */
export const GUARDED_EQUIV: Record<string, string> = {
  'static-site': 'warehouse',
  'dynamo-table': 'library',
};
/** deployIds of practice builds (nothing in AWS): the UI says "practice", never "built in your AWS account". */
export const PRACTICE_PREFIX = 'practice-';
export const isPracticeDeploy = (deployId: string) => deployId.startsWith(PRACTICE_PREFIX);
/** Server action type (deploy.preview templateId) → blueprint id. */
export const ACTION_BLUEPRINT: Record<string, string> = { create_table: 'library', create_bucket: 'warehouse', launch_instance: 'house' };
