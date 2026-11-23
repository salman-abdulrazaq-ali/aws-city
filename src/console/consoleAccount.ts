/**
 * Which AWS account a console page is signed into, read on that page. It never leaves this computer: the city only
 * compares it with the linked account and warns when they differ. Seen 23 Nov 2026: the console (and CloudShell, opened
 * from it) was still signed into the city's own account, so buckets made there never showed in My AWS, which reads the
 * linked one.
 *
 * Two sources: a multi-session console's host starts with the account id (123456789012-abcd1234.us-east-1.console…),
 * otherwise the console's `aws-userInfo` cookie names the signed-in ARN (an IAM user's, `arn:aws:iam::<id>:user/…`, or
 * an assumed role's after Switch role, `arn:aws:sts::<id>:assumed-role/…`). Neither is a documented API, so anything
 * unreadable is undefined, and the city then says nothing rather than guess.
 */
export function consoleAccount(host: string, cookie: string): string | undefined {
  const fromHost = /^(\d{12})-[a-z0-9]+\./.exec(host)?.[1];
  if (fromHost) return fromHost;
  const raw = cookie
    .split(/;\s*/)
    .find((c) => c.startsWith('aws-userInfo='))
    ?.slice('aws-userInfo='.length);
  if (!raw) return undefined;
  try {
    let text = raw;
    // URL-encoded once, sometimes twice.
    for (let i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(text); i++) text = decodeURIComponent(text);
    const info = JSON.parse(text) as { arn?: unknown };
    return typeof info.arn === 'string' ? /^arn:aws[a-z-]*:(?:iam|sts)::(\d{12}):/.exec(info.arn)?.[1] : undefined;
  } catch {
    return undefined;
  }
}
