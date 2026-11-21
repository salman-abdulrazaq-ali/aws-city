// DOM-free so the server (server/) can apply the same rule to model output.

/** Controls the agent may never press itself (the player must). Case-insensitive, word-ish match. */
const RISKY = [
  /\bdelete\b/, /\bterminate\b/, /\bremove\b/, /\bpurge\b/, /\bdestroy\b/, /\bempty\b/, /\bdisable\b/, /\bdeactivate\b/,
  /make public/, /\bpublic access\b.*\b(off|disable)/, /attach (policy|policies)/, /administratoraccess/, /full ?access/,
  // Opening access to the world or to another account (security review, 21 Nov): never the agent's click.
  /\bpublic\b/, /\bshare\b/, /\banywhere\b/, /0\.0\.0\.0/, /::\/0/, /account id/, /another (aws )?account/, /cross[- ]account/,
  /\btrust(ed)?\b/, /poweruser/,
  /create access key/, /\baccess keys?\b/, /\bsecret\b/, /\bpassword\b/, /\bmfa\b/, /\broot\b/,
  /\bbilling\b/, /\bpayment\b/, /\bpurchase\b/, /\bbuy\b/, /\bsubscribe\b/, /reserved instance/, /savings plan/, /\bupgrade\b/,
  /sign ?out/, /close account/, /account settings/, /\btransfer\b/,
];

export function isRisky(name: string, context = ''): boolean {
  const s = `${name} ${context}`.toLowerCase();
  return RISKY.some((r) => r.test(s));
}

/**
 * Controls that commit a change (create, save, launch, add, attach…). The Copilot navigates, points and fills fields;
 * the player presses these. Text planted on a console page (a tag, an object key, an AMI name) can then steer what
 * the agent fills in, but never make it commit anything: an allowlist of what it may do, not a list of bad words.
 */
const COMMIT =
  /\b(create|save|launch|submit|apply|update|attach|add|allow|grant|confirm|deploy|enable|start|run|publish|accept|invite|modify|change|associate|import|upload|request|register|authori[sz]e|finish|set|assign|copy|restore|reboot|stop|connect|send|edit|invoke|test|execute|replace|rotate)\b/;
export const isCommit = (name: string) => COMMIT.test(name.toLowerCase());
/** A commit is pressed on a button, link or menu item; picking a tile, radio, tab or option commits nothing. */
export const isCommitControl = (role: string, name: string) => ['button', 'link', 'menuitem'].includes(role) && isCommit(name);

/** Values the Copilot never types itself: networks open to the world, a bare wildcard, an AWS account number, an ARN. */
const RISKY_VALUE = [/0\.0\.0\.0\/0/, /::\/0/, /^\s*\*\s*$/, /\b\d{4}[\s.-]?\d{4}[\s.-]?\d{4}\b/, /\barn:aws/i];
export const isRiskyValue = (value: string) => RISKY_VALUE.some((r) => r.test(value));

/** Strip things that must not leave the page: account IDs, access keys, emails, ARNs' account part, long tokens. */
export function redact(text: string): string {
  return text
    .replace(/\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,}\b/g, '[key]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b\d{4}-?\d{4}-?\d{4}\b/g, '[account]')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[token]');
}
