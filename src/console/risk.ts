// DOM-free so the server (server/) can apply the same rule to model output.

/**
 * Controls the agent may never press itself (the player must). Case-insensitive. Most patterns are word-ish, but
 * managed policy names are one CamelCase word (IAMFullAccess, AmazonS3FullAccess, PowerUserAccess), so those have no
 * leading `\b`.
 */
const RISKY = [
  /\bdelete\b/, /\bterminate\b/, /\bremove\b/, /\bpurge\b/, /\bdestroy\b/, /\bempty\b/, /\bdisable\b/, /\bdeactivate\b/,
  /make public/, /\bpublic access\b.*\b(off|disable)/, /attach (policy|policies)/, /administratoraccess/, /full ?access/,
  // Managed policies inside one word (PowerUserAccess), and who can reach what: S3 Block Public Access (any of its boxes,
  // or the "I acknowledge … public" one), the whole internet as a source, every port, other accounts. The 21 Nov security
  // review's broader words (public, share, anywhere, account id, trust) hand the click back too.
  /power ?user/, /\bpublic\b/, /\bblock (all )?public\b/, /\bi acknowledge\b/, /\bshare\b/, /\banywhere\b/, /anywhere[- ]?ipv[46]/,
  // 0.0.0.0, alone or as /0, but never inside a private range (10.0.0.0/16 is an ordinary VPC CIDR)
  /(^|[^\d.])0\.0\.0\.0(?!\d)/, /::\/0/, /\ball traffic\b/,
  /account id/, /\b(an)?other aws accounts?\b/, /another (aws )?account/, /\bcross[- ]?account\b/,
  // who may take on a role, and making one
  /\btrust(ed)?\b/, /\bcreate (new )?(iam )?role\b/,
  /create access key/, /\baccess keys?\b/, /\bsecret\b/, /\bpassword\b/, /\bmfa\b/, /\broot\b/,
  /\bbilling\b/, /\bpayment\b/, /\bpurchase\b/, /\bbuy\b/, /\bsubscribe\b/, /reserved instance/, /savings plan/, /\bupgrade\b/,
  /sign ?out/, /close account/, /account settings/, /\btransfer\b/,
];

export function isRisky(name: string, context = ''): boolean {
  const s = `${name} ${context}`.toLowerCase();
  return RISKY.some((r) => r.test(s));
}

/** Only real console pages — never sign-in, never other sites. */
export function isConsoleUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    if (/(^|\.)signin\.aws\.amazon\.com$/.test(u.hostname)) return false;
    return u.hostname === 'console.aws.amazon.com' || u.hostname.endsWith('.console.aws.amazon.com');
  } catch {
    return false;
  }
}

/**
 * The first word of a form's commit control: the press that makes, starts or changes something, a billable create among
 * them ("Create database" on Production, "Launch instance" with a big type, "Create NAT gateway").
 */
const COMMIT = /^(create|launch|start|run|confirm|submit|save|apply|update|enable|attach|associate|allocate|request|deploy|purchase|buy|subscribe|order)\b/i;
/** Moving through a wizard commits nothing, even on its primary button: the whole name only ("Cancel update" commits). */
const STEP_ONLY = /^(next|previous|back|cancel|close)$/i;
/** What a commit is pressed on: a button or a menu item (a link only goes somewhere; a box, radio, option or tab fills the form). */
const PRESSED = new Set(['button', 'menuitem']);

/**
 * Whether the console page is in English (`<html lang>` en, en-US…), the only language COMMIT knows. Anything else,
 * including no lang at all (we can't show every console page sets it), fails closed.
 */
export const isEnglishPage = (lang: string) => /^en(-|$)/i.test(lang.trim());

/**
 * Whether a click on this control commits a form on the REAL console (`isConsoleUrl`; never the practice console): a
 * button or menu item whose accessible name starts with a commit word, or that the page marks as the form's main action
 * (`primary`: Cloudscape's primary variant or a native form's default submit button, which only the page can see; a
 * wizard's Next/Previous excepted). The commit words are English, so on a page whose `lang` isn't (`isEnglishPage`;
 * `''` when the page has none) every press of a button or menu item is the player's. `lang` undefined means not known
 * (a snapshot from before v2.19): the words alone decide. The Copilot acts with the console user's own rights, outside
 * the player role's caps, so that press is always the player's: it fills the form and points at the button. The server
 * applies the same rule by name and the snapshot's `lang`.
 */
export function isCommit(url: string | undefined, role: string, name: string, primary = false, lang?: string): boolean {
  if (!url || !isConsoleUrl(url) || !PRESSED.has(role)) return false;
  if (lang !== undefined && !isEnglishPage(lang)) return true;
  const n = name.trim();
  return COMMIT.test(n) || (primary && !STEP_ONLY.test(n));
}

/**
 * Words that commit a change anywhere in a control's name (create, save, launch, add, attach…; security review, 21 Nov).
 * The Copilot navigates, points and fills fields; the player presses these, on any page (the practice console too).
 * Text planted on a console page (a tag, an object key, an AMI name) can then steer what the agent fills in, but never
 * make it commit anything: an allowlist of what it may do, not a list of bad words. (`isCommit` above is the real
 * console's form-commit rule, by its first word, the page's main action and its language; both apply.)
 */
const COMMIT_WORD =
  /\b(create|save|launch|submit|apply|update|attach|add|allow|grant|confirm|deploy|enable|start|run|publish|accept|invite|modify|change|associate|import|upload|request|register|authori[sz]e|finish|set|assign|copy|restore|reboot|stop|connect|send|edit|invoke|test|execute|replace|rotate)\b/;
export const isCommitWord = (name: string) => COMMIT_WORD.test(name.toLowerCase());
/** A commit is pressed on a button, link or menu item; picking a tile, radio, tab or option commits nothing. */
export const isCommitControl = (role: string, name: string) => ['button', 'link', 'menuitem'].includes(role) && isCommitWord(name);

/** Values the Copilot never types itself: networks open to the world, a bare wildcard, an AWS account number, an ARN. */
const RISKY_VALUE = [/0\.0\.0\.0\/0/, /::\/0/, /^\s*\*\s*$/, /\b\d{4}[\s.-]?\d{4}[\s.-]?\d{4}\b/, /\barn:aws/i];
export const isRiskyValue = (value: string) => RISKY_VALUE.some((r) => r.test(value));

/** A console page, matched on its lower-cased path + query + hash (`/iam/home#/roles`). */
export interface ConsolePage {
  id: string;
  /** How the player reads it: "On IAM pages …". */
  name: string;
  page: RegExp;
}

/** `/<service>` as the first path segment. */
const service = (s: string) => new RegExp(`^/(${s})(?=[/?#]|$)`);

/**
 * Real-console pages where only the player acts: who can do what (IAM, IAM Identity Center, Organizations), keys and
 * secrets (KMS, Secrets Manager), who can reach what (security group inbound rules, S3 bucket permissions and Block
 * Public Access). The Copilot may point and explain there, never click, type or pick. The practice console
 * (practice.html) isn't the real console, so it never matches.
 */
export const PLAYER_ONLY_PAGES: readonly ConsolePage[] = [
  { id: 'iam', name: 'IAM', page: service('iam|iamv2') },
  { id: 'identity-center', name: 'IAM Identity Center', page: service('singlesignon') },
  { id: 'organizations', name: 'AWS Organizations', page: service('organizations') },
  { id: 'kms', name: 'AWS KMS', page: service('kms') },
  { id: 'secretsmanager', name: 'Secrets Manager', page: service('secretsmanager') },
  { id: 'security-group-rules', name: 'security group rules', page: /^\/(ec2|vpc|vpcconsole)(?=[/?#]).*#(modifyinboundsecuritygrouprules|createsecuritygroup)\b/ },
  { id: 's3-permissions', name: 'S3 permissions', page: /^\/s3(\/(settings|bpa)\b|(?=[/?#]).*([?&]tab=permissions\b|\/property\/(bpa|policy|acl|cors|oo)\b))/ },
];

/**
 * Real-console pages that show a secret on screen (an access key's secret, a secret's value, a SecureString, key
 * material, a shell): the Lookout never photographs them on its own (auto-snap), only when the player asks.
 */
export const SECRET_PAGES: readonly ConsolePage[] = [
  { id: 'iam-access-keys', name: 'IAM access keys', page: /^\/(iam|iamv2)(?=[/?#]).*(security_credentials|access-?keys?\b)/ },
  { id: 'secretsmanager', name: 'Secrets Manager', page: service('secretsmanager') },
  { id: 'parameter-store', name: 'Systems Manager Parameter Store', page: /^\/systems-manager\/parameters?(?=[/?#]|$)/ },
  { id: 'kms', name: 'AWS KMS', page: service('kms') },
  { id: 'cloudshell', name: 'AWS CloudShell', page: service('cloudshell') },
];

function consolePage(list: readonly ConsolePage[], raw: string | undefined): ConsolePage | undefined {
  if (!raw || !isConsoleUrl(raw)) return undefined;
  const u = new URL(raw);
  const where = `${u.pathname}${u.search}${u.hash}`.toLowerCase();
  return list.find((p) => p.page.test(where));
}

/** The player-only page this real-console URL shows, if any. */
export const playerOnlyPage = (url: string | undefined) => consolePage(PLAYER_ONLY_PAGES, url);
/** Whether this real-console URL shows a secret (never auto-snapped). */
export const isSecretPage = (url: string | undefined) => !!consolePage(SECRET_PAGES, url);

/** 12 digits, bare (an ARN's account part) or in groups of four split by one kind of -, . or space. */
const ACCOUNT_ID = /\b\d{4}([-. ]?)\d{4}\1\d{4}\b/g;

/**
 * Strip things that must not leave the page: account IDs, access keys, emails, ARNs' account part, long tokens. An access
 * key id is caught in any case (akia…) and, in capitals, typed in groups of four (AKIA IOSF ODNN 7EXA MPLE). Lowercase
 * groups aren't: "Asia have some data from" would read as one. A long token isn't an AWS managed policy's name
 * (AWSLambdaManagedEC2ResourceOperator, AmazonEC2ContainerServiceforEC2Role): a workshop step's Copilot goal and an IAM
 * page name them, and the Copilot needs the name.
 */
export function redact(text: string): string {
  return text
    .replace(/\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,}\b/gi, '[key]')
    .replace(/\b(AKIA|ASIA|AROA|AIDA)([ -][A-Z0-9]{4}){4}\b/g, '[key]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(ACCOUNT_ID, '[account]')
    .replace(/\b(?!AWS|Amazon)[A-Za-z0-9+/_-]{32,}={0,2}/g, '[token]');
}

/**
 * A console URL as it may leave the page. A multi-session console host names the account
 * (`123456789012-abcd1234.us-east-1.console.aws.amazon.com`), so that prefix goes, and an account id elsewhere in it
 * (an ARN in the hash, a bucket name) reads [account]. It stays a console URL that parses the same way (the server
 * reads its service and page: isConsoleUrl, PLAYER_ONLY_PAGES). Anything else is returned as it was.
 */
export function redactConsoleUrl(raw: string): string {
  if (!isConsoleUrl(raw)) return raw;
  const u = new URL(raw);
  u.hostname = u.hostname.replace(/^\d{12}-[a-z0-9]+\./, '');
  return u.toString().replace(ACCOUNT_ID, '[account]');
}
