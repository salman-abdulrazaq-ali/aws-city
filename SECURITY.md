# Security policy

## Reporting a vulnerability

Please report it privately: this repository's **Security** tab → **Report a vulnerability** (GitHub private
vulnerability reporting). Don't open a public issue, pull request or discussion for it.

Tell us what you found, how to reproduce it, and what it lets someone do. We reply within **3 working days**, keep you
told how the fix is going, and credit you in the advisory unless you'd rather we didn't.

## In scope

- The browser extension (`src/`, `shared/`, `public/`)
- The server (`server/`), locally and hosted
- The AWS infrastructure in `infra/`, and the player role template it publishes (`AWSCityPlayerRole-<region>`)
- The GitHub workflows (`.github/`)

## Out of scope

- AWS services themselves: report those to AWS (https://aws.amazon.com/security/vulnerability-reporting/).
- Denial of service, spam, social engineering, and findings that need a compromised device or browser.

## Testing safely

Test only against your own deployment (`docs/self-hosting.md`) or your own player account. Never read, change or
delete another player's data, and never touch a linked AWS account that isn't yours. Good-faith research that follows
this policy is welcome, and we won't take action against it.

## Supported versions

Only the latest release and `main` get security fixes.
