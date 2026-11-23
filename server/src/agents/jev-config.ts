// Jev's settings and wording, with no imports: `server/src/config.ts` reads them, and the extension's tests import that
// config (the launcher's defaults must match the server's), so this file must not pull in the logger, zod or the model
// SDKs that `jev.ts` needs. `jev.ts` re-exports everything here. The questions, their criteria and the thresholds live
// together in this one file so a person can audit and edit them in one place; the decision they feed is `decide` in
// `jev.ts`.

/** TypeSafe's current model (docs.typesafe.ai/go/models). Pinned: aliases move on release. */
export const DEFAULT_JEV_MODEL = 'jev-1.14.0';

/**
 * How a Noul answer (the probability of yes, 0–1) is read: at or below `no` is a no, at or above `yes` is a yes, and
 * anything between is unsettled, which is a row of its own in the decision table.
 */
export interface JevThresholds {
  no: number;
  yes: number;
}
/** TypeSafe's recommended starting thresholds for a Noul. */
export const DEFAULT_JEV_THRESHOLDS: JevThresholds = { no: 0.3, yes: 0.7 };

export interface JevConfig {
  apiKey: string;
  model: string;
  thresholds: JevThresholds;
}

/**
 * The questions, word for word, all Noul (yes/no). Each is one judgment about the state `{ request, change }`: the
 * player's own words and the one-line summary of the AWS change. Question ids are never sent to the model.
 * `asked_for` goes with every write; `asks_to_remove` and `names_target` only with a destructive one (terminate an
 * instance, delete a table or a bucket).
 */
export const JEV_QUESTIONS = {
  asked_for: {
    type: 'noul',
    instructions: 'Does `change` do what the player asked for in `request`?',
    criteria: {
      true: '`change` is what the player asked for, or one step of it.',
      false: 'The player asked for something different, and `change` is not part of it.',
    },
  },
  asks_to_remove: {
    type: 'noul',
    instructions: 'Does the player ask in `request` to delete, terminate or remove something?',
    criteria: {
      true: 'The player asks for something to be deleted, terminated, removed or torn down.',
      false: 'The player only asks to create, change, check or learn about something.',
    },
  },
  names_target: {
    type: 'noul',
    instructions: 'Does `request` name or describe the resource that `change` removes?',
    criteria: {
      true: 'The player names this resource, or describes it clearly enough to tell which one they mean.',
      false: "The player doesn't name or describe this resource.",
    },
  },
} as const;
export type JevQuestionId = keyof typeof JEV_QUESTIONS;
