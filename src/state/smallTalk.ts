import { placeFor } from '@/world/places';
import { matchText, SERVICES, serviceById } from '@/world/taxonomy';

/**
 * Small talk typed in the city's request box ("Eddie, how are you?") is a chat with that agent, not a request to build
 * something. Seen live, 23 Nov 2026: sent as a task, the concierge on the CPU model planned "launch a t4g.nano called
 * Eddie" and Eddie said he would (nothing reached AWS: a change still needs its card and the player's Approve, and Jev
 * would have stopped one nobody asked for). Only greetings and social questions count, short, with no word that asks for
 * a change; everything else stays a task exactly as before ("What is S3?", "Who has permission to open my bucket?",
 * "Store my holiday photos cheaply", plain requests).
 */

/** A word that asks the city to change something: any one of them makes the text a request. */
const CHANGE =
  /\b(create|make|build|launch|start|stop|terminate|delete|remove|deploy|set\s*up|store|upload|run|host|add|turn\s+(?:on|off)|enable|disable|fix|attach|copy|move|back\s*up|tear\s+down|connect|install|configure|update|change|restart|reboot|resize|scale|give)\b/i;

/** How small talk opens, once a leading agent name is set aside. */
const SOCIAL =
  /^(?:hi|hello|hey|hiya|howdy|yo|good\s+(?:morning|afternoon|evening|day)|how\s+are\s+(?:you|things)|how\s+is\s+it\s+going|hows\s+it\s+going|whats\s+up|what\s+is\s+up|who\s+are\s+you|what\s+can\s+you\s+do|what\s+do\s+you\s+do|nice\s+to\s+meet\s+you|thanks|thank\s+you|cheers)\b/;

/** Small talk is short: a greeting with a long sentence after it is usually a request. */
const MAX_WORDS = 8;

const TITLES = new Set(['sir', 'captain']);

/** Each building's agent by the name players call them ("Eddie the Engineer" → eddie, "Sir Shieldon" → shieldon). */
const AGENTS: { name: string; serviceId: string; districtId: string }[] = SERVICES.flatMap((s) => {
  const words = (placeFor(s.id)?.agentName ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const name = TITLES.has(words[0] ?? '') ? words[1] : words[0];
  return name ? [{ name, serviceId: s.id, districtId: s.districtId }] : [];
});

/** Lower case, words only (apostrophes dropped: "how's" → "hows"), single spaces. */
const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** The agent the text names, as a whole word ("Thanks Eddie!"), if any. */
const namedAgent = (plain: string) => AGENTS.find((a) => new RegExp(`\\b${a.name}\\b`).test(plain));

/**
 * The HQ whose chat should answer `text`, when it's small talk; undefined when it's a request (a task, as before).
 * `selected`: the building the player has picked, used when the text names no agent and no service.
 */
export function smallTalkTo(text: string, selected?: string): { districtId: string } | undefined {
  const plain = words(text);
  if (!plain || CHANGE.test(plain)) return undefined;
  const agent = namedAgent(plain);
  // "Eddie, how are you?", "Hey Eddie", "Thanks Eddie": the name says who, the rest says what.
  const rest = agent ? plain.replace(new RegExp(`\\b${agent.name}\\b`, 'g'), ' ').replace(/\s+/g, ' ').trim() : plain;
  if (!rest || !SOCIAL.test(rest) || plain.split(' ').length > MAX_WORDS) return undefined;
  const serviceId = agent?.serviceId ?? matchText(text) ?? selected;
  const districtId = (serviceId && serviceById(serviceId)?.districtId) || serviceById('bedrock')?.districtId;
  return districtId ? { districtId } : undefined;
}
