import { TABLE_PREFIX } from '../state/model.js';
import { type ActionName, parseAction } from './actions.js';

/**
 * A plain request in the player's own words ("Create a bucket called holiday-123", "Stop i-0123…"), read without a model.
 * The orchestrator runs it straight through the ActionService (the same policy, approval card, MFA and recent sign-in as
 * an agent's tool call), so the card shows seconds after the player asks instead of after 1-3 minutes of a small CPU
 * model thinking (seen live, 21 Nov 2026). It reads the player's request text only, never page context or a plan, so
 * text planted on a page can't produce an action.
 *
 * `ok: false`: the request was understood but isn't allowed (an m5.large, a bucket name S3 or the city won't take): the
 * player hears why at once, with no model call.
 */
export type Command = { ok: true; name: ActionName; input: Record<string, unknown> } | { ok: false; name: ActionName; reason: string };

// One request, start to end: a sentence with more in it ("…and then delete everything") isn't a plain request.
const lead = String.raw`^\s*(?:please\s+)?(?:can you\s+|could you\s+)?`;
const tail = String.raw`\s*(?:please)?\s*[.!?]?\s*$`;
const called = String.raw`(?:\s+(?:called|named))?\s+["'\x60]?`;
const end = String.raw`["'\x60]?`;
const article = String.raw`(?:me\s+)?(?:a|an|the|new|a new)?\s*`;

const PATTERNS: { re: RegExp; name: ActionName; input: (m: RegExpMatchArray) => Record<string, unknown> }[] = [
  {
    re: new RegExp(`${lead}(?:create|make|build)\\s+${article}(?:s3\\s+)?bucket${called}([A-Za-z0-9._-]{1,70})${end}${tail}`, 'i'),
    name: 'create_bucket',
    input: (m) => ({ suffix: m[1]!.toLowerCase() }),
  },
  {
    re: new RegExp(`${lead}(?:delete|remove|demolish)\\s+(?:the\\s+)?(?:s3\\s+)?bucket${called}([A-Za-z0-9._-]{3,63})${end}${tail}`, 'i'),
    name: 'delete_bucket',
    input: (m) => ({ name: m[1]!.toLowerCase() }),
  },
  {
    re: new RegExp(`${lead}(?:create|make|build)\\s+${article}(?:dynamodb\\s+)?table${called}([A-Za-z0-9._-]{1,60})${end}${tail}`, 'i'),
    name: 'create_table',
    input: (m) => ({ name: withPrefix(m[1]!) }),
  },
  {
    re: new RegExp(`${lead}(?:delete|remove|demolish)\\s+(?:the\\s+)?(?:dynamodb\\s+)?table${called}([A-Za-z0-9._-]{1,60})${end}${tail}`, 'i'),
    name: 'delete_table',
    input: (m) => ({ name: withPrefix(m[1]!) }),
  },
  {
    // "start" isn't a launch verb: "start instance i-0123…" must read as starting that instance.
    re: new RegExp(`${lead}(?:launch|create|build)\\s+${article}(?:ec2\\s+)?(?:server|instance|house)${called}([A-Za-z0-9_-]{1,60})${end}(?:\\s+(?:as\\s+)?(?:an?\\s+)?([a-z0-9]+\\.[a-z0-9]+))?${tail}`, 'i'),
    name: 'launch_instance',
    input: (m) => ({ name: m[1]!, ...(m[2] ? { instanceType: m[2].toLowerCase() } : {}) }),
  },
  ...(['stop', 'start', 'terminate'] as const).map((verb) => ({
    re: new RegExp(`${lead}${verb}\\s+(?:the\\s+)?(?:ec2\\s+)?(?:server|instance|house)?\\s*(i-[0-9a-f]{8,17})${tail}`, 'i'),
    name: `${verb}_instance` as ActionName,
    input: (m: RegExpMatchArray) => ({ instanceId: m[1]!.toLowerCase() }),
  })),
];

const withPrefix = (name: string) => {
  const n = name.toLowerCase();
  return n.startsWith(TABLE_PREFIX) ? n : `${TABLE_PREFIX}${n}`;
};

/** Why a recognised request can't run, in the city's words (the schemas in actions.ts hold the rules). */
const reasonFor = (name: ActionName, input: Record<string, unknown>): string => {
  switch (name) {
    case 'launch_instance':
      return input.instanceType && !['t4g.nano', 't4g.micro'].includes(String(input.instanceType))
        ? `The city only builds small servers: t4g.nano or t4g.micro (Graviton, a fraction of a cent an hour), not ${String(input.instanceType)}. Try "Launch a server called ${String(input.name)}".`
        : 'Server names are up to 40 letters, numbers, spaces, - or _.';
    case 'create_bucket':
      return 'AWS City names buckets aws-city-<account>-<name>. The name part is 3-40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.';
    case 'delete_bucket':
      return 'That isn’t an S3 bucket name: 3-63 lowercase letters, digits, dots or hyphens.';
    case 'create_table':
    case 'delete_table':
      return `Table names here start with ${TABLE_PREFIX} and then use 1-40 lowercase letters, digits or hyphens.`;
    default:
      return 'That request has something the city can’t use.';
  }
};

/** The action a plain request asks for (or why it can't run); undefined when it isn't one plain request. */
export const parseCommand = (text: string): Command | undefined => {
  if (text.length > 200) return undefined;
  for (const { re, name, input } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const args = input(m);
    return parseAction(name, args).ok ? { ok: true, name, input: args } : { ok: false, name, reason: reasonFor(name, args) };
  }
  return undefined;
};
