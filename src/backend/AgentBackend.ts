import type { ClientCommand, PlayerDataExport, Progress, ServerEvent } from './contract';

/**
 * `updating`: the server is older than this extension (the v2.17 version handshake refused it), so it waits for the
 * server's update; `outdated`: the server no longer serves this extension's version, so the extension needs its update.
 * Progress stays on this device in both.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error' | 'signed-out' | 'updating' | 'outdated';

/** What became of a progress save: `saved` to the account, or `refused` by it (a 4xx: sending the same copy again can't work). */
export type SaveState = 'saved' | 'refused';

/**
 * Everything the frontend needs from a backend. MockBackend fakes it in-browser; ServerBackend
 * talks to the AWS City server (server/). Nothing outside src/backend/ may do network I/O.
 */
export interface AgentBackend {
  readonly kind: 'mock' | 'server';
  /** 'templates' = curated CloudFormation into a linked account; 'guarded' = the local server's approved actions. */
  readonly deployMode?: 'templates' | 'guarded';
  /** Signed-in players (the hosted server); absent or false for the mock and the local server. */
  readonly hosted?: boolean;
  connect(): void;
  disconnect(): void;
  onEvent(cb: (e: ServerEvent) => void): () => void;
  onStatus(cb: (s: ConnectionStatus) => void): () => void;

  /** Send any contract command. Queued until connected. */
  send(cmd: ClientCommand): void;

  /** Upload a JPEG data URL via a presigned URL; returns the S3 key to reference in later commands. */
  uploadScreenshot(dataUrl: string): Promise<string>;

  /** null = backend has no progress for this user yet. */
  getProgress(): Promise<Progress | null>;
  putProgress(p: Progress): void;
  /** Each save's outcome (the server): "Not saved to your account" shows after a refusal, until a save goes through. */
  onSave?(cb: (s: SaveState) => void): () => void;
  /**
   * v2.17 "Download my data": everything the backend keeps about the player (the server: GET /me/export; the demo: this
   * device's progress, `practice: true`). The account link is metadata only, never the ExternalId.
   */
  exportMe(): Promise<PlayerDataExport>;

  /** Interactive sign-in (hosted server). Must be called from a user gesture. */
  signIn?(): Promise<void>;
  signOut?(): Promise<void>;
  /** Hosted: enrol an authenticator app (step-up MFA before linking an AWS account). */
  startTotp?(): Promise<{ secret: string; uri: string }>;
  /**
   * Turns it on, then ends every session of the player: they sign in again with the code. `signInTwice`: the server
   * never heard it was turned on, so the sign-in after this one may be asked for too.
   */
  confirmTotp?(code: string): Promise<{ signInTwice?: boolean } | undefined>;
  /** Hosted: whether the player's authenticator is on (`external`: Google sign-in keeps its own second step). */
  mfaStatus?(): Promise<'on' | 'off' | 'external' | undefined>;
  /** Try connecting again now (after going offline). */
  reconnect?(): void;
  /**
   * Hosted: who the last sign-in on this device was (the token's `sub`), or undefined. A local tag only, so a
   * session that died can hand its unsynced progress back to the same player, never to the next one.
   */
  playerId?(): string | undefined;
}

/** Tiny listener set used by all implementations. */
export class Listeners<T> {
  private set = new Set<(v: T) => void>();
  add(cb: (v: T) => void) {
    this.set.add(cb);
    return () => {
      this.set.delete(cb);
    };
  }
  emit(v: T) {
    for (const cb of this.set) {
      try {
        cb(v);
      } catch (err) {
        console.error('[backend] listener failed', err);
      }
    }
  }
}

/** Await the first event matching `pick`, or reject after `ms`. */
export function waitFor<T>(backend: AgentBackend, pick: (e: ServerEvent) => T | undefined, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error('backend timed out'));
    }, ms);
    const off = backend.onEvent((e) => {
      const v = pick(e);
      if (v === undefined) return;
      clearTimeout(timer);
      off();
      resolve(v);
    });
  });
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`);
