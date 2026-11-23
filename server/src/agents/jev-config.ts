// Jev's settings, with no imports: `server/src/config.ts` reads them, and the extension's tests import that config (the
// launcher's defaults must match the server's), so this file must not pull in the logger, zod or the model SDKs that
// `jev.ts` needs. `jev.ts` re-exports everything here.

/** A model name TypeSafe's docs show returned. Pinned: aliases move on release. */
export const DEFAULT_JEV_MODEL = 'jev-1.13.0';

export interface JevThresholds {
  /** Block when the intent answer (0–1) is below this. */
  blockBelow: number;
  /** Ask for a typed name when the intent answer is below this… */
  askBelow: number;
  /** …or the risk score (0–2, lowest level first) is at least this. */
  askRiskAtLeast: number;
}
export const DEFAULT_JEV_THRESHOLDS: JevThresholds = { blockBelow: 0.2, askBelow: 0.6, askRiskAtLeast: 1.2 };

export interface JevConfig {
  apiKey: string;
  model: string;
  thresholds: JevThresholds;
}

/** Lowest first: the index is the score. */
export const RISK_LEVELS = [
  'Harmless: it creates or starts a small game resource of the kind the player asked for.',
  'It stops, deletes or removes something, or it costs money.',
  'It destroys data, makes something public, or touches something the player did not mention.',
];
