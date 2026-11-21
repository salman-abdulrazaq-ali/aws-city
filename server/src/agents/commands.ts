import { TABLE_PREFIX } from '../state/model.js';
import { type ActionName, parseAction } from './actions.js';

/**
 * A plain request in the player's own words ("Create a bucket called holiday-123", "Stop i-0123…"), read without a model.
 * The orchestrator uses it only when the agent's turn made no tool call: a small model sometimes promises a change and
 * never makes it (seen live, 21 Nov 2026). What it returns is checked by parseAction like any tool call, then goes
 * through the same policy, approval card, MFA and recent sign-in. It reads the player's request text only, never page
 * context or the concierge's plan, so text planted on a page can't produce an action.
 */
export interface Command {
  name: ActionName;
  input: Record<string, unknown>;
}

// One request, start to end: a sentence with more in it ("…and then delete everything") isn't a plain request.
const lead = String.raw`^\s*(?:please\s+)?(?:can you\s+|could you\s+)?`;
const tail = String.raw`\s*(?:please)?\s*[.!?]?\s*$`;
const called = String.raw`(?:\s+(?:called|named))?\s+["'\x60]?`;
const end = String.raw`["'\x60]?`;

const PATTERNS: { re: RegExp; build: (m: RegExpMatchArray) => Command }[] = [
  {
    re: new RegExp(`${lead}(?:create|make|build)\\s+(?:me\\s+)?(?:a|an|the|new|a new)?\\s*(?:s3\\s+)?bucket${called}([a-z0-9-]{3,63})${end}${tail}`, 'i'),
    build: (m) => ({ name: 'create_bucket', input: { suffix: m[1]!.toLowerCase() } }),
  },
  {
    re: new RegExp(`${lead}(?:delete|remove|demolish)\\s+(?:the\\s+)?(?:s3\\s+)?bucket${called}(aws-city-[a-z0-9-]{3,60})${end}${tail}`, 'i'),
    build: (m) => ({ name: 'delete_bucket', input: { name: m[1]!.toLowerCase() } }),
  },
  {
    re: new RegExp(`${lead}(?:create|make|build)\\s+(?:me\\s+)?(?:a|an|the|new|a new)?\\s*(?:dynamodb\\s+)?table${called}([a-z0-9-]{1,45})${end}${tail}`, 'i'),
    build: (m) => ({ name: 'create_table', input: { name: withPrefix(m[1]!) } }),
  },
  {
    re: new RegExp(`${lead}(?:delete|remove|demolish)\\s+(?:the\\s+)?(?:dynamodb\\s+)?table${called}([a-z0-9-]{1,45})${end}${tail}`, 'i'),
    build: (m) => ({ name: 'delete_table', input: { name: withPrefix(m[1]!) } }),
  },
  {
    re: new RegExp(`${lead}(?:launch|create|build)\\s+(?:me\\s+)?(?:a|an|the|new|a new)?\\s*(?:ec2\\s+)?(?:server|instance|house)${called}([A-Za-z0-9_-]{1,40})${end}(?:\\s+(?:as\\s+)?(?:an?\\s+)?(t4g\\.(?:nano|micro)))?${tail}`, 'i'),
    build: (m) => ({ name: 'launch_instance', input: { name: m[1]!, ...(m[2] ? { instanceType: m[2].toLowerCase() } : {}) } }),
  },
  {
    re: new RegExp(`${lead}(stop|start|terminate)\\s+(?:the\\s+)?(?:ec2\\s+)?(?:server|instance|house)?\\s*(i-[0-9a-f]{8,17})${tail}`, 'i'),
    build: (m) => ({ name: `${m[1]!.toLowerCase()}_instance` as ActionName, input: { instanceId: m[2]!.toLowerCase() } }),
  },
];

const withPrefix = (name: string) => {
  const n = name.toLowerCase();
  return n.startsWith(TABLE_PREFIX) ? n : `${TABLE_PREFIX}${n}`;
};

/** The action a plain request asks for, if it's one of the write actions and valid; otherwise undefined. */
export const parseCommand = (text: string): Command | undefined => {
  if (text.length > 200) return undefined;
  for (const { re, build } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const command = build(m);
    return parseAction(command.name, command.input).ok ? command : undefined;
  }
  return undefined;
};
