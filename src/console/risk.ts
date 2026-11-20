// DOM-free so the server (server/) can apply the same rule to model output.

/**
 * Controls the agent may never press itself (the player must). Case-insensitive. Most patterns are word-ish, but
 * managed policy names are one CamelCase word (IAMFullAccess, AmazonS3FullAccess, PowerUserAccess), so those have no
 * leading `\b`.
 */
const RISKY = [
  /\bdelete\b/, /\bterminate\b/, /\bremove\b/, /\bpurge\b/, /\bdestroy\b/, /\bempty\b/, /\bdisable\b/, /\bdeactivate\b/,
  /make public/, /\bpublic access\b.*\b(off|disable)/, /attach (policy|policies)/, /administratoraccess/, /full ?access/,
  /power ?user/,
  // who can reach what: S3 Block Public Access (any of its boxes, or the "I acknowledge … public" one), the
  // whole internet as a source, every port, other accounts
  /\bblock (all )?public\b/, /\bi acknowledge\b/, /anywhere[- ]?ipv[46]/, /(^|[^\d.])0\.0\.0\.0\/0\b/, /::\/0/, /\ball traffic\b/,
  /\b(an)?other aws accounts?\b/, /\bcross-?account\b/,
  // who may take on a role, and making one
  /\btrust(ed)? (entit|polic|relationship)/, /\bcreate (new )?(iam )?role\b/,
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

/** Strip things that must not leave the page: account IDs, access keys, emails, ARNs' account part, long tokens. */
export function redact(text: string): string {
  return text
    .replace(/\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{12,}\b/g, '[key]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    // 12 digits, bare (an ARN's account part) or in groups of four split by one kind of -, . or space
    .replace(/\b\d{4}([-. ]?)\d{4}\1\d{4}\b/g, '[account]')
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, '[token]');
}
